import type { RigObject, RigPreset } from "../types";
import { type Affine, objectMatrix, staticValues, transformPoint } from "./rigCanvas";

export interface Point { x: number; y: number }

/** Квадрат границ объекта в координатах сцены по его текущей матрице. */
export function spriteBounds(object: RigObject, matrix: Affine): Point[] {
  const left = -object.pivot.x * object.width;
  const top = -object.pivot.y * object.height;
  return [
    transformPoint(matrix, left, top),
    transformPoint(matrix, left + object.width, top),
    transformPoint(matrix, left + object.width, top + object.height),
    transformPoint(matrix, left, top + object.height),
  ];
}

/** Базовые границы группы: объединение базовых рамок всех её потомков-спрайтов. */
export function groupBounds(preset: { objects: RigObject[] }, groupId: string): Point[] | null {
  const ids = new Set<string>([groupId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const object of preset.objects) {
      if (object.parentId && ids.has(object.parentId) && !ids.has(object.id)) {
        ids.add(object.id);
        changed = true;
      }
    }
  }
  const points: Point[] = [];
  for (const object of preset.objects) {
    if (object.kind === "group" || !ids.has(object.id)) continue;
    points.push(...spriteBounds(object, objectMatrix(object, staticValues(object))));
  }
  if (points.length === 0) {
    const group = preset.objects.find((object) => object.id === groupId);
    if (!group) return null;
    return [
      { x: group.base.x - 14, y: group.base.y - 14 },
      { x: group.base.x + 14, y: group.base.y - 14 },
      { x: group.base.x + 14, y: group.base.y + 14 },
      { x: group.base.x - 14, y: group.base.y + 14 },
    ];
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return [
    { x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY },
  ];
}
