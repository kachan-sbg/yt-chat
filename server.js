const express    = require('express');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const http       = require('http');
const { WebSocketServer } = require('ws');
const { google } = require('googleapis');
const cfg        = require('./config');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

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

function hasCredentials() {
  const c = oauth2Client.credentials;
  return !!(c?.access_token || c?.refresh_token);
}

// ── STATE ─────────────────────────────────────────────────────────────────────
// Quota
let quotaUsed       = 0;
let quotaLog        = []; // { action, units, ts }[]
let quotaResetTimer = null;
// Polling
let liveChatId           = null;
let nextPageToken        = null;
let nextPollIntervalMs   = null;
let messageHistory       = [];
let isPolling            = false;
let isStreamLive         = false; // false = scheduled/upcoming, true = actively broadcasting
let pollTimer            = null;
let currentVideoId       = null;
let autoConnectTimer     = null;
let isSearchingForStream = false;
// WebSocket clients
const wsClients = new Set();

const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

// ── QUOTA TRACKING ────────────────────────────────────────────────────────────
// Quota resets daily at midnight Pacific Time ≈ 08:00 UTC.
// Costs: liveChatMessages.list = 5 units, liveBroadcasts.list = 1 unit.

const QUOTA_STATE_PATH = path.join(__dirname, 'quota-state.json');

function quotaDateKey() {
  // Approximate Pacific Time date (UTC-8; good enough for reset-day tracking)
  const d = new Date(Date.now() - 8 * 3600_000);
  return d.toISOString().slice(0, 10); // "2026-03-31"
}

function loadQuotaState() {
  try {
    const data = JSON.parse(fs.readFileSync(QUOTA_STATE_PATH, 'utf8'));
    if (data.date === quotaDateKey()) {
      quotaUsed = data.used || 0;
      quotaLog  = data.log  || [];
      logOk(`Quota restored: ${quotaUsed}/${cfg.DAILY_QUOTA_LIMIT} units used today.`);
    } else {
      logOk('New quota day — counter reset.');
      saveQuotaState();
    }
  } catch { /* no state file yet, start fresh */ }
}

function saveQuotaState() {
  try {
    fs.writeFileSync(QUOTA_STATE_PATH, JSON.stringify({
      date: quotaDateKey(),
      used: quotaUsed,
      log:  quotaLog.slice(-2000),
    }, null, 2));
  } catch (e) {
    logErr(`Failed to save quota state: ${e.message}`);
  }
}

function getMsUntilQuotaReset() {
  const now = Date.now();
  const d   = new Date(now);
  let reset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 0, 0, 0);
  if (reset <= now) reset += 86_400_000;
  return reset - now;
}

function scheduleQuotaReset() {
  if (quotaResetTimer) clearTimeout(quotaResetTimer);
  const ms = getMsUntilQuotaReset();
  quotaResetTimer = setTimeout(() => {
    quotaUsed = 0;
    quotaLog  = [];
    saveQuotaState();
    logOk(`Quota reset. Daily limit (${cfg.DAILY_QUOTA_LIMIT} units) restored.`);
    broadcastStatus();
    scheduleQuotaReset();
    if (wsClients.size > 0 && liveChatId && !isPolling) {
      log('Resuming polling after quota reset...');
      startPolling();
    }
  }, ms);
}

// action: 'poll' | 'search' | 'connect'
function addQuota(units, action) {
  quotaUsed += units;
  quotaLog.push({ action, units, ts: new Date().toISOString() });
  saveQuotaState();
}

function getQuotaStats() {
  const stats = {};
  for (const { action, units } of quotaLog) {
    if (!stats[action]) stats[action] = { calls: 0, units: 0 };
    stats[action].calls++;
    stats[action].units += units;
  }
  return stats;
}

function getQuotaInfo() {
  const remaining  = cfg.DAILY_QUOTA_LIMIT - quotaUsed;
  const msLeft     = getMsUntilQuotaReset();
  const hoursLeft  = Math.round(msLeft / 360_000) / 10;
  const maxCalls   = Math.floor(remaining / 5);
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
    logWarn('Quota may run out before reset! Consider raising POLL_INTERVAL_MS in config.js.');
  }
}

