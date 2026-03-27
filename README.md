# YT Live Chat Overlay

A YouTube Live Chat overlay for OBS. Runs a local Node.js server that polls the YouTube Data API and serves a browser-source overlay page.

## Setup

### 1. Google Cloud credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
2. Create an **OAuth 2.0 Client ID** (Desktop or Web app)
3. Add `http://localhost:3456/auth/callback` as an Authorized Redirect URI
4. Enable the **YouTube Data API v3** for your project

### 2. Configure

```bash
cp config.local.example.js config.local.js
# Edit config.local.js and fill in CLIENT_ID and CLIENT_SECRET
```

### 3. Install & authorize

```bash
npm install
./start.sh auth     # opens browser for Google OAuth
```

### 4. Run

```bash
./start.sh          # start server in background
```

Open `http://localhost:3456/index.html` in a browser or add it as a **Browser Source** in OBS.

In the overlay UI: click **Підключити** (Connect) to attach to your active live stream.

## OBS Browser Source

| URL | Description |
|---|---|
| `http://localhost:3456/index.html` | Full UI with control panel |
| `http://localhost:3456/index.html?overlay=1` | Chat only, no control panel |
| `http://localhost:3456/index.html?overlay=1&autoconnect=1` | Auto-connects on scene load |

## Commands

```bash
./start.sh              # start server
./start.sh stop         # stop server
./start.sh auth         # authorize / check token
./start.sh status       # server + auth + stream status
./start.sh logs         # live log output
./start.sh startup      # add macOS LaunchAgent (auto-start on login)
./start.sh nostartup    # remove auto-start
```

## Configuration

All settings are in `config.js`. The only values you need to change are in `config.local.js` (credentials). Other tunables:

| Key | Default | Description |
|---|---|---|
| `PORT` | `3456` | Server port |
| `POLL_INTERVAL_MS` | `5000` | YouTube API poll interval (min 5000) |
| `MAX_MESSAGES_ON_SCREEN` | `80` | Messages kept in the overlay |
