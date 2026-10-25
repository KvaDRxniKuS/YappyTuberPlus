#!/usr/bin/env bash
# YappyTuberPlus — данные приложения и их сброс (Linux/macOS).
#
# Показывает, где приложение хранит автосохранение и пресеты, и по
# подтверждению удаляет их. Картинок отдельными файлами приложение не пишет:
# аватар лежит внутри пресета (data URL).
#
#   ./reset-yappytuber-data.sh            показать пути и спросить
#   ./reset-yappytuber-data.sh --profile  удалить автосохранение
#   ./reset-yappytuber-data.sh --presets  удалить файлы пресетов
#   ./reset-yappytuber-data.sh --all      удалить всё
set -euo pipefail

IDENT="com.yappytuberplus.studio"
case "$(uname -s)" in
  Darwin) BASE="$HOME/Library/Application Support" ;;
  *)      BASE="${XDG_DATA_HOME:-$HOME/.local/share}" ;;
esac
PROFILE="$BASE/$IDENT"
PRESETS="$BASE/$IDENT/presets"
MODE="ask"

case "${1:-}" in
  --profile) MODE="profile" ;;
  --presets) MODE="presets" ;;
  --all)     MODE="all" ;;
  --help|-h)
    echo "YappyTuberPlus — данные приложения"
    echo "  --profile  удалить автосохранение (пресет, картинки, раскладка)"
    echo "  --presets  удалить файлы *.yappy.json"
    echo "  --all      удалить всё"
    exit 0 ;;
  "") ;;
  *) echo "Неизвестный параметр: $1"; exit 1 ;;
esac

echo
echo "=== YappyTuberPlus: где лежат данные ==="
echo
echo "Автосохранение сессии (пресет, картинки в base64, раскладка панелей):"
echo "  $PROFILE"
echo
echo "Файлы, сохранённые кнопкой «Сохранить»:"
echo "  $PRESETS"
echo

if [ "$MODE" = "ask" ]; then
  read -r -p "Удалить автосохранение сессии [y/N]: " answer || true
  case "${answer:-}" in
    [yY]) MODE="profile" ;;
    *)    MODE="none" ;;
  esac
  read -r -p "Удалить сохранённые файлы пресетов [y/N]: " answer2 || true
  case "${answer2:-}" in
    [yY]) [ "$MODE" = "profile" ] && MODE="all" || MODE="presets" ;;
  esac
fi

drop_profile() {
  if [ -d "$PROFILE/EBWebView" ]; then
    rm -rf "$PROFILE/EBWebView"
    echo "Автосохранение удалено: $PROFILE/EBWebView"
  else
    echo "Профиля нет — автосохранения не было."
  fi
}

drop_presets() {
  if [ -d "$PRESETS" ]; then
    find "$PRESETS" -maxdepth 1 -name '*.yappy.json' -delete
    # Папки файлов объектов: рядом с каждым пресетом лежит <имя>.assets.
    find "$PRESETS" -maxdepth 1 -type d -name '*.assets' -exec rm -rf {} +
    echo "Сохранённые пресеты и папки их файлов удалены из $PRESETS"
  else
    echo "Папки с сохранёнными пресетами нет."
  fi
}

case "$MODE" in
  profile) drop_profile ;;
  presets) drop_presets ;;
  all)     drop_profile; drop_presets ;;
  *)       echo "Ничего не изменено." ;;
esac
