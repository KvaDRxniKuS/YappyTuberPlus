#!/usr/bin/env bash
# YappyTuberPlus — запуск (Linux/macOS).
#
# Открывает редактор в браузере. Обновление и сборку ядра делает отдельный
# файл update-yappytuber.sh: запуск ничего не скачивает и не собирает, поэтому
# он быстрый.
#
# Прошлый запуск закрывается сам: порты редактора, моста и агента
# освобождаются перед стартом, окна искать и закрывать руками не нужно.
#
#   ./start-yappytuber.sh                 запустить
#   ./start-yappytuber.sh --no-open       не открывать браузер
#   ./start-yappytuber.sh --no-bridge     не запускать мост для OBS
#   ./start-yappytuber.sh --no-update     не поднимать локальный агент
#                                         обновлений (порт 17802)
#   ./start-yappytuber.sh --app           открыть редактор как приложение:
#                                         нативное окно Tauri, а если Rust нет —
#                                         окно браузера без вкладок
#   ./start-yappytuber.sh --tauri         запустить нативное окно Tauri
#   ./start-yappytuber.sh --port 5199     другой порт редактора
#   ./start-yappytuber.sh --dir PATH      папка проекта, если скрипт не в нём
#
# Коды возврата: 0 — успех, 1 — ошибка окружения.
set -u

OVERLAY_BRIDGE_PORT="${OVERLAY_BRIDGE_PORT:-17800}"
UPDATE_AGENT_PORT="${UPDATE_AGENT_PORT:-17802}"
OPEN=1
BRIDGE=1
AGENT=1
MODE="dev"
PORT=5173
APP_DIR=""

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
fail() { printf 'ОШИБКА: %s\n' "$*" >&2; exit 1; }

# Освобождает порт: закрывает прошлый запуск, чтобы не искать окна руками.
# Без этого Vite молча взял бы другой порт, а мост для OBS не поднялся бы.
free_port() {
  local port="$1" pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    fuser -k "$port/tcp" >/dev/null 2>&1 || true
    return 0
  elif command -v ss >/dev/null 2>&1; then
    pids="$(ss -lptnH "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | sort -u)"
  fi
  [ -z "$pids" ] && return 0
  say "== Порт $port занят прошлым запуском: закрываю ($(echo "$pids" | tr '\n' ' '))"
  kill $pids 2>/dev/null || true
  sleep 1
  kill -9 $pids 2>/dev/null || true
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-open) OPEN=0 ;;
    --no-bridge) BRIDGE=0 ;;
    --bridge) BRIDGE=1 ;;
    --no-update) AGENT=0 ;;
    --tauri) MODE="tauri" ;;
    --app) MODE="app" ;;
    --port=*) PORT="${1#*=}" ;;
    --port) shift; PORT="${1:-}" ;;
    --dir=*) APP_DIR="${1#*=}" ;;
    --dir) shift; APP_DIR="${1:-}" ;;
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) warn "неизвестный параметр: $1" ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

step "YappyTuberPlus: запуск"

# --- окружение -------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  fail "не найден Node.js. Установите Node.js 20 или новее: https://nodejs.org/"
fi
say "Node.js $(node -v)"

# --- расположение проекта ---------------------------------------------------
if [ -z "$APP_DIR" ]; then
  if [ -f "$SCRIPT_DIR/package.json" ]; then
    APP_DIR="$SCRIPT_DIR"
  else
    APP_DIR="$(pwd)/YappyTuberPlus"
  fi
fi
cd "$APP_DIR" || fail "не удалось перейти в $APP_DIR"
say "Папка проекта: $APP_DIR"

# --- проект подготовлен? ----------------------------------------------------
# Запуск ничего не собирает: если зависимостей или ядра нет, их ставит и
# собирает update-yappytuber.sh. Спрашиваем один раз, а не молча падаем.
if [ ! -d node_modules ] || [ ! -f public/rig_core.wasm ]; then
  step "Проект ещё не подготовлен"
  say "Нет node_modules или public/rig_core.wasm — это делает update-yappytuber.sh."
  if [ -x "$SCRIPT_DIR/update-yappytuber.sh" ] || [ -f "$SCRIPT_DIR/update-yappytuber.sh" ]; then
    printf 'Запустить обновление сейчас? [Y/n]: '
    read -r ANSWER || ANSWER="n"
    if [ "${ANSWER:-y}" != "n" ] && [ "${ANSWER:-y}" != "N" ]; then
      bash "$SCRIPT_DIR/update-yappytuber.sh" || fail "обновление завершилось с ошибкой"
    fi
  fi
  if [ ! -d node_modules ] || [ ! -f public/rig_core.wasm ]; then
    fail "сначала запустите update-yappytuber.sh, потом этот файл"
  fi
