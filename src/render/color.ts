import type { ColorLink, ObjectColorLinks, RigObject, RigPreset } from "../types";

/**
 * Цвет из модуля: подстановка готового цвета в пресет перед отрисовкой.
 *
 * В ядро уходят только числа, поэтому цвет в скрипте не живёт: модуль отдаёт
 * `r/g/b/a` четырьмя числами, а здесь они превращаются в обычную строку цвета
 * объекта. Благодаря этому свет, фигуры, текст и материал рисуются тем же кодом,
 * что и раньше, — им всё равно, откуда взялась строка.
 *
 * Смысл `alpha` у привязки: у света край пятна прозрачный (`colorEnd` с альфой
 * 0), и мягкая граница держится именно на альфе. Если брать альфу из модуля
 * всегда, свет превратится в жёсткий круг. Поэтому по умолчанию берём только
 * RGB, а прозрачность остаётся своя; `alpha: true` — осознанный выбор «взять всё».
 */
export type { ColorLink, ObjectColorLinks };

/** Поле цвета: одно и то же имя в привязке, в интерфейсе и в тестах. */
export type ColorField = keyof ObjectColorLinks;

export const COLOR_FIELD_LABEL: Record<ColorField, string> = {
  fill: "Заливка",
  stroke: "Обводка",
  lightStart: "Свет: центр",
  lightEnd: "Свет: край",
  emissive: "Свечение",
  text: "Текст",
  textStroke: "Текст: обводка",
};

/** Цвет в числах 0…1: то, что удобно и модулю, и шейдеру. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Полное имя входа канала: `color_1.c1_r`. */
export function colorInputKey(module: string, channel: string, part: "r" | "g" | "b" | "a" | "level"): string {
  return `${module}.${channel}_${part}`;
}

/**
 * Строка цвета → числа.
 *
 * Понимает то, что реально лежит в пресете: `#rgb`, `#rrggbb`, `#rrggbbaa`,
 * `rgb(...)`, `rgba(...)`, с числами 0…255 и с процентами. Непонятное — `null`,
 * и тогда объект рисуется своим цветом: молча подставлять чёрный нельзя, иначе
 * «привязал цвет» выглядело бы как «объект пропал».
 */
export function parseColor(text: string | null | undefined): Rgba | null {
  if (typeof text !== "string") return null;
  const value = text.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value);
  if (hex) {
    const digits = hex[1];
    const expand = (part: string) => parseInt(part.length === 1 ? part + part : part, 16) / 255;
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: expand(digits[0]), g: expand(digits[1]), b: expand(digits[2]),
        a: digits.length === 4 ? expand(digits[3]) : 1,
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: expand(digits.slice(0, 2)), g: expand(digits.slice(2, 4)), b: expand(digits.slice(4, 6)),
        a: digits.length === 8 ? expand(digits.slice(6, 8)) : 1,
      };
    }
    return null;
  }
  const fn = /^rgba?\(([^)]*)\)$/i.exec(value);
  if (!fn) return null;
  const parts = fn[1].split(/[,/\s]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const number = (part: string, scale: number) => {
    const percent = part.endsWith("%");
    const raw = Number.parseFloat(part);
    if (!Number.isFinite(raw)) return null;
    return percent ? raw / 100 : raw / scale;
  };
  const r = number(parts[0], 255);
  const g = number(parts[1], 255);
  const b = number(parts[2], 255);
  if (r === null || g === null || b === null) return null;
  const a = parts.length > 3 ? number(parts[3], 1) : 1;
  return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: clamp01(a ?? 1) };
}

/** Числа → строка цвета: тот же формат, что у остальных цветов в пресете. */
export function colorText(color: Rgba): string {
  const channel = (value: number) => Math.round(clamp01(value) * 255);
  const alpha = Math.round(clamp01(color.a) * 1000) / 1000;
  return `rgba(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}, ${alpha})`;
}

/**
 * Какие цвета у объекта вообще есть.
 *
 * Список один на весь проект: по нему строится интерфейс и по нему же
 * подставляются цвета, поэтому поле не может «появиться в панели, но не
 * подставиться».
 */
export function colorFieldsOf(object: RigObject): ColorField[] {
  const fields: ColorField[] = [];
  if (object.shape) fields.push("fill", "stroke");
  if (object.light) fields.push("lightStart", "lightEnd");
  if (object.text) fields.push("text", "textStroke");
  if (object.material) fields.push("emissive");
  return fields;
}

