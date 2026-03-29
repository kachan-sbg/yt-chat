const express    = require('express');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const { google } = require('googleapis');
const cfg        = require('./config');

const app = express();

if (cfg.CLIENT_ID === 'YOUR_CLIENT_ID_HERE') {
  console.error('\n  ✗ CLIENT_ID не налаштовано в config.js\n');
  process.exit(1);
}

// ── LOGGING ───────────────────────────────────────────────────────────────────
const logTs   = () => new Date().toLocaleTimeString();
const log     = (msg) => console.log(`[${logTs()}]  →  ${msg}`);
const logOk   = (msg) => console.log(`[${logTs()}]  ✓  ${msg}`);
const logWarn = (msg) => console.log(`[${logTs()}]  ⚠  ${msg}`);
const logErr  = (msg) => console.log(`[${logTs()}]  ✗  ${msg}`);

// ── AUTH ──────────────────────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  cfg.CLIENT_ID,
  cfg.CLIENT_SECRET,
  cfg.REDIRECT_URI,
);

const TOKEN_PATH    = path.join(__dirname, cfg.TOKEN_FILE);
const SETTINGS_PATH = path.join(__dirname, 'settings.json');

const DEFAULT_SETTINGS = { opacity: 0.08, blur: 3, fontSize: 'normal' };

