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
   Ключи: `--no-bundle` — только `.exe`; `--fast` — без пересборки WASM-ядра;
   `--no-open` — не открывать папку с результатом.

При успехе скрипт сам открывает папку с результатом (в проводнике выделен установщик)
и закрывает окно: нажимать ничего не нужно. Окно остаётся открытым только при ошибке —
там же лежит её текст. Вопросы в скриптах ждут Enter, а не отдельную клавишу, поэтому
случайно набранные символы ничего не пищат и не сбрасывают ответ.

Первый запуск установки долгий: Build Tools — это 2–4 ГБ и 10–20 минут, дальше
всё быстро. Скрипты можно запускать повторно — они не переставляют уже готовое.

### Сборка на GitHub без установки инструментов

Если не хочется ставить Rust и Visual Studio, `.exe` соберёт GitHub Actions.
Workflow ниже нужно один раз добавить в репозиторий — через веб-интерфейс GitHub:

1. В репозитории: **Add file** → **Create new file**.
2. Имя файла: `.github/workflows/build-windows.yml`.
3. Вставьте текст из блока ниже и нажмите **Commit changes**.
4. Вкладка **Actions** → **Сборка Windows** → **Run workflow**.

Через 10–15 минут готовый набор (приложение и установщик) лежит в артефакте
`YappyTuberPlus-windows`. На тег `v*` дополнительно создаётся черновик релиза
с установщиком.

Полный текст файла (то же самое, что нужно вставить на шаге 3):

