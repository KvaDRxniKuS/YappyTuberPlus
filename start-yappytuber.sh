#!/usr/bin/env bash
# YappyTuberPlus — обновление и запуск (Linux/macOS).
#
# Скачивает последние изменения ветки, ставит зависимости, при наличии Rust
# пересобирает WASM-ядро и запускает редактор в браузере.
#
#   ./start-yappytuber.sh                 обновить и запустить
#   ./start-yappytuber.sh --no-open       не открывать браузер
#   ./start-yappytuber.sh --no-bridge     не запускать мост для OBS
#   ./start-yappytuber.sh --no-serve      только обновить и собрать
#   ./start-yappytuber.sh --tauri         запустить нативное окно Tauri
#   ./start-yappytuber.sh --port 5199     другой порт редактора
#   ./start-yappytuber.sh --branch NAME   другая ветка
#   ./start-yappytuber.sh --dir PATH      папка проекта, если скрипт не в нём
#
# Коды возврата: 0 — успех, 1 — ошибка окружения или сборки.
set -u

REPO_URL="${YAPPY_REPO_URL:-https://github.com/KvaDRxniKuS/YappyTuberPlus.git}"
BRANCH="${YAPPY_BRANCH:-arena/e287965b-yappytuberplus}"
FALLBACK_BRANCH="main"
OPEN=1
BRIDGE=1
SERVE=1
MODE="dev"
PORT=5173
APP_DIR=""

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
fail() { printf 'ОШИБКА: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --no-open) OPEN=0 ;;
    --no-bridge) BRIDGE=0 ;;
    --bridge) BRIDGE=1 ;;
    --no-serve) SERVE=0 ;;
    --tauri) MODE="tauri" ;;
    --branch=*) BRANCH="${1#*=}" ;;
    --branch) shift; BRANCH="${1:-}" ;;
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

step "YappyTuberPlus: обновление и запуск"

# --- окружение -------------------------------------------------------------
command -v git >/dev/null 2>&1 || fail "не найден git. Установите Git и повторите запуск."
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  fail "не найден Node.js. Установите Node.js 20 или новее: https://nodejs.org/"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  warn "Node.js $(node -v) старше требуемого 20: сборка может не пройти."
fi
say "Node.js $(node -v), npm $(npm -v)"

# --- расположение проекта ---------------------------------------------------
if [ -z "$APP_DIR" ]; then
  if [ -d "$SCRIPT_DIR/.git" ]; then
    APP_DIR="$SCRIPT_DIR"
  elif [ -f "$SCRIPT_DIR/package.json" ]; then
    APP_DIR="$SCRIPT_DIR"
  else
    APP_DIR="$(pwd)/YappyTuberPlus"
  fi
fi
say "Папка проекта: $APP_DIR"

# --- клонирование -----------------------------------------------------------
if [ ! -d "$APP_DIR/.git" ]; then
  if [ -f "$APP_DIR/package.json" ]; then
    warn "папка без git-репозитория: автообновление пропущено, просто запускаю."
  else
    step "Клонирование ветки $BRANCH"
    if ! git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"; then
      warn "не удалось клонировать ветку $BRANCH, пробую ветку по умолчанию."
      rm -rf "$APP_DIR"
      git clone "$REPO_URL" "$APP_DIR" || fail "не удалось склонировать $REPO_URL"
    fi
  fi
fi

cd "$APP_DIR" || fail "не удалось перейти в $APP_DIR"

