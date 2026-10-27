#!/usr/bin/env node
/**
 * Версия внутри собранной папки.
 *
 * `vite build` кладёт в `dist` только файлы программы: по ним нельзя понять, из
 * какого коммита они собраны и какое поколение ядра внутри. Поэтому сборка
 * дописывает рядом `build.json` — паспорт самой папки:
 *
 * ```json
 * { "version": "1.0.21.3.1.1.1", "packaging": "1.0.0", "builtAt": "…", "commit": "…" }
 * ```
 *
 * Зачем это нужно:
 *
 * - **проверить папку перед раздачей** — `node scripts/build-version.mjs --check dist`
 *   скажет, совпадает ли она с репозиторием (или это сборка недельной давности);
 * - **проверить смешанную сборку** — приложение читает `build.json` при запуске
 *   и сравнивает со своими числами: если кто-то положил рядом `rig_core.wasm`
 *   от другой сборки, это видно сразу, а не по «почему формулы дают ноль»;
 * - **обновление** — когда появится автообновление, ему будет что сравнивать:
 *   папку сборки с сервером, не заглядывая внутрь бандлов.
 *
 * Запуск:
 *
 * ```
 * node scripts/build-version.mjs                 # записать dist/build.json
 * node scripts/build-version.mjs --out Папка     # записать в другую папку
 * node scripts/build-version.mjs --check Папка   # сверить папку с репозиторием
 * node scripts/build-version.mjs --print         # напечатать паспорт репозитория
 * ```
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { readVersion } from "./lib/version.mjs";

const root = process.cwd();
const args = process.argv.slice(2);

/** Дата для человека: ISO в файле, местное время в консоли. */
function humanTime(iso) {
  if (!iso) return "время неизвестно";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function flagValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

/** Коммит, из которого собрана папка; без git — `null`, сборка не должна падать. */
function commitHash() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Все файлы папки, кроме самого манифеста: по ним считается обновление. */
function listFiles(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile()) continue;
      const name = relative(dir, path).split(sep).join("/");
      if (name === "build.json") continue;
      found.push({ path: path, name: name });
    }
  };
  walk(dir);
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Список файлов папки с размерами и хешами.
 *
 * Нужен обновлению: приложение скачивает ровно эти файлы и проверяет, что
 * пришли те байты, а не обрезанный ответ сети или чужая подмена.
 */
function fileManifest(out) {
  if (!existsSync(out)) return [];
  return listFiles(out).map((file) => ({
    path: file.name,
    size: statSync(file.path).size,
    sha256: sha256(file.path),
  }));
}

