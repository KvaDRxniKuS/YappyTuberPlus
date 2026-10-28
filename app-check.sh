#!/usr/bin/env bash
# YappyTuberPlus — проверка версии папки сборки (Linux/macOS).
#
# Сверяет паспорт build.json внутри папки с версией репозитория: та ли это
# сборка, из того ли коммита, с тем ли поколением ядра.
#
#   ./app-check.sh              спросить папку (Enter — dist)
#   ./app-check.sh dist         проверить папку сразу
set -euo pipefail
cd "$(dirname "$0")"

FOLDER="${1:-}"
if [ -z "$FOLDER" ]; then
  FOLDER="dist"
  read -r -p "Папка сборки (Enter — $FOLDER): " ANSWER || true
  [ -n "${ANSWER:-}" ] && FOLDER="$ANSWER"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js — он нужен для проверки."
  echo "Поставьте его с nodejs.org и запустите снова."
  read -r -p "Нажмите Enter, чтобы закрыть..." _ || true
  exit 1
fi

if ! node scripts/build-version.mjs --check "$FOLDER"; then
  echo
  echo "Проверка не прошла: версия или состав файлов не совпадают с паспортом."
  echo "Пересоберите её: npm run build"
  read -r -p "Нажмите Enter, чтобы закрыть..." _ || true
  exit 1
fi

echo
echo "Всё совпадает — папку можно раздавать."