function getAdaptivePollInterval() {
  const { remaining, hoursLeft, maxCalls, optimalMs } = getQuotaInfo();

  if (remaining < 5) {
    logWarn(`Quota exhausted (${quotaUsed}/${cfg.DAILY_QUOTA_LIMIT}). Polling paused. Resets in ${hoursLeft}h.`);
    return null;
  }

  const minInterval = isStreamLive ? cfg.POLL_INTERVAL_MS : cfg.SCHEDULED_POLL_INTERVAL_MS;
  const base     = nextPollIntervalMs ?? minInterval;
  const interval = Math.max(base, optimalMs, minInterval);

  if (optimalMs > base + 2000) {
    logWarn(`Quota low: ${remaining} units left, ~${maxCalls} calls, ${hoursLeft}h until reset. Slowing poll to ${Math.round(interval / 1000)}s.`);
  }

  return interval;
}

// ── STATUS PAYLOAD ────────────────────────────────────────────────────────────
function buildStatusPayload() {
  const creds = oauth2Client.credentials;
  const { remaining, hoursLeft, maxCalls } = getQuotaInfo();
  return {
    authorized:  !!(creds?.access_token || creds?.refresh_token),
    connected:   !!liveChatId,
    streamLive:  isStreamLive,
    searching:   isSearchingForStream,
    polling:     isPolling,
    videoId:     currentVideoId,
    clients:     wsClients.size,
    tokenExpiry: creds?.expiry_date ? new Date(creds.expiry_date).toLocaleTimeString('uk-UA') : null,
    quota: {
      used:     quotaUsed,
      limit:    cfg.DAILY_QUOTA_LIMIT,
      remaining,
      maxCalls,
      resetInH: hoursLeft,
      stats:    getQuotaStats(),
    },
  };
}

// ── WEBSOCKET ─────────────────────────────────────────────────────────────────
function broadcast(data) {
  if (wsClients.size === 0) return;
  const msg = JSON.stringify(data);
  for (const ws of wsClients) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(msg);
    } else {
      wsClients.delete(ws);
    }
  }
}

function broadcastStatus() {
  broadcast({ type: 'status', ...buildStatusPayload() });
}

wss.on('connection', (ws) => {
  wsClients.add(ws);
  log(`WS client connected (${wsClients.size} total)`);

  // Send current state immediately to the new client
  ws.send(JSON.stringify({ type: 'status', ...buildStatusPayload() }));

  // Trigger auto-connect if authorized and idle
  if (hasCredentials() && !isPolling && !liveChatId && !isSearchingForStream && !autoConnectTimer) {
    log('Client connected — starting auto-connect...');
    autoConnect();
  }

  ws.on('close', () => {
    wsClients.delete(ws);
    log(`WS client disconnected (${wsClients.size} remaining)`);
    if (wsClients.size === 0) {
      stopPolling();
      if (autoConnectTimer) { clearTimeout(autoConnectTimer); autoConnectTimer = null; }
      isSearchingForStream = false;
      log('No clients — polling paused to save quota.');
    }
  });

  ws.on('error', () => wsClients.delete(ws));
});

// ── YOUTUBE CALLS ─────────────────────────────────────────────────────────────
async function findActiveLiveChatId(action = 'search') {
  let res = await youtube.liveBroadcasts.list({
    part: ['snippet', 'status'],
    broadcastStatus: 'active',
    broadcastType: 'all',
    maxResults: 5,
  });
  addQuota(1, action);

  let items = (res.data.items || []).filter(i => i.snippet?.liveChatId);
  let foundLive = items.length > 0;

  if (items.length === 0) {
    res = await youtube.liveBroadcasts.list({
      part: ['snippet', 'status'],
      broadcastStatus: 'upcoming',
      broadcastType: 'all',
      maxResults: 5,
    });
    addQuota(1, action);
    items = (res.data.items || []).filter(i => i.snippet?.liveChatId);
  }

  if (items.length === 0) throw new Error('No active stream found on your channel');

  const broadcast = items[0];
  currentVideoId  = broadcast.id;
  isStreamLive    = foundLive;
  if (!isStreamLive) log('Connected to scheduled (upcoming) stream — using slow poll until live.');
  return broadcast.snippet.liveChatId;
}

