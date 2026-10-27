import type { ShapeItem, ShapeItemKind, ShapeSpec, MaskSpec, Vec2 } from "../types";

/**
 * Геометрия фигур и масок.
 *
 * Здесь нет ни кадра, ни сцены: только чистые функции над контурами. Поэтому
 * одну и ту же геометрию использует и отрисовка, и редактор пера, и маска —
 * расхождению взяться неоткуда.
 */

/** Новая фигура: прямоугольник по центру рамки объекта. */
export function defaultShape(width = 240, height = 160): ShapeSpec {
  return {
    items: [{
      id: "shape_1",
      kind: "rect",
      x: 0,
      y: 0,
      width,
      height,
      points: [],
      smoothPoints: [],
      closed: true,
    }],
    fill: "#6bc0aa",
    stroke: "#e8eef4",
    strokeWidth: 0,
    draw: true,
  };
}

/** Пустая маска: объект виден целиком. */
export function defaultMask(): MaskSpec {
  return { kind: "shape", shapeId: "", points: [], file: null, origin: "project", invert: false, feather: 0 };
}

const ITEM_KINDS: ShapeItemKind[] = ["rect", "ellipse", "path"];

function readNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Точки из массива `{x, y}` или из строки «10,20; 30,40». */
export function readPoints(raw: unknown): Vec2[] {
  if (typeof raw === "string") return parsePoints(raw);
  if (!Array.isArray(raw)) return [];
  const points: Vec2[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const point = item as Record<string, unknown>;
    const x = readNumber(point.x, NaN);
    const y = readNumber(point.y, NaN);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
  }
  return points;
}

