import type { ModuleInstance, VisemeEntry } from "../types";
import type { ModuleInputSpec } from "./registry";

/** Сколько полос спектра хранит калибровка и сравнивает рантайм. */
export const VISEME_BANDS = 32;

/** Стартовый набор визем у нового модуля: его можно править и удалять. */
export const VISEME_BASE: VisemeEntry[] = ["a", "e", "i", "o", "u"].map((name) => ({
  name,
  label: name,
  templates: [],
}));

/** Список визем экземпляра. Пропавшие/битые записи отбрасываются. */
export function visemeEntries(module: ModuleInstance): VisemeEntry[] {
  const raw = module.config.visemes;
  if (!Array.isArray(raw) || raw.length === 0) return VISEME_BASE.map((entry) => ({ ...entry, templates: [] }));
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
    hint: entry.templates.length > 0
      ? `вариантов записи: ${entry.templates.length}`
      : "нет калибровки: значения нулевые",
  }));
}

/** Центр полосы `index`: полосы логарифмические от 80 Гц до 8 кГц. */
export function bandFrequency(index: number): number {
  return 80 * Math.exp(((index + 0.5) / VISEME_BANDS) * Math.log(8000 / 80));
}

/**
 * Вес полосы. Гласные различаются формантами примерно 250–3000 Гц; выше —
 * шипящие и шум микрофона, ниже — гул. Края учитываются, но слабее.
 */
export function bandWeight(frequency: number): number {
  if (frequency < 150 || frequency > 4500) return 0.3;
  if (frequency < 250) return 0.3 + ((frequency - 150) / 100) * 0.7;
  if (frequency > 3000) return 1 - ((frequency - 3000) / 1500) * 0.7;
  return 1;
}

/**
 * Признак звука из средних амплитуд полос.
 *
 * 1. Амплитуды переводятся в дБ: так одинаковый сдвиг громкости становится
 *    прибавкой константы.
 * 2. Вычитается средний уровень (взвешенный): громкость микрофона и общий
 *    наклон АЧХ перестают влиять.
 * 3. Полосы 250–3000 Гц получают больший вес, остальные — меньший.
 * 4. Вектор приводится к единичной длине: дальше сравнивается только форма.
 *
 * Без шагов 1–3 все гласные «похожи» на 0.8–0.9: их объединяет общий спад
 * спектра, и разница формант тонет в нём.
 */
export function spectrumShape(amplitudes: number[]): number[] {
  const decibels = amplitudes.map((value) => 20 * Math.log10(Math.max(value, 1e-7)));
  let weighted = 0;
  let weightSum = 0;
  for (let index = 0; index < decibels.length; index += 1) {
    const weight = bandWeight(bandFrequency(index));
    weighted += decibels[index] * weight;
    weightSum += weight;
  }
  const mean = weightSum > 0 ? weighted / weightSum : 0;
  return unitVector(decibels.map((value, index) => (value - mean) * bandWeight(bandFrequency(index))));
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
 * Похожесть текущего спектра на эталон: косинус в квадрате.
 *
 * Спектры приходят уже центрированными по уровню (см. `spectrumFeatures`),
 * поэтому косинус меряет форму, а не громкость и не наклон микрофона.
 */
export function similarity(bands: number[], template: number[] | null | undefined): number {
  if (!template || template.length !== bands.length) return 0;
  let dot = 0;
  for (let index = 0; index < bands.length; index += 1) dot += bands[index] * template[index];
  if (!(dot > 0)) return 0;
  return Math.pow(Math.min(1, dot), 2);
}

/** Полоса ниже этой доли от самого «разбросанного» канала считается общей. */
const WHITEN_THRESHOLD = 0.3;
/** Сглаживание весов: полосы не должны различаться в десятки раз. */
const WHITEN_SOFT = 0.2;

/**
 * Веса полос по калибровкам модуля (whitening).
 *
 * Считаем разброс каждой полосы по всем записанным вариантам всех визем: где
 * звуки отличаются — полоса весит много, где у всех одинаково (наклон АЧХ,
 * низкочастотный гул, шум) — ноль. Это данные из собственных калибровок, а не
 * догадка про «правильные» форманты, поэтому метод подстраивается под микрофон
 * и дикцию.
 *
 * `null`, когда сравнивать не с чем (меньше двух записей): тогда работает
 * обычный косинус.
 */
export function discriminativeWeights(templates: number[][]): number[] | null {
  const usable = templates.filter((template) => template.length === VISEME_BANDS);
  if (usable.length < 2) return null;
  const mean = new Array(VISEME_BANDS).fill(0);
  for (const template of usable) {
    for (let index = 0; index < VISEME_BANDS; index += 1) mean[index] += template[index] / usable.length;
  }
  const deviation = new Array(VISEME_BANDS).fill(0);
  for (const template of usable) {
    for (let index = 0; index < VISEME_BANDS; index += 1) {
      const delta = template[index] - mean[index];
      deviation[index] += (delta * delta) / usable.length;
    }
  }
  const std = deviation.map((value) => Math.sqrt(value));
  const max = Math.max(...std);
  if (!(max > 1e-6)) return null;
  return std.map((value) => (value >= max * WHITEN_THRESHOLD ? 1 / (WHITEN_SOFT + value / max) : 0));
}

/** Взвешенный вектор единичной длины: веса не меняют масштаб сравнения. */
export function weightSpectrum(vector: number[], weights: number[] | null): number[] {
  if (!weights) return vector;
  return unitVector(vector.map((value, index) => value * (weights[index] ?? 0)));
}

/** Лучшая похожесть по вариантам записи: у звука бывает несколько произношений. */
export function bestSimilarity(bands: number[], templates: number[][], weights: number[] | null = null): number {
  const live = weightSpectrum(bands, weights);
  let best = 0;
  for (const template of templates) {
    const reference = weights ? weightSpectrum(template, weights) : template;
    // Повторная нормировка не нужна: weightSpectrum уже привёл вектор к единице.
    best = Math.max(best, similarity(live, reference));
  }
  return best;
}

/**
 * Значения визем по текущему кадру звука.
 *
 * `contrast` — степень, в которую возводится похожесть: чем больше, тем резче
 * выделяется самый близкий звук и тем меньше «фонит» остальным. В тишине (ниже
 * порога `gate`) все виземы нулевые.
 */
export function computeVisemes(
  module: ModuleInstance,
  bands: number[] | undefined,
  db: number,
  gate = Number(module.config.gate ?? -50),
): Record<string, number> {
  // Гейт не ступенькой, а рампой в 12 дБ: на самом пороге виземы не дёргаются
  // между нулём и полным значением.
  const openness = clamp((db - gate) / 12 + 0.5, 0, 1);
  const contrast = clamp(Number(module.config.contrast ?? 3), 1, 8);
  const entries = visemeEntries(module);
  // Веса считаются по всем калибровкам модуля сразу: так видно, какие полосы
  // действительно различают записанные звуки.
  const weights = discriminativeWeights(entries.flatMap((entry) => entry.templates));
  const values: Record<string, number> = {};
  const audible = openness > 0 && Array.isArray(bands) && bands.length === VISEME_BANDS;
  for (const entry of entries) {
    const raw = audible ? bestSimilarity(bands as number[], entry.templates, weights) : 0;
    values[entry.name] = raw > 0 ? Math.pow(raw, contrast) * openness : 0;
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

/** Только латиница, цифры и `_`: имя входа попадает в выражение скрипта. */
export function visemeNameAllowed(raw: string): boolean {
  return /^[a-z0-9_]*$/.test(raw);
}

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
