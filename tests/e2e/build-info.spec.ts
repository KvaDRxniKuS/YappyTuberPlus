import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInfoLine, buildInfoMessage, buildInfoSlots, type BuildInfo,
} from "../../src/engine/buildInfo";
import { VERSION, parseVersion, versionString } from "../../src/version";

/*
 * Паспорт собранной папки: `build.json` рядом с `index.html`. Проверяется, что
 * сборка пишет те же числа, что и редактор, что «чужая» папка видна, а
 * `--check` отличает свежую папку от старой.
 */

const root = process.cwd();

/**
 * Копия готовой папки во временном месте: файлы те же, паспорт новый.
 * `--out` пишет только паспорт, поэтому файлы копируются заранее — иначе
 * в списке `files[]` было бы пусто и сверять состав было бы не с чем.
 */
function builtFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "yappy-contents-"));
  cpSync(join(root, "dist"), folder, { recursive: true });
  execFileSync("node", ["scripts/build-version.mjs", "--out", folder], { cwd: root, encoding: "utf8" });
  return folder;
}

/** Запуск проверки: код возврата и весь её вывод. */
function check(folder: string): { code: number; out: string } {
  try {
    const out = execFileSync("node", ["scripts/build-version.mjs", "--check", folder], { cwd: root, encoding: "utf8" });
    return { code: 0, out };
  } catch (reason) {
    const error = reason as { status?: number; stdout?: string; stderr?: string };
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

test("сборка: числа в build.json совпадают с редактором", () => {
  const folder = mkdtempSync(join(tmpdir(), "yappy-build-"));
  execFileSync("node", ["scripts/build-version.mjs", "--out", folder], { cwd: root, encoding: "utf8" });
  const info = JSON.parse(readFileSync(join(folder, "build.json"), "utf8"));
  expect(info.version).toBe(versionString());
  expect(info.core).toBe(VERSION.core);
  expect(info.format).toBe(VERSION.format);
  expect(info.bridge).toBe(VERSION.bridge);
  expect(info.modules).toBe(VERSION.modules);
  expect(info.shell).toBe(VERSION.shell);
  // Версия упаковки — из package.json: раньше здесь стояло «1.0.0» руками, и
  // после релиза 1.1 тест падал на верном числе.
  expect(info.packaging).toBe(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
  expect(info.schema).toBe(1);
  expect(typeof info.builtAt).toBe("string");

  // Своя папка — проверка проходит.
  const ok = execFileSync("node", ["scripts/build-version.mjs", "--check", folder], { cwd: root, encoding: "utf8" });
  expect(ok).toContain("Совпадает");

  // Старая папка — проверка падает с перечнем слоёв.
  writeFileSync(join(folder, "build.json"), JSON.stringify({ ...info, core: info.core - 1 }), "utf8");
  expect(() => execFileSync("node", ["scripts/build-version.mjs", "--check", folder], { cwd: root, encoding: "utf8" }))
    .toThrow();
});

test("сборка: папки без паспорта объясняют, что делать", () => {
  const folder = mkdtempSync(join(tmpdir(), "yappy-build-empty-"));
  try {
    execFileSync("node", ["scripts/build-version.mjs", "--check", folder], { cwd: root, encoding: "utf8" });
    throw new Error("проверка должна была упасть");
  } catch (reason) {
    const output = `${(reason as { stdout?: string }).stdout ?? ""}${(reason as { stderr?: string }).stderr ?? ""}`;
    expect(output).toContain("нет build.json");
  }
});

test("сборка: папка со своим паспортом — тишина", () => {
  const own: BuildInfo = {
    version: versionString(),
    builtAt: "2026-10-27T12:00:00.000Z",
    commit: "abc1234",
  };
  expect(buildInfoSlots(own)).toEqual([]);
  expect(buildInfoMessage(own)).toBeNull();
  expect(buildInfoLine(own)).toContain("сборка");
  expect(buildInfoLine(own)).toContain("abc1234");
  // Файла нет (разработка) — тоже тишина.
  expect(buildInfoMessage(null)).toBeNull();
  expect(buildInfoLine(null)).toBeNull();
});

test("сборка: смешанная папка видна по слоям", () => {
  const current = parseVersion(versionString())!;
  const stale: BuildInfo = {
    version: [1, 0, current.core - 3, current.format, current.bridge, current.modules, current.shell].join("."),
    builtAt: "2026-10-20T09:00:00.000Z",
  };
  expect(buildInfoSlots(stale)).toEqual(["core"]);
  const message = buildInfoMessage(stale)!;
  expect(message).toContain("другой версии");
  expect(message).toContain(`ядро: в папке ${current.core - 3}, в коде ${current.core}`);
  expect(message).toContain("npm run build");
});

test("проверка папки: изменённый файл виден по отпечатку", () => {
  const folder = builtFolder();
  // Дописали байт в шаблон модуля: размер и хеш разошлись с паспортом.
  writeFileSync(join(folder, "modules", "key.json"), " ", { flag: "a" });
  const result = check(folder);
  expect(result.code).toBe(1);
  expect(result.out).toContain("Состав папки не совпадает с паспортом");
  expect(result.out).toContain("modules/key.json");
  expect(result.out).toContain("npm run build");
});

test("проверка папки: пропавший файл останавливает, лишний — только замечание", () => {
  const missing = builtFolder();
  rmSync(join(missing, "modules", "manual.json"));
  const gone = check(missing);
  expect(gone.code).toBe(1);
  expect(gone.out).toContain("modules/manual.json: файла нет в папке");

  const extra = builtFolder();
  writeFileSync(join(extra, "modules", "чужой.json"), "{}", "utf8");
  const stray = check(extra);
  expect(stray.code).toBe(0);
  expect(stray.out).toContain("лишние файлы");
  expect(stray.out).toContain("modules/чужой.json");
  // Временный файл недокачанного обновления мусором не считается.
  const temporary = builtFolder();
  writeFileSync(join(temporary, "app.update"), "x", "utf8");
  expect(check(temporary).out).not.toContain("лишние файлы");
});

test("проверка папки: отставший код виден, но не мешает", () => {
  const folder = builtFolder();
  const info = JSON.parse(readFileSync(join(folder, "build.json"), "utf8"));
  const rootCommit = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  // Папка «собрана» из самого первого коммита: код с тех пор точно менялся.
  writeFileSync(join(folder, "build.json"), JSON.stringify({ ...info, commit: rootCommit }), "utf8");
  const result = check(folder);
  expect(result.code).toBe(0);
  expect(result.out).toContain("код с тех пор менялся");
  expect(result.out).toContain(rootCommit);

  // Коммита нет в этой копии — тоже замечание, а не отказ.
  writeFileSync(join(folder, "build.json"), JSON.stringify({ ...info, commit: "deadbee" }), "utf8");
  const foreign = check(folder);
  expect(foreign.code).toBe(0);
  expect(foreign.out).toContain("которого нет в этой копии");
});