/** «10,20; 30,40» → точки. Разделители — `;`, перевод строки и пробелы между парами. */
export function parsePoints(text: string): Vec2[] {
  const points: Vec2[] = [];
  for (const chunk of text.split(/[;\n]+/)) {
    const pair = chunk.trim().split(/[\s,]+/).filter(Boolean);
    if (pair.length < 2) continue;
    const x = Number(pair[0]);
    const y = Number(pair[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
  }
  return points;
}

/** Точки → строка для поля ввода: «10, 20; 30, 40». */
export function formatPoints(points: Vec2[]): string {
  return points.map((point) => `${round(point.x)}, ${round(point.y)}`).join("; ");
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function normalizeItem(raw: unknown, index: number): ShapeItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const kind = ITEM_KINDS.includes(item.kind as ShapeItemKind) ? item.kind as ShapeItemKind : "rect";
  return {
    id: typeof item.id === "string" && item.id ? item.id : `shape_${index + 1}`,
    kind,
    x: readNumber(item.x),
    y: readNumber(item.y),
    width: readNumber(item.width),
    height: readNumber(item.height),
    points: readPoints(item.points),
    // Сглаживание — свойство каждой точки (0…100 %). Старое поле `smooth`
    // означало «весь контур кривой», поэтому при чтении оно разворачивается в
    // сотни: настройка не должна потеряться при открытии старого пресета.
    smoothPoints: readSmoothing(item.smoothPoints, item.smooth === true, readPoints(item.points).length),
    closed: item.closed !== false,
  };
}

/** Приводит фигуры из файла пресета к известному виду. */
export function normalizeShape(raw: unknown, width = 240, height = 160): ShapeSpec {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const items = Array.isArray(source.items)
    ? source.items.map((item, index) => normalizeItem(item, index)).filter((item): item is ShapeItem => item !== null)
    : [];
  return {
    items: items.length ? items : defaultShape(width, height).items,
    fill: typeof source.fill === "string" && source.fill ? source.fill : "#6bc0aa",
    stroke: typeof source.stroke === "string" ? source.stroke : "#e8eef4",
    strokeWidth: Math.max(0, readNumber(source.strokeWidth)),
    draw: source.draw !== false,
  };
}

/** Маска из файла пресета; `undefined` — маски нет. */
export function normalizeMask(raw: unknown): MaskSpec | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const kind = source.kind;
  if (kind !== "shape" && kind !== "points" && kind !== "file") return undefined;
  return {
    kind,
    shapeId: typeof source.shapeId === "string" ? source.shapeId : "",
    points: readPoints(source.points),
    file: typeof source.file === "string" && source.file ? source.file : null,
    // Внутренний файл лежит в хранилище приложения (`asset:<id>`), внешний —
    // путь или data URL. По самой ссылке это видно, поэтому старые пресеты
    // получают правильное значение без отдельного поля.
    origin: source.origin === "external"
      ? "external"
      : typeof source.file === "string" && /^asset:/.test(source.file) ? "project" : source.origin === "project" ? "project" : "external",
    invert: source.invert === true,
    feather: Math.max(0, readNumber(source.feather)),
  };
}

/** Обвести один контур: рамку, эллипс или перо. */
export function traceItem(ctx: CanvasRenderingContext2D, item: ShapeItem): void {
  if (item.kind === "rect") {
    ctx.rect(item.x, item.y, item.width, item.height);
    return;
  }
  if (item.kind === "ellipse") {
    const rx = Math.abs(item.width) / 2;
    const ry = Math.abs(item.height) / 2;
    ctx.ellipse(item.x + item.width / 2, item.y + item.height / 2, rx, ry, 0, 0, Math.PI * 2);
    return;
  }
  tracePath(ctx, item.points, item.smoothPoints, item.closed);
}

/**
 * Контур по точкам.
 *
 * Ломаная — отрезки как есть. Кривая — Catmull-Rom, переведённый в кубические
 * Безье: линия проходит через все точки, поэтому перо можно вести «по местам»,
 * а не подбирать управляющие ручки, которых в интерфейсе нет.
 */
export function tracePath(
  ctx: CanvasRenderingContext2D,
  points: Vec2[],
  smoothing: number | number[] | boolean,
  closed: boolean,
): void {
  if (!points.length) return;
  if (points.length === 1) {
    ctx.moveTo(points[0].x, points[0].y);
    return;
  }
  const strength = (index: number): number => {
    if (typeof smoothing === "boolean") return smoothing ? 100 : 0;
    if (typeof smoothing === "number") return smoothing;
    const value = smoothing[index];
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  };
  ctx.moveTo(points[0].x, points[0].y);
  const count = points.length;
  const at = (index: number) => points[((index % count) + count) % count];
  const segments = closed ? count : count - 1;
  for (let index = 0; index < segments; index += 1) {
    const p1 = points[index];
    const p2 = points[(index + 1) % count];
    // Ребро сглаживается настолько, насколько сглажены обе его точки: угол
    // рядом с дугой остаётся углом, а сама дуга не ломается.
    const amount = Math.min(strength(index), strength((index + 1) % count)) / 100;
    if (amount <= 0.0001) {
      ctx.lineTo(p2.x, p2.y);
      continue;
    }
    const p0 = at(index - 1);
    const p3 = at(index + 2);
    // Catmull-Rom, сжатый к концам ребра: при 100 % линия проходит через
    // точки как настоящая кривая, при 0 % — прямая.
    const c1 = { x: p1.x + ((p2.x - p0.x) / 6) * amount, y: p1.y + ((p2.y - p0.y) / 6) * amount };
    const c2 = { x: p2.x - ((p3.x - p1.x) / 6) * amount, y: p2.y - ((p3.y - p1.y) / 6) * amount };
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p2.x, p2.y);
  }
  // У замкнутого контура замыкающее ребро уже нарисовано циклом: у него своё
  // сглаживание (между последней и первой точкой), и второй раз его рисовать
  // нельзя — линия утолщалась бы на стыке.
  if (closed) ctx.closePath();
}

/** Все контуры фигуры одним путём: так маска и заливка не расходятся. */
export function traceShape(ctx: CanvasRenderingContext2D, spec: ShapeSpec): void {
  for (const item of spec.items) traceItem(ctx, item);
}

/** Ближайшая точка контура: по ней перо хватает готовую точку для переноса. */
/**
 * Сила сглаживания точек из файла пресета: массив 0…100 на каждую точку.
 * Старый пресет с `smooth: true` получает полное сглаживание.
 */
export function readSmoothing(raw: unknown, legacy: boolean, count: number): number[] {
  const list = Array.isArray(raw) ? raw : [];
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = Number(list[index]);
    const fallback = legacy ? 100 : 0;
    values.push(Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : fallback);
  }
  return values;
}

