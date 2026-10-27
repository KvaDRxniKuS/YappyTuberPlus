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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

function buildInfo() {
  const version = readVersion(root);
  return {
    ...version,
    builtAt: new Date().toISOString(),
    commit: commitHash(),
    /** Поколение формата ядра на случай, если папку будут читать чужие скрипты. */
    schema: 1,
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
  console.log(`папка:       ${folder}`);
  console.log(`сборка:      ${info.version ?? "—"} · ${humanTime(info.builtAt)}`
    + `${info.commit ? ` · коммит ${info.commit}` : ""}`);
  console.log(`репозиторий: ${current.version}`);
  console.log(differs ? "\nПапка не совпадает с репозиторием:" : "\nСовпадает: папку можно раздавать.");
  for (const line of lines) console.log(`  ${line}`);
  if (differs) console.log("\nПересоберите: npm run build.");
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
  const info = buildInfo();
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "build.json"), `${JSON.stringify(info, null, 2)}\n`, "utf8");
  console.log(`build.json: ${join(out, "build.json")} → ${info.version}`);
}
