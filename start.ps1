# YT Live Chat - Start/Stop/Restart Server
# Usage: powershell -ExecutionPolicy Bypass -File start.ps1 [-Stop] [-Restart] [-Status] [-AddStartup] [-RemStartup] [-Silent]
#
# See HOWTO.md for setup instructions.

param(
    [switch]$Stop,
    [switch]$Restart,
    [switch]$Status,
    [switch]$AddStartup,
    [switch]$RemStartup,
    [switch]$Silent    # suppress interactive pause; used by Task Scheduler / startup
)

$AppDir      = $PSScriptRoot
$AppName     = "YT Live Chat"
$Port        = 3456
$PidFile     = Join-Path $AppDir "server.pid"
$LogFile     = Join-Path $AppDir "server.log"
$StartupName = "YTLiveChat"

# ── Output helpers ────────────────────────────────────────────────────────────
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green  }
function Write-Warn($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  [XX] $msg" -ForegroundColor Red    }
function Write-Info($msg) { Write-Host "  [..] $msg" -ForegroundColor Cyan   }
function Write-Hr         { Write-Host ("  " + ("-" * 50)) -ForegroundColor DarkGray }

function Write-Header {
    Write-Host ""
    Write-Host "  $AppName" -ForegroundColor White
    Write-Hr
}

# ── Node.js check ─────────────────────────────────────────────────────────────
function Test-Node {
    try {
        $ver = & node --version 2>&1
        if ($LASTEXITCODE -eq 0) { Write-Ok "Node.js $ver"; return $true }
    } catch {}
    Write-Err "Node.js not found. Download from https://nodejs.org"
    return $false
}

# ── Dependencies check ────────────────────────────────────────────────────────
function Test-Dependencies {
    $modDir = Join-Path $AppDir "node_modules"
    if (-not (Test-Path $modDir)) {
        Write-Warn "node_modules not found. Running npm install..."
        Push-Location $AppDir
        & npm install 2>&1 | Out-Null
        Pop-Location
        if (Test-Path $modDir) { Write-Ok "Dependencies installed." }
        else { Write-Err "npm install failed."; return $false }
    } else {
        Write-Ok "node_modules found."
    }
    return $true
}

# ── Find running server process ───────────────────────────────────────────────
function Get-ServerProcess {
    if (Test-Path $PidFile) {
        $savedPid = Get-Content $PidFile -ErrorAction SilentlyContinue
        if ($savedPid) {
            $proc = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
            if ($proc -and $proc.Name -match "node") { return $proc }
        }
    }
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($proc) { return $proc }
    }
    return $null
}

function Test-PortBusy {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return ($null -ne $conn)
}

# ── Stop server ───────────────────────────────────────────────────────────────
function Stop-Server {
    $proc = Get-ServerProcess
    if ($proc) {
        Write-Warn "Stopping server (PID $($proc.Id))..."
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
        Remove-Item $PidFile -ErrorAction SilentlyContinue
        Write-Ok "Server stopped."
    } else {
        Write-Info "Server is not running."
    }
}

# ── Run auth ──────────────────────────────────────────────────────────────────
function Start-Auth {
    Write-Info "Starting OAuth authorization (a browser window will open)..."
    Push-Location $AppDir
    & node auth.js
    Pop-Location
}

