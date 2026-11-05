import type { RigFrame, RigObject, RigPreset } from "../types";

/**
 * Видимость объекта из источников.
 *
 * Правило одно и то же для всех источников: **каждый источник — множитель**, а
 * итог — их произведение. 1 — виден, 0 — нет, дробное значение — полупрозрачный
 * объект. Поэтому «виден на награде и только днём» — это два множителя, а не
 * два разных механизма: награда даёт 1 или 0, время суток — число.
 *
 * Источники бывают трёх видов, и различаются они только тем, откуда берётся
 * число:
 *
 * - `input` — вход включённого модуля: `mic.speak`, `mouse.left`, `key.jump`;
 * - `signal` — канал `signal.<имя>`: его пишут плагины и ручные сигналы;
 * - `state` — значение предыдущего кадра: параметр этого же объекта
 *   (`state.opacity`) или переменная скрипта (`state.mood`).
 *
 * Число входа по умолчанию уже считается в 0…1. Галочка «min/max входа»
 * растягивает собственный диапазон входа (например, −1…1 у `mouse.x`) в 0…1 —
 * тогда в настройках видно те же границы, что у модуля.
 *
 * Булев источник — это ворота: больше 0.5 — открыто. Шкалы и min/max у него
 * нет и быть не может.
 */

export type VisibilityKind = "input" | "signal" | "state";

export interface VisibilitySource {
  kind: VisibilityKind;
  /** Имя модуля для `input`; у `signal` и `state` пустое. */
  module: string;
  /** Имя входа, сигнала или переменной. */
  name: string;
  /** Ворота: значение читается как «да/нет», без шкалы. */
  gate: boolean;
  /** Растянуть `min…max` источника в 0…1 вместо готового 0…1. */
  range: boolean;
  /** Нижняя граница растяжения: значение на ней даёт 0. */
  min: number;
  /** Верхняя граница: значение на ней даёт 1. */
  max: number;
  /** Инверсия: 1 − значение. */
  invert: boolean;
}

/** Маркер блока поведения: тот же, что читает вкладка «Поведение». */
export const BEHAVIOUR_META = "// @behaviour ";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Разбор списка источников из JSON блока.
 *
 * Запись без модуля отбрасывается: читать её неоткуда. Пустое имя остаётся —
 * это источник, который ещё не дозаполнили в панели, и он честно не участвует
 * в произведении (см. `sourceReady`). Иначе поле ввода имени стирало бы
 * источник на первом же нажатии клавиши.
 */
export function readVisibilitySources(raw: unknown): VisibilitySource[] {
  if (!Array.isArray(raw)) return [];
  const sources: VisibilitySource[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const source = item as Record<string, unknown>;
    const kind: VisibilityKind = source.kind === "signal" || source.kind === "state" ? source.kind : "input";
    const module = typeof source.module === "string" ? source.module.trim() : "";
    const name = typeof source.name === "string" ? source.name.trim() : "";
    if (kind === "input" && !NAME.test(module)) continue;
    const min = finite(source.min, 0);
    const max = finite(source.max, 1);
    sources.push({
      kind,
      module: kind === "input" ? module : "",
      name,
      gate: source.gate === true,
      // Пустой диапазон бессмысленен: растягивать нечего, поэтому остаётся
      // готовый 0…1 — так битые настройки не превращаются в «всегда виден».
      range: source.range === true && max > min,
      min: Math.min(min, max),
      max: Math.max(min, max),
      invert: source.invert === true,
    });
  }
  return sources;
}

/** Контекст одного кадра: значения входов, сигналы и кадр до него. */
export interface VisibilityContext {
  /** Плоский словарь входов: `<модуль>.<вход>` → число. */
  values: Record<string, number>;
  /** Канал `signal.<имя>` → число. */
  signals: Record<string, number>;
  /** Кадр предыдущего шага: из него читается `state.<имя>`. */
  previous: RigFrame | null;
}

/** Пустой контекст: без входов видимость считается по `state` и всё. */
export const EMPTY_VISIBILITY_CONTEXT: VisibilityContext = { values: {}, signals: {}, previous: null };

/** Ключ источника в списке выбора: `mic.speak`, `signal.reward`, `state.opacity`. */
export function sourceKey(source: VisibilitySource): string {
  if (source.kind === "signal") return `signal.${source.name}`;
  if (source.kind === "state") return `state.${source.name}`;
  return `${source.module}.${source.name}`;
}

/** Подпись источника для панели: то же, что ключ — в скрипте и на экране. */
export function sourceLabel(source: VisibilitySource): string {
  const key = sourceKey(source);
  if (source.gate) return `${key} · ворота`;
  return source.range ? `${key} · ${source.min}…${source.max}` : key;
}

/**
 * Готов ли источник к работе: имя заполнено, у входа есть модуль. Пока нет —
 * множитель не участвует, и объект не пропадает из-за незаконченной настройки.
 */
export function sourceReady(source: VisibilitySource): boolean {
  return source.name !== "" && (source.kind !== "input" || source.module !== "");
}

