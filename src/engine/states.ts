import type { RigObject } from "../types";

/**
 * Состояния объекта — блок в скрипте, как «Поведение».
 *
 * Истина — сам скрипт: настройки лежат JSON-строкой в комментарии внутри блока,
 * а сгенерированные формулы ниже блока читает ядро. Вкладка «Состояния» и
 * вкладка «Объект» поэтому всегда показывают одно и то же, а продвинутый автор
 * может удалить блок и писать веса руками.
 *
 * Блок — **добавка**, а не переопределение: он пишет каналы `<поле>_states`,
 * а поле складывает канал с авторским кодом (`x = inherit + x_behaviour +
 * x_states`). Поэтому позы не стирают формулы, а формулы не спорят с позами.
 *
 * Механизм один — позы с весами. Привязка к параметру необязательна:
 *
 * - **есть `param`** — позы стоят на значениях параметра (`at`), веса считаются
 *   базисными функциями по участкам между соседними ключами, сумма весов 1;
 * - **нет `param`** — у каждой позы своё выражение веса (`weight`).
 *
 * Значения полей — **дельты** к авторской позе, а не абсолютные координаты:
 * иначе состояния спорили бы с инспектором и «Поведением».
 */

/** Маркер блока: по нему вкладка находит настройки в скрипте. */
export const STATES_META = "// @states ";

const START = "// ── состояния: вкладка «Состояния» ──";
const END = "// ── конец состояний ──";

/** Поля, которые умеет двигать состояние. Порядок — порядок строк в блоке. */
export const STATE_FIELDS = [
  "x", "y", "rotation", "skewX", "skewY", "sizeX", "sizeY", "opacity", "visible",
] as const;

export type StateField = (typeof STATE_FIELDS)[number];

/**
 * Поля-множители: нейтраль 1 и `*` в авторской строке.
 *
 * Позиция, поворот и наклон складываются (нейтраль 0), размер и прозрачность
 * умножаются (нейтраль 1). Видимость — тоже множитель: состояние может только
 * **гасить**, поэтому её поза даёт `1 - w * (1 - v)`.
 */
const MULTIPLICATIVE: ReadonlySet<StateField> = new Set<StateField>([
  "sizeX", "sizeY", "opacity", "visible",
]);

/** Имя параметра: `manual.value`, `mood`, `tracker.head_rx`. */
const PARAM = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Имя переменной без точки: такие ядро отдаёт в `vars` по списку `watch`. */
const LOCAL = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Смещение точки деформера в долях картинки. */
export type PosePoint = [number, number];

export interface Pose {
  /** Значение параметра у привязанного слоя. */
  at?: number;
  /** Выражение веса у свободного слоя. */
  weight?: string;
  /** Дельты полей; отсутствующее поле не трогается. */
  pose: Partial<Record<StateField, number>>;
  /** Смещения точек деформера: индекс точки → смещение. */
  points?: Record<string, PosePoint>;
}

export interface StateLayer {
  /** Имя слоя в списке «Состояния». */
  name: string;
  /** Параметр привязки; `null` — свободные веса. */
  param: string | null;
  /** Отрезок таймлайна; `null` — брать из паспорта входа. */
  range: [number, number] | null;
  /** `smoothstep` внутри участка вместо прямой. */
  smooth: boolean;
  /** `sum` — наложение, `average` — нормированная смесь. */
  normalize: "sum" | "average";
  poses: Pose[];
}

export interface States {
  layers: StateLayer[];
}

/** Пустые состояния: блок не нужен, скрипт остаётся как есть. */
export const EMPTY_STATES: States = { layers: [] };

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Однострочное выражение: перенос и фигурные скобки испортили бы блок. */
function expression(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  if (/[\n\r]/.test(raw)) return null;
  if (raw.includes("{") || raw.includes("}")) return null;
  return raw;
}

/** Число в тексте: без хвостовых нулей, отрицательное — в скобках. */
function num(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** Отрицательное число как слагаемое: `a - (-3)` читается однозначно. */
function signed(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return rounded < 0 ? `(${rounded})` : String(rounded);
}

function readPoints(raw: unknown): Record<string, PosePoint> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const result: Record<string, PosePoint> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(key) || !Array.isArray(value)) continue;
    const x = finite(value[0]);
    const y = finite(value[1]);
    if (x === null || y === null) continue;
    result[key] = [x, y];
  }
  return Object.keys(result).length ? result : undefined;
}

