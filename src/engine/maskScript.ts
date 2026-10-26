import type { MaskSpec } from "../types";
import { normalizeMask } from "../render/shape";

/**
 * Маска в скрипте объекта.
 *
 * Так же, как вкладка «Поведение», маска хранит свои настройки прямо в скрипте:
 * JSON-строкой в комментарии внутри управляемого блока. Причина та же — истина
 * должна быть в одном месте. Инспектор правит настройки и переписывает блок,
 * а скрипт применяет значение: строка `mask = 1` — это обычный параметр,
 * поэтому маску можно плавно проявлять формулой, гасить событием или отдать
 * будущему модулю динамической маски.
 *
 * Геометрия (точки, фигура, файл, инверсия, мягкий край) остаётся в JSON:
 * в языке скрипта нет ни массивов, ни объектов, и придумывать их ради маски
 * значит усложнить ядро сильнее, чем стоит вся маска.
 */
export const MASK_START = "// ── маска: вкладка «Объект» ──";
export const MASK_END = "// ── конец маски ──";
const META = "// @mask ";

/** Строка блока при пустой настройке: значение по умолчанию для параметра. */
const DEFAULT_BODY = "mask = 1";

interface Block {
  start: number;
  end: number;
  meta: string;
  body: string[];
}

/** Границы управляемого блока в тексте скрипта. */
function blockAt(script: string): Block | null {
  const lines = script.split("\n");
  const start = lines.findIndex((line) => line.trim() === MASK_START);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.trim() === MASK_END);
  if (end < 0) return null;
  const inner = lines.slice(start + 1, end);
  const metaIndex = inner.findIndex((line) => line.trimStart().startsWith(META));
  return {
    start,
    end,
    meta: metaIndex >= 0 ? inner[metaIndex].trimStart().slice(META.length) : "",
    body: inner.filter((_, index) => index !== metaIndex),
  };
}

/**
 * Текст блока для настройки маски.
 *
 * `body` — строки формул, которые написал пользователь: переписывая геометрию,
 * их нельзя терять, иначе правка ползунка молча возвращала бы `mask = 1`.
 */
function blockText(mask: MaskSpec, body: string[]): string {
  const kept = body.length ? body : [DEFAULT_BODY];
  return [MASK_START, `${META}${JSON.stringify({ ...mask, points: mask.points })}`, ...kept, MASK_END].join("\n");
}

/**
 * Блок с настройками маски или без него. Инспектор зовёт это на каждую правку:
 * настройки в пресете и в скрипте должны совпадать всегда, а не «при открытии».
 */
export function writeMaskBlock(script: string, mask: MaskSpec | null | undefined): string {
  const block = blockAt(script);
  if (!mask) {
    if (!block) return script;
    const lines = script.split("\n");
    const rest = [...lines.slice(0, block.start), ...lines.slice(block.end + 1)];
    return rest.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\s+$/, "");
  }
  if (!block) {
    const base = script.replace(/\s+$/, "");
    return base ? `${base}\n\n${blockText(mask, [])}` : blockText(mask, []);
  }
  const lines = script.split("\n");
  const text = blockText(mask, block.body);
  return [...lines.slice(0, block.start), text, ...lines.slice(block.end + 1)].join("\n");
}

/** Настройки из блока или `null`, если блока нет или он испорчен. */
export function parseMaskBlock(script: string): MaskSpec | null {
  const block = blockAt(script);
  if (!block || !block.meta.trim()) return null;
  try {
    return normalizeMask(JSON.parse(block.meta)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Есть ли в скрипте блок маски. Нужно, чтобы отличить «маску убрали» от
 * «скрипт старый и про блок ничего не знает»: во втором случае настройку из
 * пресета надо не потерять, а дописать в скрипт.
 */
export function hasMaskBlock(script: string): boolean {
  return blockAt(script) !== null;
}