function loadSettings(profile = 'default') {
  try {
    const data  = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    // Migrate old flat format { opacity, blur, fontSize } → { default: {...} }
    const store = data.opacity !== undefined ? { default: data } : data;
    return { ...DEFAULT_SETTINGS, ...(store[profile] || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(profile = 'default', settings) {
  let store = {};
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    store = data.opacity !== undefined ? { default: data } : data;
  } catch {}
  store[profile] = settings;
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(store, null, 2));
}

function loadTokens() {
  try {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oauth2Client.setCredentials(tokens);
    logOk('Tokens loaded.');
    return true;
  } catch {
    return false;
  }
}

oauth2Client.on('tokens', (tokens) => {
  const merged = { ...oauth2Client.credentials, ...tokens };
  if (!merged.refresh_token && oauth2Client.credentials.refresh_token) {
    merged.refresh_token = oauth2Client.credentials.refresh_token;
  }
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
  logOk('Tokens refreshed automatically.');
});

const hasTokens = loadTokens();

// ── QUOTA TRACKING ────────────────────────────────────────────────────────────
// YouTube Data API v3 quota resets daily at midnight Pacific Time ≈ 08:00 UTC.
// Costs: liveChatMessages.list = 5 units, liveBroadcasts.list = 1 unit.

let quotaUsed       = 0;
let quotaResetTimer = null;

function getMsUntilQuotaReset() {
  const now = Date.now();
  const d   = new Date(now);
  // Midnight Pacific ≈ 08:00 UTC (PST) / 07:00 UTC (PDT). Using 08:00 as safe approximation.
  let reset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 0, 0, 0);
  if (reset <= now) reset += 86_400_000;
  return reset - now;
}

function scheduleQuotaReset() {
  if (quotaResetTimer) clearTimeout(quotaResetTimer);
  const ms = getMsUntilQuotaReset();
  quotaResetTimer = setTimeout(() => {
    quotaUsed = 0;
    logOk(`Quota reset. Daily limit (${cfg.DAILY_QUOTA_LIMIT} units) restored.`);
    scheduleQuotaReset();
    // Resume polling if a stream is connected but polling was paused for quota
    if (liveChatId && !isPolling) {
      log('Resuming polling after quota reset...');
      startPolling();
    }
  }, ms);
}

function addQuota(units) {
  quotaUsed += units;
}

function getQuotaInfo() {
  const remaining  = cfg.DAILY_QUOTA_LIMIT - quotaUsed;
  const msLeft     = getMsUntilQuotaReset();
  const hoursLeft  = Math.round(msLeft / 360_000) / 10; // 1 decimal
  const maxCalls   = Math.floor(remaining / 5);          // 5 units per poll
  const optimalMs  = maxCalls > 0 ? Math.ceil(msLeft / maxCalls) : Infinity;
  return { remaining, hoursLeft, maxCalls, optimalMs };
}

function logQuotaEstimate() {
  const { remaining, hoursLeft, maxCalls } = getQuotaInfo();
  const currentInterval = (nextPollIntervalMs ?? cfg.POLL_INTERVAL_MS) / 1000;
  const callsPerHour    = Math.floor(3600 / currentInterval);
  const unitsPerHour    = callsPerHour * 5;
  const hoursUntilDry   = remaining / unitsPerHour;
  log(`Quota: ${quotaUsed}/${cfg.DAILY_QUOTA_LIMIT} used | ${remaining} remaining | resets in ${hoursLeft}h`);
  log(`At ${currentInterval}s interval: ~${callsPerHour} calls/h, ~${unitsPerHour} units/h → quota lasts ~${hoursUntilDry.toFixed(1)}h`);
  if (hoursUntilDry < hoursLeft) {
    logWarn(`Quota may run out before reset! Consider raising POLL_INTERVAL_MS in config.js.`);
  }
}

function getAdaptivePollInterval() {
  const { remaining, hoursLeft, maxCalls, optimalMs } = getQuotaInfo();

  if (remaining < 5) {
    logWarn(`Quota exhausted (${quotaUsed}/${cfg.DAILY_QUOTA_LIMIT}). Polling paused. Resets in ${hoursLeft}h.`);
    return null; // caller should pause polling until reset
  }

  const base     = nextPollIntervalMs ?? cfg.POLL_INTERVAL_MS;
  const interval = Math.max(base, optimalMs);

  if (optimalMs > base + 2000) {
    logWarn(`Quota low: ${remaining} units left, ~${maxCalls} calls, ${hoursLeft}h until reset. Slowing poll to ${Math.round(interval / 1000)}s.`);
  }

  return interval;
}

// ── STATE ─────────────────────────────────────────────────────────────────────
let liveChatId           = null;
let nextPageToken        = null;
let nextPollIntervalMs   = null;
let messageHistory       = [];
let isPolling            = false;
let pollTimer            = null;
let currentVideoId       = null;
let autoConnectTimer     = null;
let isSearchingForStream = false;

const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

// ── YOUTUBE CALLS ─────────────────────────────────────────────────────────────
async function findActiveLiveChatId() {
  let res = await youtube.liveBroadcasts.list({
    part: ['snippet', 'status'],
    broadcastStatus: 'active',
    broadcastType: 'all',
    maxResults: 5,
  });
  addQuota(1);

  let items = (res.data.items || []).filter(i => i.snippet?.liveChatId);

  if (items.length === 0) {
    res = await youtube.liveBroadcasts.list({
      part: ['snippet', 'status'],
      broadcastStatus: 'upcoming',
      broadcastType: 'all',
      maxResults: 5,
    });
    addQuota(1);
    items = (res.data.items || []).filter(i => i.snippet?.liveChatId);
  }

  if (items.length === 0) throw new Error('No active stream found on your channel');

  const broadcast = items[0];
  currentVideoId  = broadcast.id;
  return broadcast.snippet.liveChatId;
}

async function fetchMessages() {
  if (!liveChatId) return;

  const params = { part: ['snippet', 'authorDetails'], liveChatId, maxResults: 200 };
  if (nextPageToken) params.pageToken = nextPageToken;

  const res = await youtube.liveChatMessages.list(params);
  addQuota(5);

  nextPageToken = res.data.nextPageToken;
  if (res.data.pollingIntervalMillis) {
    nextPollIntervalMs = Math.max(cfg.POLL_INTERVAL_MS, res.data.pollingIntervalMillis);
  }

  const newMessages = (res.data.items || []).map(item => ({
    id:          item.id,
    author:      item.authorDetails.displayName,
    authorPhoto: item.authorDetails.profileImageUrl,
    isModerator: item.authorDetails.isChatModerator,
    isOwner:     item.authorDetails.isChatOwner,
    isMember:    item.authorDetails.isChatSponsor,
    text:        item.snippet.displayMessage || '',
    timestamp:   item.snippet.publishedAt,
    type:        item.snippet.type,
  }));

  if (newMessages.length > 0) {
    log(`${newMessages.length} message(s) received. Quota used: ${quotaUsed}/${cfg.DAILY_QUOTA_LIMIT}.`);
  }

  messageHistory.push(...newMessages);
  if (messageHistory.length > cfg.HISTORY_SIZE) messageHistory = messageHistory.slice(-cfg.HISTORY_SIZE);
}

// ── POLLING ───────────────────────────────────────────────────────────────────
function startPolling() {
  if (isPolling) return;
  isPolling = true;
  log(`Polling started. Stream: ${currentVideoId}`);

  const tick = async () => {
    if (!isPolling) return;
    try {
      await fetchMessages();
    } catch (e) {
      logErr(`Poll error: ${e.message}`);
      if (e.message?.includes('liveChatEnded')) {
        isPolling = false; liveChatId = null; currentVideoId = null;
        log('Stream ended. Waiting for next stream...');
        scheduleAutoConnect();
        return;
      }
    }

    const interval = getAdaptivePollInterval();
    if (interval === null) {
      isPolling = false;
      return; // quotaResetTimer will resume polling
    }

    const intervalSec = Math.round(interval / 1000);
    if (intervalSec > (cfg.POLL_INTERVAL_MS / 1000) + 2) {
      log(`Next poll in ${intervalSec}s (yt: ${Math.round((nextPollIntervalMs ?? 0) / 1000)}s, quota: ${Math.round(getQuotaInfo().optimalMs / 1000)}s).`);
    }

    pollTimer = setTimeout(tick, interval);
  };

  tick();
}

function stopPolling() {
  isPolling = false;
  nextPollIntervalMs = null;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  log('Polling stopped.');
}

async function autoConnect() {
  if (isPolling || liveChatId) return;
  isSearchingForStream = true;
  try {
    messageHistory = []; nextPageToken = null;
    log('Searching for active stream...');
    liveChatId = await findActiveLiveChatId();
    isSearchingForStream = false;
    logOk(`Connected to stream: ${currentVideoId}`);
    startPolling();
  } catch (e) {
    isSearchingForStream = false;
    log(`Stream not found (${e.message}). Retry in ${cfg.AUTO_CONNECT_RETRY_MS / 1000}s...`);
    autoConnectTimer = setTimeout(autoConnect, cfg.AUTO_CONNECT_RETRY_MS);
  }
}

function scheduleAutoConnect() {
  if (autoConnectTimer) { clearTimeout(autoConnectTimer); autoConnectTimer = null; }
  autoConnectTimer = setTimeout(autoConnect, cfg.AUTO_CONNECT_RETRY_MS);
}

// ── EXPRESS MIDDLEWARE ────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

function requireAuth(req, res, next) {
  const creds = oauth2Client.credentials;
  if (!creds?.access_token && !creds?.refresh_token) {
    return res.status(401).json({ error: 'Not authorized. Run: node auth.js' });
  }
  next();
}

// ── API ROUTES ────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const creds = oauth2Client.credentials;
  const { remaining, hoursLeft, maxCalls } = getQuotaInfo();
  res.json({
    authorized:  !!(creds?.access_token || creds?.refresh_token),
    connected:   !!liveChatId,
    searching:   isSearchingForStream,
    polling:     isPolling,
    videoId:     currentVideoId,
    tokenExpiry: creds?.expiry_date ? new Date(creds.expiry_date).toLocaleTimeString('uk-UA') : null,
    quota: {
      used:      quotaUsed,
      limit:     cfg.DAILY_QUOTA_LIMIT,
      remaining,
      maxCalls,
      resetInH:  hoursLeft,
    },
  });
});