function readPose(raw: unknown): Pose | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const pose: Partial<Record<StateField, number>> = {};
  const rawPose = source.pose && typeof source.pose === "object"
    ? source.pose as Record<string, unknown>
    : {};
  for (const field of STATE_FIELDS) {
    const value = finite(rawPose[field]);
    if (value !== null) pose[field] = value;
  }
  const result: Pose = { pose };
  const at = finite(source.at);
  if (at !== null) result.at = at;
  const weight = expression(source.weight);
  if (weight) result.weight = weight;
  const points = readPoints(source.points);
  if (points) result.points = points;
  return result;
}

function readLayer(raw: unknown): StateLayer | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const name = text(source.name).slice(0, 60) || "слой";
  const paramRaw = text(source.param);
  const param = paramRaw && PARAM.test(paramRaw) ? paramRaw : null;
  let range: [number, number] | null = null;
  if (Array.isArray(source.range)) {
    const low = finite(source.range[0]);
    const high = finite(source.range[1]);
    if (low !== null && high !== null && high > low) range = [low, high];
  }
  const poses: Pose[] = [];
  if (Array.isArray(source.poses)) {
    for (const item of source.poses) {
      const pose = readPose(item);
      if (pose) poses.push(pose);
    }
  }
  // Привязанный слой: ключи по возрастанию, одинаковые значения схлопываются
  // (иначе при генерации получилось бы деление на ноль).
  if (param) {
    const bound = poses.filter((pose) => pose.at !== undefined);
    bound.sort((a, b) => (a.at as number) - (b.at as number));
    const unique: Pose[] = [];
    for (const pose of bound) {
      const last = unique[unique.length - 1];
      if (last && last.at === pose.at) unique[unique.length - 1] = pose;
      else unique.push(pose);
    }
    poses.length = 0;
    poses.push(...unique);
  }
  return {
    name,
    param,
    range,
    smooth: source.smooth === true,
    normalize: source.normalize === "average" ? "average" : "sum",
    poses,
  };
}

/** Настройки из скрипта. Битый JSON — пустые состояния, скрипт не переписываем. */
export function readStates(script: string): States {
  for (const line of script.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(STATES_META)) continue;
    try {
      const raw: unknown = JSON.parse(trimmed.slice(STATES_META.length));
      if (!raw || typeof raw !== "object") return { layers: [] };
      const layers = (raw as { layers?: unknown }).layers;
      if (!Array.isArray(layers)) return { layers: [] };
      const parsed: StateLayer[] = [];
      for (const item of layers) {
        const layer = readLayer(item);
        if (layer) parsed.push(layer);
      }
      return { layers: parsed };
    } catch {
      return { layers: [] };
    }
  }
  return { layers: [] };
}

/** Есть ли в скрипте блок состояний. */
export function hasStates(script: string): boolean {
  return script.split("\n").some((line) => line.trim() === START);
}

/** Ничего не настроено — блок не нужен. */
export function isStatesDefault(states: States): boolean {
  return states.layers.every((layer) => layer.poses.length === 0);
}

/**
 * Имена, значения которых нужны слоям: их объект просит у ядра списком `watch`.
 *
 * Рендерер переменных скрипта не видит, поэтому деформер, привязанный к
 * локальной переменной, получил бы ноль. Входы модулей (`mic.speak`) сюда не
 * попадают: у них есть точка в имени, и их ядро отдаёт в кадрах и так.
 */
export function watchNames(states: States): string[] {
  const names = new Set<string>();
  for (const layer of states.layers) {
    const param = layer.param ?? "";
    if (param && LOCAL.test(param)) names.add(param);
  }
  return [...names].sort();
}

/**
 * Веса слоя: строки `t…` для участков и `w…` для поз.
 *
 * Привязанный слой — базисные функции по участкам между соседними ключами:
 * сумма весов всегда 1, ключи задают не только положение, но и скорость
 * участка. За крайними ключами вес крайней позы равен 1 — значение **держится**,
 * а не экстраполируется.
 */
