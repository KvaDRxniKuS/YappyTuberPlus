#!/usr/bin/env node
/**
 * Обновление рабочей копии: забрать ветку, не потеряв ничего пользовательского.
 *
 * Раньше это делали сами лаунчеры — двумя наборами команд на batch и bash. Тут
 * то же самое одним файлом на Node (он всё равно нужен лаунчеру), и с одной
 * важной разницей: **папка сборки — не правка кода**.
 *
 * Папка сборки (`dist`) лежит в репозитории, потому что из неё берутся
 * обновления. Для git же своя сборка выглядит как изменённые файлы репозитория,
 * и раньше лаунчер честно «прятал» её в `git stash` — после запуска на диске
 * оказывалась версия из репозитория, а своя сборка уезжала в список
 * припрятанного. Теперь по-другому:
 *
 * - папка сборки **копируется** во временную папку, обновление идёт своим ходом,
 *   потом сборка возвращается на место — своя остаётся своей;
 * - правки в исходниках по-прежнему уходят в `git stash` (и это сказано прямо),
 *   потому что вернуть их иначе неоткуда; если stash не удался, обновление
 *   отменяется, а не стирает правки;
 * - о расхождении сборки с репозиторием сообщается одной строкой, без «правок
 *   файлов репозитория», которых не было.
 *
 * Запуск (лаунчеры вызывают именно так):
 *
 * ```
 * node scripts/sync-repo.mjs --branch arena/… --fallback main
 * node scripts/sync-repo.mjs --dry-run          # показать план, ничего не меняя
 * ```
 *
 * Коды возврата: 0 — обновлено или обновлять нечего (можно работать),
 * 2 — обновить не удалось (лаунчер предупредит и продолжит со старыми файлами),
 * 3 — это не git-копия вовсе (тоже не повод останавливать запуск).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);

function argument(name, fallback) {
  const index = args.indexOf(name);
  const next = args[index + 1];
  if (index >= 0 && next && !next.startsWith("--")) return next;
  const inline = args.find((value) => value.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

const branch = argument("--branch", "");
const fallbackBranch = argument("--fallback", "main");
const remote = argument("--remote", "origin");
const repoUrl = argument("--repo", "https://github.com/KvaDRxniKuS/YappyTuberPlus.git");
const folder = argument("--folder", "dist").replace(/[\\/]+$/, "");
const dryRun = args.includes("--dry-run");

const say = (line = "") => console.log(line);
const warn = (line) => console.log(`** ${line}`);

/** git без исключений: нужен ответ, а не падение лаунчера. */
function git(gitArgs) {
  try {
    const out = execFileSync("git", gitArgs, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // `out` — как есть: у `git status` первый символ строки значащий, и
    // обрезка пробелов съела бы первую букву пути.
    return { ok: true, out, text: out.trim() };
  } catch (error) {
    return {
      ok: false,
      out: String(error.stdout ?? ""),
      text: String(error.stdout ?? "").trim(),
      err: String(error.stderr ?? "").trim(),
    };
  }
}

/** Что изменено в отслеживаемых файлах: список путей. */
function changedPaths() {
  return git(["status", "--porcelain", "--untracked-files=no"]).out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      // «XY путь» либо «XY старый -> новый»: берём итоговый путь.
      const rest = line.slice(3);
      const arrow = rest.indexOf(" -> ");
      return (arrow >= 0 ? rest.slice(arrow + 4) : rest).trim();
    })
    .filter(Boolean);
}

const inFolder = (path) => path === folder || path.startsWith(`${folder}/`);

// --- 0. это вообще git-копия? ----------------------------------------------
if (!git(["rev-parse", "--is-inside-work-tree"]).ok) {
  say("Автообновление недоступно: папка не является git-репозиторием.");
  process.exit(3);
}

// --- 1. удалённый репозиторий и получение веток -----------------------------
if (!git(["remote", "get-url", remote]).ok) {
  if (dryRun) {
    say(`Удалённого ${remote} нет — добавил бы ${repoUrl}.`);
  } else {
    git(["remote", "add", remote, repoUrl]);
  }
}
if (!git(["fetch", remote, "--prune"]).ok) {
  warn("git fetch не удался, работаю с локальной копией.");
}