fi

# --- прошлый запуск не мешает -----------------------------------------------
free_port "$PORT"
[ "$BRIDGE" = "1" ] && free_port "$OVERLAY_BRIDGE_PORT"
[ "$AGENT" = "1" ] && free_port "$UPDATE_AGENT_PORT"

# --- запуск -----------------------------------------------------------------
URL="http://localhost:${PORT}/"

# Окно-приложение: тот же редактор, но без вкладок, адресной строки и меню.
# Так проще делать «Захват окна» — в кадр не попадает интерфейс браузера.
open_app_window() {
  local name
  for name in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge brave-browser; do
    if command -v "$name" >/dev/null 2>&1; then
      "$name" --app="$URL" --window-size=1280,860 >/dev/null 2>&1 &
      return 0
    fi
  done
  if [ "$(uname -s 2>/dev/null)" = "Darwin" ] && [ -d "/Applications/Google Chrome.app" ]; then
    open -na "Google Chrome" --args --app="$URL" --window-size=1280,860 >/dev/null 2>&1 &
    return 0
  fi
  return 1
}

open_browser() {
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 &
  elif command -v cmd.exe >/dev/null 2>&1; then cmd.exe /c start "" "$URL" >/dev/null 2>&1 &
  else warn "откройте $URL вручную"; fi
}

if [ "$BRIDGE" = "1" ]; then
  step "Мост для OBS (источник браузера)"
  ( npm run overlay:bridge >/dev/null 2>&1 & ) || warn "мост не запустился — источник браузера в OBS будет недоступен."
fi

if [ "$AGENT" = "1" ]; then
  # Локальный агент обновлений: страница просит его заменить файлы папки сборки.
  ( npm run update:agent >/dev/null 2>&1 & ) || warn "агент обновлений не запустился — обновление папки сделает лаунчер при следующем запуске."
fi

# Нативное окно возможно только при установленном Rust: без него --app
# откатывается на окно-приложение браузера, а потом на обычный браузер.
TAURI_READY=0
if command -v cargo >/dev/null 2>&1 && [ -d src-tauri ]; then TAURI_READY=1; fi

if [ "$MODE" = "app" ] && [ "$TAURI_READY" = "1" ]; then
  step "Режим приложения: нативное окно"
  say "Первый запуск собирает окно несколько минут, дальше запуск быстрый."
  say "Остановка: Ctrl+C"
  npm run tauri dev
  exit $?
fi

if [ "$MODE" = "app" ]; then
  warn "Rust/Tauri не найден — открою окно-приложение в браузере."
  MODE="app-browser"
fi
if [ "$MODE" = "tauri" ] && [ "$TAURI_READY" = "0" ]; then
  warn "Rust/Tauri не найден — запускаю редактор в браузере."
  MODE="dev"
fi

say ""
say "Редактор:  $URL"
say "Оверлей:   ${URL}overlay.html?overlay=1&guide=1"
say "Захват:    ${URL}overlay.html?capture=1"
say "Остановка: Ctrl+C"
say ""

if [ "$OPEN" = "1" ] && [ "$MODE" = "app-browser" ]; then
  say "Окно-приложение: без вкладок и адресной строки."
  if ! open_app_window; then
    warn "Chrome/Edge/Chromium не найден — открою редактор в обычном браузере."
    ( sleep 4; open_browser ) &
  fi
elif [ "$OPEN" = "1" ] && [ "$MODE" = "dev" ]; then
  ( sleep 4; open_browser ) &
fi

if [ "$MODE" = "tauri" ]; then
  npm run tauri dev
else
  npm run dev -- --port "$PORT"
fi
