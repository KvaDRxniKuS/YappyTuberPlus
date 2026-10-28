#!/usr/bin/env bash
# Пульс: мост для модуля «Пульсометр».
#
#   ./app-pulse.sh            тренажёр: пульс гуляет 60...110
#   ./app-pulse.sh --hr 90    ровные 90 ударов
#   ./app-pulse.sh --port 18000
#
# Отдаёт ws://127.0.0.1:17801/inputs и http://127.0.0.1:17801/state.
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js: мост написан на нём. Поставьте Node.js 20 или новее: https://nodejs.org/" >&2
  exit 1
fi
exec node scripts/pulse-bridge.mjs "$@"
