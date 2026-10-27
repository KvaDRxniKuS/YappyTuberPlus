#!/usr/bin/env node
/**
 * Публикация готовой папки сборки в репозиторий.
 *
 * Зачем отдельная кнопка: обновление читается из репозитория, значит «выпустить
 * версию» = закоммитить и запушить папку. Но собирать здесь нельзя — сборку
 * делает `npm run build` (или `build-yappytuber.bat`), и её сначала нужно
 * проверить руками. Поэтому скрипт **только публикует** и никогда не собирает.
 *
 * Порядок проверок — от дешёвых к дорогим, и ни одна не пропускается:
 *
 * 1. в папке есть `build.json` — иначе публиковать нечего;
 * 2. папка совпадает с репозиторием по числам (`build:check`) — иначе это
 *    сборка другого кода;
 * 3. в исходниках нет незакоммиченных правок — иначе в репозиторий уехала бы
 *    папка, собранная из несуществующего кода;
 * 4. есть что публиковать (`git status` по папке и `public/rig_core.wasm`);
 * 5. есть права на пуш (`git push --dry-run`): вход в GitHub выполнен.
 *
 * Запуск:
 *
 * ```
 * npm run build:publish            # опубликовать dist
 * npm run build:publish -- --check # показать, что уедет, ничего не делая
 * node scripts/publish-build.mjs --folder D:\Rig\dist
 * ```
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);

function argument(name, fallback) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  const inline = args.find((value) => value.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

const folder = argument("--folder", "dist").replace(/[\\/]+$/, "");
const remote = argument("--remote", "origin");
const checkOnly = args.includes("--check");

/** Запуск git без оболочки: вывод нужен и для разбора, и для человека. */
function git(gitArgs, options = {}) {
  try {
    const out = execFileSync("git", gitArgs, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Вывод не обрезаем: у `git status` первый символ строки — код состояния,
    // и на нём держится разбор путей.
    return { ok: true, out, err: "" };
  } catch (error) {
    return {
      ok: false,
      out: String(error.stdout ?? ""),
      err: String(error.stderr ?? error.message ?? "").trim(),
    };
  }
}

function stop(message, hint) {
  console.error(`\n** ${message}`);
  if (hint) console.error(`   ${hint}`);
  process.exit(1);
}

// --- 1. паспорт папки -------------------------------------------------------
const manifestPath = join(root, folder, "build.json");
if (!existsSync(manifestPath)) {
  stop(
    `в папке ${folder} нет build.json: похоже, сборки там нет.`,
    "Соберите папку (npm run build или build-yappytuber.bat), проверьте её, потом публикуйте.",
  );
}
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  stop(`файл ${folder}/build.json не читается как JSON.`, "Пересоберите папку — он пишется сборкой.");
}
const version = typeof manifest.version === "string" ? manifest.version : "?";
const files = Array.isArray(manifest.files) ? manifest.files.length : 0;

// --- 2. репозиторий и ветка -------------------------------------------------
if (!git(["rev-parse", "--is-inside-work-tree"]).ok) {
  stop("эта папка не git-репозиторий: публиковать некуда.", "Работать нужно внутри копии репозитория.");
}
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).out.trim();
if (!branch || branch === "HEAD") {
  stop("вы на отвязанном коммите (detached HEAD).", "Переключитесь на ветку и повторите.");
}
if (!git(["remote", "get-url", remote]).ok) {
  stop(`у репозитория нет удалённого ${remote}.`, "Проверьте, что это копия YappyTuberPlus.");
}

// --- 3. папка совпадает с репозиторием по числам ----------------------------
try {
  const output = execFileSync("node", ["scripts/build-version.mjs", "--check", folder], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(output);
} catch (error) {
  process.stdout.write(String(error.stdout ?? ""));
  process.stderr.write(String(error.stderr ?? ""));
  stop(
    `папка ${folder} не совпадает с репозиторием по версии.`,
    "Пересоберите её целиком и проверьте: публиковать чужую сборку нельзя.",
  );
}

// --- 4. исходники чистые ----------------------------------------------------
/** Пути, которые и есть публикация: папка сборки и собранное ядро. */
const published = [folder, "public/rig_core.wasm"];
/** Путь из строки `git status --porcelain`: после кода состояния, с учётом переименований. */
function statusPath(line) {
  const rest = line.slice(3);
  const arrow = rest.indexOf(" -> ");
  return (arrow >= 0 ? rest.slice(arrow + 4) : rest).trim();
}

const statusAll = git(["status", "--porcelain", "--untracked-files=no"]).out
  .split("\n")
  .filter(Boolean)
  .map(statusPath)
  .filter(Boolean);
const foreign = statusAll.filter(
  (path) => !published.some((allowed) => path === allowed || path.startsWith(`${allowed}/`)),
);
if (foreign.length) {
  stop(
    `в исходниках есть незакоммиченные правки (${foreign.length}): ${foreign.slice(0, 5).join(", ")}`
      + (foreign.length > 5 ? " …" : ""),
    "Публикуется снимок репозитория: сначала закоммитьте код, потом публикуйте папку.",
  );
}

// --- 5. что именно уедет ----------------------------------------------------
const changed = git(["status", "--porcelain", "--untracked-files=all", "--", ...published]).out
  .split("\n")
  .filter(Boolean)
  .map((line) => line.trimEnd());
if (!changed.length) {
  console.log(`\nПубликовать нечего: ${folder} и public/rig_core.wasm уже совпадают с репозиторием.`);
  process.exit(0);
}
console.log(`\nК публикации: ${changed.length} файлов · версия ${version}${files ? ` · в паспорте ${files}` : ""}`);
for (const line of changed.slice(0, 12)) console.log(`  ${line}`);
if (changed.length > 12) console.log(`  … и ещё ${changed.length - 12}`);

if (checkOnly) {
  console.log("\nПроверка (--check): ничего не закоммичено и не отправлено.");
  process.exit(0);
}

// --- 6. права на пуш --------------------------------------------------------
const probe = git(["push", "--dry-run", remote, "HEAD"]);
if (!probe.ok) {
  const reason = (probe.err || probe.out).split("\n").slice(-3).join("\n   ");
  stop(
    `нет доступа к ${remote}: отправить сборку не получится.`,
    `Проверьте вход в GitHub (git push просит логин и токен).\n   ${reason}`,
  );
}

// --- 7. коммит и пуш --------------------------------------------------------
const message = `Сборка ${version}`;
if (!git(["add", "--", ...published]).ok) {
  stop("не удалось подготовить файлы сборки к коммиту.", "Проверьте права на файлы папки.");
}
const commit = git(["commit", "-m", message]);
if (!commit.ok) {
  stop("коммит не создался.", commit.err || commit.out);
}
const hash = git(["rev-parse", "--short", "HEAD"]).out.trim();
const push = git(["push", remote, "HEAD"]);
if (!push.ok) {
  stop(
    "сборка закоммичена, но не отправлена.",
    `Повторите публикацию: ${push.err || push.out}`,
  );
}

console.log(`\nОпубликовано: ${version} · файлов ${changed.length} · коммит ${hash} · ветка ${branch}`);
console.log(`Проверить может любой: https://raw.githubusercontent.com/KvaDRxniKuS/YappyTuberPlus/${branch}/dist/build.json`);
console.log(`Папка на диске: ${relative(root, join(root, folder)) || "."}`);
