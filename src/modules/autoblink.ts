import type { ModuleInstance } from "../types";
import type { ModuleInputSpec } from "./registry";

/**
 * Модуль «Моргание» (AutoBlink): таймер, который сам решает, когда закрыть глаза.
 *
 * Выводов у модуля может быть сколько угодно: один моргает редко и мягко, второй
 * — часто и коротко, третий дёргает бровь. Каждый вывод — отдельный вход в скрипте
 * (`auto.blink`, `auto.blink_2`), поэтому два одинаковых по смыслу модуля больше
 * не нужны.
 *
 * Почему нужен **семечко**: два вывода с одинаковым интервалом и разбросом
 * моргали бы в такт — оба берут `Math.random` из одного потока и стартуют вместе.
 * Семечко задаёт свой генератор на вывод, а имена модуля и вывода в него
 * подмешиваются: даже одинаковые числа дают разные рисунки, и синхронности нет.
 * `0` — «случайное»: семечко подбирается при запуске, рисунок каждый раз новый,
 * но внутри одного вывода он согласован.
 */

/** Один вывод моргания: свой таймер, свои числа и свой генератор. */
export interface BlinkOutput {
  /** Имя для скрипта: латиница, цифры и `_`. Это же имя входа. */
  name: string;
  /** Подпись в панели; пробелы разрешены. */
  label: string;
  /** Средний интервал между морганиями, мс; конечное число от 0 без верхнего предела. */
  period: number;
  /** Сколько вход держится в максимуме, мс; конечное число от 0. */
  hold: number;
  /** Разброс интервала, %: 0 — метроном; верхнего предела нет. */
  jitter: number;
  /** Значение «глаза открыты»; любое конечное число. */
  min: number;
  /** Значение «глаза закрыты»; любое конечное число. */
  max: number;
  /** Семечко 0…2³²−1: `0` — случайное при запуске. */
  seed: number;
}

/** Полный диапазон семечка, который принимает используемый 32-битный генератор. */
export const BLINK_SEED_MAX = 0xffff_ffff;

/** Вывод нового модуля: то, что видно в панели сразу после добавления. */
export const BLINK_OUTPUT_BASE: BlinkOutput = {
  name: "blink",
  label: "Моргание",
  period: 4200,
  hold: 140,
  jitter: 35,
  min: 0,
  max: 1,
  seed: 0,
};

export type BlinkNumberField = "period" | "hold" | "jitter" | "min" | "max" | "seed";

/**
 * Нормализация числового поля: убраны прежние произвольные пределы таймера.
 * Сохраняем только ограничения, нужные смыслу/формату: интервалы и проценты
 * разброса неотрицательны, а семечко — целое в диапазоне uint32.
 */
export function normalizeBlinkNumber(field: BlinkNumberField, value: number): number {
  if (!Number.isFinite(value)) return BLINK_OUTPUT_BASE[field];
  if (field === "period" || field === "hold" || field === "jitter") return Math.max(0, value);
  if (field === "seed") return Math.min(BLINK_SEED_MAX, Math.max(0, Math.round(value)));
  return value;
}

const number = (value: unknown, fallback: number) => (
  typeof value === "number" && Number.isFinite(value) ? value : fallback
);

/** Имя вывода — латиница, цифры и `_`: оно попадает в скрипт. */
export function blinkNameAllowed(raw: string): boolean {
  return /^[a-z_][a-z0-9_]*$/.test(raw);
}

export function sanitizeBlinkName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  if (!cleaned) return "blink";
  return /^[a-z_]/.test(cleaned) ? cleaned : `b_${cleaned}`;
}

export function uniqueBlinkName(outputs: BlinkOutput[], base: string): string {
  const clean = sanitizeBlinkName(base);
  if (!outputs.some((output) => output.name === clean)) return clean;
  let index = 2;
  while (outputs.some((output) => output.name === `${clean}_${index}`)) index += 1;
  return `${clean}_${index}`;
}

