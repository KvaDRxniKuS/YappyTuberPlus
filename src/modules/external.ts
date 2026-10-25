import type { ExternalSourceConfig, ExternalSourceRule, ModuleInstance } from "../types";
import type { ModuleInputSpec } from "./registry";

/**
 * Внешний источник: значения приходят из сети и превращаются во входы модуля.
 *
 * Модуль `external` — «быстрый путь» создания интеграции: адрес, транспорт и
 * таблица отображения живут в настройках экземпляра (то есть в пресете), код не
 * нужен. Детальная настройка — те же поля, но у каждого входа: подпись, границы,
 * множитель, смещение и удержание импульса.
 *
 * Сейчас поддержан транспорт `ws` (WebSocket): он не подчиняется CORS, поэтому
 * работает и в браузере, и в нативном окне. `http` и `osc` ждут Rust-транспорта —
 * до этого они честно показывают статус «не поддержан», а не молчат.
 */

export const EXTERNAL_TRANSPORTS: ExternalSourceConfig["transport"][] = ["ws", "http", "osc"];

/** Типы источника живут в `types.ts` вместе с настройками экземпляра. */
export type ExternalRule = ExternalSourceRule;
export type { ExternalSourceConfig };

/** Пустой источник для нового экземпляра. */
export function defaultExternalSource(): ExternalSourceConfig {
  return {
    transport: "ws",
    url: "",
    mapping: [{ input: "value", path: "$.value", min: 0, max: 1 }],
    reconnect: true,
  };
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Имя входа только латиницей: оно попадает в выражение скрипта. */
function readInputName(raw: unknown): string {
  const name = String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z_]/.test(name) ? name.slice(0, 24) : name ? `v_${name}`.slice(0, 24) : "";
}

/** Источник из настроек экземпляра: битые поля заменяются безопасными. */
export function readExternalSource(config: Record<string, unknown> | undefined): ExternalSourceConfig {
  const raw = (config?.source ?? undefined) as Partial<ExternalSourceConfig> | undefined;
  const source = raw && typeof raw === "object" ? raw : {};
  const transport = EXTERNAL_TRANSPORTS.includes(source.transport as ExternalSourceConfig["transport"])
    ? (source.transport as ExternalSourceConfig["transport"])
    : "ws";
  const mapping = (Array.isArray(source.mapping) ? (source.mapping as unknown[]) : [])
    .map((item): ExternalRule | null => {
      if (!item || typeof item !== "object") return null;
      const rule = item as Record<string, unknown>;
      const input = readInputName(rule.input);
      const path = String(rule.path ?? "").trim();
      if (!input || !path) return null;
      const kind = rule.kind === "db" || rule.kind === "flag" ? rule.kind : "level";
      return {
        input,
        path,
        label: typeof rule.label === "string" && rule.label.trim() ? rule.label.trim().slice(0, 24) : undefined,
        kind,
        min: rule.min === undefined ? undefined : readNumber(rule.min, 0),
        max: rule.max === undefined ? undefined : readNumber(rule.max, 1),
        scale: rule.scale === undefined ? 1 : readNumber(rule.scale, 1),
        offset: rule.offset === undefined ? 0 : readNumber(rule.offset, 0),
        holdMs: rule.holdMs === undefined ? 0 : Math.max(0, readNumber(rule.holdMs, 0)),
      };
    })
    .filter((rule): rule is ExternalRule => rule !== null)
    // Один вход — одно правило: иначе значение зависело бы от порядка строк.
    .filter((rule, index, list) => list.findIndex((item) => item.input === rule.input) === index);
  return {
    transport,
    url: typeof source.url === "string" ? source.url.trim() : "",
    subscribe: typeof source.subscribe === "string" && source.subscribe.trim() ? source.subscribe.trim() : undefined,
    mapping,
    reconnect: source.reconnect !== false,
  };
}

/**
 * Входы экземпляра берутся из таблицы отображения: добавили строку — появился
 * вход. Шаблон `inputs` работает запасным вариантом, пока таблица пуста, чтобы
 * новый модуль не был «без входов».
 */
export function externalInputs(module: ModuleInstance, fallback: ModuleInputSpec[] = []): ModuleInputSpec[] {
  const source = readExternalSource(module.config as Record<string, unknown>);
  if (source.mapping.length === 0) return fallback;
  return source.mapping.map((rule) => ({
    name: rule.input,
    label: rule.label || rule.input,
    min: rule.kind === "db" ? (rule.min ?? -80) : (rule.min ?? 0),
    max: rule.kind === "db" ? (rule.max ?? 0) : (rule.max ?? 1),
    step: rule.kind === "flag" ? 1 : 0.01,
    kind: rule.kind ?? "level",
    hint: `${rule.path}${rule.holdMs ? ` · импульс ${Math.round(rule.holdMs)} мс` : ""}`,
  }));
}

/**
 * Значение по пути `$.data.bpm` / `$.items[0].n`.
 *
 * Поддержаны объекты, массивы и индексы — этого хватает и для Twitch EventSub
 * (`$.event.total`), и для простых мостов (`$.hr`). Строки не превращаются в
 * числа: «да» вместо 1 — это ошибка конфигурации, а не значение.
 */
export function readPath(payload: unknown, path: string): unknown {
  let rest = path.trim();
  if (rest === "$" || rest === "") return payload;
  if (rest.startsWith("$")) rest = rest.slice(1);
  let current: unknown = payload;
  let index = 0;
  while (index < rest.length) {
    const char = rest[index];
    if (char === ".") { index += 1; continue; }
    if (char === "[") {
      const close = rest.indexOf("]", index);
      if (close === -1) return undefined;
      const key = rest.slice(index + 1, close).trim();
      current = step(current, key);
      index = close + 1;
      continue;
    }
    let end = index;
    while (end < rest.length && rest[end] !== "." && rest[end] !== "[") end += 1;
    current = step(current, rest.slice(index, end));
    index = end;
  }
  return current;
}

function step(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const position = Number(key);
    return Number.isInteger(position) ? value[position] : undefined;
  }
  if (typeof value === "object") return (value as Record<string, unknown>)[key];
  return undefined;
}

/** Число из значения JSON: логическое — 0/1, строка-число — число. */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Применение правила к значению: множитель, смещение, границы. */
export function applyRule(rule: ExternalRule, raw: unknown): number | null {
  const value = toNumber(raw);
  if (value === null) return null;
  const scaled = value * (rule.scale ?? 1) + (rule.offset ?? 0);
  const min = rule.min;
  const max = rule.max;
  let result = scaled;
  if (min !== undefined) result = Math.max(min, result);
  if (max !== undefined) result = Math.min(max, result);
  return result;
}

/** Все входы из одного сообщения: `{ hr: 72, cheer: 100 }`. */
export function applyMapping(payload: unknown, mapping: ExternalRule[]): Record<string, number> {
  const values: Record<string, number> = {};
  for (const rule of mapping) {
    const value = applyRule(rule, readPath(payload, rule.path));
    if (value !== null) values[rule.input] = value;
  }
  return values;
}

/** Путь по умолчанию для новой строки отображения. */
export function defaultRule(input = "value", path = "$.value"): ExternalRule {
  return { input, path, kind: "level", scale: 1, offset: 0, min: 0, max: 1, holdMs: 0 };
}
