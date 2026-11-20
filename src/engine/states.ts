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
  /**
   * Сглаживание входа, мс: значение параметра проходит через `smooth(...)`
   * перед расчётом весов. `0` — выключено.
   *
   * Это именно сглаживание **входа**, а не формы участка: у трекера дрожание
   * снимается временем, а не изменением кривой между ключами. Старый формат
   * знал только `true`/`false` — `true` читается как `SMOOTH_DEFAULT`.
   */
  smooth: number;
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

/** Сглаживание входа: мс, `true` из старого формата, иначе выключено. */
export const SMOOTH_DEFAULT = 120;
export const SMOOTH_LIMIT = 2000;

function readSmooth(raw: unknown): number {
  if (raw === true) return SMOOTH_DEFAULT;
  const value = finite(raw);
  if (value === null || value <= 0) return 0;
  return Math.min(SMOOTH_LIMIT, Math.round(value));
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
    smooth: readSmooth(source.smooth),
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
    // Сглаживание входа — вокруг параметра, поэтому `smooth` стоит до деления:
    // иначе дрожание трекера попадало бы в участок уже после ограничения.
    const source = layer.smooth > 0 ? `smooth(${layer.param}, ${num(layer.smooth)})` : layer.param;
    const raw = `limit((${source} - ${signed(from)}) / ${num(span)}, 0, 1)`;
    temps.push(`t${index}_${segment} = ${raw}`);
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
  // Каналов может не быть: слой только что создан, поза ещё пустая. Блок всё
  // равно пишется — иначе настройки исчезли бы с первым же пересозданием
  // скрипта, а вкладка показала бы пустой список.
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

/**
 * Правки состояний — чистые функции над данными.
 *
 * Вкладка «Состояния» только показывает и вызывает: всё, что меняет структуру
 * (слои, ключи, дельты), живёт здесь, поэтому проверяется без браузера.
 */

/** Новый слой: привязанный к параметру, если он задан. */
export function makeLayer(index: number, param: string | null = null): StateLayer {
  return {
    name: param ? `слой ${index + 1}` : `веса ${index + 1}`,
    param,
    range: null,
    smooth: 0,
    normalize: "sum",
    poses: param ? [{ at: 0, pose: {} }] : [{ weight: "1", pose: {} }],
  };
}

export function addLayer(states: States, layer: StateLayer): States {
  return { layers: [...states.layers, layer] };
}

export function removeLayer(states: States, index: number): States {
  return { layers: states.layers.filter((_, position) => position !== index) };
}

export function patchLayer(states: States, index: number, patch: Partial<StateLayer>): States {
  return {
    layers: states.layers.map((layer, position) => (
      position === index ? { ...layer, ...patch } : layer
    )),
  };
}

/**
 * Ключ в точке параметра. Поза кладётся на существующий ключ того же значения,
 * иначе создаётся новый — клик по таймлайну не должен плодить двойников.
 */
export function addKey(layer: StateLayer, at: number, pose: Partial<Record<StateField, number>> = {}): StateLayer {
  const existing = layer.poses.findIndex((item) => item.at === at);
  if (existing >= 0) {
    const poses = layer.poses.map((item, index) => (
      index === existing ? { ...item, pose: { ...item.pose, ...pose } } : item
    ));
    return sortKeys({ ...layer, poses });
  }
  return sortKeys({ ...layer, poses: [...layer.poses, { at, pose: { ...pose } }] });
}

export function removeKey(layer: StateLayer, index: number): StateLayer {
  return { ...layer, poses: layer.poses.filter((_, position) => position !== index) };
}

/** Ключ переехал: порядок восстанавливается, одинаковые значения сливаются. */
export function moveKey(layer: StateLayer, index: number, at: number): StateLayer {
  if (!Number.isFinite(at)) return layer;
  const poses = layer.poses.map((pose, position) => (
    position === index ? { ...pose, at } : pose
  ));
  return sortKeys({ ...layer, poses });
}

export function setPose(layer: StateLayer, index: number, pose: Partial<Record<StateField, number>>): StateLayer {
  return {
    ...layer,
    poses: layer.poses.map((item, position) => (
      position === index ? { ...item, pose: { ...item.pose, ...pose } } : item
    )),
  };
}

/** Один ключ по возрастанию значения; одинаковые схлопываются в последний. */
function sortKeys(layer: StateLayer): StateLayer {
  const sorted = [...layer.poses].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const unique: Pose[] = [];
  for (const pose of sorted) {
    const last = unique[unique.length - 1];
    if (last && last.at === pose.at) unique[unique.length - 1] = pose;
    else unique.push(pose);
  }
  return { ...layer, poses: unique };
}

/**
 * Отрезок таймлайна: что выставлено, иначе крайние ключи, иначе 0…1.
 * Паспорт входа живёт в `meta` у редактора, поэтому сюда он приходит готовым.
 */
export function layerRange(layer: StateLayer, fallback: [number, number] | null = null): [number, number] {
  if (layer.range) return layer.range;
  const keys = layer.poses.map((pose) => pose.at).filter((at): at is number => at !== undefined);
  if (keys.length >= 2) return [Math.min(...keys), Math.max(...keys)];
  if (keys.length === 1) return [keys[0] - 1, keys[0] + 1];
  return fallback ?? [0, 1];
}

/** Имя входа модуля `manual.<имя>` — его можно двигать предпросмотром. */
export function manualInputOf(param: string | null): string | null {
  if (!param) return null;
  const match = /^manual\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(param);
  return match ? match[1] : null;
}

/**
 * Дельта позы из разницы базовых поз.
 *
 * Запись позы опирается на единственное, что человек реально двигает руками, —
 * базовую позу объекта (перетаскивание на сцене и инспектор). Поэтому запись
 * берёт разницу «было → стало» и переводит её в дельты: позиция, поворот и
 * наклон складываются, размер и прозрачность — отношения.
 */
export function poseFromBase(
  before: { x?: number; y?: number; rotation?: number; skewX?: number; skewY?: number; sizeX?: number; sizeY?: number; opacity?: number },
  after: { x?: number; y?: number; rotation?: number; skewX?: number; skewY?: number; sizeX?: number; sizeY?: number; opacity?: number },
): Partial<Record<StateField, number>> {
  const pose: Partial<Record<StateField, number>> = {};
  const sum = (key: "x" | "y" | "rotation" | "skewX" | "skewY") => {
    const delta = (after[key] ?? 0) - (before[key] ?? 0);
    if (Math.abs(delta) > 1e-6) pose[key] = Math.round(delta * 1000) / 1000;
  };
  sum("x");
  sum("y");
  sum("rotation");
  sum("skewX");
  sum("skewY");
  const ratio = (key: "sizeX" | "sizeY" | "opacity") => {
    const from = before[key] ?? 1;
    const to = after[key] ?? 1;
    if (!from || Math.abs(to - from) < 1e-6) return;
    pose[key] = Math.round((to / from) * 1000) / 1000;
  };
  ratio("sizeX");
  ratio("sizeY");
  ratio("opacity");
  return pose;
}

/** Ось зеркала: точка в координатах сцены и угол в градусах. */
export interface MirrorAxis {
  x: number;
  y: number;
  /** Градусы: 90 — вертикальная ось, 0 — горизонтальная. */
  angle: number;
}

export interface MirrorOrigin {
  /**
   * Базовая позиция объекта: относительно неё считаются дельты позы.
   * Если ось проходит через неё (значение по умолчанию), отражение вектора
   * дельты совпадает с отражением положения.
   */
  x: number;
  y: number;
  /** Размер объекта: точки деформера живут в долях картинки. */
  width?: number;
  height?: number;
}

/** Ось ортогональна: только у неё наклоны меняют знак без искажения формы. */
function orthogonal(angle: number): boolean {
  const quarter = ((angle % 180) + 180) % 180;
  return Math.abs(quarter) < 1e-9 || Math.abs(quarter - 90) < 1e-9;
}

/**
 * Зеркало позы относительно оси «точка + угол».
 *
 * Смещения отражаются как положения в сцене относительно базы объекта: при оси
 * через саму базу (по умолчанию) это ровно `d′ = 2(d·u)·u − d` из плана.
 * Поворот меняет знак: отражение переворачивает обход, а не поворачивает
 * картинку. Наклоны меняют знак только у ортогональных осей — при косой оси
 * отражённый наклон нашими полями не выражается, и подменять его нельзя.
 */
export function mirrorLayer(
  layer: StateLayer,
  axis: MirrorAxis,
  origin: MirrorOrigin,
): StateLayer {
  const radians = (axis.angle * Math.PI) / 180;
  const ux = Math.cos(radians);
  const uy = Math.sin(radians);
  const flip = orthogonal(axis.angle);
  /** Отражение вектора относительно направления оси. */
  const reflect = (dx: number, dy: number): [number, number] => {
    const dot = dx * ux + dy * uy;
    return [2 * dot * ux - dx, 2 * dot * uy - dy];
  };
  const width = origin.width ?? 1;
  const height = origin.height ?? 1;
  const round = (value: number) => {
    const result = Math.round(value * 1000) / 1000;
    return Object.is(result, -0) ? 0 : result;
  };
  return {
    ...layer,
    poses: layer.poses.map((pose) => {
      const next: Partial<Record<StateField, number>> = { ...pose.pose };
      if (pose.pose.x !== undefined || pose.pose.y !== undefined) {
        const [rx, ry] = reflect(
          origin.x + (pose.pose.x ?? 0) - axis.x,
          origin.y + (pose.pose.y ?? 0) - axis.y,
        );
        const x = round(rx + axis.x - origin.x);
        const y = round(ry + axis.y - origin.y);
        if (x === 0) delete next.x; else next.x = x;
        if (y === 0) delete next.y; else next.y = y;
      }
      for (const field of ["rotation", "skewX", "skewY"] as const) {
        const value = pose.pose[field];
        if (value === undefined) continue;
        if (field !== "rotation" && !flip) continue;
        const flipped = round(-value);
        if (flipped === 0) delete next[field]; else next[field] = flipped;
      }
      const points = pose.points
        ? Object.fromEntries(Object.entries(pose.points).map(([key, point]) => {
          const [dx, dy] = reflect(point[0] * width, point[1] * height);
          return [key, [round(dx / width), round(dy / height)]];
        })) as Record<string, PosePoint>
        : undefined;
      return { ...pose, pose: next, points };
    }),
  };
}

/**
 * «Инвертировать по входу»: значения ключей зеркалятся на отрезке параметра
 * (`at → от + до − at`), позы остаются при своих ключах.
 */
export function invertByInput(layer: StateLayer, fallback: [number, number] | null = null): StateLayer {
  const [from, to] = layerRange(layer, fallback);
  const sum = from + to;
  const poses = layer.poses.map((pose) => (
    pose.at === undefined ? pose : { ...pose, at: Math.round((sum - pose.at) * 1000) / 1000 }
  ));
  return sortKeys({ ...layer, poses });
}

/**
 * «Развернуть по таймлайну»: значения ключей на месте, позы идут в обратном
 * порядке. На несимметричных ключах это не то же самое, что инверсия по входу.
 */
export function reversePoses(layer: StateLayer): StateLayer {
  const positions = [...layer.poses]
    .map((pose) => pose.at)
    .sort((a, b) => (a ?? 0) - (b ?? 0));
  const reversed = [...layer.poses].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).reverse();
  return {
    ...layer,
    poses: positions.map((at, index) => ({ ...reversed[index], at })),
  };
}

