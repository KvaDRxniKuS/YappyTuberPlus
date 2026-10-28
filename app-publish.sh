#!/usr/bin/env bash
# YappyTuberPlus — публикация папки сборки в репозиторий (Linux/macOS).
#
# Берёт уже готовую папку (её собирает `npm run build`), проверяет, что она
# совпадает с репозиторием по версии, что исходники закоммичены и что есть
# доступ к GitHub, затем коммитит и отправляет папку.
#
# САМ НЕ СОБИРАЕТ И НЕ ТЕСТИРУЕТ: сначала сборка и проверка, потом публикация.
#
#   ./app-publish.sh                опубликовать dist
#   ./app-publish.sh --check        показать, что уедет, ничего не отправляя
#   ./app-publish.sh D:\Rig\dist    другая папка сборки
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js — он нужен для публикации."
  read -r -p "Нажмите Enter, чтобы закрыть..." _ || true
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "Не найден Git — без него публиковать некуда."
  read -r -p "Нажмите Enter, чтобы закрыть..." _ || true
  exit 1
fi

if ! node scripts/publish-build.mjs "$@"; then
  echo
  echo "Публикация не выполнена — причина выше."
  echo "Сборку при этом никто не менял: папка осталась как была."
  read -r -p "Нажмите Enter, чтобы закрыть..." _ || true
  exit 1
fi
