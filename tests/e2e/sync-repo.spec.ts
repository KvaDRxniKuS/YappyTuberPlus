import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * Обновление рабочей копии (scripts/sync-repo.mjs).
 *
 * Лаунчер раньше сам прятал «изменённые файлы репозитория» в git stash — и вместе
 * с правками уезжала папка сборки, которую пользователь собрал сам. Здесь
 * закреплено новое поведение: сборка возвращается на место, правки кода уходят в
 * stash (и об этом сказано), а если сохранить их не удалось — обновление
 * отменяется, а не стирает файлы.
 */

const root = process.cwd();
const script = join(root, "scripts", "sync-repo.mjs");
const BRANCH = "arena/test";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Запуск обновления: код возврата и весь вывод. */
function sync(cwd: string, args: string[] = []): { code: number; out: string } {
  try {
    const out = execFileSync("node", [script, "--branch", BRANCH, "--fallback", "main", ...args], {
      cwd,
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (reason) {
    const error = reason as { status?: number; stdout?: string; stderr?: string };
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

interface Env {
  /** «Удалённый» репозиторий: сюда пушим новую версию. */
  origin: string;
  /** Рабочая копия: здесь запускается обновление. */
  work: string;
  /** Вторая копия: из неё публикуем новую версию. */
  author: string;
}

/** Небольшой «репозиторий»: код в src, папка сборки в dist. */
function makeEnv(): Env {
  const base = mkdtempSync(join(tmpdir(), "yappy-sync-"));
  const origin = join(base, "origin.git");
  const author = join(base, "author");
  const work = join(base, "work");

  mkdirSync(join(author, "src"), { recursive: true });
  mkdirSync(join(author, "dist"), { recursive: true });
  writeFileSync(join(author, "src", "app.ts"), "код v1\n", "utf8");
  writeFileSync(join(author, "dist", "index.html"), "сборка v1\n", "utf8");

  git(author, ["init", "-q", "-b", BRANCH]);
  git(author, ["config", "user.email", "test@example.com"]);
  git(author, ["config", "user.name", "Тест"]);
  git(author, ["add", "-A"]);
  git(author, ["commit", "-qm", "v1"]);
  git(author, ["init", "-q", "--bare", origin]);
  git(author, ["remote", "add", "origin", origin]);
  git(author, ["push", "-q", "-u", "origin", "HEAD"]);

  // Ветка задаётся явно: у свежего bare-репозитория HEAD смотрит в master.
  git(base, ["clone", "-q", "-b", BRANCH, origin, work]);
  git(work, ["config", "user.email", "test@example.com"]);
  git(work, ["config", "user.name", "Тест"]);
  return { origin, work, author };
}

/** Новая версия в репозитории: меняет и код, и папку сборки. */
function publish(env: Env, name: string): void {
  writeFileSync(join(env.author, "src", "app.ts"), `код ${name}\n`, "utf8");
  writeFileSync(join(env.author, "dist", "index.html"), `сборка ${name}\n`, "utf8");
  git(env.author, ["add", "-A"]);
  git(env.author, ["commit", "-qm", name]);
  git(env.author, ["push", "-q", "origin", "HEAD"]);
}

test("обновление: своя сборка остаётся, правки кода уходят в stash", () => {
  const env = makeEnv();
  publish(env, "v2");
  writeFileSync(join(env.work, "dist", "index.html"), "МОЯ СБОРКА\n", "utf8");
  writeFileSync(join(env.work, "src", "app.ts"), "код v1\nмоя правка\n", "utf8");

  const result = sync(env.work);
  expect(result.code).toBe(0);
  // Сборка на месте — своя, а не из репозитория.
  expect(readFileSync(join(env.work, "dist", "index.html"), "utf8")).toContain("МОЯ СБОРКА");
  // Код обновлён до версии из репозитория.
  expect(readFileSync(join(env.work, "src", "app.ts"), "utf8")).toContain("код v2");
  // Правка не потеряна: она в stash, и об этом сказано.
  expect(git(env.work, ["stash", "list"])).toContain("yappytuber auto-backup");
  expect(git(env.work, ["stash", "show", "-p"])).toContain("моя правка");
  expect(result.out).toContain("git stash");
  expect(result.out).toContain("вернуть: git stash pop");
  // В stash нет папки сборки: она сохранена отдельно.
  expect(git(env.work, ["stash", "show", "--name-only"])).not.toContain("dist/");
  expect(result.out.toLowerCase()).toContain("возвращена на место");
});

test("обновление: изменена только сборка — stash не создаётся", () => {
  const env = makeEnv();
  publish(env, "v2");
  writeFileSync(join(env.work, "dist", "index.html"), "ТОЛЬКО СБОРКА\n", "utf8");

  const result = sync(env.work);
  expect(result.code).toBe(0);
  expect(readFileSync(join(env.work, "dist", "index.html"), "utf8")).toContain("ТОЛЬКО СБОРКА");
  expect(readFileSync(join(env.work, "src", "app.ts"), "utf8")).toContain("код v2");
  // Молча ничего не «прячем»: ни лишнего stash, ни слова про правки репозитория.
  expect(git(env.work, ["stash", "list"])).toBe("");
  expect(result.out).not.toContain("Правки в исходниках");
  expect(result.out).toContain("своя сборка");
});

test("обновление: расхождение веток — сброс, сборка цела", () => {
  const env = makeEnv();
  // Локальный коммит, которого нет в репозитории.
  writeFileSync(join(env.work, "local.txt"), "локально\n", "utf8");
  git(env.work, ["add", "-A"]);
  git(env.work, ["commit", "-qm", "локально"]);
  publish(env, "v3");
  writeFileSync(join(env.work, "dist", "index.html"), "СБОРКА ПОСЛЕ СБРОСА\n", "utf8");

  const result = sync(env.work);
  expect(result.code).toBe(0);
  expect(result.out).toContain("разошлась");
  expect(readFileSync(join(env.work, "src", "app.ts"), "utf8")).toContain("код v3");
  expect(readFileSync(join(env.work, "dist", "index.html"), "utf8")).toContain("СБОРКА ПОСЛЕ СБРОСА");
});

test("обновление: --dry-run ничего не меняет", () => {
  const env = makeEnv();
  publish(env, "v2");
  writeFileSync(join(env.work, "dist", "index.html"), "СБОРКА ДО ПРОВЕРКИ\n", "utf8");
  writeFileSync(join(env.work, "src", "app.ts"), "код v1\nправка\n", "utf8");

  const result = sync(env.work, ["--dry-run"]);
  expect(result.code).toBe(0);
  expect(result.out).toContain("ничего не изменено");
  // Всё как было: и правка, и сборка, и отсутствие stash.
  expect(readFileSync(join(env.work, "src", "app.ts"), "utf8")).toContain("правка");
  expect(readFileSync(join(env.work, "dist", "index.html"), "utf8")).toContain("СБОРКА ДО ПРОВЕРКИ");
  expect(git(env.work, ["stash", "list"])).toBe("");
});

test("обновление: не git-копия и репозиторий без коммитов", () => {
  const plain = mkdtempSync(join(tmpdir(), "yappy-plain-"));
  const outside = sync(plain);
  expect(outside.code).toBe(3);
  expect(outside.out).toContain("не является git-репозиторием");

  // Пустая копия с удалённым репозиторием: ветка раскладывается с нуля.
  const env = makeEnv();
  const fresh = mkdtempSync(join(tmpdir(), "yappy-fresh-"));
  git(fresh, ["init", "-q"]);
  git(fresh, ["remote", "add", "origin", env.origin]);
  const blank = sync(fresh);
  expect(blank.code).toBe(0);
  expect(git(fresh, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(BRANCH);
  expect(existsSync(join(fresh, "src", "app.ts"))).toBe(true);
});

/** Строки без комментариев: `rem` в batch, `#` в bash. */
function commands(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*(rem\b|::|#)/i.test(line))
    .join("\n");
}

/** Кусок файла между двумя отметками: обе не входят. */
function slice(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  expect(start, `отметка «${from}» есть`).toBeGreaterThan(-1);
  expect(end, `отметка «${to}» идёт после`).toBeGreaterThan(start);
  return text.slice(start, end);
}

test("обновление зовёт общий скрипт, а не прячет папку сборки само", () => {
  // Обновление отделено от запуска: `start` больше ничего не скачивает и не
  // собирает, поэтому эти проверки смотрят на `update`.
  const bat = readFileSync(join(root, "app-update.bat"), "utf8");
  const sh = readFileSync(join(root, "app-update.sh"), "utf8");

  // Обновление — один вызов на обеих платформах.
  const batUpdate = slice(bat, ":update\r\n", "rem --- зависимости");
  const shUpdate = slice(sh, "# --- обновление", "# --- зависимости");
  for (const part of [batUpdate, shUpdate]) {
    const executable = commands(part);
    expect(executable).toContain("sync-repo.mjs");
    // Ручного stash в лаунчерах больше нет: папку сборки сохраняет скрипт.
    expect(executable).not.toContain("git stash");
    // Сброс и переключение веток тоже ушли в скрипт.
    expect(executable).not.toContain("git reset --hard");
  }

  // Коды возврата трактуются мягко: не обновились — работаем с текущими файлами.
  expect(bat).toContain("Обновление не удалось");
  expect(sh).toContain("работаю с текущими файлами");

  // А сам запуск к git не прикасается вовсе.
  for (const name of ["app-start.bat", "app-start.sh"]) {
    const text = readFileSync(join(root, name), "utf8");
    expect(commands(text), name).not.toContain("sync-repo.mjs");
    expect(commands(text), name).not.toContain("git clone");
  }
});
