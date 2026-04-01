# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A YouTube Live Chat overlay tool for OBS. It runs a local Express server that polls the YouTube Data API v3 for live chat messages and serves a browser-source overlay page.

## Commands

```bash
# Install dependencies
npm install

# First-time auth (opens browser for Google OAuth)
node auth.js
# or via shell script:
./start.sh auth

# Start server (foreground)
npm start

# Start server (background, with logging)
./start.sh

# Other shell script commands
./start.sh stop        # stop background server
./start.sh status      # check server + auth + connection status
./start.sh logs        # tail server.log
./start.sh startup     # add macOS LaunchAgent autostart
./start.sh nostartup   # remove autostart
```

Server runs on port **3456** (set in `config.js`).

## Architecture

Four files form the core:

- **`config.js`** — all configuration: OAuth credentials, port, poll interval, token file path, OAuth scopes, redirect URI. Edit this to change any setting. Key values: `POLL_INTERVAL_MS` (default 10s), `DAILY_QUOTA_LIMIT` (default 10000), `AUTO_CONNECT_RETRY_MS` (default 30s).
- **`server.js`** — Express + WebSocket server. Manages OAuth2 tokens, polls YouTube `liveChatMessages.list`, persists quota state to disk, and pushes messages to connected overlay clients via WebSocket.
- **`index.html`** — Single-file frontend. Connects via WebSocket (`ws://localhost:3456/ws`) to receive pushed messages and status updates. No polling, no build step.
- **`auth.js`** — Standalone CLI for Google OAuth flow. Spins up a temporary Express server on the same port to handle the OAuth callback, then exits.

### WebSocket (`ws://localhost:3456/ws`)

The overlay connects via WebSocket instead of REST polling. This is the primary real-time channel.

**Server → client messages:**
- `{ type: 'status', authorized, connected, searching, polling, videoId, clients, quota: { used, limit, remaining, resetInH, stats } }` — sent on every state change and after each poll tick
- `{ type: 'messages', messages: [...] }` — pushed when new chat messages arrive

**Client-gated polling:** the server only polls YouTube and runs auto-connect while at least one WebSocket client is connected. When all clients disconnect (e.g. OBS scene switches away), polling stops automatically — saving quota during testing or when not streaming.

### Quota tracking

- **Cost:** `liveChatMessages.list` = 5 units/call, `liveBroadcasts.list` = 1 unit/call.
- **Persistence:** quota usage is saved to `quota-state.json` on every API call. Server restarts restore the counter so the adaptive throttle keeps working correctly.
- **Per-action stats:** each call is logged with an `action` label: `'poll'` (chat messages), `'search'` (auto-connect scan), `'connect'` (manual connect button). Aggregated stats are returned in `/api/status` and every WS status message.
- **Adaptive throttle:** `getAdaptivePollInterval()` computes `MAX(POLL_INTERVAL_MS, YouTube's pollingIntervalMillis, quota-safe interval)`. When quota is low it slows polling; when exhausted it pauses until the daily reset.
- **Daily reset:** midnight Pacific Time ≈ 08:00 UTC. `quota-state.json` is cleared automatically.

### API endpoints

| Endpoint | Description |
|---|---|
| `GET /api/status` | Auth + connection state + quota stats |
| `GET /api/connect` | Find active broadcast and start polling |
| `GET /api/messages` | Ring buffer read (REST fallback, not used by frontend) |
| `GET /api/disconnect` | Stop polling and cancel auto-connect |
| `GET /auth/start` | Redirect to Google OAuth consent |
| `GET /auth/callback` | OAuth callback, saves `tokens.json` |
| `GET /api/auth/logout` | Clear credentials and tokens |
| `GET /api/settings?profile=` | Load overlay settings |
| `POST /api/settings?profile=` | Save overlay settings |

### OBS usage

Add a Browser Source pointing to `http://localhost:3456/index.html`. Profiles via `?profile=`:
- (none) — default overlay with control panel
- `?profile=obs` — overlay only, no panel, no status bar
- `?profile=streamer` — compact inline layout for streamer monitor

The WebSocket connection from the browser source is what activates polling. No `?autoconnect=1` param needed — opening the page is enough.

### Token handling

`tokens.json` stores OAuth credentials. The server auto-refreshes via `oauth2Client.on('tokens', ...)` and merges new tokens while preserving the `refresh_token`. `auth.js` must be run before `server.js` on first use, and again if tokens become invalid.

**Credentials** live in `config.local.js` (gitignored). `config.js` loads them via `require('./config.local')` and falls back to placeholder strings. `config.local.example.js` is the committed template.

### Key state variables in `server.js`

| Variable | Purpose |
|---|---|
| `quotaUsed` / `quotaLog` | Daily quota counter + per-call log (persisted to `quota-state.json`) |
| `wsClients` | Set of open WebSocket connections |
| `liveChatId` | Active chat ID from YouTube; `null` when not connected |
| `isPolling` | Whether the poll timer loop is running |
| `isSearchingForStream` | Whether `autoConnect()` is currently searching |
| `nextPollIntervalMs` | YouTube's recommended interval from last API response |
| `autoConnectTimer` | Pending `setTimeout` for next auto-connect retry |