/**
 * Свободное имя: копия получает ` (2)`, если имя уже занято.
 *
 * Имена уникальны и внутри пачки, и относительно существующих слоёв: две
 * вставки одного и того же слоя не должны выглядеть одинаково.
 */
export function uniqueLayerName(name: string, taken: readonly string[]): string {
  const busy = new Set(taken);
  const base = name.trim() || "слой";
  if (!busy.has(base)) return base;
  const bare = base.replace(/\s*\(\d+\)$/, "");
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${bare} (${index})`;
    if (!busy.has(candidate)) return candidate;
  }
  return `${bare} (${busy.size + 1})`;
}

/** Копии слоёв с новыми именами: правка копии не задевает оригинал. */
export function cloneLayers(layers: readonly StateLayer[], taken: readonly string[]): StateLayer[] {
  const names = [...taken];
  return layers.map((layer) => {
    const name = uniqueLayerName(layer.name, names);
    names.push(name);
    return {
      ...layer,
      name,
      range: layer.range ? [layer.range[0], layer.range[1]] : null,
      poses: layer.poses.map((pose) => ({
        ...pose,
        pose: { ...pose.pose },
        points: pose.points ? { ...pose.points } : undefined,
      })),
    };
  });
}

/** Вставить слои после указанного места (по умолчанию — в конец). */
export function insertLayers(states: States, layers: readonly StateLayer[], after = states.layers.length - 1): States {
  const at = Math.min(states.layers.length, Math.max(0, after + 1));
  return { layers: [...states.layers.slice(0, at), ...layers, ...states.layers.slice(at)] };
}

/** Убрать слои по индексам: выделение может быть любым. */
export function removeLayers(states: States, indexes: readonly number[]): States {
  const drop = new Set(indexes);
  return { layers: states.layers.filter((_, position) => !drop.has(position)) };
}

/**
 * Пересчёт ключей под новый диапазон входа: `at` остаётся значением шкалы, но
 * пропорционально переносится в границы нового параметра.
 *
 * Нужен при замене параметра, у которого другой паспорт (`−1…1` → `0…1`):
 * без пересчёта ключ на `1` уехал бы за край и слой стоял бы в крайнем весе.
 */
export function scaleKeys(layer: StateLayer, from: [number, number], to: [number, number]): StateLayer {
  const span = from[1] - from[0];
  if (!span) return layer;
  const scale = (to[1] - to[0]) / span;
  const poses = layer.poses.map((pose) => (
    pose.at === undefined ? pose : {
      ...pose,
      at: Math.round((to[0] + (pose.at - from[0]) * scale) * 1000) / 1000,
    }
  ));
  return sortKeys({ ...layer, range: to, poses });
}

/**
 * Веса слоя по значению параметра — тот же базис, что генерирует `weightLines`,
 * но числом.
 *
 * Нужен предпросмотру: вкладка показывает позу «между ключами», не дожидаясь
 * ядра. Дублирование формулы намеренное: генератор пишет текст для ядра, а
 * здесь считается картинка в редакторе, и разъехаться они не могут незаметно —
 * у обоих один и тот же набор ключей и одно правило участков.
 */
export function weightsAt(layer: StateLayer, value: number): number[] {
  if (!layer.param) return [];
  const keys = layer.poses.map((pose) => pose.at ?? 0);
  if (keys.length === 0) return [];
  if (keys.length === 1) return [1];
  const temps: number[] = [];
  for (let segment = 0; segment < keys.length - 1; segment += 1) {
    const from = keys[segment];
    const span = keys[segment + 1] - from;
    temps.push(span === 0 ? 0 : Math.min(1, Math.max(0, (value - from) / span)));
  }
  const weights: number[] = [1 - temps[0]];
  for (let poseIndex = 1; poseIndex < keys.length - 1; poseIndex += 1) {
    weights.push(temps[poseIndex - 1] * (1 - temps[poseIndex]));
  }
  weights.push(temps[temps.length - 1]);
  return weights;
}

/**
 * Дельта выбранного слоя в точке таймлайна: то, что слой делает с объектом.
 *
 * Правила те же, что у каналов: смещения складываются, размер и прозрачность —
 * множители, видимость только гасит. Прочие слои не учитываются: вкладка
 * показывает состояние **этого** слоя — иначе правку одного слоя нельзя было бы
 * проверить, не глядя на остальные.
 */
export function poseAt(layer: StateLayer, value: number): Partial<Record<StateField, number>> {
  const weights = weightsAt(layer, value);
  const delta: Partial<Record<StateField, number>> = {};
  if (!weights.length) return delta;
  for (const field of STATE_FIELDS) {
    if (field === "visible") {
      let factor = 1;
      layer.poses.forEach((pose, index) => {
        const item = pose.pose.visible;
        if (item === undefined || item === 1) return;
        factor *= 1 - weights[index] * (1 - item);
      });
      if (Math.abs(factor - 1) > 1e-9) delta.visible = Math.round(factor * 1000) / 1000;
      continue;
    }
    let total = 0;
    let used = false;
    layer.poses.forEach((pose, index) => {
      const raw = pose.pose[field];
      if (raw === undefined) return;
      used = true;
      total += (MULTIPLICATIVE.has(field) ? raw - 1 : raw) * weights[index];
    });
    if (!used) continue;
    const result = MULTIPLICATIVE.has(field) ? 1 + total : total;
    if (Math.abs(result - (MULTIPLICATIVE.has(field) ? 1 : 0)) < 1e-9) continue;
    delta[field] = Math.round(result * 1000) / 1000;
  }
  return delta;
}

/** Дельта выбранной позы: у свободного слоя предпросмотр идёт по ней. */
export function poseOfPose(pose: Pose): Partial<Record<StateField, number>> {
  return { ...pose.pose };
}

/**
 * Базовая поза с наложенной дельтой — то, что видно на сцене в предпросмотре.
 *
 * Складываются смещения и повороты, умножаются размер и прозрачность: ровно те
 * же правила, что у каналов `*_states` в скрипте.
 */
export function applyPoseToBase(
  base: { x?: number; y?: number; rotation?: number; skewX?: number; skewY?: number; sizeX?: number; sizeY?: number; opacity?: number },
  delta: Partial<Record<StateField, number>>,
): { x?: number; y?: number; rotation?: number; skewX?: number; skewY?: number; sizeX?: number; sizeY?: number; opacity?: number } {
  const next = { ...base };
  for (const field of ["x", "y", "rotation", "skewX", "skewY"] as const) {
    const value = delta[field];
    if (value === undefined) continue;
    next[field] = Math.round(((next[field] ?? 0) + value) * 1000) / 1000;
  }
  for (const field of ["sizeX", "sizeY", "opacity"] as const) {
    const value = delta[field];
    if (value === undefined) continue;
    next[field] = Math.round(((next[field] ?? 1) * value) * 1000) / 1000;
  }
  return next;
}

/** Совпадают ли позы: предпросмотр не должен путать свою запись с правкой человека. */
export function sameBase(
  left: { x?: number; y?: number; rotation?: number; skewX?: number; skewY?: number; sizeX?: number; sizeY?: number; opacity?: number } | null,
  right: { x?: number; y?: number; rotation?: number; skewX?: number; skewY?: number; sizeX?: number; sizeY?: number; opacity?: number } | null,
): boolean {
  if (!left || !right) return left === right;
  const fields = ["x", "y", "rotation", "skewX", "skewY", "sizeX", "sizeY", "opacity"] as const;
  return fields.every((field) => Math.abs((left[field] ?? 0) - (right[field] ?? 0)) < 1e-6);
}
