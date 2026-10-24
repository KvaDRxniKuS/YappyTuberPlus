import type { RigObject } from "../types";

/**
 * Геометрия и правила выделения. Модуль намеренно не зависит от React и DOM:
 * его проверяют node-тесты, а `Scene`/`TreePanel` только передают данные.
 */

export interface Point { x: number; y: number }
export interface Box { minX: number; minY: number; maxX: number; maxY: number }

/** Диапазон по видимому порядку строк дерева: от опорного объекта до кликнутого. */
export function rangeIds(order: string[], anchor: string | null, target: string): string[] {
  const to = order.indexOf(target);
  if (to < 0) return [target];
  const from = anchor ? order.indexOf(anchor) : -1;
  if (from < 0) return [target];
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  return order.slice(start, end + 1);
}

/** Переключение одного объекта в наборе: добавить, если нет, иначе убрать. */
export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

/**
 * Корни выборки — объекты, чьи предки в выборку не входят. Удаление,
 * дублирование и перетаскивание идут по корням, иначе дети обработаются дважды.
 * Порядок сохраняется как в выборке.
 */
export function selectionRoots(objects: RigObject[], ids: Iterable<string>): string[] {
  const set = new Set(ids);
  const byId = new Map(objects.map((object) => [object.id, object]));
  return [...set].filter((id) => {
    const seen = new Set<string>();
    let parent = byId.get(id)?.parentId ?? null;
    while (parent && !seen.has(parent)) {
      if (set.has(parent)) return false;
      seen.add(parent);
      parent = byId.get(parent)?.parentId ?? null;
    }
    return true;
  });
}

/** Все потомки набора (включая сами корни) — то, что реально двигается вместе с корнем. */
export function subtreeIds(objects: RigObject[], roots: Iterable<string>): string[] {
  const result = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const object of objects) {
      if (object.parentId && result.has(object.parentId) && !result.has(object.id)) {
        result.add(object.id);
        changed = true;
      }
    }
  }
  return [...result];
}

export function boxFromPoints(a: Point, b: Point): Box {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

export function boxFromCorners(points: Point[]): Box {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

export function boxIntersects(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function boxContainsPoint(box: Box, point: Point): boolean {
  return point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY;
}

export function boxCenter(box: Box): Point {
  return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
}

export function boxCorners(box: Box): Point[] {
  return [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ];
}

/** Пересечение двух отрезков (стандартный тест ориентаций). */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const onSegment = (p: Point, q: Point, r: Point) =>
    Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) &&
    Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y);
  if (d1 === 0 && onSegment(c, d, a)) return true;
  if (d2 === 0 && onSegment(c, d, b)) return true;
  if (d3 === 0 && onSegment(a, b, c)) return true;
  if (d4 === 0 && onSegment(a, b, d)) return true;
  return false;
}

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    const intersects = (a.y > point.y) !== (b.y > point.y) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Лассо задевает объект, если центр рамки внутри, угол рамки внутри лассо или рёбра пересеклись. */
export function polygonIntersectsBox(polygon: Point[], box: Box): boolean {
  if (polygon.length < 3) return false;
  if (pointInPolygon(boxCenter(box), polygon)) return true;
  const corners = boxCorners(box);
  if (corners.some((corner) => pointInPolygon(corner, polygon))) return true;
  for (const corner of corners) if (boxContainsPoint(box, corner) && pointInPolygon(corner, polygon)) return true;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    for (let corner = 0; corner < corners.length; corner += 1) {
      if (segmentsIntersect(a, b, corners[corner], corners[(corner + 1) % corners.length])) return true;
    }
  }
  return false;
}