app.get('/auth/start', (req, res) => {
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: cfg.SCOPES, prompt: 'consent' });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2>Error: ${error}</h2>`);
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    logOk('OAuth callback: tokens saved.');
    res.send(`<html><body style="font-family:sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center"><div><div style="font-size:48px">✅</div><h2>Authorization successful!</h2><script>setTimeout(()=>window.close(),2000)</script></div></body></html>`);
  } catch (e) {
    logErr(`OAuth callback error: ${e.message}`);
    res.send(`<h2>Error: ${e.message}</h2>`);
  }
});

app.get('/api/auth/status', (req, res) => {
  const creds = oauth2Client.credentials;
  res.json({ authorized: !!(creds?.access_token || creds?.refresh_token) });
});

app.get('/api/auth/logout', (req, res) => {
  stopPolling();
  oauth2Client.setCredentials({});
  try { fs.unlinkSync(TOKEN_PATH); } catch {}
  liveChatId = null; currentVideoId = null;
  logWarn('Logged out and tokens cleared.');
  res.json({ ok: true });
});

app.get('/api/connect', requireAuth, async (req, res) => {
  try {
    stopPolling();
    messageHistory = []; nextPageToken = null;
    liveChatId = await findActiveLiveChatId();
    startPolling();
    logOk(`Manual connect: ${currentVideoId}`);
    res.json({ ok: true, liveChatId, videoId: currentVideoId });
  } catch (e) {
    logErr(`Connect failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Timestamp-based feed — pass ?since=<unix_ms> to get only newer messages.
// Omit (or since=0) to seed with the last 10 messages from history.
app.get('/api/messages', requireAuth, (req, res) => {
  const since    = parseInt(req.query.since ?? 0, 10);
  const messages = since > 0
    ? messageHistory.filter(m => new Date(m.timestamp).getTime() > since)
    : messageHistory.slice(-10);
  res.json({ messages, connected: !!liveChatId, searching: isSearchingForStream, videoId: currentVideoId });
});

app.get('/api/history', requireAuth, (req, res) => {
  res.json({ messages: messageHistory });
});

app.get('/api/settings', (req, res) => {
  res.json(loadSettings(req.query.profile || 'default'));
});

app.post('/api/settings', (req, res) => {
  const profile = req.query.profile || 'default';
  const current = loadSettings(profile);
  const updated = { ...current, ...req.body };
  saveSettings(profile, updated);
  res.json(updated);
});

app.get('/api/disconnect', (req, res) => {
  stopPolling();
  if (autoConnectTimer) { clearTimeout(autoConnectTimer); autoConnectTimer = null; }
  isSearchingForStream = false;
  liveChatId = null; nextPageToken = null; messageHistory = []; currentVideoId = null;
  res.json({ ok: true });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(cfg.PORT, () => {
  console.log(`\n  ✓ YT Chat Server: http://localhost:${cfg.PORT}`);
  console.log(`  ✓ Overlay:        http://localhost:${cfg.PORT}/index.html\n`);

  scheduleQuotaReset();

  if (!hasTokens) {
    logWarn('No tokens found. Run: node auth.js');
  } else {
    logQuotaEstimate();
    log('Starting auto-connect...');
    autoConnect();
  }
});
