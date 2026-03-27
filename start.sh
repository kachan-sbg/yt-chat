#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  start.sh — Запуск YT Live Chat сервера (macOS / Linux)
#
#  Використання:
#    ./start.sh              ← запустити сервер
#    ./start.sh auth         ← авторизуватись / перевірити токен
#    ./start.sh status       ← показати статус без запуску
#    ./start.sh stop         ← зупинити сервер
#    ./start.sh logs         ← показати лог в реальному часі
#    ./start.sh startup      ← додати в автозапуск (macOS LaunchAgent)
#    ./start.sh nostartup    ← прибрати з автозапуску
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── КОНФІГ ────────────────────────────────────────────────────────────────────
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$APP_DIR/server.pid"
LOG_FILE="$APP_DIR/server.log"
PORT=3456                         # має збігатись з config.js
APP_NAME="YT Live Chat"

# macOS LaunchAgent
PLIST_LABEL="com.ytlivechat.server"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

# ── КОЛЬОРИ ───────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_GREEN="\033[32m"; C_YELLOW="\033[33m"; C_RED="\033[31m"
  C_CYAN="\033[36m";  C_DIM="\033[2m";     C_RESET="\033[0m"
  C_BOLD="\033[1m"
else
  C_GREEN=""; C_YELLOW=""; C_RED=""
  C_CYAN="";  C_DIM="";    C_RESET=""
  C_BOLD=""
fi

ok()   { echo -e "  ${C_GREEN}✓${C_RESET} $*"; }
warn() { echo -e "  ${C_YELLOW}⚠${C_RESET} $*"; }
err()  { echo -e "  ${C_RED}✗${C_RESET} $*"; }
info() { echo -e "  ${C_CYAN}→${C_RESET} $*"; }
hr()   { echo -e "  ${C_DIM}$(printf '─%.0s' {1..50})${C_RESET}"; }

header() {
  echo ""
  echo -e "  ${C_BOLD}${APP_NAME}${C_RESET}"
  hr
}

# ── ПЕРЕВІРИТИ NODE.JS ────────────────────────────────────────────────────────
check_node() {
  if ! command -v node &>/dev/null; then
    err "Node.js не знайдено"
    info "Встанови через https://nodejs.org або: brew install node"
    return 1
  fi
  local ver
  ver=$(node --version)
  ok "Node.js $ver"
  return 0
}

# ── ПЕРЕВІРИТИ ЗАЛЕЖНОСТІ ─────────────────────────────────────────────────────
check_deps() {
  if [[ ! -d "$APP_DIR/node_modules" ]]; then
    warn "node_modules не знайдено. Встановлюємо..."
    (cd "$APP_DIR" && npm install --silent)
    if [[ -d "$APP_DIR/node_modules" ]]; then
      ok "Залежності встановлено"
    else
      err "npm install не вдався"
      return 1
    fi
  else
    ok "node_modules знайдено"
  fi
  return 0
}

# ── ЗНАЙТИ ПРОЦЕС СЕРВЕРА ─────────────────────────────────────────────────────
get_server_pid() {
  # По PID-файлу
  if [[ -f "$PID_FILE" ]]; then
    local saved_pid
    saved_pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [[ -n "$saved_pid" ]] && kill -0 "$saved_pid" 2>/dev/null; then
      echo "$saved_pid"
      return 0
    fi
  fi
  # Fallback: lsof по порту
  local pid
  pid=$(lsof -ti "tcp:$PORT" 2>/dev/null | head -1 || echo "")
  echo "$pid"
}

# ── СТАТУС СЕРВЕРА ЧЕРЕЗ API ──────────────────────────────────────────────────
get_api_status() {
  curl -sf --max-time 3 "http://localhost:$PORT/api/status" 2>/dev/null || echo ""
}

# ── ПОКАЗАТИ СТАТУС ───────────────────────────────────────────────────────────
cmd_status() {
  header

  check_node || return

  local pid
  pid=$(get_server_pid)

  if [[ -n "$pid" ]]; then
    ok "Сервер запущено (PID $pid)"
  else
    warn "Сервер не запущено"
  fi

  local api_resp
  api_resp=$(get_api_status)

  if [[ -n "$api_resp" ]]; then
    local authorized connected video_id token_expiry
    authorized=$(echo "$api_resp"   | grep -o '"authorized":[^,}]*' | cut -d: -f2 | tr -d ' "')
    connected=$(echo "$api_resp"    | grep -o '"connected":[^,}]*'  | cut -d: -f2 | tr -d ' "')
    video_id=$(echo "$api_resp"     | grep -o '"videoId":"[^"]*"'   | cut -d'"' -f4)
    token_expiry=$(echo "$api_resp" | grep -o '"tokenExpiry":"[^"]*"' | cut -d'"' -f4)

    if [[ "$authorized" == "true" ]]; then
      ok "Авторизація: OK"
    else
      warn "Авторизація: потрібна  →  ./start.sh auth"
    fi

    [[ -n "$token_expiry" ]] && info "Токен діє до: $token_expiry"

    if [[ "$connected" == "true" ]]; then
      ok "Підключено до стріму: $video_id"
    else
      info "Стрім: не підключено"
    fi

    info "Overlay: http://localhost:$PORT/index.html"
  else
    [[ -n "$pid" ]] && warn "API не відповідає (можливо ще стартує)"
  fi

  # Автозапуск
  if [[ -f "$PLIST_PATH" ]]; then
    ok "Автозапуск: увімкнено (LaunchAgent)"
  else
    info "Автозапуск: вимкнено"
  fi

  hr; echo ""
}

