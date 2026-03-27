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

const oauth2Client = new google.auth.OAuth2(
  cfg.CLIENT_ID,
  cfg.CLIENT_SECRET,
  cfg.REDIRECT_URI,
);

const TOKEN_PATH    = path.join(__dirname, cfg.TOKEN_FILE);
const SETTINGS_PATH = path.join(__dirname, 'settings.json');

const DEFAULT_SETTINGS = { opacity: 0.08, blur: 3, fontSize: 'normal' };

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}

function saveSettings(data) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2));
}

function loadTokens() {
  try {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oauth2Client.setCredentials(tokens);
    console.log('  ✓ Токени завантажено');
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
  console.log('  ✓ Токени оновлено автоматично');
});

const hasTokens = loadTokens();

let liveChatId           = null;
let nextPageToken        = null;
let messageBuffer        = [];
let messageHistory       = [];
let isPolling            = false;
let pollTimer            = null;
let currentVideoId       = null;
let autoConnectTimer     = null;
let isSearchingForStream = false;

const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

async function findActiveLiveChatId() {
  let res = await youtube.liveBroadcasts.list({
    part: ['snippet', 'status'],
    broadcastStatus: 'active',
    broadcastType: 'all',
    maxResults: 5,
  });
  let items = (res.data.items || []).filter(i => i.snippet?.liveChatId);

  if (items.length === 0) {
    res = await youtube.liveBroadcasts.list({
      part: ['snippet', 'status'],
      broadcastStatus: 'upcoming',
      broadcastType: 'all',
      maxResults: 5,
    });
    items = (res.data.items || []).filter(i => i.snippet?.liveChatId);
  }

  if (items.length === 0) throw new Error('Активний стрім не знайдено на твоєму каналі');

  const broadcast = items[0];
  currentVideoId  = broadcast.id;
  return broadcast.snippet.liveChatId;
}

async function fetchMessages() {
  if (!liveChatId) return;
  const params = {
    part: ['snippet', 'authorDetails'],
    liveChatId,
    maxResults: 200,
  };
  if (nextPageToken) params.pageToken = nextPageToken;

  const res = await youtube.liveChatMessages.list(params);
  nextPageToken = res.data.nextPageToken;

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

  messageBuffer.push(...newMessages);
  if (messageBuffer.length > 500) messageBuffer = messageBuffer.slice(-500);

  messageHistory.push(...newMessages);
  if (messageHistory.length > cfg.HISTORY_SIZE) messageHistory = messageHistory.slice(-cfg.HISTORY_SIZE);
}

function startPolling() {
  if (isPolling) return;
  isPolling = true;
  const tick = async () => {
    if (!isPolling) return;
    try {
      await fetchMessages();
    } catch (e) {
      console.error('  [Poll]', e.message);
      if (e.message?.includes('liveChatEnded')) {
        isPolling = false; liveChatId = null; currentVideoId = null;
        console.log('  → Стрім завершився. Очікування наступного...');
        scheduleAutoConnect();
        return;
      }
    }
    pollTimer = setTimeout(tick, cfg.POLL_INTERVAL_MS);
  };
  tick();
}

function stopPolling() {
  isPolling = false;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

async function autoConnect() {
  if (isPolling || liveChatId) return;
  isSearchingForStream = true;
  try {
    messageBuffer = []; messageHistory = []; nextPageToken = null;
    liveChatId = await findActiveLiveChatId();
    isSearchingForStream = false;
    startPolling();
    console.log(`  ✓ Авто-підключення: ${currentVideoId}`);
  } catch {
    autoConnectTimer = setTimeout(autoConnect, cfg.AUTO_CONNECT_RETRY_MS);
  }
}

function scheduleAutoConnect() {
  if (autoConnectTimer) { clearTimeout(autoConnectTimer); autoConnectTimer = null; }
  autoConnectTimer = setTimeout(autoConnect, cfg.AUTO_CONNECT_RETRY_MS);
}

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

function requireAuth(req, res, next) {
  const creds = oauth2Client.credentials;
  if (!creds?.access_token && !creds?.refresh_token) {
    return res.status(401).json({ error: 'Не авторизовано. Запусти: node auth.js' });
  }
  next();
}

app.get('/api/status', (req, res) => {
  const creds = oauth2Client.credentials;
  res.json({
    authorized:  !!(creds?.access_token || creds?.refresh_token),
    connected:   !!liveChatId,
    searching:   isSearchingForStream,
    polling:     isPolling,
    videoId:     currentVideoId,
    tokenExpiry: creds?.expiry_date ? new Date(creds.expiry_date).toLocaleTimeString('uk-UA') : null,
  });
});

app.get('/auth/start', (req, res) => {
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: cfg.SCOPES, prompt: 'consent' });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2>Помилка: ${error}</h2>`);
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    res.send(`<html><body style="font-family:sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center"><div><div style="font-size:48px">✅</div><h2>Авторизація успішна!</h2><script>setTimeout(()=>window.close(),2000)</script></div></body></html>`);
  } catch (e) {
    res.send(`<h2>Помилка: ${e.message}</h2>`);
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
  res.json({ ok: true });
});

app.get('/api/connect', requireAuth, async (req, res) => {
  try {
    stopPolling();
    messageBuffer = []; nextPageToken = null;
    liveChatId = await findActiveLiveChatId();
    startPolling();
    console.log(`  ✓ Підключено: ${currentVideoId}`);
    res.json({ ok: true, liveChatId, videoId: currentVideoId });
  } catch (e) {
    console.error('  ✗', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/messages', requireAuth, (req, res) => {
  const messages = [...messageBuffer];
  messageBuffer  = [];
  res.json({ messages, connected: !!liveChatId, videoId: currentVideoId });
});

app.get('/api/history', requireAuth, (req, res) => {
  res.json({ messages: messageHistory });
});

app.get('/api/settings', (req, res) => {
  res.json(loadSettings());
});

app.post('/api/settings', (req, res) => {
  const current = loadSettings();
  const updated = { ...current, ...req.body };
  saveSettings(updated);
  res.json(updated);
});

app.get('/api/disconnect', (req, res) => {
  stopPolling();
  if (autoConnectTimer) { clearTimeout(autoConnectTimer); autoConnectTimer = null; }
  isSearchingForStream = false;
  liveChatId = null; nextPageToken = null; messageBuffer = []; currentVideoId = null;
  res.json({ ok: true });
});

app.listen(cfg.PORT, () => {
  console.log(`\n  ✓ YT Chat Server: http://localhost:${cfg.PORT}`);
  console.log(`  ✓ Overlay:        http://localhost:${cfg.PORT}/index.html`);
  if (!hasTokens) {
    console.log(`\n  ⚠ Токени не знайдено. Запусти спочатку: node auth.js\n`);
  } else {
    console.log(`\n  → Сервер готовий!\n`);
    autoConnect();
  }
});