```yaml
name: Сборка Windows

# Готовый .exe можно получить без установки Rust и Node.js:
# вкладка Actions → «Сборка Windows» → Run workflow, затем скачать артефакт
# YappyTuberPlus-windows. На тег v* дополнительно создаётся черновик релиза.

on:
  workflow_dispatch:
  push:
    branches: [main]
    tags: ["v*"]
  pull_request:
    paths:
      - "src/**"
      - "src-tauri/**"
      - "crates/**"
      - "package.json"
      - "package-lock.json"
      - ".github/workflows/build-windows.yml"

permissions:
  contents: write

jobs:
  build:
    name: Windows x64
    runs-on: windows-latest
    timeout-minutes: 60
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: wasm32-unknown-unknown

      - name: Кэш Rust
        uses: swatinem/rust-cache@v2
        with:
          workspaces: "src-tauri -> target"

      - name: Зависимости
        run: npm ci

      - name: Сборка приложения и установщика
        run: npm run tauri build

      - name: Артефакты
        uses: actions/upload-artifact@v4
        with:
          name: YappyTuberPlus-windows
          if-no-files-found: error
          path: |
            src-tauri/target/release/yappytuberplus.exe
            src-tauri/target/release/bundle/nsis/*.exe

      - name: Черновик релиза (тег v*)
        if: startsWith(github.ref, 'refs/tags/v')
        uses: softprops/action-gh-release@v2
        with:
          draft: true
          files: |
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

### Новые Rust-зависимости

Внешние источники добавляют два крейта: `reqwest` (HTTP-опрос и SSE, с `rustls-tls`,
поэтому OpenSSL в системе не нужен) и `tokio` (`net`/`time`/`rt`/`sync` — UDP для OSC).
Первый запуск `cargo build` после обновления скачает их и обновит `src-tauri/Cargo.lock`.
Если сборка запускается с `--locked`, добавьте в неё `cargo update -p reqwest` или
уберите флаг: интернет нужен только на этом шаге.

### Если Rust не собирается: разбор частых ошибок

Нативный слой с внешними источниками (`src-tauri/src/sources.rs`) добавляет `reqwest` и
`tokio`. Первая сборка после обновления поэтому дольше обычного и требует интернета.
Разбор по тексту ошибки:

| Что видно в консоли | Причина | Что делать |
|---|---|---|
| `failed to select a version for the requirement 'reqwest'` | `Cargo.lock` от старой версии | `cd src-tauri && cargo update -p reqwest` (или удалить `src-tauri/Cargo.lock` и собрать заново) |
| `failed to get '...' as a dependency ... network` | нет интернета или блокирует прокси | подключиться и повторить: `cd src-tauri && cargo fetch` |
| `error[E0433]: failed to resolve: use of undeclared crate or module 'reqwest'` | правка `Cargo.toml` не попала в сборку | проверить, что `reqwest` и `tokio` стоят в секции `[dependencies]`, затем `cargo clean -p yappytuberplus` |
| `error[E0599]: no method named 'chunk'` | не включена фича `stream` у `reqwest` | в `Cargo.toml` должно быть `features = ["rustls-tls", "charset", "stream"]` |
| `error: linking with 'cc' failed` / `openssl` | включён системный TLS | мы используем `rustls-tls`: проверить, что `default-features = false` не потерялось |
| `Command source_probe not found` в приложении | запущена старая сборка | `npm run tauri build` заново: команда появилась в этом обновлении |
| `cannot find attribute 'tauri::command'` на `sources.rs` | не обновился `tauri` | `cd src-tauri && cargo update -p tauri` |

Что делать **после первой успешной** сборки: закоммитить `src-tauri/Cargo.lock` — тогда
остальным не понадобится сеть на разрешение версий.

Если Rust пока не собирается, а работать нужно сейчас: запустите
`start-yappytuber.bat --app` без Rust — приложение откроется в браузерном окне. В нём
живут WebSocket-источники (пульс через `pulse-bridge.bat`, свои мосты) и все модули с
клавиатурой и мышью. Не работают только `http`/`sse`/`osc` и Twitch — им нужен нативный
слой.

**Что прислать, если не собралось:** строку с `error[E…]`/`error:` и 5–10 строк под ней,
плюс версию Rust (`rustc --version`). По такому куску видно причину без гадания.

## 3. Сборка

### Проверка в нативном окне

```bash
npm run tauri dev
```

Откроется окно «YappyTuberPlus — Rig Studio» без браузерной обвязки. Vite при этом
поднимает сам Tauri; `--port` не используется. Первый запуск компилирует Rust-часть
(единицы минут), дальше — секунды.

### Папка сборки и её паспорт

`npm run build` собирает папку `dist` — это и есть готовая программа (кроме
нативной оболочки): `index.html`, `assets/`, `overlay.html`, `rig_core.wasm`,
шаблоны модулей. `.bat`-файлы в репозитории запускают проект из исходников и
продуктом не являются.

Рядом с `index.html` сборка дописывает `build.json` — паспорт самой папки:

```json
{ "version": "1.0.21.3.1.1.1", "packaging": "1.0.0",
  "builtAt": "2026-10-27T19:16:04.713Z", "commit": "6a21d6a", "schema": 1 }
```

Зачем:

```bash
npm run build:info          # напечатать паспорт репозитория (что попадёт в сборку)
npm run build:check dist    # сверить готовую папку с репозиторием
```

`build:check` печатает, какие слои разошлись, и падает с кодом 1, если папка
старая или собрана из другого коммита:

```text
папка:       .../dist
сборка:      1.0.19.3.1.1.1 · 2026-10-20 09:14 · коммит 1e4556e
репозиторий: 1.0.21.3.1.1.1

Папка не совпадает с репозиторием:
  ядро: в папке 19, в репозитории 21 — папка старше репозитория
```

То же самое без консоли — двойной клик по `check-build.bat` (или
`./check-build.sh`): он спросит папку и покажет расхождение.

Приложение тоже читает `build.json` при запуске: если в папку положили чужой
`rig_core.wasm` или распаковали старую сборку поверх новой, это видно в статусе,
а не выясняется по «почему формулы дают ноль». В `npm run dev` файла нет — там
всё из одного репозитория.

### Сборка установщика

```bash
npm run tauri build
```

Tauri сам выполнит `npm run build` (WASM-ядро → `tsc` → `vite build`) и упакует
фронтенд в бинарник. Куда смотреть:

```text
src-tauri/target/release/yappytuberplus.exe          # само приложение
src-tauri/target/release/bundle/nsis/YappyTuberPlus_1.0.0_x64-setup.exe   # установщик
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
