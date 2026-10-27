#!/usr/bin/env node
/**
 * Отчёт по поколению ядра.
 *
 * Слот «ядро» в версии — не про количество строк и не про «крупные релизы», а
 * про правки контракта: функции DSL, параметры кадра, виды объектов, семантика
 * кадра. Такие правки записаны таблицей в `docs/VERSIONS.md` («Хронология
 * ядра»), и там же стоит их число.
 *
 * Скрипт сверяет таблицу с историей git:
 *
 * - какие коммиты трогали `crates/rig-core`, но в таблицу не попали —
 *   их нужно либо записать поколением, либо осознанно пропустить;
 * - совпадает ли число поколений в документе, в `src/version.ts` и в
 *   `crates/rig-core/src/lib.rs` (`CORE_GENERATION`);
 * - не отстала ли таблица признаков (`src/engine/coreFeatures.ts`): каждое имя
 *   должно существовать в ядре, а каждое поколение — быть в таблице §4;
 * - нет ли в ядре встроенной функции, которой нет в таблице признаков: иначе
 *   сцена с ней получила бы требование «самое новое» вместо честного.
 *
 * Запуск: `npm run version:report` (нужен git и полная история: при
 * поверхностном клоне сначала `git fetch --unshallow`).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const docsPath = join(root, "docs", "VERSIONS.md");

/** История по ядру: хеш, дата, тема. */
function coreCommits() {
  const output = execFileSync(
    "git",
    ["log", "--reverse", "--date=short", "--pretty=%h|%ad|%s", "--", "crates/rig-core"],
    { cwd: root, encoding: "utf8" },
  );
  return output.trim().split("\n").filter(Boolean).map((line) => {
    const [hash, date, subject] = line.split("|");
    return { hash, date, subject: subject ?? "" };
  });
}

/** Строки таблицы поколений: `| 12 | \`abc1234\` | 2026-10-26 | … |`. */
function tableRows(text) {
  const rows = [];
  const pattern = /^\|\s*(\d{1,4})\s*\|\s*`([0-9a-f]{7,40})`\s*\|/gm;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    rows.push({ generation: Number(match[1]), hash: match[2] });
  }
  return rows;
}

/**
 * Все хеши, упомянутые в документе: правка без поколения тоже записывается
 * строкой таблицы, просто с прочерком вместо номера.
 */
function mentionedHashes(text) {
  const found = new Set();
  const pattern = /`([0-9a-f]{7,40})`/g;
  let match;
  while ((match = pattern.exec(text)) !== null) found.add(match[1]);
  return found;
}

/** Таблица признаков: `id`, `since`, имена функций и слов. */
function coreFeatures() {
  const text = readFileSync(join(root, "src/engine/coreFeatures.ts"), "utf8");
  const features = [];
  const blocks = text.split(/\n  \{\n    id:/).slice(1);
  for (const block of blocks) {
    const id = /^\s*"([^"]+)"/.exec(block);
    const since = /since:\s*(\d+)/.exec(block);
    if (!id || !since) continue;
    const names = [];
    const arrays = block.matchAll(/(?:functions|words):\s*\[([^\]]*)\]/g);
    for (const array of arrays) {
      for (const quoted of array[1].matchAll(/"([^"]+)"/g)) names.push(quoted[1]);
    }
    const removed = /removed:\s*(\d+)/.exec(block);
    features.push({
      id: id[1],
      since: Number(since[1]),
      removed: removed ? Number(removed[1]) : null,
      names,
    });
  }
  const base = /export const BASE_FUNCTIONS[^=]*=\s*\[([\s\S]*?)\];/.exec(text);
  const baseNames = base ? [...base[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]) : [];
  return { features, baseNames };
}

/** Встроенные функции, которые ядро разбирает с ожидаемым числом аргументов. */
function rustFunctions() {
  const text = readFileSync(join(root, "crates/rig-core/src/runtime.rs"), "utf8");
  const start = text.indexOf("let expected = match name {");
  if (start < 0) return [];
  const end = text.indexOf("};", start);
  const block = text.slice(start, end);
  return [...new Set([...block.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]))];
}

/** Все имена, встречающиеся в строках ядра: по ним проверяется существование. */
function rustSource() {
  const files = ["lib.rs", "runtime.rs", "parser.rs", "model.rs", "ffi.rs"];
  return files.map((file) => readFileSync(join(root, "crates/rig-core/src", file), "utf8")).join("\n");
}

function readNumber(path, pattern) {
  const text = readFileSync(join(root, path), "utf8");
  const match = pattern.exec(text);
  return match ? Number(match[1]) : null;
}

const docs = readFileSync(docsPath, "utf8");
const rows = tableRows(docs);
const commits = coreCommits();

const known = mentionedHashes(docs);
const missing = commits.filter((commit) => !known.has(commit.hash));