function normalizeOutput(raw: unknown, fallbackName: string): BlinkOutput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Partial<BlinkOutput>;
  const name = typeof source.name === "string" && source.name.trim()
    ? sanitizeBlinkName(source.name)
    : fallbackName;
  const rawMin = normalizeBlinkNumber("min", number(source.min, BLINK_OUTPUT_BASE.min));
  const rawMax = normalizeBlinkNumber("max", number(source.max, BLINK_OUTPUT_BASE.max));
  return {
    name,
    // Не удаляем пробелы: подпись редактируется посимвольно, и завершающий пробел
    // нужен, чтобы можно было допечатать следующее слово.
    label: typeof source.label === "string" ? source.label.slice(0, 32) : "",
    period: normalizeBlinkNumber("period", number(source.period, BLINK_OUTPUT_BASE.period)),
    hold: normalizeBlinkNumber("hold", number(source.hold, BLINK_OUTPUT_BASE.hold)),
    jitter: normalizeBlinkNumber("jitter", number(source.jitter, BLINK_OUTPUT_BASE.jitter)),
    // Min/max могут быть вне 0…1; лишь сохраняем логичный порядок диапазона.
    min: Math.min(rawMin, rawMax),
    max: Math.max(rawMin, rawMax),
    seed: normalizeBlinkNumber("seed", number(source.seed, BLINK_OUTPUT_BASE.seed)),
  };
}

/** Выводы экземпляра. Старый пресет с полями наверху превращается в один вывод. */
export function autoBlinkOutputs(module: ModuleInstance): BlinkOutput[] {
  const list: BlinkOutput[] = [];
  const raw = module.config.outputs;
  if (Array.isArray(raw)) {
    raw.forEach((item, index) => {
      const output = normalizeOutput(item, index === 0 ? "blink" : `blink_${index + 1}`);
      if (!output) return;
      output.name = uniqueBlinkName(list, output.name);
      if (!output.label) output.label = output.name;
      list.push(output);
    });
  }
  if (list.length) return list;
  // До нескольких выводов у модуля были просто поля `period`, `hold`… Значения
  // не теряем: они становятся единственным выводом `blink`, поэтому старые
  // пресеты и формулы `auto.blink` продолжают работать.
  const legacy = normalizeOutput(module.config, "blink");
  if (!legacy) return [{ ...BLINK_OUTPUT_BASE }];
  if (!legacy.label) legacy.label = legacy.name;
  return [legacy];
}

/**
 * Входы модуля: по одному на вывод.
 *
 * Границы входа — это `min`/`max` вывода, поэтому ползунок в панели «Входы»
 * ходит ровно в тех пределах, что заданы для этого моргания.
 */
export function autoBlinkInputs(module: ModuleInstance): ModuleInputSpec[] {
  return autoBlinkOutputs(module).map((output) => ({
    name: output.name,
    label: output.label,
    min: output.min,
    max: output.max,
    step: 0.01,
    kind: "level" as const,
    hint: `Моргание по таймеру: ${Math.round(output.period / 100) / 10} с между закрытиями`,
  }));
}

/** Вход, которым управляют видимостью глаза: `blink`, а если его нет — первый. */
export function autoBlinkEyeInput(module: ModuleInstance): string {
  const outputs = autoBlinkOutputs(module);
  return outputs.some((output) => output.name === "blink") ? "blink" : outputs[0]?.name ?? "blink";
}

