#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  auth.js — Авторизація через Google + перевірка токенів
//
//  Використання:
//    node auth.js          ← перевірити статус + авторизуватись якщо треба
//    node auth.js --status ← тільки перевірити статус (без відкриття браузера)
//    node auth.js --reset  ← видалити токени і авторизуватись заново
// ═══════════════════════════════════════════════════════════════

const { google }   = require('googleapis');
const express      = require('express');
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');
const cfg          = require('./config');

const TOKEN_PATH = path.join(__dirname, cfg.TOKEN_FILE);
const args       = process.argv.slice(2);
const MODE_STATUS = args.includes('--status');
const MODE_RESET  = args.includes('--reset');

// ── КОЛЬОРИ для консолі ───────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  blue:   '\x1b[36m',
  orange: '\x1b[33m',
};
const ok   = (s) => console.log(`${c.green}  ✓ ${c.reset}${s}`);
const warn = (s) => console.log(`${c.yellow}  ⚠ ${c.reset}${s}`);
const err  = (s) => console.log(`${c.red}  ✗ ${c.reset}${s}`);
const info = (s) => console.log(`${c.blue}  → ${c.reset}${s}`);
const hr   = ()  => console.log(`${c.dim}${'─'.repeat(52)}${c.reset}`);

// ── OAUTH CLIENT ──────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  cfg.CLIENT_ID,
  cfg.CLIENT_SECRET,
  cfg.REDIRECT_URI,
);

// ── ЗАВАНТАЖИТИ ТОКЕНИ ────────────────────────────────────────
function loadTokens() {
  try {
    const raw    = fs.readFileSync(TOKEN_PATH, 'utf8');
    const tokens = JSON.parse(raw);
    return tokens;
  } catch {
    return null;
  }
}

// ── ЗБЕРЕГТИ ТОКЕНИ ───────────────────────────────────────────
function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
}

// ── ПЕРЕВІРИТИ СТАТУС ТОКЕНІВ ─────────────────────────────────
async function checkTokenStatus(tokens) {
  if (!tokens) return { valid: false, reason: 'no_tokens' };

  const hasRefresh = !!tokens.refresh_token;
  const hasAccess  = !!tokens.access_token;

  if (!hasRefresh && !hasAccess) {
    return { valid: false, reason: 'empty' };
  }

  // Перевіряємо чи не прострочений access_token
  const now       = Date.now();
  const expiresAt = tokens.expiry_date || 0;
  const expired   = expiresAt > 0 && now >= expiresAt - 60_000; // -1хв буфер

  if (expired && !hasRefresh) {
    return { valid: false, reason: 'expired_no_refresh' };
  }

  if (expired && hasRefresh) {
    // Спробуємо оновити через refresh_token
    try {
      oauth2Client.setCredentials(tokens);
      const { credentials } = await oauth2Client.refreshAccessToken();
      const merged = { ...tokens, ...credentials };
      saveTokens(merged);
      return { valid: true, reason: 'refreshed', tokens: merged };
    } catch (e) {
      return { valid: false, reason: 'refresh_failed', detail: e.message };
    }
  }

  // Верифікуємо через tokeninfo endpoint
  try {
    oauth2Client.setCredentials(tokens);
    const tokenInfo = await oauth2Client.getTokenInfo(tokens.access_token);
    return {
      valid:     true,
      reason:    'ok',
      email:     tokenInfo.email,
      expiresAt: new Date(expiresAt).toLocaleTimeString('uk-UA'),
      scopes:    tokenInfo.scopes,
    };
  } catch (e) {
    // access_token не валідний, але є refresh_token — спробуємо оновити
    if (hasRefresh) {
      try {
        oauth2Client.setCredentials(tokens);
        const { credentials } = await oauth2Client.refreshAccessToken();
        const merged = { ...tokens, ...credentials };
        saveTokens(merged);
        return { valid: true, reason: 'refreshed', tokens: merged };
      } catch (e2) {
        return { valid: false, reason: 'refresh_failed', detail: e2.message };
      }
    }
    return { valid: false, reason: 'invalid', detail: e.message };
  }
}