# ── Start server ──────────────────────────────────────────────────────────────
function Start-Server {
    $existing = Get-ServerProcess
    if ($existing) {
        Write-Ok "Server is already running (PID $($existing.Id))"
        Write-Info "Overlay: http://localhost:$Port/index.html"
        return
    }

    if (Test-PortBusy) {
        Write-Err "Port $Port is in use by another process."
        Write-Info "Change PORT in config.js or free the port."
        return
    }

    # Auth check - run automatically if tokens are missing
    $tokenFile = Join-Path $AppDir "tokens.json"
    if (-not (Test-Path $tokenFile)) {
        Write-Warn "tokens.json not found. Starting authorization..."
        Write-Hr
        Start-Auth
        Write-Hr
        if (-not (Test-Path $tokenFile)) {
            Write-Err "Authorization did not complete. Run start.ps1 again to retry."
            Write-Host ""
            Write-Host "  Press any key to exit..." -ForegroundColor DarkGray
            $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
            return
        }
        Write-Ok "Authorization successful."
    }

    Write-Info "Starting server..."

    # Launch node via cmd.exe so stdout+stderr are redirected at the OS level.
    # In-process PowerShell event handlers (add_OutputDataReceived) die when this
    # script exits and cannot survive a background process — OS-level redirection
    # (cmd >> file 2>&1) is the only reliable approach on Windows.
    $serverJs = Join-Path $AppDir 'server.js'
    try {
        $proc = Start-Process -FilePath "cmd.exe" `
            -ArgumentList "/c node `"$serverJs`" >> `"$LogFile`" 2>&1" `
            -WorkingDirectory $AppDir `
            -WindowStyle Hidden `
            -PassThru -ErrorAction Stop
    } catch {
        Write-Err "Failed to launch server: $_"
        return
    }

    $proc.Id | Out-File $PidFile -Encoding ascii

    $started = $false
    for ($i = 0; $i -lt 8; $i++) {
        Start-Sleep -Seconds 1
        if (Test-PortBusy) { $started = $true; break }
        if ($proc.HasExited) {
            Write-Err "Server exited with an error. See: $LogFile"
            Remove-Item $PidFile -ErrorAction SilentlyContinue
            return
        }
    }

    if ($started) {
        Write-Ok "Server started (PID $($proc.Id))"
        Write-Ok "Overlay: http://localhost:$Port/index.html"
        Write-Info "Log file: $LogFile"
    } else {
        Write-Err "Server did not respond within 8 seconds. See: $LogFile"
    }
}

# ── Startup (Task Scheduler) ──────────────────────────────────────────────────
function Add-Startup {
    $scriptPath = Join-Path $AppDir "start.ps1"
    $action  = New-ScheduledTaskAction `
        -Execute "powershell.exe" `
        -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -Silent" `
        -WorkingDirectory $AppDir
    $trigger  = New-ScheduledTaskTrigger -AtLogon
    $settings = New-ScheduledTaskSettingsSet `
        -ExecutionTimeLimit (New-TimeSpan -Hours 12) `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal `
        -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive -RunLevel Limited
    try {
        Register-ScheduledTask `
            -TaskName $StartupName -Action $action -Trigger $trigger `
            -Settings $settings -Principal $principal -Force | Out-Null
        Write-Ok "Auto-start added (Task Scheduler: '$StartupName')"
        Write-Info "Server will start automatically when you log in to Windows."
    } catch {
        Write-Err "Failed to add auto-start: $_"
        Write-Warn "Try running PowerShell as Administrator."
    }
}

function Remove-Startup {
    $task = Get-ScheduledTask -TaskName $StartupName -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $StartupName -Confirm:$false
        Write-Ok "Auto-start removed."
    } else {
        Write-Info "Auto-start was not configured."
    }
}

# ── Status ────────────────────────────────────────────────────────────────────
function Show-Status {
    Write-Header
    if (-not (Test-Node)) { return }

    $proc = Get-ServerProcess
    if ($proc) { Write-Ok "Server running (PID $($proc.Id))" }
    else        { Write-Warn "Server is not running." }

    try {
        $s = Invoke-RestMethod -Uri "http://localhost:$Port/api/status" -TimeoutSec 3 -ErrorAction Stop
        if ($s.authorized) { Write-Ok  "Auth: OK" }
        else               { Write-Warn "Auth: missing - run start.ps1 to authorize" }
        if ($s.tokenExpiry) { Write-Info "Token expires: $($s.tokenExpiry)" }
        if ($s.connected)  { Write-Ok  "Stream: $($s.videoId)" }
        else               { Write-Info "Stream: not connected" }
        if ($s.quota) {
            Write-Info "Quota: $($s.quota.used)/$($s.quota.limit) used | $($s.quota.remaining) left | resets in $($s.quota.resetInH)h"
        }
        Write-Info "Overlay: http://localhost:$Port/index.html"
    } catch {
        if ($proc) { Write-Warn "Server running but API not responding yet." }
    }

    $task = Get-ScheduledTask -TaskName $StartupName -ErrorAction SilentlyContinue
    if ($task) { Write-Ok  "Auto-start: enabled" }
    else       { Write-Info "Auto-start: disabled" }

    Write-Hr; Write-Host ""
}

# ── Pause helper (used on interactive exit) ───────────────────────────────────
function Wait-UserInput {
    if (-not $Silent) {
        Write-Host ""
        Read-Host "  Press Enter to close"
    }
}

# ── Main ──────────────────────────────────────────────────────────────────────
Write-Header
if (-not (Test-Node))        { Wait-UserInput; exit 1 }
if (-not (Test-Dependencies)){ Wait-UserInput; exit 1 }
Write-Hr

if ($Stop)       { Stop-Server;    Write-Hr; Write-Host ""; exit 0 }
if ($Restart)    { Stop-Server; Write-Hr; Start-Server; Write-Hr; Write-Host ""; exit 0 }
if ($Status)     { Show-Status;    exit 0 }
if ($AddStartup) { Add-Startup;    Write-Hr; Write-Host ""; exit 0 }
if ($RemStartup) { Remove-Startup; Write-Hr; Write-Host ""; exit 0 }

# Default: start
Start-Server
Write-Hr
Wait-UserInput
