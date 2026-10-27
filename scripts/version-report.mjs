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
 *   `crates/rig-core/src/lib.rs` (`CORE_GENERATION`).
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
const numbered = rows.length ? Math.max(...rows.map((row) => row.generation)) : 0;
const gaps = rows.map((row) => row.generation).filter((value, index, list) => value !== index + 1);

console.log(`правок ядра в истории: ${commits.length}`);
console.log(`поколений в таблице:   ${numbered} (строк ${rows.length})`);
console.log(`src/version.ts:        core ${inTs ?? "—"}`);
console.log(`lib.rs:                CORE_GENERATION ${inRust ?? "—"}`);

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

console.log(problem ? "\nЕсть расхождения." : "\nВсё сходится: таблица, редактор и ядро на одном поколении.");
process.exit(problem ? 1 : 0);