/** Сглаживание конкретной точки: 0 — угол, 100 — полная кривая. */
export function smoothingOf(item: ShapeItem, index: number): number {
  const value = item.smoothPoints[index];
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

/**
 * Куда вставить точку, чтобы контур не перекосило: между двумя ближайшими.
 *
 * Возвращает индекс, по которому новую точку нужно вставить (то есть она
 * встанет перед ним). Для замкнутого контура замыкающее ребро тоже участвует:
 * иначе клик по нижней стороне кольца отправлял точку в конец списка.
 */
export function insertIndexFor(points: Vec2[], target: Vec2, closed: boolean): number {
  if (points.length < 2) return points.length;
  let best = points.length;
  let distance = Infinity;
  const segments = closed ? points.length : points.length - 1;
  for (let index = 0; index < segments; index += 1) {
    const from = points[index];
    const to = points[(index + 1) % points.length];
    const squared = distanceToSegment(target, from, to);
    if (squared < distance) {
      distance = squared;
      best = index + 1;
    }
  }
  return best;
}

/**
 * Что делает клик пером.
 *
 * Логика вынесена из сцены, чтобы её можно было проверить тестом: правила
 * такие — Alt по точке меняет тип соединения, клик по первой точке замыкает
 * контур (от трёх точек), клик по готовой точке начинает перетаскивание, а
 * клик мимо вставляет новую между двумя ближайшими.
 */
export type PenAction =
  | { type: "toggle-smoothing"; index: number; value: number }
  | { type: "close" }
  | { type: "drag"; index: number }
  | { type: "insert"; index: number; smoothing: number };

export function penAction(item: ShapeItem, target: Vec2, radius: number, alt = false): PenAction {
  const index = nearestPoint(item.points, target, radius);
  if (index >= 0) {
    if (alt) return { type: "toggle-smoothing", index, value: smoothingOf(item, index) > 0 ? 0 : 100 };
    if (index === 0 && item.points.length >= 3 && !item.closed) return { type: "close" };
    return { type: "drag", index };
  }
  const at = insertIndexFor(item.points, target, item.closed);
  // Сглаживание новой точки — среднее у соседей: вставка не ломает дугу.
  const beforeIndex = at - 1 >= 0 ? at - 1 : item.points.length - 1;
  const afterIndex = at < item.points.length ? at : 0;
  const before = item.points[beforeIndex];
  const after = item.points[afterIndex];
  const smoothing = before && after
    ? (smoothingOf(item, beforeIndex) + smoothingOf(item, afterIndex)) / 2
    : 0;
  return { type: "insert", index: at, smoothing };
}

/** Квадрат расстояния от точки до отрезка. */
function distanceToSegment(point: Vec2, from: Vec2, to: Vec2): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.min(1, Math.max(0, ((point.x - from.x) * dx + (point.y - from.y) * dy) / length));
  const x = from.x + dx * t;
  const y = from.y + dy * t;
  return (point.x - x) ** 2 + (point.y - y) ** 2;
}

export function nearestPoint(points: Vec2[], target: Vec2, radius: number): number {
  let best = -1;
  let distance = radius * radius;
  points.forEach((point, index) => {
    const dx = point.x - target.x;
    const dy = point.y - target.y;
    const squared = dx * dx + dy * dy;
    if (squared <= distance) {
      distance = squared;
      best = index;
    }
  });
  return best;
}

/** Уникальный id контура в пределах фигуры: `path_1`, `path_2`… */
export function uniqueItemId(spec: ShapeSpec, base: ShapeItemKind): string {
  const prefix = base === "ellipse" ? "ellipse" : base === "path" ? "path" : "rect";
  let index = spec.items.length + 1;
  while (spec.items.some((item) => item.id === `${prefix}_${index}`)) index += 1;
  return `${prefix}_${index}`;
}

/** Новый контур для кнопки «Добавить»: рамка чуть меньше объекта, перо — пустое. */
export function makeItem(spec: ShapeSpec, kind: ShapeItemKind, width: number, height: number): ShapeItem {
  const inset = 0.15;
  return {
    id: uniqueItemId(spec, kind),
    kind,
    x: Math.round(width * inset),
    y: Math.round(height * inset),
    width: Math.round(width * (1 - inset * 2)),
    height: Math.round(height * (1 - inset * 2)),
    points: [],
    smoothPoints: [],
    closed: true,
  };
}
