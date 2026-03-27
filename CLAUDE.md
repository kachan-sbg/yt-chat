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

Three files form the core:

- **`config.js`** — all configuration: OAuth credentials, port, poll interval, token file path, OAuth scopes, redirect URI. Edit this to change any setting.
- **`server.js`** — Express server. Manages OAuth2 tokens in memory (loaded from `tokens.json`), polls YouTube `liveChatMessages.list` every `POLL_INTERVAL_MS` ms, buffers up to 500 messages in-memory, and exposes a REST API.
- **`index.html`** — Single-file frontend. Polls `GET /api/messages` every 4 seconds, renders messages as DOM elements, and trims to `MAX_MSGS` on screen. No build step.
- **`auth.js`** — Standalone CLI for Google OAuth flow. Spins up a temporary Express server on the same port to handle the OAuth callback, then exits.

### API endpoints

| Endpoint | Description |
|---|---|
| `GET /api/status` | Auth + connection state |
| `GET /api/connect` | Find active broadcast and start polling |
| `GET /api/messages` | Drain message buffer (destructive read) |
| `GET /api/disconnect` | Stop polling |
| `GET /auth/start` | Redirect to Google OAuth consent |
| `GET /auth/callback` | OAuth callback, saves `tokens.json` |
| `GET /api/auth/logout` | Clear credentials and tokens |

### OBS usage

Add a Browser Source pointing to `http://localhost:3456/index.html`. For overlay-only mode (no control panel), use `?overlay=1`. For auto-connect on OBS scene load, use `?overlay=1&autoconnect=1`.

### Token handling

`tokens.json` stores OAuth credentials. The server auto-refreshes via `oauth2Client.on('tokens', ...)` and merges new tokens while preserving the `refresh_token`. `auth.js` must be run before `server.js` on first use, and again if tokens become invalid.

**Credentials** live in `config.local.js` (gitignored). `config.js` loads them via `require('./config.local')` and falls back to placeholder strings. `config.local.example.js` is the committed template.
