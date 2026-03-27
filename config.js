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
  // Як часто сервер запитує YouTube API (мс). Мінімум 5000.
  POLL_INTERVAL_MS: 5000,

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
