# Сборка приложения (не браузер)

Редактор — это Vite + React, который запускается внутри **Tauri 2**. Нативное окно
использует системный WebView2 (Windows) вместо браузера: адресной строки, вкладок и
ярлыка «localhost» нет, приложение ставится обычным установщиком и работает без Node.js.

Есть два режима:

| | Что запускает | Кому |
|---|---|---|
| `npm run tauri dev` | окно приложения, фронтенд берётся из Vite (`localhost:5173`) | разработка и проверка окон |
| `npm run tauri build` | готовый `.exe` + установщик, фронтенд вшит внутрь | обычный запуск «как программа» |

Браузерный запуск (`npm run dev`) остаётся только для разработки и предпросмотра.

## 1. Что установить

### Windows (основная платформа)

1. **Node.js 20+** — <https://nodejs.org/> (LTS).
2. **Rust** через `rustup` — <https://rustup.rs/>. При установке согласитесь на
   `stable-x86_64-pc-windows-msvc` и компонент «Desktop development with C++».
   Если Visual Studio Build Tools не установлены, rustup предложит ссылку — нужен
   пакет **«Сборка приложений для классических приложений на C++»** (MSVC + Windows SDK).
3. **WebView2** — на Windows 10/11 уже установлен вместе с системой. Если нет:
   <https://developer.microsoft.com/microsoft-edge/webview2/>.
4. **Git** — не обязателен для сборки, но нужен лаунчеру для автообновления.

Проверка, что всё на месте:

```bat
node -v
cargo -v
rustup target list --installed
```

### Linux / macOS

```bash
# Linux (Debian/Ubuntu)
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
# macOS
xcode-select --install
```

Важно: **`.exe` собирается только на Windows.** Кросс-сборка с Linux/macOS для Windows
в Tauri не поддерживается — на Linux получится `.deb`/AppImage, на macOS — `.app`/`.dmg`.

### Автоматическая установка (Windows)

Два двойных клика вместо консоли:

1. **`install-build-tools.bat`** — проверяет и ставит всё нужное: Git, Node.js LTS,
   Visual Studio Build Tools с C++, Rust (`x86_64-pc-windows-msvc`), WebView2.
   Просит права администратора (UAC), качает компоненты из интернета.
   Ключи: `--check` — только показать, чего не хватает; `--yes` — без подтверждения.
2. **`build-yappytuber.bat`** — ставит npm-зависимости и собирает `.exe` с установщиком.
   Ключи: `--no-bundle` — только `.exe`; `--fast` — без пересборки WASM-ядра.

Первый запуск установки долгий: Build Tools — это 2–4 ГБ и 10–20 минут, дальше
всё быстро. Скрипты можно запускать повторно — они не переставляют уже готовое.

### Сборка на GitHub без установки инструментов

Если не хочется ставить Rust и Visual Studio, `.exe` соберёт GitHub Actions.
Готовый файл workflow лежит в папке проекта: `.github/workflows/build-windows.yml`.
Его нужно один раз добавить в репозиторий — через веб-интерфейс GitHub:

1. В репозитории: **Add file** → **Create new file**.
2. Имя файла: `.github/workflows/build-windows.yml`.
3. Вставьте содержимое файла из папки проекта и нажмите **Commit changes**.
4. Вкладка **Actions** → **Сборка Windows** → **Run workflow**.

Через 10–15 минут готовый набор (приложение и установщик) лежит в артефакте
`YappyTuberPlus-windows`. На тег `v*` дополнительно создаётся черновик релиза
с установщиком.

Ключевые шаги этого workflow, если собирать его заново:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with: { node-version: 22, cache: npm }
- uses: dtolnay/rust-toolchain@stable
  with: { targets: wasm32-unknown-unknown }
