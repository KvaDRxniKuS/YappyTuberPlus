import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  expect(info.packaging).toBe("1.0.0");
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
