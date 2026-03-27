# ═══════════════════════════════════════════════════════════════════════════
#  start.ps1 — Запуск YT Live Chat сервера
#
#  Використання:
#    .\start.ps1              ← запустити сервер (перевіряє авторизацію)
#    .\start.ps1 -Auth        ← авторизуватись / перевірити токен
#    .\start.ps1 -Status      ← показати статус без запуску
#    .\start.ps1 -Stop        ← зупинити запущений сервер
#    .\start.ps1 -AddStartup  ← додати в автозапуск Windows
#    .\start.ps1 -RemStartup  ← прибрати з автозапуску
# ═══════════════════════════════════════════════════════════════════════════

param(
  [switch]$Auth,
  [switch]$Status,
  [switch]$Stop,
  [switch]$AddStartup,
  [switch]$RemStartup
)

# ── КОНФІГ ────────────────────────────────────────────────────────────────────
$AppDir    = $PSScriptRoot           # папка де лежить цей скрипт (C:\yt-chat)
$AppName   = "YT Live Chat"
$Port      = 3456
$PidFile   = Join-Path $AppDir "server.pid"
$LogFile   = Join-Path $AppDir "server.log"
$StartupName = "YTLiveChat"

# ── КОЛЬОРИ ───────────────────────────────────────────────────────────────────
function Write-Ok($msg)   { Write-Host "  [OK] " -ForegroundColor Green  -NoNewline; Write-Host $msg }
function Write-Warn($msg) { Write-Host "  [!!] " -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Write-Err($msg)  { Write-Host "  [XX] " -ForegroundColor Red    -NoNewline; Write-Host $msg }
function Write-Info($msg) { Write-Host "  [ ] " -ForegroundColor Cyan   -NoNewline; Write-Host $msg }
function Write-Hr         { Write-Host ("  " + ("─" * 50)) -ForegroundColor DarkGray }

function Write-Header {
  Write-Host ""
  Write-Host "  $AppName" -ForegroundColor White
  Write-Hr
}

# ── ПЕРЕВІРИТИ NODE.JS ────────────────────────────────────────────────────────
function Test-Node {
  try {
    $ver = & node --version 2>&1
    if ($LASTEXITCODE -eq 0) {
      Write-Ok "Node.js $ver"
      return $true
    }
  } catch {}
  Write-Err "Node.js не знайдено. Завантаж з https://nodejs.org"
  return $false
}

# ── ПЕРЕВІРИТИ node_modules ───────────────────────────────────────────────────
function Test-Dependencies {
  $modDir = Join-Path $AppDir "node_modules"
  if (-not (Test-Path $modDir)) {
    Write-Warn "node_modules не знайдено. Встановлюємо залежності..."
    Push-Location $AppDir
    & npm install 2>&1 | Out-Null
    Pop-Location
    if (Test-Path $modDir) {
      Write-Ok "Залежності встановлено"
    } else {
      Write-Err "Не вдалось встановити залежності (npm install failed)"
      return $false
    }
  } else {
    Write-Ok "node_modules знайдено"
  }
  return $true
}

# ── ЗНАЙТИ ПРОЦЕС СЕРВЕРА ─────────────────────────────────────────────────────
function Get-ServerProcess {
  # Шукаємо по PID з файлу
  if (Test-Path $PidFile) {
    $savedPid = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($savedPid) {
      $proc = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
      if ($proc -and $proc.Name -match "node") {
        return $proc
      }
    }
  }
  # Fallback: шукаємо node процес що слухає на нашому порті
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($conn) {
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($proc) { return $proc }
  }
  return $null
}

# ── ПЕРЕВІРИТИ ЧИ ПОРТ ЗАЙНЯТИЙ ──────────────────────────────────────────────
function Test-PortBusy {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return ($null -ne $conn)
}

# ── СТАТУС СЕРВЕРА ────────────────────────────────────────────────────────────
function Get-ServerStatus {
  try {
    $resp = Invoke-RestMethod -Uri "http://localhost:$Port/api/status" -TimeoutSec 3 -ErrorAction Stop
    return $resp
  } catch {
    return $null
  }
}

# ── ПОКАЗАТИ СТАТУС ───────────────────────────────────────────────────────────
function Show-Status {
  Write-Header
  
  # Node.js
  if (-not (Test-Node)) { return }
  
  # Сервер запущено?
  $proc = Get-ServerProcess
  if ($proc) {
    Write-Ok "Сервер запущено (PID $($proc.Id))"
  } else {
    Write-Warn "Сервер не запущено"
  }
  
  # API статус
  $apiStatus = Get-ServerStatus
  if ($apiStatus) {
    if ($apiStatus.authorized) {
      Write-Ok "Авторизація: OK"
    } else {
      Write-Warn "Авторизація: потрібна (запусти .\start.ps1 -Auth)"
    }

    if ($apiStatus.tokenExpiry) {
      Write-Info "Токен діє до: $($apiStatus.tokenExpiry)"
    }

    if ($apiStatus.connected) {
      Write-Ok "Підключено до стріму: $($apiStatus.videoId)"
    } else {
      Write-Info "Стрім: не підключено"
    }
    
    Write-Info "Overlay: http://localhost:$Port/index.html"
  } else {
    if ($proc) {
      Write-Warn "Сервер запущено але API не відповідає (ще стартує?)"
    }
  }
  
  # Автозапуск
  $task = Get-ScheduledTask -TaskName $StartupName -ErrorAction SilentlyContinue
  if ($task) {
    Write-Ok "Автозапуск: увімкнено"
  } else {
    Write-Info "Автозапуск: вимкнено"
  }

  Write-Hr
  Write-Host ""
}

# ── ЗУПИНИТИ СЕРВЕР ───────────────────────────────────────────────────────────
function Stop-Server {
  $proc = Get-ServerProcess
  if ($proc) {
    Write-Warn "Зупиняємо сервер (PID $($proc.Id))..."
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Ok "Сервер зупинено"
  } else {
    Write-Info "Сервер не запущено"
  }
}

# ── ЗАПУСТИТИ СЕРВЕР ──────────────────────────────────────────────────────────
function Start-Server {
  # Перевірка існуючого інстансу
  $existing = Get-ServerProcess
  if ($existing) {
    Write-Ok "Сервер вже запущено (PID $($existing.Id))"
    Write-Info "Overlay: http://localhost:$Port/index.html"
    return
  }

  # Перевірка порту (інший процес?)
  if (Test-PortBusy) {
    Write-Err "Порт $Port зайнятий іншим процесом!"
    Write-Info "Зміни PORT в config.js або звільни порт"
    return
  }

  # Перевірка авторизації перед запуском
  $tokenFile = Join-Path $AppDir "tokens.json"
  if (-not (Test-Path $tokenFile)) {
    Write-Warn "tokens.json не знайдено!"
    Write-Info "Спочатку авторизуйся: .\start.ps1 -Auth"
    $answer = Read-Host "  Запустити авторизацію зараз? (y/n)"
    if ($answer -eq "y") {
      Run-Auth
    }
    return
  }

  Write-Info "Запускаємо сервер..."

  # Запускаємо node server.js у фоні
  $pinfo = New-Object System.Diagnostics.ProcessStartInfo
  $pinfo.FileName  = "node"
  $pinfo.Arguments = "`"$(Join-Path $AppDir 'server.js')`""
  $pinfo.WorkingDirectory       = $AppDir
  $pinfo.RedirectStandardOutput = $true
  $pinfo.RedirectStandardError  = $true
  $pinfo.UseShellExecute        = $false
  $pinfo.CreateNoWindow         = $true

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $pinfo

  # Лог в файл
  $logStream = [System.IO.StreamWriter]::new($LogFile, $true)

  $proc.add_OutputDataReceived({
    param($sender, $e)
    if ($e.Data) { $logStream.WriteLine("[$(Get-Date -Format 'HH:mm:ss')] $($e.Data)") }
  })
  $proc.add_ErrorDataReceived({
    param($sender, $e)
    if ($e.Data) { $logStream.WriteLine("[$(Get-Date -Format 'HH:mm:ss')] ERR: $($e.Data)") }
  })

  $proc.Start() | Out-Null
  $proc.BeginOutputReadLine()
  $proc.BeginErrorReadLine()

  # Зберегти PID
  $proc.Id | Out-File $PidFile -Encoding utf8

  # Чекаємо поки сервер піднімається (до 8 сек)
  $maxWait = 8
  $started = $false
  for ($i = 0; $i -lt $maxWait; $i++) {
    Start-Sleep -Seconds 1
    if (Test-PortBusy) {
      $started = $true
      break
    }
    if ($proc.HasExited) {
      Write-Err "Сервер завершився з помилкою. Дивись server.log"
      $logStream.Close()
      return
    }
  }

  $logStream.Close()

  if ($started) {
    Write-Ok "Сервер запущено (PID $($proc.Id))"
    Write-Ok "Overlay: http://localhost:$Port/index.html"
    Write-Info "Лог: $LogFile"
  } else {
    Write-Err "Сервер не відповів за $maxWait сек. Дивись server.log"
  }
}

# ── АВТОРИЗАЦІЯ ───────────────────────────────────────────────────────────────
function Run-Auth {
  Write-Info "Запускаємо авторизацію..."
  Push-Location $AppDir
  & node auth.js
  Pop-Location
}

# ── АВТОЗАПУСК ────────────────────────────────────────────────────────────────
function Add-Startup {
  $scriptPath = $MyInvocation.ScriptName
  if (-not $scriptPath) { $scriptPath = Join-Path $AppDir "start.ps1" }

  # Використовуємо Task Scheduler (надійніше ніж реєстр)
  $action  = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`"" `
    -WorkingDirectory $AppDir

  $trigger = New-ScheduledTaskTrigger -AtLogon

  $settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 12) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

  $principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited

  try {
    Register-ScheduledTask `
      -TaskName $StartupName `
      -Action $action `
      -Trigger $trigger `
      -Settings $settings `
      -Principal $principal `
      -Force | Out-Null

    Write-Ok "Автозапуск додано (Task Scheduler: '$StartupName')"
    Write-Info "Сервер буде стартувати автоматично при вході в Windows"
  } catch {
    Write-Err "Не вдалось додати автозапуск: $_"
    Write-Warn "Спробуй запустити PowerShell від імені Адміністратора"
  }
}

function Remove-Startup {
  $task = Get-ScheduledTask -TaskName $StartupName -ErrorAction SilentlyContinue
  if ($task) {
    Unregister-ScheduledTask -TaskName $StartupName -Confirm:$false
    Write-Ok "Автозапуск прибрано"
  } else {
    Write-Info "Автозапуск не був налаштований"
  }
}

# ── MAIN ──────────────────────────────────────────────────────────────────────
Write-Header

if (-not (Test-Node))        { exit 1 }
if (-not (Test-Dependencies)){ exit 1 }

Write-Hr

if ($Stop)       { Stop-Server; exit 0 }
if ($Auth)       { Run-Auth;    exit 0 }
if ($Status)     { Show-Status; exit 0 }
if ($AddStartup) { Add-Startup; Write-Hr; Write-Host ""; exit 0 }
if ($RemStartup) { Remove-Startup; Write-Hr; Write-Host ""; exit 0 }

# Звичайний запуск
Start-Server
Write-Hr
Write-Host ""