- run: npm ci
- run: npm run tauri build
- uses: actions/upload-artifact@v4
  with:
    name: YappyTuberPlus-windows
    path: |
      src-tauri/target/release/yappytuberplus.exe
      src-tauri/target/release/bundle/nsis/*.exe
```

## 2. Подготовка проекта

```bash
npm ci                                  # зависимости
rustup target add wasm32-unknown-unknown # ядро рига собирается в WASM
```

`wasm32` нужен потому, что шаг сборки фронтенда (`npm run build`) пересобирает
`crates/rig-core` в `public/rig_core.wasm`. Готовый WASM лежит в репозитории, поэтому
без Rust фронтенд тоже собирается — но для нативной сборки Rust всё равно нужен.

Если Rust установлен, но `wasm32` не добавлен, `npm run build` остановится с ошибкой
про target — лечится командой `rustup target add wasm32-unknown-unknown`.

## 3. Сборка

### Проверка в нативном окне

```bash
npm run tauri dev
```

Откроется окно «YappyTuberPlus — Rig Studio» без браузерной обвязки. Vite при этом
поднимает сам Tauri; `--port` не используется. Первый запуск компилирует Rust-часть
(единицы минут), дальше — секунды.

### Сборка установщика

```bash
npm run tauri build
```

Tauri сам выполнит `npm run build` (WASM-ядро → `tsc` → `vite build`) и упакует
фронтенд в бинарник. Куда смотреть:

```text
src-tauri/target/release/yappytuberplus.exe          # само приложение
src-tauri/target/release/bundle/nsis/YappyTuberPlus_0.1.0_x64-setup.exe   # установщик
```

Установщик NSIS при первом запуске скачивает свою утилиту из интернета; полностью
офлайн-сборка возможна, но тогда её нужно поставить заранее (`%LOCALAPPDATA%\tauri`).

Только `.exe` без установщика (быстрая проверка):

```bash
npm run tauri build -- --no-bundle
```

Установщик без подписи, поэтому Windows SmartScreen покажет предупреждение
«Неизвестный издатель» → «Подробнее» → «Выполнить в любом случае». Для продажи нужен
сертификат подписи кода; пока его нет, это ожидаемо.

## 4. Что работает в собранном приложении

- **Файлы пресетов** — «Сохранить» перезаписывает текущий файл, «Сохранить как…»
  открывает системный диалог выбора папки, «Открыть» — системный диалог файла.
  По умолчанию пресеты лежат в `%APPDATA%\com.yappytuberplus.studio\presets`.
- **Окно захвата** — «Оверлей» → «Открыть окно захвата»: отдельное окно без рамки,
  видно в списке окон OBS/Discord/Game Bar, прозрачность отдаётся в запись
  (в OBS включите «Прозрачность» у источника «Захват окна»).
- **Оверлей** — прозрачное окно поверх остальных, передача кадров через события Tauri,
  без Node-моста.

Встроенный сервер оверлея (страница для источника браузера в OBS и релей `/overlay-ws`)
поднимается самим приложением на `127.0.0.1:17800`; веб-сборка попадает в установщик как
ресурс (`bundle.resources` в `src-tauri/tauri.conf.json`), поэтому ссылка работает без
папки проекта. Порт, адрес и папку сборки можно переопределить переменными
`YTP_OVERLAY_PORT`, `YTP_OVERLAY_HOST`, `YTP_OVERLAY_WEB`.

Мост `npm run overlay:bridge` и скачивание файлов в браузере нужны только в
браузерном режиме разработки.

## 5. Запуск без консоли

Два способа:

1. **Установщик** (рекомендуется): запустить `YappyTuberPlus_..._x64-setup.exe`,
   дальше — ярлык в меню «Пуск». Node и Rust на машине больше не нужны.
2. **Лаунчер с `--app`**: `start-yappytuber.bat --app` обновляет репозиторий и
   открывает нативное окно Tauri; если Rust нет — откатывается на окно-приложение
   Chrome/Edge, затем на обычный браузер. Это режим для разработки, а не для
   конечного пользователя.

## 6. Если что-то не собирается

| Симптом | Причина и решение |
|---|---|
| `link.exe not found` | нет MSVC Build Tools: установите «Сборка приложений для классических приложений на C++» |
| `error: target 'wasm32-unknown-unknown' not found` | `rustup target add wasm32-unknown-unknown` |
| `failed to bundle project: NSIS not found` | нет интернета для загрузки NSIS; соберите с `--no-bundle` или повторите сборку |
| Приложение открывается, но окно пустое | не выполнен `npm run build` перед `tauri build` (обычно Tauri делает это сам; проверьте, что нет ошибок `tsc`) |
| Прозрачность окна не работает | Windows 7/старый WebView2: обновите WebView2 Runtime |
| Окно захвата не видно в OBS | окно нужно не минимизировать; в OBS выберите «Захват окна», а не «Захват игры» |
| Долгая сборка каждый раз | первый релизный билд компилирует все зависимости; последующие — только изменённое |

## 7. Версия и имя

- Имя продукта, идентификатор и версия — `src-tauri/tauri.conf.json`
  (`productName`, `identifier`, `version`, размеры главного окна).
- Версия в `package.json` и `src-tauri/tauri.conf.json` должна совпадать — по ней
  называется файл установщика.
- Иконки — `src-tauri/icons/*`; пересобрать из одной картинки:
  `npm run tauri icon path/to/icon.png`.
