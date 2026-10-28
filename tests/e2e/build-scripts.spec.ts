import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
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

test("сборка: при успехе окно закрывается, папку открывает сам", () => {
  const bat = script("build-yappytuber.bat");
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
  const bat = script("build-yappytuber.bat");
  expect(section(bat, "npm_failed", "build_failed")).toContain("pause");
  expect(section(bat, "build_failed", "usage")).toContain("pause");
});

test("сборка: папку можно не открывать — ключ --no-open", () => {
  const bat = script("build-yappytuber.bat");
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
  const updateBat = code(script("update-yappytuber.bat"));
  const updateSh = script("update-yappytuber.sh");
  const startBat = code(script("start-yappytuber.bat"));
  const startSh = script("start-yappytuber.sh");

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
  for (const name of ["build-yappytuber.bat", "install-build-tools.bat", "start-yappytuber.bat", "update-yappytuber.bat"]) {
    const text = code(script(name));
    expect(text, name).not.toContain("choice ");
    expect(text, name).toContain("set /p");
  }
});

test("linux/macOS: папка с пакетом открывается сама и без ожидания", () => {
  const sh = script("build-yappytuber.sh");
  expect(sh).toContain("--no-open) OPEN=0 ;;");
  expect(sh).toContain('xdg-open "$TARGET"');
  expect(sh).toContain('open "$TARGET"');
  // Сценарий не просит нажатий: паузы в нём быть не должно.
  expect(sh).not.toMatch(/^\s*read\s+-/m);
});
