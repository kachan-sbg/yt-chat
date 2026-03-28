// ═══════════════════════════════════════════════════════════════
//  YT LIVE CHAT — КОНФІГУРАЦІЯ
//  Заповни CLIENT_ID і CLIENT_SECRET у config.local.js
//  (скопіюй config.local.example.js → config.local.js)
// ═══════════════════════════════════════════════════════════════

// Credentials live in config.local.js (gitignored)
let local = {};
try { local = require('./config.local'); } catch {}

module.exports = {

  // ── Google OAuth ──────────────────────────────────────────────
  CLIENT_ID:     local.CLIENT_ID     || 'YOUR_CLIENT_ID_HERE',
  CLIENT_SECRET: local.CLIENT_SECRET || 'YOUR_CLIENT_SECRET_HERE',

  // ── Сервер ────────────────────────────────────────────────────
  PORT: 3456,

  // ── YouTube polling ───────────────────────────────────────────
  // Minimum interval between YouTube API requests (ms).
  // YouTube also returns pollingIntervalMillis in each response;
  // the server uses MAX(this value, YouTube's recommendation, quota-safe interval).
  // liveChatMessages.list costs 5 quota units. At 10s: ~4320 calls/day × 5 = ~21600 units
  // which exceeds the default 10000/day limit, so the adaptive logic will slow it down.
  POLL_INTERVAL_MS: 10_000,

  // Daily YouTube Data API v3 quota limit (units). Default project quota is 10 000.
  // Increase this if you have requested a higher quota in Google Cloud Console.
  DAILY_QUOTA_LIMIT: 10_000,

  // Як часто шукати активний стрім якщо він ще не запущений (мс).
  AUTO_CONNECT_RETRY_MS: 30_000,

  // ── Overlay ───────────────────────────────────────────────────
  // Максимум повідомлень на екрані (старіші видаляються)
  MAX_MESSAGES_ON_SCREEN: 80,

  // Скільки останніх повідомлень зберігати для нових підключень
  HISTORY_SIZE: 10,

  // ── Шляхи (не змінювати якщо не переносиш папку) ─────────────
  TOKEN_FILE: 'tokens.json',

  // ── OAuth scopes ──────────────────────────────────────────────
  SCOPES: [
    'https://www.googleapis.com/auth/youtube.readonly',
  ],

  // Redirect URI — має збігатись з Google Cloud Console
  get REDIRECT_URI() {
    return `http://localhost:${this.PORT}/auth/callback`;
  },
};
