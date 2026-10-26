import type { ExternalSourceConfig, ExternalSourceRule, ExternalTextConfig, ModuleInstance } from "../types";
import type { ModuleInputSpec } from "./registry";

/**
 * Внешний источник: значения приходят из сети и превращаются во входы модуля.
 *
 * Модуль `external` — «быстрый путь» создания интеграции: адрес, транспорт и
 * таблица отображения живут в настройках экземпляра (то есть в пресете), код не
 * нужен. Детальная настройка — те же поля, но у каждого входа: подпись, границы,
 * множитель, смещение и удержание импульса.
 *
 * `ws` (WebSocket) работает в окне и не подчиняется CORS, поэтому одинаково
 * живёт в браузере и в приложении. `http`, `sse` и `osc` поднимает Rust
 * (`src-tauri/src/sources.rs`): браузерные запросы упёрлись бы в CORS, а до UDP
 * из вебвью не добраться вовсе. В браузере эти транспорты честно пишут, что
 * доступны только в приложении.
 */

export const EXTERNAL_TRANSPORTS: ExternalSourceConfig["transport"][] = ["ws", "http", "sse", "osc", "twitch"];

/** Подсказка адреса и поведение транспорта: одна таблица для панели и проверок. */
export const TRANSPORT_INFO: Record<ExternalSourceConfig["transport"], {
  label: string;
  placeholder: string;
  /** Транспорт выполняет Rust, а не окно. */
  native: boolean;
}> = {
  ws: { label: "WebSocket", placeholder: "ws://127.0.0.1:17801/inputs", native: false },
  http: { label: "HTTP-опрос", placeholder: "http://127.0.0.1:17802/state", native: true },
  sse: { label: "SSE-поток", placeholder: "http://127.0.0.1:17802/events", native: true },
  osc: { label: "OSC (UDP)", placeholder: "udp://0.0.0.0:9000", native: true },
  // Twitch — не адрес, а сервис: поля у него свои (Client ID, канал, события).
  twitch: { label: "Twitch", placeholder: "", native: true },
};

/** Транспорт выполняет Rust: у него своя нативная часть и своя пауза опроса. */
export function isNativeTransport(transport: ExternalSourceConfig["transport"]): boolean {
  return transport !== "ws";
}

/** Twitch ходит в свой API: адрес у него не спрашивают, спрашивают канал. */
export function isTwitchTransport(transport: ExternalSourceConfig["transport"]): boolean {
  return transport === "twitch";
}

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
    intervalMs: 1000,
  };
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Кириллица в латиницу: имена входов должны быть пригодны для скрипта.
 * Без этого «Смена аватара» превращалась бы в пустое имя и две награды
 * с русскими названиями слились бы в один вход.
 */
const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};

function transliterate(text: string): string {
  return text
    .split("")
    .map((char) => {
      const lower = char.toLowerCase();
      const latin = TRANSLIT[lower];
      if (latin === undefined) return char;
      return char === lower ? latin : latin.toUpperCase();
    })
    .join("");
}

/** Пределы истории сообщений: столько строк держим и читаем из скрипта. */
export const TEXT_HISTORY_MIN = 1;
export const TEXT_HISTORY_MAX = 100;
export const TEXT_HISTORY_DEFAULT = 12;

/** Настройки текста: путь обязателен, остальное — с понятными умолчаниями. */
function readTextConfig(raw: unknown): ExternalTextConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  const path = String(item.path ?? "").trim();
  if (!path) return undefined;
  const authorPath = String(item.authorPath ?? "").trim();
  const input = String(item.input ?? "").trim();
  const history = Number(item.history);
  return {
    path,
    authorPath: authorPath || undefined,
    // Имя входа нужно скрипту (`twitch.chat.message`), поэтому оно латиницей.
    input: input ? readInputName(input) : undefined,
    history: Number.isFinite(history)
      ? Math.min(TEXT_HISTORY_MAX, Math.max(TEXT_HISTORY_MIN, Math.round(history)))
      : TEXT_HISTORY_DEFAULT,
    showAuthor: item.showAuthor !== false,
  };
}

/** Имя входа только латиницей: оно попадает в выражение скрипта. */
export function externalInputName(raw: unknown): string {
  return readInputName(raw);
}

