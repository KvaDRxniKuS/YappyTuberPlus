import type { ModuleInstance } from "../types";
import type { ModuleInputSpec } from "./registry";
import { parseColor, type Rgba } from "../render/color";

/**
 * Модуль «Цвет»: палитра, режим и время.
 *
 * Входы модуля — числа, потому что в ядро и в скрипт проходят только числа. Один
 * канал даёт пять входов: `_r`, `_g`, `_b`, `_a` и `_level`. Привязка цвета в
 * «Поведении» выбирает канал целиком, поэтому про `_r/_g/_b` человек не думает,
 * а в скрипте `color_1.c1_r` — обычная переменная (например, чтобы гнать яркость
 * света от речи).
 *
 * Вся математика — чистые функции от времени: их проверяют тесты, а не глаз.
 * Единственное состояние — сглаживание между кадрами (`smooth`), оно живёт здесь
 * же и сбрасывается при остановке.
 */

export type ColorMode = "static" | "breathe" | "cycle" | "sequence" | "wave" | "random" | "react";

export const COLOR_MODES: Array<{ value: ColorMode; label: string; hint: string }> = [
  { value: "static", label: "Статичный", hint: "Один цвет, без изменений" },
  { value: "breathe", label: "Дыхание", hint: "Плавно между первыми двумя цветами палитры" },
  { value: "cycle", label: "Круг", hint: "По кругу по всей палитре, переходы плавные" },
  { value: "sequence", label: "Последовательность", hint: "Строго по очереди, каждый цвет стоит своё время" },
  { value: "wave", label: "Волна", hint: "Оттенок идёт по кругу, насыщенность — из палитры" },
  { value: "random", label: "Случайный", hint: "Новый цвет из палитры через равные промежутки" },
  { value: "react", label: "Реакция", hint: "Цвет стоит, яркость ведёт вход другого модуля" },
];

export interface ColorStop {
  /** Цвет в том же виде, что и у остальных цветов пресета: `#rrggbb` или `rgba(…)`. */
  color: string;
  /** Сколько секунд цвет стоит в «последовательности» и «случайном». */
  hold: number;
}

export interface ColorChannel {
  /** Имя для скрипта: латиница, цифры и `_`. Входы — `<имя>_r`, `<имя>_g`… */
  name: string;
  /** Подпись в панели и в списках привязки. */
  label: string;
  mode: ColorMode;
  colors: ColorStop[];
  /** 0…200 %: 100 % — две секунды на шаг палитры. */
  speed: number;
  /** 0…100 %: сдвиг по времени, чтобы два канала не мигали в такт. */
  phase: number;
  /** 0…200 %: общая яркость канала. */
  brightness: number;
  /** 0…100 %: инерция перехода между цветами. */
  smooth: number;
  /** Для режима «Реакция»: чей вход ведёт яркость. */
  react: { module: string; input: string } | null;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const number = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** Стартовый канал нового модуля: его видно в панели и можно править. */
export const COLOR_CHANNEL_BASE: ColorChannel = {
  name: "c1",
  label: "Основной",
  mode: "cycle",
  colors: [
    { color: "#ff4d6d", hold: 1 },
    { color: "#8b5cf6", hold: 1 },
    { color: "#22d3ee", hold: 1 },
  ],
  speed: 100,
  phase: 0,
  brightness: 100,
  smooth: 40,
  react: null,
};

/** Имя канала — латиница, цифры и `_`: оно попадает в скрипт. */
export function channelNameAllowed(raw: string): boolean {
  return /^[a-z0-9_]*$/.test(raw);
}

export function sanitizeChannelName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  if (!cleaned) return "c";
  return /^[a-z_]/.test(cleaned) ? cleaned : `c_${cleaned}`;
}

export function uniqueChannelName(channels: ColorChannel[], base: string): string {
  const clean = sanitizeChannelName(base);
  if (!channels.some((channel) => channel.name === clean)) return clean;
  let index = 2;
  while (channels.some((channel) => channel.name === `${clean}_${index}`)) index += 1;
  return `${clean}_${index}`;
}

function normalizeStop(raw: unknown): ColorStop | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as { color?: unknown; hold?: unknown };
  const color = typeof source.color === "string" ? source.color.trim() : "";
  if (!parseColor(color)) return null;
  return { color, hold: clamp(number(source.hold, 1), 0.05, 60) };
}

function normalizeMode(raw: unknown): ColorMode {
  return COLOR_MODES.some((mode) => mode.value === raw) ? raw as ColorMode : "static";
}

