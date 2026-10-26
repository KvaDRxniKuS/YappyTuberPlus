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
      smooth: false,
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
  return { kind: "shape", shapeId: "", points: [], file: null, invert: false, feather: 0 };
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
    smooth: item.smooth === true,
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
  tracePath(ctx, item.points, item.smooth, item.closed);
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
  smooth: boolean,
  closed: boolean,
): void {
  if (!points.length) return;
  if (points.length === 1) {
    ctx.moveTo(points[0].x, points[0].y);
    return;
  }
  if (!smooth || points.length < 3) {
    ctx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) ctx.lineTo(points[index].x, points[index].y);
    if (closed) {
      ctx.lineTo(points[0].x, points[0].y);
      ctx.closePath();
    }
    return;
  }

  const count = points.length;
  const at = (index: number) => points[((index % count) + count) % count];
  ctx.moveTo(points[0].x, points[0].y);
  const segments = closed ? count : count - 1;
  for (let index = 0; index < segments; index += 1) {
    const p0 = at(index - 1);
    const p1 = at(index);
    const p2 = at(index + 1);
    const p3 = at(index + 2);
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p2.x, p2.y);
  }
  if (closed) ctx.closePath();
}

/** Все контуры фигуры одним путём: так маска и заливка не расходятся. */
export function traceShape(ctx: CanvasRenderingContext2D, spec: ShapeSpec): void {
  for (const item of spec.items) traceItem(ctx, item);
}

/** Ближайшая точка контура: по ней перо хватает готовую точку для переноса. */
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
    smooth: true,
    closed: true,
  };
}