# ── ЗУПИНИТИ СЕРВЕР ───────────────────────────────────────────────────────────
cmd_stop() {
  local pid
  pid=$(get_server_pid)
  if [[ -n "$pid" ]]; then
    warn "Зупиняємо сервер (PID $pid)..."
    kill "$pid" 2>/dev/null || true
    sleep 0.5
    rm -f "$PID_FILE"
    ok "Сервер зупинено"
  else
    info "Сервер не запущено"
  fi
}

# ── ЗАПУСТИТИ СЕРВЕР ──────────────────────────────────────────────────────────
cmd_start() {
  # Перевірка існуючого інстансу
  local pid
  pid=$(get_server_pid)
  if [[ -n "$pid" ]]; then
    ok "Сервер вже запущено (PID $pid)"
    info "Overlay: http://localhost:$PORT/index.html"
    return
  fi

  # Перевірка токенів
  if [[ ! -f "$APP_DIR/tokens.json" ]]; then
    warn "tokens.json не знайдено!"
    info "Спочатку авторизуйся: ./start.sh auth"
    echo ""
    read -rp "  Запустити авторизацію зараз? (y/n): " answer
    if [[ "$answer" == "y" ]]; then
      cmd_auth
    fi
    return
  fi

  info "Запускаємо сервер..."

  # Запуск у фоні, лог у файл
  nohup node "$APP_DIR/server.js" >> "$LOG_FILE" 2>&1 &
  local new_pid=$!
  echo "$new_pid" > "$PID_FILE"

  # Чекаємо до 8 секунд
  local started=false
  for i in {1..8}; do
    sleep 1
    if lsof -ti "tcp:$PORT" &>/dev/null; then
      started=true
      break
    fi
    # Якщо процес впав
    if ! kill -0 "$new_pid" 2>/dev/null; then
      err "Сервер завершився з помилкою. Дивись: $LOG_FILE"
      rm -f "$PID_FILE"
      return 1
    fi
  done

  if $started; then
    ok "Сервер запущено (PID $new_pid)"
    ok "Overlay: http://localhost:$PORT/index.html"
    info "Лог: $LOG_FILE"
  else
    err "Сервер не відповів за 8 сек. Дивись: $LOG_FILE"
    rm -f "$PID_FILE"
  fi
}

# ── АВТОРИЗАЦІЯ ───────────────────────────────────────────────────────────────
cmd_auth() {
  (cd "$APP_DIR" && node auth.js)
}

# ── ЛОГИ ──────────────────────────────────────────────────────────────────────
cmd_logs() {
  if [[ -f "$LOG_FILE" ]]; then
    info "Лог (Ctrl+C щоб вийти):"
    hr
    tail -f "$LOG_FILE"
  else
    warn "Лог-файл не знайдено (сервер ще не запускався?)"
  fi
}

# ── АВТОЗАПУСК macOS (LaunchAgent) ───────────────────────────────────────────
cmd_startup_add() {
  mkdir -p "$HOME/Library/LaunchAgents"

  cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>${APP_DIR}/server.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${APP_DIR}</string>

  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>

  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>

  <!-- Запускати при логіні -->
  <key>RunAtLoad</key>
  <true/>

  <!-- Перезапускати якщо впав -->
  <key>KeepAlive</key>
  <true/>

  <!-- Затримка перезапуску після краш -->
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
PLIST

  # Завантажити агент
  launchctl load "$PLIST_PATH" 2>/dev/null || true
  ok "Автозапуск додано (LaunchAgent)"
  info "Сервер буде стартувати автоматично при логіні в macOS"
  info "Файл: $PLIST_PATH"
}

cmd_startup_remove() {
  if [[ -f "$PLIST_PATH" ]]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    ok "Автозапуск прибрано"
  else
    info "Автозапуск не був налаштований"
  fi
}

# ── HELP ──────────────────────────────────────────────────────────────────────
cmd_help() {
  header
  echo -e "  ${C_BOLD}Команди:${C_RESET}"
  echo ""
  echo "    ./start.sh             — запустити сервер"
  echo "    ./start.sh auth        — авторизація / перевірка токену"
  echo "    ./start.sh status      — статус сервера"
  echo "    ./start.sh stop        — зупинити сервер"
  echo "    ./start.sh logs        — показати лог (live)"
  echo "    ./start.sh startup     — додати в автозапуск macOS"
  echo "    ./start.sh nostartup   — прибрати з автозапуску"
  hr; echo ""
}

# ── MAIN ──────────────────────────────────────────────────────────────────────
CMD="${1:-start}"

header

check_node || exit 1
check_deps || exit 1

hr

case "$CMD" in
  start)      cmd_start ;;
  stop)       cmd_stop ;;
  auth)       cmd_auth ;;
  status)     cmd_status ;;
  logs)       cmd_logs ;;
  startup)    cmd_startup_add ;;
  nostartup)  cmd_startup_remove ;;
  help|--help|-h) cmd_help ;;
  *)
    err "Невідома команда: $CMD"
    cmd_help
    exit 1
    ;;
esac