/** Собранное приложение, если оно есть рядом: exe обновляется отдельно от фронтенда. */
function exeEntry() {
  const candidates = [
    join(root, "src-tauri", "target", "release", "yappytuberplus.exe"),
    join(root, "src-tauri", "target", "release", "yappytuberplus"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    return { path: "yappytuberplus.exe", size: statSync(path).size, sha256: sha256(path), source: path };
  }
  return null;
}

function buildInfo(out) {
  const version = readVersion(root);
  return {
    ...version,
    builtAt: new Date().toISOString(),
    commit: commitHash(),
    /** Поколение формата самого манифеста. */
    schema: 1,
    /** Что скачивать обновлению: путь относительно папки, размер, sha256. */
    files: out ? fileManifest(out) : [],
  };
}

const SLOTS = [
  ["release", "релиз"],
  ["core", "ядро"],
  ["format", "файл"],
  ["bridge", "мост"],
  ["modules", "модули"],
  ["shell", "оболочка"],
];

/** Любой git-вызов без падения: нужен ответ, а не исключение. */
function gitQuiet(gitArgs) {
  try {
    return execFileSync("git", gitArgs, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Сверка папки с её же паспортом: все ли файлы из `files[]` на месте и те ли
 * это байты.
 *
 * Номера версий отвечают на вопрос «из какого кода собрано», а этот список — на
 * вопрос «та ли это папка». Разница видна, когда файл потеряли при копировании,
 * дописали в него что-то руками или подложили чужой `rig_core.wasm` с тем же
 * поколением. Хеши считаются только по паспорту: без него проверять нечего.
 *
 * Пропавший или изменённый файл — ошибка (такую папку раздавать нельзя).
 * Лишний файл — только предупреждение: он не входит в обновление и ничего не
 * ломает, но о нём стоит знать.
 */
function compareContents(folder, info) {
  const problems = [];
  const notices = [];
  if (!Array.isArray(info.files) || info.files.length === 0) {
    notices.push("в паспорте нет списка файлов — сверка содержимого пропущена");
    return { problems, notices };
  }
  const listed = new Map(info.files.map((file) => [file.path, file]));
  const extra = [];
  for (const file of listFiles(folder)) {
    const known = listed.get(file.name);
    if (!known) {
      // Временный файл недокачанного обновления — мусор, а не расхождение.
      if (!file.name.endsWith(".update")) extra.push(file.name);
      continue;
    }
    listed.delete(file.name);
    const size = statSync(file.path).size;
    if (typeof known.size === "number" && known.size !== size) {
      problems.push(`${file.name}: ${size} байт вместо ${known.size}`);
      continue;
    }
    if (known.sha256 && sha256(file.path) !== known.sha256) {
      problems.push(`${file.name}: содержимое не совпало с отпечатком в паспорте`);
    }
  }
  for (const path of listed.keys()) problems.push(`${path}: файла нет в папке`);
  if (extra.length) {
    notices.push(`лишние файлы (в обновление не входят): ${extra.slice(0, 5).join(", ")}`
      + `${extra.length > 5 ? ` и ещё ${extra.length - 5}` : ""}`);
  }
  return { problems, notices };
}

/**
 * Отстал ли код от собранной папки.
 *
 * Молчать нельзя: папка, собранная неделю назад, выглядит «совпадающей», если
 * поколения не двигались. Но и ругаться на каждый запуск тоже незачем —
 * публикация папки сама создаёт коммит, и он ничего не значит. Поэтому
 * сравниваются только изменения **кода**: если между коммитом сборки и `HEAD`
 * трогали лишь `dist` и `public/rig_core.wasm`, предупреждения нет.
 */
function compareCommit(info) {
  const head = commitHash();
  if (!head || !info.commit) return null;
  if (head === info.commit) return null;
  if (gitQuiet(["cat-file", "-e", `${info.commit}^{commit}`]) === null) {
    return `папка собрана из коммита ${info.commit}, которого нет в этой копии репозитория`;
  }
  // Только то, что реально попадает в папку сборки. Документация, тесты и
  // скрипты публикации сборку не меняют — из-за них предупреждать незачем.
  const code = gitQuiet(["diff", "--name-only", info.commit, "HEAD", "--",
    "src", "crates", "public", "index.html", "overlay.html", "vite.config.ts",
    "package.json", "tsconfig.json", "scripts/build-wasm.mjs"]);
  // null — сравнить не удалось (например, коммит пришёл из другой истории).
  if (code === null || code === "") return null;
  const ahead = gitQuiet(["rev-list", "--count", `${info.commit}..HEAD`]) ?? "несколько";
  const files = code.split("\n").filter(Boolean);
  return `папка собрана из коммита ${info.commit}, а код с тех пор менялся `
    + `(${files.length} файлов, например ${files.slice(0, 3).join(", ")}) — `
    + `после таких правок папку пересобирают (всего коммитов после сборки: ${ahead})`;
}

/** Сравнение папки с репозиторием: по слоям, а не одной строкой. */
function compare(folder, info, current) {
  const lines = [];
  let differs = false;
  const folderRelease = Array.isArray(info.release) ? info.release.join(".") : null;
  if (folderRelease !== current.release.join(".")) {
    differs = true;
    lines.push(`релиз: в папке ${folderRelease ?? "—"}, в репозитории ${current.release.join(".")}`);
  }
  for (const [key, label] of SLOTS.slice(1)) {
    if (info[key] === undefined) {
      differs = true;
      lines.push(`${label}: в build.json нет поля «${key}»`);
      continue;
    }
    if (info[key] === current[key]) continue;
    const direction = info[key] < current[key] ? "старше репозитория" : "новее репозитория";
    differs = true;
    lines.push(`${label}: в папке ${info[key]}, в репозитории ${current[key]} — папка ${direction}`);
  }
  const contents = compareContents(folder, info);
  const commitNote = compareCommit(info);
  if (contents.problems.length) differs = true;

  console.log(`папка:       ${folder}`);
  console.log(`сборка:      ${info.version ?? "—"} · ${humanTime(info.builtAt)}`
    + `${info.commit ? ` · коммит ${info.commit}` : ""}`);
  console.log(`репозиторий: ${current.version}`);
  if (lines.length) {
    console.log("\nСлои версий не совпадают с репозиторием:");
    for (const line of lines) console.log(`  ${line}`);
  }
  if (contents.problems.length) {
    console.log("\nСостав папки не совпадает с паспортом:");
    for (const line of contents.problems.slice(0, 12)) console.log(`  ${line}`);
    if (contents.problems.length > 12) console.log(`  … и ещё ${contents.problems.length - 12}`);
  }
  for (const notice of contents.notices) console.log(`\nЗамечание: ${notice}`);
  if (commitNote) console.log(`\nЗамечание: ${commitNote}`);

  if (differs) {
    console.log("\nПапка не совпадает с репозиторием — пересоберите: npm run build.");
  } else {
    console.log("\nСовпадает: папку можно раздавать.");
  }
  return !differs;
}

if (args.includes("--print")) {
  console.log(JSON.stringify(buildInfo(), null, 2));
} else if (flagValue("--check")) {
  const folder = resolve(root, flagValue("--check"));
  const path = join(folder, "build.json");
  if (!existsSync(path)) {
    console.error(`В папке нет build.json: ${path}`);
    console.error("Значит, она собрана до появления паспорта сборки — пересоберите: npm run build.");
    process.exit(1);
  }
  const info = JSON.parse(readFileSync(path, "utf8"));
  const current = readVersion(root);
  process.exit(compare(folder, info, current) ? 0 : 1);
} else {
  const out = resolve(root, flagValue("--out") ?? join("dist"));
  mkdirSync(out, { recursive: true });
  // Список файлов считается до записи манифеста: он сам в него не входит.
  const info = buildInfo(out);
  const exe = exeEntry();
  if (exe) {
    // Приложение кладём рядом с фронтендом: тогда обновление может заменить и его.
    const target = join(out, exe.path);
    writeFileSync(target, readFileSync(exe.source));
    info.files = [...info.files.filter((file) => file.path !== exe.path), {
      path: exe.path, size: exe.size, sha256: exe.sha256,
    }].sort((left, right) => left.path.localeCompare(right.path));
    info.app = { path: exe.path, size: exe.size, sha256: exe.sha256 };
  }
  writeFileSync(join(out, "build.json"), `${JSON.stringify(info, null, 2)}\n`, "utf8");
  console.log(`build.json: ${join(out, "build.json")} → ${info.version}`
    + `${info.files.length ? ` · файлов ${info.files.length}` : ""}`
    + `${info.app ? " · с приложением" : ""}`);
}
