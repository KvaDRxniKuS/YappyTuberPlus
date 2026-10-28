#!/usr/bin/env bash
# YappyTuberPlus — сборка приложения (Linux/macOS).
#
#   ./app-build.sh              приложение + пакет
#   ./app-build.sh --no-bundle  только бинарник
#   ./app-build.sh --fast       без пересборки WASM-ядра
#   ./app-build.sh --no-open    не открывать папку с результатом
#   ./app-build.sh --help       справка
#
# При успехе папка с результатом открывается сама, ждать нажатия не нужно.
#
# Внимание: на Linux получится .deb/AppImage, на macOS — .app/.dmg.
# Файл .exe для Windows собирается только на Windows: см. app-build.bat
# и docs/BUILD.md.
set -u

BUNDLE=1
FAST=0
OPEN=1

usage() { awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; }
fail() { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --no-bundle) BUNDLE=0 ;;
    --fast) FAST=1 ;;
    --no-open) OPEN=0 ;;
    -h|--help) usage; exit 0 ;;
    *) say "Неизвестный параметр: $1"; usage; exit 1 ;;
  esac
  shift
done

cd "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)" || fail "не удалось перейти в папку проекта"

say "============================================================"
say "  YappyTuberPlus — сборка приложения"
say "============================================================"

[ -f package.json ] || fail "рядом со скриптом нет package.json — положите его в корень проекта"

# --- инструменты ------------------------------------------------------------
MISSING=""
command -v node >/dev/null 2>&1 || MISSING="$MISSING node"
command -v npm  >/dev/null 2>&1 || MISSING="$MISSING npm"
command -v cargo >/dev/null 2>&1 || MISSING="$MISSING rust"

if [ -n "$MISSING" ]; then
  say "Не хватает:$MISSING"
  say ""
  say "Как поставить:"
  say "  Node.js 20+: https://nodejs.org/ (или пакет nodejs/npm вашего дистрибутива)"
  say "  Rust:        https://rustup.rs/"
  case "$(uname -s)" in
    Linux)
      say "  Библиотеки Tauri (Debian/Ubuntu):"
      say "    sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \\"
      say "      libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev"
      ;;
    Darwin)
      say "  macOS: xcode-select --install"
      ;;
  esac
  say ""
  say "Подробнее: docs/BUILD.md"
  exit 1
fi

say "Node.js: $(node -v)   Rust: $(cargo --version 2>/dev/null | head -1)"

# --- зависимости ------------------------------------------------------------
if [ ! -d node_modules ] || [ ! -d node_modules/react ]; then
  step "Установка зависимостей (npm ci)"
  npm ci --no-audit --no-fund || { step "npm ci не удался, пробую npm install"; npm install --no-audit --no-fund; } \
    || fail "не удалось установить зависимости"
else
  step "Зависимости уже установлены"
fi

# --- WASM-ядро --------------------------------------------------------------
if [ "$FAST" = "0" ]; then
  step "Ядро рига (wasm32)"
  if rustup target add wasm32-unknown-unknown >/dev/null 2>&1; then
    say "target wasm32-unknown-unknown готов"
  else
    say "target wasm32 добавить не удалось — используется public/rig_core.wasm"
  fi
fi

# --- сборка -----------------------------------------------------------------
step "Сборка приложения"
if [ "$BUNDLE" = "1" ]; then
  npm run tauri build || fail "сборка завершилась с ошибкой (подробности выше)"
else
  npm run tauri build -- --no-bundle || fail "сборка завершилась с ошибкой (подробности выше)"
fi

# --- результат --------------------------------------------------------------
step "Готово"
RELEASE="src-tauri/target/release"
BIN=""
for candidate in "$RELEASE"/yappytuberplus "YappyTuberPlus.app"; do
  if [ -e "$RELEASE/$candidate" ] || [ -e "$candidate" ]; then BIN="$candidate"; break; fi
done
[ -n "$BIN" ] && say "Приложение: $RELEASE"

FOUND=0
for bundle in "$RELEASE"/bundle/*/*; do
  [ -e "$bundle" ] || continue
  say "Пакет: $bundle"
  FOUND=1
done
[ "$FOUND" = "0" ] && say "Пакет не собирался (--no-bundle) или bundler недоступен"

say ""
say "Подробности и решение ошибок: docs/BUILD.md"

# --- папку открываем сами ----------------------------------------------------
# В терминале ждать нажатия незачем, а в файловом менеджере результат виден
# сразу: открываем папку с пакетом, иначе — с бинарником.
if [ "$OPEN" = "1" ]; then
  TARGET=""
  for bundle in "$RELEASE"/bundle/*/*; do
    [ -e "$bundle" ] && TARGET="$(dirname "$bundle")" && break
  done
  [ -n "$TARGET" ] || TARGET="$RELEASE"
  if [ -d "$TARGET" ]; then
    case "$(uname -s)" in
      Darwin) open "$TARGET" >/dev/null 2>&1 || say "Откройте папку: $TARGET" ;;
      *) xdg-open "$TARGET" >/dev/null 2>&1 || say "Откройте папку: $TARGET" ;;
    esac
  fi
fi
