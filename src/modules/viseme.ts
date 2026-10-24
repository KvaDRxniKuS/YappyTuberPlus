import type { ModuleInstance, VisemeEntry } from "../types";
import type { ModuleInputSpec } from "./registry";

/** Сколько полос спектра хранит калибровка и сравнивает рантайм. */
export const VISEME_BANDS = 32;

/** Стартовый набор визем у нового модуля: его можно править и удалять. */
export const VISEME_BASE: VisemeEntry[] = ["a", "e", "i", "o", "u"].map((name) => ({
  name,
  label: name,
  template: null,
}));

/** Список визем экземпляра. Пропавшие/битые записи отбрасываются. */
export function visemeEntries(module: ModuleInstance): VisemeEntry[] {
  const raw = module.config.visemes;
  if (!Array.isArray(raw) || raw.length === 0) return VISEME_BASE.map((entry) => ({ ...entry }));
  return raw;
}

/** Входы экземпляра визем: по одному на каждую запись списка. */
export function visemeInputs(module: ModuleInstance): ModuleInputSpec[] {
  return visemeEntries(module).map((entry) => ({
    name: entry.name,
    label: entry.label,
    min: 0,
    max: 1,
    step: 0.01,
    kind: "level" as const,
    hint: entry.template ? "откалибровано" : "нет калибровки: значения нулевые",
  }));
}

/** Вектор единичной длины: сравнивать спектры нужно по форме, а не по громкости. */
export function unitVector(vector: number[]): number[] {
  let length = 0;
  for (const value of vector) length += value * value;
  length = Math.sqrt(length);
  if (!(length > 1e-9)) return vector.map(() => 0);
  return vector.map((value) => value / length);
}

/** Средний спектр записи: усредняем кадры и снова приводим к единичной длине. */
export function averageSpectrum(frames: number[][]): number[] | null {
  const usable = frames.filter((frame) => frame.length > 0);
  if (usable.length === 0) return null;
  const sum = new Array(usable[0].length).fill(0);
  for (const frame of usable) {
    for (let index = 0; index < sum.length; index += 1) sum[index] += frame[index] ?? 0;
  }
  return unitVector(sum.map((value) => value / usable.length));
}

/**
 * Похожесть текущего спектра на эталон: косинус в квадрате. Квадрат нужен,
 * чтобы «похоже» не превращалось в «везде 0.9»: у близких звуков косинус и
 * так высокий, а различать надо именно форму рта.
 */
export function similarity(bands: number[], template: number[] | null): number {
  if (!template || template.length !== bands.length) return 0;
  let dot = 0;
  for (let index = 0; index < bands.length; index += 1) dot += bands[index] * template[index];
  if (!(dot > 0)) return 0;
  return Math.pow(Math.min(1, dot), 2);
}

/**
 * Значения визем по текущему кадру звука. В тишине (ниже порога `gate`) все
 * виземы нулевые: иначе шум микрофона давал бы «похожесть» на всё сразу.
 */
export function computeVisemes(module: ModuleInstance, bands: number[] | undefined, db: number): Record<string, number> {
  const gate = Number(module.config.gate ?? -50);
  // Гейт не ступенькой, а рампой в 12 дБ: на самом пороге виземы не дёргаются
  // между нулём и полным значением.
  const openness = clamp((db - gate) / 12 + 0.5, 0, 1);
  const values: Record<string, number> = {};
  const audible = openness > 0 && Array.isArray(bands) && bands.length === VISEME_BANDS;
  for (const entry of visemeEntries(module)) {
    values[entry.name] = audible ? similarity(bands as number[], entry.template) * openness : 0;
  }
  return values;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Нормализация: сумма визем = 1. В тишине нули остаются нулями. */
export function normalizeVisemes(values: Record<string, number>): Record<string, number> {
  let sum = 0;
  for (const value of Object.values(values)) sum += value;
  if (!(sum > 1e-6)) return values;
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(values)) result[key] = value / sum;
  return result;
}

/** Кириллица в латиницу: имя входа должно остаться пригодным для скрипта. */
const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/**
 * Имя входа виземы: латиница, цифры и `_` — иначе выражение не скомпилируется.
 * Подпись при этом остаётся такой, как её ввели: `ö` в скрипте живёт как
 * `o_umlaut`, а «ы» — как `y`.
 */
export function sanitizeVisemeName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/ö/g, "o_umlaut")
    .replace(/ä/g, "a_umlaut")
    .replace(/ü/g, "u_umlaut")
    .replace(/ß/g, "ss")
    .replace(/[а-яё]/g, (letter) => CYRILLIC[letter] ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) return "viseme";
  return /^[a-z_]/.test(cleaned) ? cleaned : `v_${cleaned}`;
}

/** Свободное имя в списке визем экземпляра. */
export function uniqueVisemeName(entries: VisemeEntry[], base: string): string {
  const clean = sanitizeVisemeName(base);
  if (!entries.some((entry) => entry.name === clean)) return clean;
  let index = 2;
  while (entries.some((entry) => entry.name === `${clean}_${index}`)) index += 1;
  return `${clean}_${index}`;
}
