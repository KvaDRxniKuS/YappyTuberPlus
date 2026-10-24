import type { RigObject } from "../types";
import { setParent } from "./preset";
import { selectionRoots } from "./selection";

const orderCache = new WeakMap<RigObject[], string[]>();
const pathCache = new WeakMap<RigObject[], Map<string, number[]>>();

/**
 * Порядок объектов «как в структуре»: обход в глубину, дети идут в том же
 * порядке, в каком лежат в массиве пресета. Этот порядок задаёт две вещи:
 * порядок строк в дереве и приоритет отрисовки при одинаковом слое — верхняя
 * строка рисуется поверх нижней.
 */
export function structureOrder(objects: RigObject[]): string[] {
  const cached = orderCache.get(objects);
  if (cached) return cached;
  const children = childrenMap(objects);
  const result: string[] = [];
  const visited = new Set<string>();
  const walk = (parentId: string | null) => {
    for (const object of children.get(parentId) || []) {
      if (visited.has(object.id)) continue;
      visited.add(object.id);
      result.push(object.id);
      walk(object.id);
    }
  };
  walk(null);
  // Объекты с потерянным родителем показываем в конце, чтобы не терять их из вида.
  for (const object of objects) {
    if (visited.has(object.id)) continue;
    visited.add(object.id);
    result.push(object.id);
  }
  orderCache.set(objects, result);
  return result;
}

function childrenMap(objects: RigObject[]): Map<string | null, RigObject[]> {
  const children = new Map<string | null, RigObject[]>();
  for (const object of objects) {
    const list = children.get(object.parentId);
    if (list) list.push(object);
    else children.set(object.parentId, [object]);
  }
  return children;
}

/**
 * Путь до объекта по индексам среди соседей: `[0, 1]` — второй ребёнок первого
 * корня. Ноль — самая верхняя строка. Путь нужен, чтобы сравнивать объекты по
 * структуре: у соседей решает первый различающийся индекс, потомок всегда
 * рисуется поверх предка.
 */
export function structurePaths(objects: RigObject[]): Map<string, number[]> {
  const cached = pathCache.get(objects);
  if (cached) return cached;
  const children = childrenMap(objects);
  const paths = new Map<string, number[]>();
  const visited = new Set<string>();
  const walk = (parentId: string | null, prefix: number[]) => {
    const list = children.get(parentId) || [];
    list.forEach((object, index) => {
      if (visited.has(object.id)) return;
      visited.add(object.id);
      const path = [...prefix, index];
      paths.set(object.id, path);
      walk(object.id, path);
    });
  };
  walk(null, []);
  for (const object of objects) if (!paths.has(object.id)) paths.set(object.id, [Number.MAX_SAFE_INTEGER]);
  pathCache.set(objects, paths);
  return paths;
}

/**
 * Кто впереди при одинаковом слое: >0 — `a` поверх `b`, <0 — наоборот, 0 — равны.
 * Верхняя строка структуры рисуется поверх нижней, потомок — поверх предка.
 */
export function frontness(pathA: number[] = [], pathB: number[] = []): number {
  const shared = Math.min(pathA.length, pathB.length);
  for (let index = 0; index < shared; index += 1) {
    if (pathA[index] !== pathB[index]) return pathA[index] < pathB[index] ? 1 : -1;
  }
  if (pathA.length === pathB.length) return 0;
  return pathA.length > pathB.length ? 1 : -1;
}

/** Позиция объекта в структуре: 0 — самый верхний. */
export function structurePositions(objects: RigObject[]): Map<string, number> {
  return new Map(structureOrder(objects).map((id, index) => [id, index]));
}


function subtreeBlock(objects: RigObject[], rootId: string): RigObject[] {
  const ids = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const object of objects) {
      if (object.parentId && ids.has(object.parentId) && !ids.has(object.id)) {
        ids.add(object.id);
        changed = true;
      }
    }
  }
  return objects.filter((object) => ids.has(object.id));
}

/**
 * Перестановка объектов в структуре: переносит блоки поддеревьев перед целью
 * (`before`) или после неё (`after`). Если цель живёт у другого родителя,
 * корни переезжают к нему же — как в обычном дереве, где «выше/ниже» тянет
 * объект к соседям цели. Перестановка внутрь собственного поддерева
 * игнорируется.
 */
export function reorderObjects(
  objects: RigObject[],
  ids: string[],
  targetId: string,
  position: "before" | "after",
): RigObject[] {
  const roots = selectionRoots(objects, ids).filter((id) => id !== targetId);
  if (!roots.length) return objects;
  const target = objects.find((object) => object.id === targetId);
  if (!target) return objects;

  const moving = new Set<string>();
  for (const root of roots) {
    for (const block of subtreeBlock(objects, root)) {
      if (block.id === targetId) return objects; // нельзя вложить объект в себя
      moving.add(block.id);
    }
  }
  if (moving.has(targetId)) return objects;

  const remaining = objects.filter((object) => !moving.has(object.id));
  const targetIndex = remaining.findIndex((object) => object.id === targetId);
  if (targetIndex < 0) return objects;

  // Блок каждого корня — в порядке массива, чтобы поддерево осталось целым.
  const parentId = target.parentId;
  const prepared: RigObject[] = [];
  for (const root of roots) {
    const blockIds = new Set(subtreeBlock(objects, root).map((object) => object.id));
    for (const object of objects) {
      if (!blockIds.has(object.id)) continue;
      prepared.push(object.id === root && object.parentId !== parentId ? setParent(object, parentId) : object);
    }
  }

  const insertion = position === "before" ? targetIndex : targetIndex + 1;
  return [
    ...remaining.slice(0, insertion),
    ...prepared,
    ...remaining.slice(insertion),
  ];
}

/**
 * Сосед для сдвига выделения на строку вверх/вниз. Возвращает цель, перед
 * которой (вверх) или после которой (вниз) нужно вставить блоки.
 */
export function reorderNeighbor(
  objects: RigObject[],
  ids: string[],
  direction: -1 | 1,
): { targetId: string; position: "before" | "after" } | null {
  const roots = selectionRoots(objects, ids);
  if (!roots.length) return null;
  const order = structureOrder(objects);
  const moving = new Set<string>();
  for (const root of roots) for (const object of subtreeBlock(objects, root)) moving.add(object.id);

  const positions = roots.map((id) => order.indexOf(id)).filter((index) => index >= 0);
  if (!positions.length) return null;
  const edge = direction < 0 ? Math.min(...positions) : Math.max(...positions);
  for (let index = edge + direction; index >= 0 && index < order.length; index += direction) {
    const candidate = order[index];
    if (moving.has(candidate)) continue;
    return { targetId: candidate, position: direction < 0 ? "before" : "after" };
  }
  return null;
}