function weightLines(layer: StateLayer, index: number): {
  temps: string[];
  defs: string[];
  weights: string[];
} {
  if (!layer.param) {
    // Свободный слой: вес — выражение автора, поэтому это переменная блока.
    const defs = layer.poses.map((pose, poseIndex) => (
      `w${index}_${poseIndex} = ${pose.weight ? `(${pose.weight})` : "0"}`
    ));
    return {
      temps: [],
      defs,
      weights: layer.poses.map((_, poseIndex) => `w${index}_${poseIndex}`),
    };
  }
  const keys = layer.poses.map((pose) => pose.at as number);
  if (keys.length === 0) return { temps: [], defs: [], weights: [] };
  if (keys.length === 1) return { temps: [], defs: [], weights: ["1"] };
  const temps: string[] = [];
  for (let segment = 0; segment < keys.length - 1; segment += 1) {
    const from = keys[segment];
    const span = keys[segment + 1] - from;
    const raw = `limit((${layer.param} - ${signed(from)}) / ${num(span)}, 0, 1)`;
    temps.push(`t${index}_${segment} = ${layer.smooth ? `smoothstep(0, 1, ${raw})` : raw}`);
  }
  const weights: string[] = [];
  weights.push(`(1 - t${index}_0)`);
  for (let poseIndex = 1; poseIndex < keys.length - 1; poseIndex += 1) {
    weights.push(`(t${index}_${poseIndex - 1} * (1 - t${index}_${poseIndex}))`);
  }
  weights.push(`t${index}_${keys.length - 2}`);
  return { temps, defs: [], weights };
}

/**
 * Одна строка канала на поле: сумма вкладов всех поз всех слоёв.
 *
 * `sizeX`, `sizeY`, `opacity` — множители: вклад позы это `(v - 1) * w`, итог
 * `1 + Σ`. `visible` — произведение `1 - w * (1 - v)`: состояние только гасит.
 */
function channelExpression(
  field: StateField,
  parts: Array<{ layer: StateLayer; weights: string[] }>,
): string | null {
  // Видимость — произведение по всем слоям: состояние только гасит.
  if (field === "visible") {
    const factors: string[] = [];
    for (const { layer, weights } of parts) {
      layer.poses.forEach((pose, poseIndex) => {
        const value = pose.pose.visible;
        if (value === undefined || value === 1) return;
        factors.push(`(1 - ${weights[poseIndex]} * ${signed(1 - value)})`);
      });
    }
    return factors.length ? factors.join(" * ") : null;
  }
  const multiplicative = MULTIPLICATIVE.has(field);
  const terms: string[] = [];
  for (const { layer, weights } of parts) {
    const adds: string[] = [];
    const used: string[] = [];
    layer.poses.forEach((pose, poseIndex) => {
      const raw = pose.pose[field];
      if (raw === undefined) return;
      const value = multiplicative ? raw - 1 : raw;
      if (value === 0) return;
      adds.push(`${signed(value)} * ${weights[poseIndex]}`);
      used.push(weights[poseIndex]);
    });
    if (!adds.length) continue;
    if (layer.normalize === "average" && weights.length > 0) {
      // Среднее считается внутри слоя, поэтому деление обёрнуто целиком.
      terms.push(`(${adds.join(" + ")}) / (${used.join(" + ")})`);
    } else {
      terms.push(adds.join(" + "));
    }
  }
  if (!terms.length) return null;
  // Деление уже обёрнуто скобками и связывает крепче сложения.
  const joined = terms.join(" + ");
  return multiplicative ? `(${joined})` : joined;
}

/**
 * Текст блока состояний. Пустой список слоёв или слои без поз — пустая строка:
 * объект без состояний не должен тащить за собой блок.
 */
export function statesBlock(states: States, object: RigObject): string {
  const layers = states.layers.filter((layer) => layer.poses.length > 0);
  if (!layers.length) return "";
  const body: string[] = [];
  const parts: Array<{ layer: StateLayer; weights: string[] }> = [];
  layers.forEach((layer, index) => {
    const { temps, defs, weights } = weightLines(layer, index);
    body.push(...temps);
    // Свободный слой сам объявляет свои веса: у привязанного они выражения.
    body.push(...defs);
    parts.push({ layer, weights });
  });
  const channels: string[] = [];
  for (const field of STATE_FIELDS) {
    const expressionText = channelExpression(field, parts);
    if (!expressionText) continue;
    if (MULTIPLICATIVE.has(field) && field !== "visible") {
      channels.push(`${field}_states = 1 + ${expressionText}`);
    } else if (field === "visible") {
      channels.push(`visible_states = ${expressionText}`);
    } else {
      channels.push(`${field}_states = ${expressionText}`);
    }
  }
  if (!channels.length) return "";
  return [
    START,
    `${STATES_META}${JSON.stringify({ layers })}`,
    ...body,
    ...channels,
    END,
  ].join("\n");
}