// ── ВИВЕСТИ СТАТУС В КОНСОЛЬ ──────────────────────────────────
async function printStatus() {
  console.log();
  console.log(`${c.bold}  YT Live Chat — Статус авторизації${c.reset}`);
  hr();

  // Перевірити конфіг
  if (cfg.CLIENT_ID === 'YOUR_CLIENT_ID_HERE') {
    err('CLIENT_ID не налаштовано в config.js');
    info('Відкрий config.js і встав свої дані з Google Cloud Console');
    return { configured: false };
  }
  ok('config.js — CLIENT_ID знайдено');

  // Перевірити токени
  const tokens = loadTokens();
  if (!tokens) {
    warn('tokens.json не знайдено → авторизація потрібна');
    return { configured: true, authorized: false };
  }

  ok(`tokens.json знайдено`);

  const status = await checkTokenStatus(tokens);

  if (!status.valid) {
    const reasons = {
      empty:              'Файл токенів порожній',
      expired_no_refresh: 'Токен прострочений, refresh_token відсутній',
      refresh_failed:     `Не вдалось оновити токен: ${status.detail}`,
      invalid:            `Токен недійсний: ${status.detail}`,
    };
    err(reasons[status.reason] || `Токен недійсний (${status.reason})`);
    return { configured: true, authorized: false };
  }

  if (status.reason === 'refreshed') {
    ok('Токен оновлено автоматично (через refresh_token)');
  } else {
    ok('Токен дійсний');
  }

  if (status.email)     ok(`Акаунт: ${c.bold}${status.email}${c.reset}`);
  if (status.expiresAt) info(`Access token діє до: ${status.expiresAt}`);

  hr();
  return { configured: true, authorized: true, email: status.email };
}

// ── ВІДКРИТИ БРАУЗЕР ──────────────────────────────────────────
function openBrowser(url) {
  try {
    // Windows
    execSync(`start "" "${url}"`, { stdio: 'ignore' });
  } catch {
    try {
      // Mac
      execSync(`open "${url}"`, { stdio: 'ignore' });
    } catch {
      // Linux
      try { execSync(`xdg-open "${url}"`, { stdio: 'ignore' }); } catch {}
    }
  }
}

// ── OAUTH FLOW ────────────────────────────────────────────────
async function runAuthFlow() {
  const authApp  = express();
  let   server   = null;

  return new Promise((resolve, reject) => {
    // Тимчасовий сервер тільки для callback
    authApp.get('/auth/callback', async (req, res) => {
      const { code, error } = req.query;

      if (error) {
        res.send(htmlResult(false, `Помилка: ${error}`));
        server.close();
        reject(new Error(error));
        return;
      }

      try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        saveTokens(tokens);

        res.send(htmlResult(true));
        ok('Авторизація успішна!');

        // Перевіряємо email
        try {
          const info = await oauth2Client.getTokenInfo(tokens.access_token);
          ok(`Акаунт: ${c.bold}${info.email}${c.reset}`);
        } catch {}

        server.close();
        resolve(tokens);
      } catch (e) {
        res.send(htmlResult(false, e.message));
        server.close();
        reject(e);
      }
    });

    server = authApp.listen(cfg.PORT, () => {
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope:       cfg.SCOPES,
        prompt:      'consent',
      });

      console.log();
      info('Відкриваємо браузер для авторизації...');
      info(`Якщо браузер не відкрився, перейди вручну:`);
      console.log(`${c.dim}  ${authUrl}${c.reset}`);
      console.log();

      openBrowser(authUrl);
    }).on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        err(`Порт ${cfg.PORT} зайнятий. Зупини server.js або вкажи інший PORT в config.js`);
      } else {
        err(e.message);
      }
      reject(e);
    });

    // Таймаут 3 хвилини
    setTimeout(() => {
      server.close();
      reject(new Error('Timeout: авторизація не завершена за 3 хвилини'));
    }, 3 * 60 * 1000);
  });
}

// ── HTML для сторінки після авторизації ──────────────────────
function htmlResult(success, errMsg = '') {
  const icon = success ? '✅' : '❌';
  const text = success ? 'Авторизація успішна! Можеш закрити це вікно.' : `Помилка: ${errMsg}`;
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#111;color:#eee;
    display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">
    <div><div style="font-size:48px">${icon}</div><h2>${text}</h2>
    ${success ? '<script>setTimeout(()=>window.close(),2000)</script>' : ''}
    </div></body></html>`;
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  if (MODE_RESET) {
    try { fs.unlinkSync(TOKEN_PATH); ok('tokens.json видалено'); } catch {}
    console.log();
  }

  const status = await printStatus();
  hr();

  if (MODE_STATUS) {
    // Тільки статус — виходимо
    process.exit(status.authorized ? 0 : 1);
  }

  if (!status.configured) {
    console.log();
    err('Спочатку налаштуй config.js');
    process.exit(1);
  }

  if (status.authorized) {
    ok('Все готово! Можна запускати server.js');
    console.log();
    process.exit(0);
  }

  // Потрібна авторизація
  console.log();
  warn('Потрібна авторизація. Запускаємо OAuth flow...');
  hr();

  try {
    await runAuthFlow();
    console.log();
    ok('Все готово! Тепер можна запускати server.js');
    console.log();
    process.exit(0);
  } catch (e) {
    console.log();
    err(`Авторизація не вдалась: ${e.message}`);
    process.exit(1);
  }
}

main();
