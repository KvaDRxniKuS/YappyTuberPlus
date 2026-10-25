import type { RigFrame, RigObject } from "../types";

/** Строка `layer = …` из скрипта объекта. */
const LAYER_LINE = /^[ \t]*layer[ \t]*=[ \t]*(.+?)[ \t]*$/m;

export function scriptLayer(script: string): string | null {
  const match = LAYER_LINE.exec(script);
  return match ? match[1].trim() : null;
}

/**
 * Слой, с которым объект реально рисуется.
 *
 * Числовой литерал в скрипте — это тот же слой, что и `base.layer` (инспектор
 * пишет оба), поэтому порядок отрисовки берётся из пресета, а не из кадра.
 * Кадр движка обновляется только на тике: пока идёт расстановка (пауза, стоп)
 * или правка ещё не дошла до ядра, слой из кадра отставал бы, и спрайты
 * переставлялись бы лишь после «Стоп → Продолжить». Формулу (`layer = 2 + 1`,
 * ссылки, `inherit` от динамического родителя) по-прежнему считает движок.
 */
export function resolveLayer(
  objects: RigObject[],
  frame: RigFrame | null,
  object: RigObject,
  seen: Set<string> = new Set(),
): number {
  const expression = scriptLayer(object.script);
  if (!expression) return object.base.layer;
  const literal = Number(expression);
  if (Number.isFinite(literal)) return literal;
  if (expression === "inherit") {
    const parent = object.parentId ? objects.find((item) => item.id === object.parentId) : undefined;
    if (parent && !seen.has(parent.id)) {
      return resolveLayer(objects, frame, parent, new Set([...seen, object.id]));
    }
    return object.base.layer;
  }
  const dynamic = frame?.objects[object.id]?.layer;
  return typeof dynamic === "number" ? dynamic : object.base.layer;
}
