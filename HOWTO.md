# How to run the scripts

## macOS / Linux

### First-time setup (one command, run once)

```bash
chmod +x start.sh stop.sh restart.sh
```

This makes the scripts executable. Without this step macOS will say "permission denied".

### Running

```bash
./start.sh      # start the server (runs auth automatically if needed)
./stop.sh       # stop the server
./restart.sh    # restart the server
./start.sh logs # watch live log output (Ctrl+C to exit)
```

---

## Windows (PowerShell)

### First-time setup — allow running local scripts

Windows blocks PowerShell scripts by default. Run **one** of these options:

**Option A — allow scripts for your user (recommended, one-time):**
Open PowerShell and run:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```
After this, you can run scripts normally with `.\start.ps1`.

**Option B — bypass per-run (no permanent change, no admin needed):**
```powershell
powershell -ExecutionPolicy Bypass -File start.ps1
```

**Option C — right-click the .ps1 file → "Run with PowerShell"**
This uses Bypass automatically on most Windows versions.

### Running

```powershell
.\start.ps1      # start the server (runs auth automatically if needed)
.\stop.ps1       # stop the server
.\restart.ps1    # restart the server
```

Or without changing execution policy:
```powershell
powershell -ExecutionPolicy Bypass -File start.ps1
powershell -ExecutionPolicy Bypass -File stop.ps1
powershell -ExecutionPolicy Bypass -File restart.ps1
```

### Watching logs on Windows

```powershell
Get-Content server.log -Wait -Tail 50
```

---

## First run (both platforms)

On first run `start` will detect that `tokens.json` is missing and launch the Google OAuth flow automatically — a browser window will open. Complete the login there, then the server starts.

If the browser does not open automatically, the script will print a URL — copy and open it manually.
