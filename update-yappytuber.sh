#!/usr/bin/env bash
# YappyTuberPlus — обновление и сборка (Linux/macOS).
#
# Скачивает последние изменения ветки, ставит зависимости и при наличии Rust
# пересобирает WASM-ядро. Ничего не запускает: запуск — start-yappytuber.sh,
# и его окно можно не закрывать между обновлениями.
#
#   ./update-yappytuber.sh                обновить и собрать
#   ./update-yappytuber.sh --no-wasm      не пересобирать ядро (быстро)
#   ./update-yappytuber.sh --branch NAME  другая ветка
#   ./update-yappytuber.sh --dir PATH     папка проекта, если скрипт не в нём
#   ./update-yappytuber.sh --help         справка
#
# Коды возврата: 0 — успех, 1 — ошибка окружения или сборки.
set -u

REPO_URL="${YAPPY_REPO_URL:-https://github.com/KvaDRxniKuS/YappyTuberPlus.git}"
BRANCH="${YAPPY_BRANCH:-arena/e287965b-yappytuberplus}"
FALLBACK_BRANCH="main"
WASM=1
APP_DIR=""

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
fail() { printf 'ОШИБКА: %s\n' "$*" >&2; exit 1; }

# Превращает распакованный архив (папка без .git) в git-копию, чтобы работало
# автообновление. Возвращает 0 при успехе; содержимое приводится к ветке.
attach_repo() {
  step "Папка без .git: включаю автообновление"
  local dir="$1"
  attach_rollback() { rm -rf "$dir/.git"; return 1; }
  git -C "$dir" init -q >/dev/null 2>&1 || return 1
  git -C "$dir" remote add origin "$REPO_URL" >/dev/null 2>&1 || { attach_rollback; return 1; }
  git -C "$dir" fetch origin --prune >/dev/null 2>&1 || { attach_rollback; return 1; }
  local attach="$BRANCH"
  git -C "$dir" rev-parse --verify --quiet "origin/$attach" >/dev/null || attach="$FALLBACK_BRANCH"
  git -C "$dir" rev-parse --verify --quiet "origin/$attach" >/dev/null || { attach_rollback; return 1; }
  git -C "$dir" symbolic-ref HEAD "refs/heads/$attach" >/dev/null 2>&1 || { attach_rollback; return 1; }
  git -C "$dir" reset --hard "origin/$attach" >/dev/null 2>&1 || { attach_rollback; return 1; }
  say "Автообновление включено: ветка $attach."
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-wasm) WASM=0 ;;
    --branch=*) BRANCH="${1#*=}" ;;
    --branch) shift; BRANCH="${1:-}" ;;
    --dir=*) APP_DIR="${1#*=}" ;;
    --dir) shift; APP_DIR="${1:-}" ;;
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) warn "неизвестный параметр: $1" ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

step "YappyTuberPlus: обновление и сборка"

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

# --- клонирование или подключение архива ------------------------------------
if [ ! -d "$APP_DIR/.git" ]; then
  if [ -f "$APP_DIR/package.json" ]; then
    # Скачали ZIP вместо git clone — подключаем репозиторий на месте.
    attach_repo "$APP_DIR" \
      || warn "не удалось подключить репозиторий — обновляю только зависимости и ядро."
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
# Вся работа с git — в scripts/sync-repo.mjs: он забирает ветку, уводит правки
# исходников в git stash и сохраняет свою папку сборки, чтобы обновление не
# заменило её версией из репозитория.
step "Получение обновлений"
node scripts/sync-repo.mjs --branch "$BRANCH" --fallback "$FALLBACK_BRANCH" \
  || warn "обновление не удалось — работаю с текущими файлами."

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
if [ "$WASM" = "0" ]; then
  if [ -f public/rig_core.wasm ]; then
    say "Пропущено по --no-wasm: остаётся public/rig_core.wasm."
  else
    fail "нет public/rig_core.wasm, а сборка пропущена по --no-wasm"
  fi
elif command -v cargo >/dev/null 2>&1 && command -v rustup >/dev/null 2>&1 \
  && rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown; then
  npm run build:wasm || fail "сборка WASM завершилась с ошибкой"
elif [ -f public/rig_core.wasm ]; then
  say "Rust/wasm32 не найден — использую собранный public/rig_core.wasm."
else
  fail "нет Rust/wasm32 и отсутствует public/rig_core.wasm"
fi

step "Готово: проект обновлён и собран."
say "Запуск: ./start-yappytuber.sh — его окно можно не закрывать,"
say "следующее обновление его не тронет, а запуск сам освободит порт."