// --- 2. какую ветку брать: ту, где последний коммит новее -------------------
const exists = (name) => Boolean(name) && git(["rev-parse", "--verify", "--quiet", `origin/${name}`]).ok;
const stamp = (name) => Number(git(["log", "-1", "--format=%ct", `origin/${name}`]).text || 0);
const hasSession = exists(branch);
const hasFallback = exists(fallbackBranch);
if (!hasSession && !hasFallback) {
  warn("ветки не получены с удалённого репозитория — продолжаю без обновления.");
  process.exit(2);
}
let target = hasSession ? branch : fallbackBranch;
if (hasSession && hasFallback && stamp(fallbackBranch) > stamp(branch)) target = fallbackBranch;
if (!hasSession) warn(`ветка ${branch} не найдена на удалённом репозитории, использую ${fallbackBranch}.`);
say(`Ветка обновления: ${target}`);

// --- 3. что уже изменено: правки кода отдельно, сборка отдельно -------------
const dirty = changedPaths();
const codeChanged = dirty.filter((path) => !inFolder(path));
const folderChanged = dirty.length - codeChanged.length;

let backup = "";
if (folderChanged > 0 && existsSync(join(root, folder))) {
  say(`В папке ${folder} лежит своя сборка (${folderChanged} файлов) — сохраняю и верну её после обновления.`);
  if (!dryRun) {
    // Копия рядом с системной временной папкой: обновление её не касается.
    backup = mkdtempSync(join(tmpdir(), "yappytuber-dist-"));
    cpSync(join(root, folder), backup, { recursive: true });
    // Приводим папку к версии репозитория: иначе git не даст обновить ветку.
    git(["checkout", "--", folder]);
  }
}

/** Вернуть сборку на место поверх обновлённого репозитория. */
function restoreFolder() {
  if (dryRun || !backup) return;
  rmSync(join(root, folder), { recursive: true, force: true });
  cpSync(backup, join(root, folder), { recursive: true });
  rmSync(backup, { recursive: true, force: true });
  backup = "";
  say(`Своя сборка в ${folder} возвращена на место (в репозитории — версия из обновления).`);
  say(`  опубликовать: app-publish.bat · взять версию репозитория: git checkout -- ${folder}`);
}

/** Обновление не состоялось: вернуть всё как было и сказать честно. */
function abort(reason) {
  warn(reason);
  restoreFolder();
  process.exit(2);
}

if (codeChanged.length) {
  say(`Правки в исходниках (${codeChanged.length}) ${dryRun ? "уйдут" : "сохраняю"} в git stash — yappytuber auto-backup:`);
  for (const path of codeChanged.slice(0, 5)) say(`  ${path}`);
  if (codeChanged.length > 5) say(`  … и ещё ${codeChanged.length - 5}`);
  say("  вернуть: git stash pop");
  if (!dryRun) {
    // Папку сборки в stash не кладём: она сохранена отдельно.
    const stashed = git(["stash", "push", "-m", "yappytuber auto-backup", "--", ".", `:(exclude)${folder}`]);
    if (!stashed.ok) {
      // Старый git или необычный путь: пробуем совсем простое.
      if (!git(["stash", "push", "-m", "yappytuber auto-backup"]).ok) {
        abort("не удалось сохранить правки в git stash — обновление отменено, файлы не тронуты.");
      }
    }
  }
}

// --- 4. переключение ветки ---------------------------------------------------
const hasHead = git(["rev-parse", "--verify", "--quiet", "HEAD"]).ok;
const current = hasHead ? git(["rev-parse", "--abbrev-ref", "HEAD"]).text : "";
if (!hasHead) {
  // Репозиторий без коммитов (например, после git init): ставим ветку и файлы.
  if (!dryRun) {
    git(["symbolic-ref", "HEAD", `refs/heads/${target}`]);
    if (!git(["reset", "--hard", `origin/${target}`]).ok) abort("не удалось разложить файлы ветки.");
  }
} else if (current !== target) {
  if (!dryRun) {
    if (!git(["checkout", target]).ok && !git(["checkout", "-b", target, `origin/${target}`]).ok) {
      abort(`не удалось переключиться на ветку ${target}.`);
    }
  }
  say(`Ветка: ${target}`);
}

// --- 5. обновление ----------------------------------------------------------
if (!dryRun) {
  if (!git(["merge", "--ff-only", `origin/${target}`]).ok) {
    warn(`ветка разошлась с удалённой — жёсткий сброс на origin/${target};`);
    say("  прежнее состояние доступно через: git reflog");
    if (!git(["reset", "--hard", `origin/${target}`]).ok) abort("жёсткий сброс не удался.");
  }
  say(`Ветка: ${git(["rev-parse", "--abbrev-ref", "HEAD"]).text} · ${git(["log", "-1", "--format=%h %s"]).text}`);
}

restoreFolder();
say(dryRun ? "Проверка (--dry-run): ничего не изменено." : "Обновление завершено.");
process.exit(0);