function readInputName(raw: unknown): string {
  const name = transliterate(String(raw ?? ""))
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
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
      // Условие читается только осмысленное: путь обязателен, сравнение — нет.
      const whenPath = rule.when && typeof rule.when === "object"
        ? String((rule.when as Record<string, unknown>).path ?? "").trim()
        : "";
      const whenRaw = rule.when as Record<string, unknown> | undefined;
      const when = whenPath
        ? {
          path: whenPath,
          equals: typeof whenRaw?.equals === "string" && whenRaw.equals ? whenRaw.equals : undefined,
          contains: typeof whenRaw?.contains === "string" && whenRaw.contains ? whenRaw.contains : undefined,
          ignoreCase: whenRaw?.ignoreCase === true ? true : undefined,
        }
        : undefined;
      return {
        input,
        path,
        label: typeof rule.label === "string" && rule.label.trim() ? rule.label.trim().slice(0, 24) : undefined,
        kind,
        min: rule.min === undefined ? undefined : readNumber(rule.min, 0),
        max: rule.max === undefined ? undefined : readNumber(rule.max, 1),
        scale: rule.scale === undefined ? 1 : readNumber(rule.scale, 1),
        offset: rule.offset === undefined ? 0 : readNumber(rule.offset, 0),
        step: rule.step === undefined ? undefined : readNumber(rule.step, 0.01),
        holdMs: rule.holdMs === undefined ? 0 : Math.max(0, readNumber(rule.holdMs, 0)),
        event: typeof rule.event === "string" && rule.event.trim() ? rule.event.trim() : undefined,
        when,
        fallback: rule.fallback === undefined ? undefined : readNumber(rule.fallback, 0),
        count: rule.count === true ? true : undefined,
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
    intervalMs: Math.min(600_000, Math.max(100, readNumber(source.intervalMs, 1000))),
    clientId: typeof source.clientId === "string" && source.clientId.trim() ? source.clientId.trim() : undefined,
    text: readTextConfig(source.text),
    channel: typeof source.channel === "string" && source.channel.trim()
      ? source.channel.trim().toLowerCase().replace(/^@/, "")
      : undefined,
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
    // Шаг берётся из строки таблицы: у счётчиков сообщений и bits он целый,
    // у громкости — сотые. Паспорт входа читает его как `<вход>.step`.
    step: rule.step ?? (rule.kind === "flag" ? 1 : 0.01),
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
      // Ключ может быть в кавычках: у OSC адрес содержит слэши —
      // `$["/avatar/parameters/HR"]`, иначе путь не разобрать.
      let key = rest.slice(index + 1, close).trim();
      if (key.length >= 2 && (key[0] === '"' || key[0] === "'") && key[key.length - 1] === key[0]) {
        key = key.slice(1, -1);
      }
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

/**
 * Подходит ли правило к этому сообщению.
 *
 * Условие нужно, когда одно сообщение описывает разные события: у награды есть
 * `reward.cost`, у рейда — `viewers`. `when` позволяет не смешивать их в одну
 * строку и не читать «пустое» поле как ноль.
 */
export function ruleMatches(rule: ExternalRule, payload: unknown): boolean {
  if (!rule.when) return true;
  const raw = readPath(payload, rule.when.path);
  const source = raw === undefined || raw === null ? "" : String(raw);
  // Команды чата люди пишут как угодно: «!Dance» и «!dance» — одно и то же.
  const fold = (text: string) => (rule.when?.ignoreCase ? text.toLowerCase() : text);
  const text = fold(source);
  if (rule.when.equals !== undefined) return text === fold(rule.when.equals);
  if (rule.when.contains !== undefined) return text.includes(fold(rule.when.contains));
  return text !== "";
}

/** Применение правила к значению: множитель, смещение, границы. */
export function applyRule(rule: ExternalRule, raw: unknown): number | null {
  // Поля нет или оно не число (у фоллова приходит дата) — берём `fallback`:
  // «событие пришло» само по себе значение.
  const source = toNumber(raw) === null && rule.fallback !== undefined ? rule.fallback : raw;
  const value = toNumber(source);
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
    // Счётчик считает хост: тут значение из поля только мешало бы.
    if (rule.count) continue;
    if (!ruleMatches(rule, payload)) continue;
    const value = applyRule(rule, readPath(payload, rule.path));
    if (value !== null) values[rule.input] = value;
  }
  return values;
}

/** Путь по умолчанию для новой строки отображения. */
export function defaultRule(input = "value", path = "$.value"): ExternalRule {
  return { input, path, kind: "level", scale: 1, offset: 0, min: 0, max: 1, holdMs: 0 };
}