async function checkIfStreamWentLive() {
  if (!currentVideoId) return;
  try {
    const res = await youtube.liveBroadcasts.list({ part: ['status'], id: [currentVideoId] });
    addQuota(1, 'status');
    const status = res.data.items?.[0]?.status?.lifeCycleStatus;
    if (status === 'live' || status === 'liveStarting') {
      isStreamLive = true;
      logOk('Stream is now live — switching to normal poll interval.');
      broadcastStatus();
    }
  } catch (e) {
    logErr(`Status check failed: ${e.message}`);
  }
}

async function fetchMessages() {
  if (!liveChatId) return;

  const params = { part: ['snippet', 'authorDetails'], liveChatId, maxResults: 200 };
  if (nextPageToken) params.pageToken = nextPageToken;

  const res = await youtube.liveChatMessages.list(params);
  addQuota(5, 'poll');

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
    broadcast({ type: 'messages', messages: newMessages });
  }

  messageHistory.push(...newMessages);
  if (messageHistory.length > cfg.HISTORY_SIZE) messageHistory = messageHistory.slice(-cfg.HISTORY_SIZE);

  broadcastStatus();
}

// ── POLLING ───────────────────────────────────────────────────────────────────
function startPolling() {
  if (isPolling) return;
  isPolling = true;
  log(`Polling started. Stream: ${currentVideoId}`);

  const tick = async () => {
    if (!isPolling) return;
    try {
      if (!isStreamLive) await checkIfStreamWentLive();
      await fetchMessages();
    } catch (e) {
      logErr(`Poll error: ${e.message}`);
      if (e.message?.includes('liveChatEnded')) {
        isPolling = false; liveChatId = null; currentVideoId = null; isStreamLive = false;
        log('Stream ended. Waiting for next stream...');
        broadcastStatus();
        if (wsClients.size > 0) scheduleAutoConnect();
        return;
      }
    }

    const interval = getAdaptivePollInterval();
    if (interval === null) {
      isPolling = false;
      broadcastStatus();
      return; // quotaResetTimer will resume
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
  broadcastStatus();
  try {
    messageHistory = []; nextPageToken = null;
    log('Searching for active stream...');
    liveChatId = await findActiveLiveChatId('search');
    isSearchingForStream = false;
    logOk(`Connected to stream: ${currentVideoId}`);
    broadcastStatus();
    startPolling();
  } catch (e) {
    isSearchingForStream = false;
    log(`Stream not found (${e.message}). Retry in ${cfg.AUTO_CONNECT_RETRY_MS / 1000}s...`);
    broadcastStatus();
    if (wsClients.size > 0) {
      autoConnectTimer = setTimeout(autoConnect, cfg.AUTO_CONNECT_RETRY_MS);
    } else {
      log('No clients connected — auto-connect search stopped.');
    }
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
  res.json(buildStatusPayload());
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
    broadcastStatus();
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
  broadcastStatus();
  res.json({ ok: true });
});

app.get('/api/connect', requireAuth, async (req, res) => {
  try {
    stopPolling();
    messageHistory = []; nextPageToken = null;
    liveChatId = await findActiveLiveChatId('connect');
    startPolling();
    logOk(`Manual connect: ${currentVideoId}`);
    broadcastStatus();
    res.json({ ok: true, liveChatId, videoId: currentVideoId });
  } catch (e) {
    logErr(`Connect failed: ${e.message}`);
    broadcastStatus();
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/messages', requireAuth, (req, res) => {
  res.json({ messages: messageHistory, connected: !!liveChatId, searching: isSearchingForStream, videoId: currentVideoId });
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
  liveChatId = null; nextPageToken = null; messageHistory = []; currentVideoId = null; isStreamLive = false;
  broadcastStatus();
  res.json({ ok: true });
});

// ── START ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  server.listen(cfg.PORT, () => {
    console.log(`\n  ✓ YT Chat Server: http://localhost:${cfg.PORT}`);
    console.log(`  ✓ Overlay:        http://localhost:${cfg.PORT}/index.html\n`);

    loadQuotaState();
    scheduleQuotaReset();

    if (!hasTokens) {
      logWarn('No tokens found. Run: node auth.js');
    } else {
      logQuotaEstimate();
      log('Ready. Polling starts when overlay connects via WebSocket.');
    }
  });
}

module.exports = { app, server, wss };
