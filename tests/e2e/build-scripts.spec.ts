import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Скрипты сборки запускают двойным кликом, поэтому ведут себя как установщик:
 * при успехе показывают результат, открывают папку и закрываются сами, а окно
 * остаётся только при ошибке. Никаких «нажмите клавишу» на успешном пути.
 *
 * Здесь же закреплено, что `choice` в этих файлах больше нет: он пищит на
 * каждую «лишнюю» клавишу, а ответ требует одной буквы без Enter.
 */

function script(name: string): string {
  return readFileSync(join(process.cwd(), name), "utf8");
}

/** Строки файла без комментариев: `rem` в batch. */
function code(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*(rem\b|::)/i.test(line))
    .join("\n");
}

/** Кусок batch-файла между двумя метками (обе не входят). */
function section(text: string, from: string, to: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `:${from}`);
  expect(start, `метка :${from} есть в файле`).toBeGreaterThan(-1);
  const end = to === "__end__"
    ? lines.length
    : lines.findIndex((line) => line.trim() === `:${to}`);
  expect(end, `метка :${to} идёт после :${from}`).toBeGreaterThan(start);
  return code(lines.slice(start + 1, end).join("\n"));
}

/**
 * Ярлыки — одной группой.
 *
 * Человек не работает из консоли: он открывает папку проекта в Проводнике и
 * ищет двойной клик глазами. Пока ярлыки назывались по-разному
 * (`build-yappytuber`, `check-build`, `reset-yappytuber-data`), они стояли
 * вперемешку с `Cargo.toml` и `package.json`. Префикс `app-` собирает их в
 * один непрерывный блок в начале списка — и по имени сразу видно, что это
 * ярлык, а не исходник.
 */
test("ярлыки: все двойные клики в корне — одной группой app-*", () => {
  const launchers = readdirSync(process.cwd(), { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".bat") || entry.name.endsWith(".sh")))
    .map((entry) => entry.name)
    .sort();
  expect(launchers.length).toBeGreaterThanOrEqual(15);
  // Ни одного ярлыка без префикса: иначе группа снова рассыпается.
  expect(launchers.filter((name) => !name.startsWith("app-"))).toEqual([]);
  // И у каждого есть напарник для другой платформы, кроме установки окружения:
  // Build Tools с её winget и MSVC на Linux/macOS не ставятся.
  const missing = launchers
    .filter((name) => !name.startsWith("app-tools"))
    .map((name) => name.replace(/\.(bat|sh)$/, ""))
    .filter((base) => !launchers.includes(`${base}.bat`) || !launchers.includes(`${base}.sh`));
  expect([...new Set(missing)]).toEqual([]);

  // Внутри ярлыков — только новые имена: старые остались лишь в истории.
  // Скрипты в `scripts/` не переименовывались, поэтому `publish-build.mjs` и
  // `pulse-bridge.mjs` — законные упоминания, их и не ловим.
  const oldNames = /(build-yappytuber|start-yappytuber|update-yappytuber|reset-yappytuber-data|install-build-tools|check-build|publish-build|pulse-bridge)(?!\.mjs)/;
  for (const name of launchers) {
    const hit = oldNames.exec(script(name));
    expect(hit?.[0] ?? null, `${name}: старое имя`).toBeNull();
  }
});

test("сборка: при успехе окно закрывается, папку открывает сам", () => {
  const bat = script("app-build.bat");
  // Успешный путь целиком: от «Готово» до первой ветки с ошибкой.
  const done = section(bat, "build_done", "npm_failed");
  // Ни ожидания клавиши, ни вопроса с писком.
  expect(done).not.toContain("pause");
  expect(done).not.toContain("choice");
  // Папка открывается в проводнике: установщик выделен, иначе — папка сборки.
  expect(done).toContain('start "" explorer /select,"%SETUP%"');
  expect(done).toContain('start "" explorer "%RELEASE%"');
  // И окно закрывается с кодом успеха.
  expect(done.trimEnd().endsWith("exit /b 0")).toBe(true);
});

test("сборка: ошибка по-прежнему оставляет окно открытым", () => {
  const bat = script("app-build.bat");
  expect(section(bat, "npm_failed", "build_failed")).toContain("pause");
  expect(section(bat, "build_failed", "usage")).toContain("pause");
});

test("сборка: папку можно не открывать — ключ --no-open", () => {
  const bat = script("app-build.bat");
  expect(bat).toContain('if /i "%~1"=="--no-open" ( set "OPEN=0" & shift & goto parse )');
  // «Не открывать» проверяется раньше, чем вызывается проводник.
  const plain = code(bat);
  const shut = plain.indexOf('if "%OPEN%"=="0" goto build_quiet');
  const open = plain.indexOf('start "" explorer');
  expect(shut).toBeGreaterThan(-1);
  expect(open).toBeGreaterThan(shut);
  // Ключ описан и в шапке файла, и в справке.
  const header = bat.split(/\r?\n/).slice(0, 25).join("\n");
  expect(header).toContain("--no-open");
  expect(section(bat, "usage", "__end__").length).toBeGreaterThan(0);
  expect(code(bat)).toContain("--no-open     не открывать папку с результатом");
});

test("лаунчеры разделены: update собирает, start только запускает", () => {
  const updateBat = code(script("app-update.bat"));
  const updateSh = script("app-update.sh");
  const startBat = code(script("app-start.bat"));
  const startSh = script("app-start.sh");

  // Git, зависимости и ядро — только в обновлении.
  for (const text of [updateBat, updateSh]) {
    expect(text).toContain("sync-repo.mjs");
    expect(text).toContain("build:wasm");
  }
  expect(updateBat).toContain("npm ci");

  // Запуск ничего не скачивает и не собирает: он должен быть быстрым.
  for (const text of [startBat, startSh]) {
    expect(text).not.toContain("sync-repo.mjs");
    expect(text).not.toContain("build:wasm");
    expect(text).not.toContain("npm ci");
    expect(text).not.toContain("git clone");
  }

  // Прошлый запуск закрывается сам: иначе порт занят, а окна ищут руками.
  expect(startBat).toContain("netstat -ano");
  expect(startBat).toContain("taskkill /f /pid");
  expect(startSh).toContain("free_port()");
  expect(startSh).toContain("lsof -ti");

  // Оба файла объясняют свою роль и умеют показать справку.
  for (const text of [updateBat, updateSh, startBat, startSh]) expect(text).toContain("--help");
});

test("ни один двойной клик не пищит: choice убран, вопросы ждут Enter", () => {
  for (const name of ["app-build.bat", "app-tools.bat", "app-start.bat", "app-update.bat"]) {
    const text = code(script(name));
    expect(text, name).not.toContain("choice ");
    expect(text, name).toContain("set /p");
  }
});

test("linux/macOS: папка с пакетом открывается сама и без ожидания", () => {
  const sh = script("app-build.sh");
  expect(sh).toContain("--no-open) OPEN=0 ;;");
  expect(sh).toContain('xdg-open "$TARGET"');
  expect(sh).toContain('open "$TARGET"');
  // Сценарий не просит нажатий: паузы в нём быть не должно.
  expect(sh).not.toMatch(/^\s*read\s+-/m);
});