# --- обновление -------------------------------------------------------------
if [ -d ".git" ]; then
  step "Получение обновлений"
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "$REPO_URL"
  git fetch origin --prune >/dev/null 2>&1 || warn "git fetch не удался, работаю с локальной копией."

  # Берём ту ветку, где последний коммит новее: сессионную или main.
  HAS_BRANCH=0
  HAS_MAIN=0
  git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null && HAS_BRANCH=1
  git rev-parse --verify --quiet "origin/$FALLBACK_BRANCH" >/dev/null && HAS_MAIN=1
  if [ "$HAS_BRANCH" = "0" ] && [ "$HAS_MAIN" = "0" ]; then
    fail "на удалённом репозитории нет ни $BRANCH, ни $FALLBACK_BRANCH"
  fi
  if [ "$HAS_BRANCH" = "1" ] && [ "$HAS_MAIN" = "1" ]; then
    STAMP_BRANCH="$(git log -1 --format=%ct "origin/$BRANCH" 2>/dev/null || echo 0)"
    STAMP_MAIN="$(git log -1 --format=%ct "origin/$FALLBACK_BRANCH" 2>/dev/null || echo 0)"
    if [ "${STAMP_MAIN:-0}" -gt "${STAMP_BRANCH:-0}" ]; then TARGET="$FALLBACK_BRANCH"; else TARGET="$BRANCH"; fi
  elif [ "$HAS_BRANCH" = "1" ]; then
    TARGET="$BRANCH"
  else
    warn "ветка $BRANCH не найдена на удалённом репозитории, использую $FALLBACK_BRANCH."
    TARGET="$FALLBACK_BRANCH"
  fi
  say "Ветка обновления: $TARGET"

  if [ -n "$(git status --porcelain)" ]; then
    warn "в папке есть локальные изменения — сохраняю их в git stash (yappytuber auto-backup)."
    git stash push -u -m "yappytuber auto-backup $(date '+%Y-%m-%d %H:%M:%S')" >/dev/null \
      || warn "не удалось сохранить локальные изменения."
  fi

  CURRENT="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
  if [ "$CURRENT" != "$TARGET" ]; then
    git checkout "$TARGET" >/dev/null 2>&1 || git checkout -b "$TARGET" "origin/$TARGET" >/dev/null 2>&1
  fi
  if ! git merge --ff-only "origin/$TARGET" >/dev/null 2>&1; then
    warn "ветка разошлась с удалённой — жёсткий сброс; прежнее состояние доступно через git reflog."
    git reset --hard "origin/$TARGET" >/dev/null || fail "не удалось обновить ветку $TARGET"
  fi
  say "Ветка: $(git rev-parse --abbrev-ref HEAD) · $(git log -1 --format='%h %s')"
else
  say "Автообновление недоступно: папка не является git-репозиторием."
fi

# --- зависимости ------------------------------------------------------------
if [ ! -d node_modules ]; then
  step "Установка зависимостей (npm ci)"
  npm ci --no-audit --no-fund || fail "npm ci завершился с ошибкой"
else
  step "Проверка зависимостей"
  npm install --no-audit --no-fund --prefer-offline >/dev/null 2>&1 \
    || warn "npm install не удался, использую текущие node_modules."
fi

# --- WASM-ядро --------------------------------------------------------------
step "Rust-ядро (WASM)"
if command -v cargo >/dev/null 2>&1 && command -v rustup >/dev/null 2>&1 \
  && rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown; then
  npm run build:wasm || fail "сборка WASM завершилась с ошибкой"
else
  if [ -f public/rig_core.wasm ]; then
    say "Rust/wasm32 не найден — использую собранный public/rig_core.wasm."
  else
    fail "нет Rust/wasm32 и отсутствует public/rig_core.wasm"
  fi
fi

if [ "$SERVE" = "0" ]; then
  step "Готово (--no-serve): проект обновлён и собран."
  exit 0
fi

# --- запуск -----------------------------------------------------------------
URL="http://localhost:${PORT}/"

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

say ""
say "Редактор:  $URL"
say "Оверлей:   ${URL}overlay.html?overlay=1&guide=1"
say "Остановка: Ctrl+C"
say ""

if [ "$OPEN" = "1" ] && [ "$MODE" = "dev" ]; then
  ( sleep 4; open_browser ) &
fi

if [ "$MODE" = "tauri" ]; then
  npm run tauri dev
else
  npm run dev -- --port "$PORT"
fi