function normalizeChannel(raw: unknown, fallbackName: string): ColorChannel | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Partial<ColorChannel>;
  const name = typeof source.name === "string" && source.name ? sanitizeChannelName(source.name) : fallbackName;
  const colors = Array.isArray(source.colors)
    ? source.colors.map(normalizeStop).filter((stop): stop is ColorStop => stop !== null)
    : [];
  const react = source.react && typeof source.react === "object"
    && typeof (source.react as { module?: unknown }).module === "string"
    && typeof (source.react as { input?: unknown }).input === "string"
    ? { module: (source.react as { module: string }).module, input: (source.react as { input: string }).input }
    : null;
  return {
    name,
    label: typeof source.label === "string" && source.label.trim() ? source.label.trim() : name,
    mode: normalizeMode(source.mode),
    // Пустая палитра — это «ни одного цвета», рисовать нечего: берём стартовую.
    colors: colors.length ? colors : COLOR_CHANNEL_BASE.colors.map((stop) => ({ ...stop })),
    speed: clamp(number(source.speed, 100), 0, 200),
    phase: clamp(number(source.phase, 0), 0, 100),
    brightness: clamp(number(source.brightness, 100), 0, 200),
    smooth: clamp(number(source.smooth, 0), 0, 100),
    react,
  };
}

/** Каналы экземпляра. Битые записи отбрасываются, имена не повторяются. */
export function colorChannels(module: ModuleInstance): ColorChannel[] {
  const raw = module.config.channels;
  const list: ColorChannel[] = [];
  if (Array.isArray(raw)) {
    raw.forEach((item, index) => {
      const channel = normalizeChannel(item, `c${index + 1}`);
      if (!channel) return;
      channel.name = uniqueChannelName(list, channel.name);
      list.push(channel);
    });
  }
  if (!list.length) {
    const base = normalizeChannel(COLOR_CHANNEL_BASE, "c1")!;
    list.push(base);
  }
  return list;
}

/**
 * Входы канала: цвет четырьмя числами и яркость.
 *
 * Вид входа — `level`: и цвет, и яркость лежат в 0…1, поэтому в панели «Входы»
 * это обычные ползунки, а в скрипте — обычные числа.
 */
export function colorInputs(module: ModuleInstance): ModuleInputSpec[] {
  const result: ModuleInputSpec[] = [];
  for (const channel of colorChannels(module)) {
    const parts: Array<{ part: "r" | "g" | "b" | "a" | "level"; label: string; hint: string }> = [
      { part: "r", label: "красный", hint: "Красная составляющая цвета 0…1" },
      { part: "g", label: "зелёный", hint: "Зелёная составляющая цвета 0…1" },
      { part: "b", label: "синий", hint: "Синяя составляющая цвета 0…1" },
      { part: "a", label: "прозрачность", hint: "Альфа цвета 0…1: берётся, только если так сказано в привязке" },
      { part: "level", label: "яркость", hint: "Яркость канала с учётом режима «Реакция» 0…1" },
    ];
    for (const part of parts) {
      result.push({
        name: `${channel.name}_${part.part}`,
        label: `${channel.label}: ${part.label}`,
        min: 0,
        max: 1,
        step: 0.01,
        kind: "level",
        hint: part.hint,
      });
    }
  }
  return result;
}

/** HSV (0…1) → RGB. Нужен режиму «Волна». */
export function hsvColor(h: number, s: number, v: number): Rgba {
  const hue = ((h % 1) + 1) % 1;
  const sector = hue * 6;
  const index = Math.floor(sector) % 6;
  const f = sector - Math.floor(sector);
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [
    [v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q],
  ][index];
  return { r, g, b, a: 1 };
}

/** RGB → HSV (0…1). */
export function rgbToHsv(color: Rgba): { h: number; s: number; v: number } {
  const max = Math.max(color.r, color.g, color.b);
  const min = Math.min(color.r, color.g, color.b);
  const delta = max - min;
  let hue = 0;
  if (delta > 1e-6) {
    if (max === color.r) hue = ((color.g - color.b) / delta) % 6;
    else if (max === color.g) hue = (color.b - color.r) / delta + 2;
    else hue = (color.r - color.g) / delta + 4;
    hue /= 6;
    if (hue < 0) hue += 1;
  }
  return { h: hue, s: max <= 1e-6 ? 0 : delta / max, v: max };
}

/** Палитра канала в числах: строки разбираются один раз на канал. */
function paletteOf(channel: ColorChannel): Rgba[] {
  const parsed = channel.colors
    .map((stop) => parseColor(stop.color))
    .filter((color): color is Rgba => color !== null);
  return parsed.length ? parsed : [{ ...parseColor(COLOR_CHANNEL_BASE.colors[0].color)! }];
}

function mix(from: Rgba, to: Rgba, t: number): Rgba {
  const k = clamp(t, 0, 1);
  return {
    r: from.r + (to.r - from.r) * k,
    g: from.g + (to.g - from.g) * k,
    b: from.b + (to.b - from.b) * k,
    a: from.a + (to.a - from.a) * k,
  };
}