/** FNV-1a: одинаковый текст — одинаковое число, разный — разное. */
function hashText(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Семечко вывода: число из настроек плюс имена модуля и вывода.
 *
 * Имена в замесе не для красоты: без них два вывода с одинаковым числом давали бы
 * одинаковый поток случайных чисел — то есть ровно ту синхронность, от которой
 * семечко и спасает.
 */
export function blinkSeed(seed: number, moduleName: string, outputName: string): number {
  const mixed = Math.imul(seed | 0, 0x9e3779b1) >>> 0;
  return (hashText(`${moduleName}/${outputName}`) ^ mixed) >>> 0;
}

/**
 * Поток случайных чисел вывода: mulberry32 с семечком, замешанным на именах.
 *
 * Объект, а не функция: состояний столько же, сколько выводов, и каждое живёт
 * само по себе — иначе два одинаковых моргания снова шли бы в такт.
 */
export class BlinkRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  /** Следующее число 0…1; поток тот же, что у `mulberry32` с этим семечком. */
  next(): number {
    this.seed = (this.seed + 0x6d2b79f5) >>> 0;
    let value = this.seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  /** Настройка на другое семечко: переименование вывода начинает рисунок заново. */
  restart(seed: number): void {
    this.seed = seed >>> 0;
  }
}

/** Поток случайных чисел вывода: он же нужен таймеру и тестам. */
export function blinkRandom(seed: number, moduleName: string, outputName: string): BlinkRandom {
  return new BlinkRandom(blinkSeed(seed, moduleName, outputName));
}

/** Состояние таймера одного вывода: когда моргнуть и до какого времени держать. */
export interface BlinkState {
  next: number;
  until: number;
  random: BlinkRandom;
  /** С каким семечком заведён таймер: правка числа перезаводит поток. */
  seed: number;
}

/** Бесконечность от переполнения не попадает в таймер/JSON: верхний предел — MAX_VALUE. */
function safeTimeAdd(left: number, right: number): number {
  const sum = left + right;
  return Number.isFinite(sum) ? sum : Number.MAX_VALUE;
}

/** Неотрицательная длительность: положительное переполнение насыщается MAX_VALUE. */
function safeDuration(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  return Number.isFinite(value) ? value : Number.MAX_VALUE;
}

/**
 * Завести таймер: первое моргание — через половину интервала.
 *
 * Так персонаж не моргает на каждом запуске, будто по команде. `seed` из настроек
 * пишется в поле `seed` вывода: `0` — случайное число, взятое один раз.
 */
export function blinkState(time: number, output: BlinkOutput, moduleName: string): BlinkState {
  const seed = output.seed > 0 ? output.seed : Math.floor(Math.random() * BLINK_SEED_MAX) + 1;
  const random = blinkRandom(seed, moduleName, output.name);
  const period = normalizeBlinkNumber("period", output.period);
  return { next: safeTimeAdd(time, period * (0.5 + random.next() * 0.5)), until: 0, random, seed };
}

/**
 * Шаг таймера: планирует следующее моргание и отдаёт значение входа.
 *
 * Разброс считается от интервала, но не короче длительности: иначе при большом
 * разбросе пятно «закрыто» перекрывало бы следующее открытие и моргание слиплось
 * бы в одно долгое закрытие.
 */
export function blinkTick(state: BlinkState, output: BlinkOutput, now: number): number {
  if (now >= state.next) {
    const hold = normalizeBlinkNumber("hold", output.hold);
    const period = normalizeBlinkNumber("period", output.period);
    const jitter = normalizeBlinkNumber("jitter", output.jitter) / 100;
    state.until = safeTimeAdd(now, hold);
    const spread = safeDuration(period * (1 + (state.random.next() * 2 - 1) * jitter));
    state.next = safeTimeAdd(now, Math.max(safeTimeAdd(hold, 40), spread));
  }
  return now < state.until ? output.max : output.min;
}

/**
 * Разброс интервала, который получится у вывода: нужен тестам и подсказке.
 * Возвращает границы в миллисекундах, а не проценты.
 */
export function blinkSpread(output: BlinkOutput): { shortest: number; longest: number } {
  const period = normalizeBlinkNumber("period", output.period);
  const hold = normalizeBlinkNumber("hold", output.hold);
  const jitter = normalizeBlinkNumber("jitter", output.jitter) / 100;
  const pause = safeTimeAdd(hold, 40);
  const shortest = Math.max(pause, safeDuration(period * (1 - jitter)));
  const longest = Math.max(pause, safeDuration(period * (1 + jitter)));
  return { shortest, longest };
}