const inTs = readNumber("src/version.ts", /core:\s*(\d+)/);
const inRust = readNumber("crates/rig-core/src/lib.rs", /CORE_GENERATION:\s*u32\s*=\s*(\d+)/);
const acceptsFrom = readNumber("crates/rig-core/src/lib.rs", /ACCEPTS_FROM:\s*u32\s*=\s*(\d+)/);
const { features, baseNames } = coreFeatures();
const rust = rustSource();
const knownNames = new Set(baseNames);
for (const feature of features) for (const name of feature.names) knownNames.add(name);
// Убранные формы остаются в таблице как память о языке: их имён в ядре уже нет,
// и проверять существование нужно только у живых признаков.
const liveNames = new Set(baseNames);
for (const feature of features) {
  if (feature.removed) continue;
  for (const name of feature.names) liveNames.add(name);
}
const numbered = rows.length ? Math.max(...rows.map((row) => row.generation)) : 0;
const gaps = rows.map((row) => row.generation).filter((value, index, list) => value !== index + 1);

console.log(`правок ядра в истории: ${commits.length}`);
console.log(`поколений в таблице:   ${numbered} (строк ${rows.length})`);
console.log(`src/version.ts:        core ${inTs ?? "—"}`);
console.log(`lib.rs:                CORE_GENERATION ${inRust ?? "—"}, ACCEPTS_FROM ${acceptsFrom ?? "—"}`);
console.log(`признаков в таблице:  ${features.length}`);

let problem = false;
if (missing.length) {
  problem = true;
  console.log("\nНе записаны в таблицу поколений:");
  for (const commit of missing) {
    console.log(`  ${commit.hash} ${commit.date}  ${commit.subject}`);
  }
  console.log("Правка контракта — новый номер поколения; правка сборки или");
  console.log("диагностики — тоже строка таблицы, но с пометкой «без поколения».");
}
if (gaps.length) {
  problem = true;
  console.log(`\nНомера поколений идут не подряд: ${gaps.join(", ")}.`);
}
if (inTs !== numbered || inRust !== numbered) {
  problem = true;
  console.log(`\nЧисла разошлись: таблица ${numbered}, version.ts ${inTs}, lib.rs ${inRust}.`);
}

if (acceptsFrom === null || acceptsFrom > (inRust ?? 0) || acceptsFrom < 1) {
  problem = true;
  console.log(`\nACCEPTS_FROM ${acceptsFrom ?? "—"} не согласован с CORE_GENERATION ${inRust}.`);
}
// Диапазон совместимости — не вкусовое число: это поколение, в котором язык
// последний раз ломался. Если из таблицы признаков убрали что-то в другом
// поколении, число в ядре обязано это повторить.
const expectedAccepts = features.reduce((max, feature) => Math.max(max, feature.removed ?? 0), 1);
if (acceptsFrom !== expectedAccepts) {
  problem = true;
  console.log(`\nACCEPTS_FROM ${acceptsFrom ?? "—"}, а по таблице признаков должно быть `
    + `${expectedAccepts}: убранное в этом поколении ломает старые сцены.`);
}
const generationSet = new Set(rows.map((row) => row.generation));
const lateFeature = features.filter((feature) => !generationSet.has(feature.since));
if (lateFeature.length) {
  problem = true;
  console.log("\nПризнак ссылается на поколение, которого нет в таблице §4:");
  for (const feature of lateFeature) console.log(`  ${feature.id} → ${feature.since}`);
}
const unknownInCore = [...liveNames].filter((name) => !rust.includes(`"${name}"`));
// Убранная форма не должна вернуться в разбор функций: именно там ядро
// объявляет, что оно понимает. Сообщения об ошибках не считаются.
const dispatch = new Set(rustFunctions());
const removedStillAlive = features
  .filter((feature) => feature.removed)
  .filter((feature) => feature.names.some((name) => dispatch.has(name)));
if (unknownInCore.length) {
  problem = true;
  console.log(`\nИмена из таблицы признаков не найдены в ядре: ${unknownInCore.join(", ")}.`);
  console.log("Переименование или удаление — повод поправить таблицу и, если поведение");
  console.log("убрали, поднять ACCEPTS_FROM.");
}
if (removedStillAlive.length) {
  problem = true;
  console.log("\nПризнак записан убранным, но ядро его всё ещё разбирает:");
  for (const feature of removedStillAlive) console.log(`  ${feature.id}`);
}
const lateRemoval = features.filter((feature) => feature.removed && !generationSet.has(feature.removed));
if (lateRemoval.length) {
  problem = true;
  console.log("\nПризнак убран в поколении, которого нет в таблице §4:");
  for (const feature of lateRemoval) console.log(`  ${feature.id} → ${feature.removed}`);
}
const unlisted = rustFunctions().filter((name) => !knownNames.has(name));
if (unlisted.length) {
  problem = true;
  console.log(`\nВ ядре есть функции вне таблицы признаков: ${unlisted.join(", ")}.`);
  console.log("Сцена с ними получит требование «текущее ядро» — запишите поколение.");
}

console.log(problem
  ? "\nЕсть расхождения."
  : "\nВсё сходится: таблица, признаки, редактор и ядро согласованы.");
process.exit(problem ? 1 : 0);