/** Секунд на один шаг палитры: 100 % — две секунды. */
export function stepSeconds(channel: ColorChannel): number {
  const speed = clamp(channel.speed, 0, 200);
  if (speed <= 0) return Number.POSITIVE_INFINITY;
  return 2 / (speed / 100);
}

/** Детерминированный «случайный» выбор: одинаковый для одного окна времени. */
function hashIndex(seed: string, window: number, size: number): number {
  let hash = 2166136261 ^ window;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % size;
}

/**
 * Цвет канала в момент времени — без состояния и без сглаживания.
 *
 * `level` нужен режиму «Реакция»: яркость ведёт вход другого модуля, а цвет
 * остаётся первым из палитры.
 */
export function channelColorAt(channel: ColorChannel, time: number, level = 1): Rgba {
  const palette = paletteOf(channel);
  const speed = clamp(channel.speed, 0, 200);
  const offset = (clamp(channel.phase, 0, 100) / 100) * 4;
  const t = Math.max(0, time) + offset;
  const step = stepSeconds(channel);

  switch (channel.mode) {
    case "static":
    case "react":
      return { ...palette[0] };
    case "breathe": {
      if (!Number.isFinite(step)) return { ...palette[0] };
      const target = palette[1] ?? palette[0];
      // Треугольная волна: туда и обратно, без рывка на краях.
      const cycle = (t / step) % 2;
      const k = cycle <= 1 ? cycle : 2 - cycle;
      return mix(palette[0], target, k);
    }
    case "cycle": {
      if (!Number.isFinite(step)) return { ...palette[0] };
      const position = (t / step) % palette.length;
      const index = Math.floor(position);
      const next = palette[(index + 1) % palette.length];
      return mix(palette[index], next, position - index);
    }
    case "sequence": {
      // Строго по очереди: сколько стоит каждый цвет, решает `hold`.
      const holds = channel.colors.map((stop) => clamp(number(stop.hold, 1), 0.05, 60));
      const total = holds.reduce((sum, hold) => sum + hold, 0);
      let rest = t % total;
      for (let index = 0; index < holds.length; index += 1) {
        if (rest < holds[index]) return { ...palette[index] };
        rest -= holds[index];
      }
      return { ...palette[0] };
    }
    case "wave": {
      if (!Number.isFinite(step)) return { ...palette[0] };
      const base = rgbToHsv(palette[0]);
      // Оттенок идёт по кругу; насыщенность и яркость — из первого цвета палитры.
      const hue = (t / (step * 3)) % 1;
      const color = hsvColor(hue, Math.max(base.s, 0.55), Math.max(base.v, 0.55));
      return { ...color, a: palette[0].a };
    }
    case "random": {
      const hold = clamp(number(channel.colors[0]?.hold, 1), 0.05, 60);
      const window = Math.floor(t / hold);
      const index = hashIndex(channel.name, window, palette.length);
      // Небольшой переход в начале окна: без него «случайный» мигает рывками.
      const fade = clamp((t % hold) / Math.min(0.25, hold / 2), 0, 1);
      const previous = hashIndex(channel.name, window - 1, palette.length);
      return mix(palette[previous], palette[index], fade);
    }
    default:
      return { ...palette[0] };
  }
}

/** Сглаживание между кадрами живёт по каналу: `smooth` — инерция, а не фильтр. */
const smoothState = new Map<string, Rgba>();

export function resetColorState(): void {
  smoothState.clear();
}

/**
 * Значения канала: цвет с учётом яркости и сглаживания.
 *
 * `dt` — секунды с прошлого кадра (для сглаживания), `level` — значение входа
 * «Реакции» (0…1). Возвращает готовые числа для `_r/_g/_b/_a/_level`.
 */
export function channelValues(
  moduleName: string,
  channel: ColorChannel,
  time: number,
  dt: number,
  level: number,
): Record<"r" | "g" | "b" | "a" | "level", number> {
  const target = channelColorAt(channel, time, level);
  const key = `${moduleName}:${channel.name}`;
  const previous = smoothState.get(key);
  const smooth = clamp(channel.smooth, 0, 100) / 100;
  let color = target;
  if (previous && smooth > 0) {
    // Инерция: 0 % — цвет меняется мгновенно, 100 % — тянется около полутора секунд.
    const tau = smooth * 1.5;
    const k = dt > 0 ? 1 - Math.exp(-dt / Math.max(0.02, tau)) : 1;
    color = mix(previous, target, k);
  }
  smoothState.set(key, color);
  const brightness = clamp(channel.brightness, 0, 200) / 100;
  const react = channel.mode === "react" ? clamp(level, 0, 1) : 1;
  const gain = brightness * react;
  return {
    r: clamp(color.r * gain, 0, 1),
    g: clamp(color.g * gain, 0, 1),
    b: clamp(color.b * gain, 0, 1),
    a: clamp(color.a, 0, 1),
    level: clamp(gain > 2 ? 1 : gain / 2, 0, 1),
  };
}