/** Своя строка цвета поля — то, что останется, если модуль пропал. */
export function ownColorOf(object: RigObject, field: ColorField): string | null {
  switch (field) {
    case "fill": return object.shape?.fill ?? null;
    case "stroke": return object.shape?.stroke ?? null;
    case "lightStart": return object.light?.colorStart ?? null;
    case "lightEnd": return object.light?.colorEnd ?? null;
    case "emissive": return object.material?.emissive.color ?? null;
    case "text": return object.text?.color ?? null;
    case "textStroke": return object.text?.strokeColor ?? null;
    default: return null;
  }
}

/** Значение канала из плоского словаря входов; `null` — канала нет. */
export function channelColor(values: Record<string, number>, link: ColorLink): Rgba | null {
  const read = (part: "r" | "g" | "b" | "a") => values[colorInputKey(link.module, link.channel, part)];
  const r = read("r");
  const g = read("g");
  const b = read("b");
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  const a = values[colorInputKey(link.module, link.channel, "a")];
  return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a: Number.isFinite(a) ? clamp01(a) : 1 };
}

/** Готовые цвета по объектам: `{ obj: { fill: {…}, lightStart: {…} } }`. */
export function resolvedColors(
  preset: RigPreset,
  values: Record<string, number>,
): Record<string, Partial<Record<ColorField, Rgba>>> {
  const result: Record<string, Partial<Record<ColorField, Rgba>>> = {};
  for (const object of preset.objects) {
    const links = object.colors;
    if (!links) continue;
    const resolved: Partial<Record<ColorField, Rgba>> = {};
    for (const field of colorFieldsOf(object)) {
      const link = links[field];
      if (!link) continue;
      const color = channelColor(values, link);
      if (color) resolved[field] = color;
    }
    if (Object.keys(resolved).length) result[object.id] = resolved;
  }
  return result;
}

/**
 * Подставляет цвета из модулей в пресет — и на этом всё.
 *
 * Отрисовка света, фигур, текста и материала уже читает цвет из объекта, поэтому
 * подмена здесь не требует ни одной правки в них: света рисуются тем же кодом,
 * что и раньше, просто со строкой цвета из канала.
 *
 * Возвращается **тот же** пресет, если подставлять нечего: лишняя копия сцены на
 * кадр — это лишние пересчёты подписи оверлея.
 */
export function applyColors(
  preset: RigPreset,
  colors: Record<string, Partial<Record<ColorField, Rgba>>>,
): RigPreset {
  const ids = Object.keys(colors);
  if (!ids.length) return preset;
  let changed = false;
  const objects = preset.objects.map((object) => {
    const resolved = colors[object.id];
    if (!resolved) return object;
    const links = object.colors ?? {};
    let next = object;
    const write = (field: ColorField, text: string | null, apply: (object: RigObject, value: string) => RigObject) => {
      const color = resolved[field];
      if (!color || !text) return;
      const own = parseColor(text);
      if (!own) return;
      // Альфа: по умолчанию своя (у света на ней держится мягкий край), и только
      // по осознанной галке — из канала.
      const alpha = links[field]?.alpha === true ? color.a : own.a;
      next = apply(next, colorText({ ...color, a: alpha }));
    };
    write("fill", object.shape?.fill ?? null, (current, value) => (
      current.shape ? { ...current, shape: { ...current.shape, fill: value } } : current
    ));
    write("stroke", object.shape?.stroke ?? null, (current, value) => (
      current.shape ? { ...current, shape: { ...current.shape, stroke: value } } : current
    ));
    write("lightStart", object.light?.colorStart ?? null, (current, value) => (
      current.light ? { ...current, light: { ...current.light, colorStart: value } } : current
    ));
    write("lightEnd", object.light?.colorEnd ?? null, (current, value) => (
      current.light ? { ...current, light: { ...current.light, colorEnd: value } } : current
    ));
    write("emissive", object.material?.emissive.color ?? null, (current, value) => (
      current.material ? { ...current, material: { ...current.material, emissive: { ...current.material.emissive, color: value } } } : current
    ));
    write("text", object.text?.color ?? null, (current, value) => (
      current.text ? { ...current, text: { ...current.text, color: value } } : current
    ));
    write("textStroke", object.text?.strokeColor ?? null, (current, value) => (
      current.text ? { ...current, text: { ...current.text, strokeColor: value } } : current
    ));
    if (next !== object) changed = true;
    return next;
  });
  return changed ? { ...preset, objects } : preset;
}

/** Модули, у которых есть цветовые каналы: для списков в интерфейсе. */
export function colorModuleNames(preset: RigPreset): string[] {
  return preset.modules
    .filter((module) => module.type === "color")
    .map((module) => module.name);
}