/** Число источника до преобразований. Неизвестное имя даёт ноль, как в ядре. */
export function sourceValue(source: VisibilitySource, objectId: string, context: VisibilityContext): number {
  let value = 0;
  if (source.kind === "signal") {
    value = context.signals[source.name] ?? context.values[`signal.${source.name}`] ?? 0;
  } else if (source.kind === "state") {
    // `state.<имя>` — значение предыдущего кадра: переменная скрипта важнее
    // одноимённого параметра, иначе `state.mood` читал бы не то, что написали.
    const globals = context.previous?.globals;
    const own = context.previous?.objects[objectId] as Record<string, number> | undefined;
    value = globals && source.name in globals ? globals[source.name] : own?.[source.name] ?? 0;
  } else {
    value = context.values[`${source.module}.${source.name}`] ?? 0;
  }
  return Number.isFinite(value) ? value : 0;
}

/**
 * Множитель одного источника, 0…1.
 *
 * Ворота не знают шкалы: «нажато» — это 1, «не нажато» — 0. Числовой источник
 * сначала приводится к 0…1 (готовым значением или растяжением min…max), потом
 * зажимается — модуль может отдать выброс, а видимость обязана остаться долей.
 */
export function sourceMultiplier(source: VisibilitySource, objectId: string, context: VisibilityContext): number {
  const raw = sourceValue(source, objectId, context);
  if (source.gate) {
    const open = raw > 0.5 ? 1 : 0;
    return source.invert ? 1 - open : open;
  }
  const value = source.range
    ? (() => {
      const span = source.max - source.min;
      return span > 0 ? (raw - source.min) / span : raw >= source.max ? 1 : 0;
    })()
    : raw;
  const clamped = Math.min(1, Math.max(0, value));
  return source.invert ? 1 - clamped : clamped;
}

/** Итоговая видимость: произведение всех источников. */
export function visibilityProduct(
  sources: readonly VisibilitySource[],
  objectId: string,
  context: VisibilityContext,
): number {
  let value = 1;
  for (const source of sources) {
    if (!sourceReady(source)) continue;
    value *= sourceMultiplier(source, objectId, context);
  }
  return Math.min(1, Math.max(0, value));
}

/** Порог, ниже которого объект считается невидимым: `visible` — флаг, не число. */
export const VISIBLE_THRESHOLD = 0.5;

/**
 * Кэш источников по тексту скрипта: кадров десятки в секунду, а скрипт меняется
 * только правкой. Ключ — сам текст, поэтому кэш не протухает; размер ограничен,
 * чтобы долгая работа не копила строки.
 */
const sourceCache = new Map<string, VisibilitySource[]>();
const CACHE_LIMIT = 256;

/** Источники видимости из блока поведения в скрипте объекта. */
export function visibilityOfScript(script: string): VisibilitySource[] {
  const cached = sourceCache.get(script);
  if (cached) return cached;
  let sources: VisibilitySource[] = [];
  for (const line of script.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(BEHAVIOUR_META)) continue;
    try {
      const raw: unknown = JSON.parse(trimmed.slice(BEHAVIOUR_META.length));
      if (raw && typeof raw === "object") {
        sources = readVisibilitySources((raw as Record<string, unknown>).visibility);
      }
    } catch {
      // Битый JSON — это отсутствие настроек, а не повод погасить объект.
    }
    break;
  }
  if (sourceCache.size >= CACHE_LIMIT) sourceCache.clear();
  sourceCache.set(script, sources);
  return sources;
}

/** Источники видимости объекта. */
export function visibilityOf(object: RigObject): VisibilitySource[] {
  return visibilityOfScript(object.script);
}

/**
 * Применяет видимость к готовому кадру.
 *
 * `visible` остаётся двоичным флагом — объект либо рисуется, либо нет, — а доля
 * уходит в `opacity`: так «почти виден» означает прозрачность, а не мигание
 * между кадрами. Уже нулевой `visible` (галочка «включён», рот, глаз, пресеты)
 * не поднимается обратно: видимость умеет только выключать.
 */
export function applyVisibility(
  preset: RigPreset,
  frame: RigFrame,
  context: VisibilityContext = EMPTY_VISIBILITY_CONTEXT,
): RigFrame {
  let changed = false;
  const objects: RigFrame["objects"] = {};
  for (const object of preset.objects) {
    const current = frame.objects[object.id];
    if (!current) continue;
    const sources = visibilityOf(object);
    if (!sources.length) {
      objects[object.id] = current;
      continue;
    }
    const value = visibilityProduct(sources, object.id, context);
    if (value >= 1) {
      objects[object.id] = current;
      continue;
    }
    changed = true;
    objects[object.id] = {
      ...current,
      visible: current.visible !== 0 && value > VISIBLE_THRESHOLD ? 1 : 0,
      opacity: current.opacity * value,
    };
  }
  return changed ? { ...frame, objects } : frame;
}

/** Явно ли настроена видимость: нужно панели и генератору блока. */
export function hasVisibility(sources: readonly VisibilitySource[]): boolean {
  return sources.length > 0;
}