/** Границы блока в скрипте или `null`, если блока нет. */
function blockRange(script: string): { start: number; end: number } | null {
  const lines = script.split("\n");
  const startLine = lines.findIndex((line) => line.trim() === START);
  if (startLine < 0) return null;
  const endLine = lines.findIndex((line, index) => index > startLine && line.trim() === END);
  if (endLine < 0) return null;
  let start = 0;
  for (let index = 0; index < startLine; index += 1) start += lines[index].length + 1;
  let end = start;
  for (let index = startLine; index <= endLine; index += 1) end += lines[index].length + 1;
  return { start, end: end - 1 };
}

function channelName(field: StateField): string {
  return `${field}_states`;
}

/** Как канал встаёт в авторскую строку. */
function channelTerm(field: StateField): string {
  return `${MULTIPLICATIVE.has(field) ? "*" : "+"} ${channelName(field)}`;
}

/** Строка по умолчанию, если её в скрипте нет. */
function channelLine(field: StateField, hasParent: boolean): string {
  const channel = channelName(field);
  if (!hasParent) return `${field} = ${channel}`;
  return MULTIPLICATIVE.has(field)
    ? `${field} = inherit * ${channel}`
    : `${field} = inherit + ${channel}`;
}

/** Убирает из правой части терм канала — только если он там есть. */
function stripTerm(rhs: string, field: StateField): string {
  const channel = channelName(field);
  const trimmed = rhs.trim();
  if (trimmed === channel) return MULTIPLICATIVE.has(field) ? "1" : "0";
  return rhs.replace(new RegExp(`\\s*[+*]\\s*${channel}\\b`), "");
}

/**
 * Вставляет терм канала сразу за `inherit`, если он есть, иначе в конец.
 *
 * Так строка читается как «наследство плюс поведение плюс состояния плюс моё»,
 * и порядок блоков в скрипте не важен. Строки внутри блоков событий не
 * трогаем: `{}` считается глубиной.
 */
function bindChannels(text: string, fields: readonly StateField[], hasParent: boolean): string {
  const lines = text.split("\n");
  const done = new Set<StateField>();
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (depth === 0) {
      for (const field of STATE_FIELDS) {
        const match = new RegExp(`^(\\s*)${field}\\s*=\\s*(.*)$`).exec(line);
        if (!match) continue;
        const channel = channelName(field);
        let rhs = stripTerm(match[2], field);
        if (fields.includes(field)) {
          if (!new RegExp(`\\b${channel}\\b`).test(rhs)) {
            const inherit = /\binherit\b/.exec(rhs);
            const term = channelTerm(field);
            if (inherit) {
              const at = inherit.index + inherit[0].length;
              rhs = `${rhs.slice(0, at)} ${term}${rhs.slice(at)}`;
            } else {
              rhs = `${rhs.trimEnd()} ${term}`;
            }
          }
        }
        lines[index] = rhs === match[2] ? line : `${match[1]}${field} = ${rhs}`;
        done.add(field);
        break;
      }
    }
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (depth < 0) depth = 0;
  }
  const missing = fields.filter((field) => !done.has(field));
  if (missing.length) {
    const extra = missing.map((field) => channelLine(field, hasParent)).join("\n");
    const body = lines.join("\n").replace(/\s+$/, "");
    return body ? `${body}\n${extra}` : extra;
  }
  return lines.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
}

export interface StatesWrite {
  script: string;
  /** Поля, которые теперь задаёт блок: их терм стоит в авторских строках. */
  fields: StateField[];
}

/**
 * Переписывает блок состояний, сохраняя авторский код под ним.
 * Пустые состояния блок удаляют, а терм канала из строк убирают.
 */
export function writeStates(script: string, states: States, object: RigObject): StatesWrite {
  const range = blockRange(script);
  const tail = range ? script.slice(0, range.start) + script.slice(range.end) : script;
  const block = statesBlock(states, object);
  const fields = block
    ? STATE_FIELDS.filter((field) => new RegExp(`^\\s*${channelName(field)}\\s*=`, "m").test(block))
    : [];
  const rest = bindChannels(tail, fields, Boolean(object.parentId));
  const body = [block, rest].filter(Boolean).join("\n\n");
  return { script: body ? `${body}\n` : "", fields: [...fields] };
}

/** Сброс состояний у всего выделения: блок из каждого скрипта удаляется. */
export function resetStatesFor(targets: RigObject[]): Record<string, string> {
  const scripts: Record<string, string> = {};
  for (const target of targets) {
    scripts[target.id] = writeStates(target.script, EMPTY_STATES, target).script;
  }
  return scripts;
}
