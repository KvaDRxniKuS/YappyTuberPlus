import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * Публикация папки сборки.
 *
 * Кнопка только публикует: сборку делает `npm run build`, проверку — человек.
 * Здесь проверяются её предохранители: папка без паспорта, незакоммиченные
 * исходники, отсутствие доступа и повторная публикация того же самого.
 */

const root = process.cwd();

/** Запуск скрипта публикации. Не падает на ошибке — её и проверяем. */
function publish(cwd: string, args: string[] = []): { code: number; out: string } {
  try {
    const out = execFileSync("node", ["scripts/publish-build.mjs", ...args], { cwd, encoding: "utf8" });
    return { code: 0, out };
  } catch (reason) {
    const error = reason as { status?: number; stdout?: string; stderr?: string };
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * «Пересобрать» папку: поменять файл и переписать паспорт под новое содержимое.
 * Так выглядит настоящая сборка — манифест всегда описывает то, что лежит рядом.
 */
function rebuild(dir: string, file = "index.html", body = "<!doctype html><title>новая</title>"): void {
  writeFileSync(join(dir, "dist", file), body, "utf8");
  execFileSync("node", ["scripts/build-version.mjs", "--out", "dist"], { cwd: dir, encoding: "utf8" });
}

/**
 * Небольшая копия репозитория с готовой папкой сборки и своим «удалённым»
 * репозиторием: публикация проверяется целиком, включая коммит и пуш.
 */
function makeRepo(): { dir: string; remote: string } {
  const dir = mkdtempSync(join(tmpdir(), "yappy-publish-"));
  const remote = `${dir}-remote.git`;
  // Скриптам нужны версия, протокол моста и поколение ядра.
  cpSync(join(root, "scripts"), join(dir, "scripts"), { recursive: true });
  cpSync(join(root, "dist"), join(dir, "dist"), { recursive: true });
  cpSync(join(root, "public", "rig_core.wasm"), join(dir, "public", "rig_core.wasm"));
  mkdirSync(join(dir, "src", "overlay"), { recursive: true });
  cpSync(join(root, "src", "version.ts"), join(dir, "src", "version.ts"));
  cpSync(join(root, "src", "overlay", "protocol.ts"), join(dir, "src", "overlay", "protocol.ts"));
  mkdirSync(join(dir, "crates", "rig-core", "src"), { recursive: true });
  cpSync(
    join(root, "crates", "rig-core", "src", "lib.rs"),
    join(dir, "crates", "rig-core", "src", "lib.rs"),
  );

  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Тест"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "старт"]);
  git(dir, ["init", "-q", "--bare", remote]);
  git(dir, ["remote", "add", "origin", remote]);
  git(dir, ["push", "-q", "-u", "origin", "HEAD"]);
  return { dir, remote };
}

test("публикация: без изменений ничего не делает", () => {
  const { dir } = makeRepo();
  const result = publish(dir, ["--check"]);
  expect(result.code).toBe(0);
  expect(result.out).toContain("Совпадает");
  expect(result.out).toContain("Публиковать нечего");
  // Ничего не закоммичено: рабочая копия осталась чистой.
  expect(git(dir, ["status", "--porcelain"])).toBe("");
});

test("публикация: изменённая папка уезжает в репозиторий", () => {
  const { dir, remote } = makeRepo();
  rebuild(dir);

  // «--check» показывает, что уедет, но не отправляет.
  const check = publish(dir, ["--check"]);
  expect(check.code).toBe(0);
  expect(check.out).toContain("К публикации");
  expect(check.out).toContain("dist/index.html");
  expect(git(dir, ["status", "--porcelain"])).toContain("dist/index.html");

  const publishResult = publish(dir);
  expect(publishResult.code).toBe(0);
  expect(publishResult.out).toContain("Опубликовано");
  // В удалённом репозитории появился коммит сборки.
  // Ветка по умолчанию у пустого bare-репозитория — master, а пушим мы main.
  expect(git(remote, ["log", "main", "--oneline", "-1"])).toContain("Сборка");

  // Второй раз публиковать нечего.
  expect(publish(dir).out).toContain("Публиковать нечего");
});

test("публикация: незакоммиченные исходники останавливают", () => {
  const { dir } = makeRepo();
  rebuild(dir, "index.html", "<!doctype html><title>x</title>");
  writeFileSync(join(dir, "src", "version.ts"), "\n// правка\n", { flag: "a" });

  const result = publish(dir);
  expect(result.code).toBe(1);
  expect(result.out).toContain("незакоммиченные правки");
  expect(result.out).toContain("src/version.ts");
  // Папка сборки не уехала: в репозитории только стартовый коммит.
  expect(git(dir, ["log", "--oneline"])).not.toContain("Сборка");
});

test("публикация: пустая папка и отсутствие доступа объясняются", () => {
  const empty = mkdtempSync(join(tmpdir(), "yappy-empty-"));
  const missing = publish(root, ["--folder", empty]);
  expect(missing.code).toBe(1);
  expect(missing.out).toContain("нет build.json");

  const { dir } = makeRepo();
  rebuild(dir, "index.html", "<!doctype html><title>y</title>");
  git(dir, ["remote", "set-url", "origin", join(dir, "ничего-нет.git")]);
  const noAccess = publish(dir);
  expect(noAccess.code).toBe(1);
  expect(noAccess.out).toContain("нет доступа");
});

test("публикация: папка, изменённая в обход паспорта, не уезжает", () => {
  const { dir } = makeRepo();
  // Файл поправили руками, паспорт остался от сборки: содержимое и хеши разошлись.
  writeFileSync(join(dir, "dist", "index.html"), "<!doctype html><title>правка руками</title>", "utf8");
  const result = publish(dir);
  expect(result.code).toBe(1);
  expect(result.out).toContain("Состав папки не совпадает с паспортом");
  // Пути в паспорте — относительно папки сборки.
  expect(result.out).toContain("index.html");
  expect(git(dir, ["log", "--oneline"])).not.toContain("Сборка");
});

test("публикация: двойной клик без консоли", () => {
  const bat = readFileSync(join(root, "app-publish.bat"), "utf8");
  const sh = readFileSync(join(root, "app-publish.sh"), "utf8");

  // Ярлык зовёт скрипт и остаётся открытым только при ошибке.
  expect(bat).toContain("node scripts\\publish-build.mjs");
  expect(bat).toContain("pause");
  expect(bat).toContain("--check");
  expect(bat).toContain("САМ НЕ СОБИРАЕТ");
  expect(sh).toContain("node scripts/publish-build.mjs");
  expect(sh).toContain("Публикация не выполнена");
});
