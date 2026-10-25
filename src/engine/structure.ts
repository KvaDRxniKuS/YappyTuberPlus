import type { BasePose, RigObject } from "../types";
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

export interface PivotPose {
  x: number;
  y: number;
}

/** Скриптовые значения объекта из кадра: поворот и масштаб, которые видит `follow`. */
export type MotionOf = (objectId: string) => { rotation: number; sizeX: number; sizeY: number } | null;

/** Скрипт опирается на родителя: `follow(offset, parent)` — значит база родителя его двигает. */
function followsParent(script: string): boolean {
  return /\bfollow\s*\(|\boffset\b/.test(script);
}

/** Значения кадра, которые нужны для сдвига пивота. */
export interface PivotValues {
  rotation?: number;
  sizeX?: number;
  sizeY?: number;
  skewX?: number;
  skewY?: number;
}

/**
 * Сдвиг базы, при котором картинка не дёргается от переезда пивота.
 *
 * Спрайт рисуется от `−pivot × размер`, то есть пивот — это и есть его
 * `base.x/base.y`: чтобы картинка осталась на месте, база двигается на
 * `M · Δpivot · размер`, где `M = R · S · Skew` — линейная часть матрицы
 * отрисовки (то же самое, что строит `objectMatrix`).
 */
export function pivotBaseShift(object: RigObject, values: PivotValues | null | undefined, next: PivotPose): PivotPose {
  const rotation = object.base.rotation + (values?.rotation ?? 0);
  const skewX = Math.tan(((object.base.skewX + (values?.skewX ?? 0)) * Math.PI) / 180);
  const skewY = Math.tan(((object.base.skewY + (values?.skewY ?? 0)) * Math.PI) / 180);
  const scaleX = object.base.sizeX * (values?.sizeX ?? 1);
  const scaleY = object.base.sizeY * (values?.sizeY ?? 1);
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = (next.x - object.pivot.x) * object.width;
  const dy = (next.y - object.pivot.y) * object.height;
  // Сначала масштаб, потом перекос — тот же порядок, что в `objectMatrix`.
  const shearedX = dx + skewX * dy;
  const shearedY = skewY * dx + dy;
  const scaledX = shearedX * scaleX;
  const scaledY = shearedY * scaleY;
  // И поворот вокруг пивота.
  return {
    x: cos * scaledX - sin * scaledY,
    y: sin * scaledX + cos * scaledY,
  };
}

/**
 * Перестановка пивота без «дёрганья» картинки.
 *
 * Пивот объекта — это его `base.x/base.y`, поэтому новая точка пивота просто
 * записывается в базу, а картинка при этом не едет: спрайт рисуется со сдвигом
 * `−pivot × размер`, и переезд базы ровно компенсирует переезд пивота.
 *
 * Дети зависят от родителя через `follow(offset, parent)`: мир ребёнка —
 * это `его base + его значение`, а значение складывается из значения родителя
 * и повёрнутого смещения. Поэтому, сдвинув базу родителя на `d`, нужно
 * компенсировать и сдвиг, и изменение значения: для ребёнка
 * `S = M⁻¹·((M − I)·S_родителя − V_родителя)`, после чего `V = −S`. Так по всей
 * цепочке, поэтому и внуки, и хвосты остаются на месте. Дети, которые родителя
 * не читают (нет `follow`/`offset`), не трогаются: их мир от его базы не зависит.
 */
export function repivot(
  objects: RigObject[],
  id: string,
  base: PivotPose,
  pivot: PivotPose,
  motion?: MotionOf,
): RigObject[] {
  const target = objects.find((object) => object.id === id);
  if (!target) return objects;
  const shift = { x: base.x - target.base.x, y: base.y - target.base.y };

  const pose = (objectId: string) => motion?.(objectId) ?? { rotation: 0, sizeX: 1, sizeY: 1 };
  // M — то же, что считает ядро в `follow`: сначала масштаб, потом поворот.
  const apply = (objectId: string, vector: PivotPose): PivotPose => {
    const { rotation, sizeX, sizeY } = pose(objectId);
    const radians = (rotation * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
      x: cos * vector.x * sizeX - sin * vector.y * sizeY,
      y: sin * vector.x * sizeX + cos * vector.y * sizeY,
    };
  };
  const unapply = (objectId: string, vector: PivotPose): PivotPose => {
    const { rotation, sizeX, sizeY } = pose(objectId);
    const radians = (rotation * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
      x: (cos * vector.x + sin * vector.y) / (sizeX === 0 ? 1 : sizeX),
      y: (-sin * vector.x + cos * vector.y) / (sizeY === 0 ? 1 : sizeY),
    };
  };

  const shifts = new Map<string, PivotPose>();
  // Само значение пивота тоже могло поехать — если он читает своего родителя.
  const parent = target.parentId ? objects.find((object) => object.id === target.parentId) : null;
  const firstValue = parent && followsParent(target.script)
    ? (() => {
      const moved = apply(parent.id, shift);
      return { x: moved.x - shift.x, y: moved.y - shift.y };
    })()
    : { x: 0, y: 0 };

  const queue: { objectId: string; shift: PivotPose; value: PivotPose }[] = [
    { objectId: id, shift, value: firstValue },
  ];
  while (queue.length) {
    const current = queue.shift() as { objectId: string; shift: PivotPose; value: PivotPose };
    const moved = apply(current.objectId, current.shift);
    const local = {
      x: moved.x - current.shift.x - current.value.x,
      y: moved.y - current.shift.y - current.value.y,
    };
    for (const child of objects) {
      if (child.parentId !== current.objectId || !followsParent(child.script)) continue;
      const childShift = unapply(current.objectId, local);
      shifts.set(child.id, childShift);
      queue.push({ objectId: child.id, shift: childShift, value: { x: -childShift.x, y: -childShift.y } });
    }
  }

  return objects.map((object) => {
    if (object.id === id) {
      return { ...object, base: { ...object.base, x: base.x, y: base.y }, pivot };
    }
    const fix = shifts.get(object.id);
    return fix ? { ...object, base: { ...object.base, x: object.base.x + fix.x, y: object.base.y + fix.y } } : object;
  });
}

/**
 * Дочерние объекты едут за базовой позой родителя.
 *
 * Иерархия в ядре динамическая: `inherit` и `follow()` передают детям только
 * изменения из скрипта. Базовая поза хранится абсолютно, поэтому поворот или
 * масштаб родителя в инспекторе (и сдвиг через «Δ»-поля) должен сам перенести
 * базы потомков — иначе ребёнок «отклеивается» и не меняет ни угол, ни место.
 *
 * `handled` — объекты, которые правятся этой же операцией: они и их поддеревья
 * пропускаются, иначе сдвиг применился бы дважды.
 */
export function propagateBase(
  objects: RigObject[],
  id: string,
  before: BasePose,
  after: BasePose,
  handled: Iterable<string> = [],
): RigObject[] {
  const skip = new Set<string>();
  for (const handledId of handled) {
    for (const object of subtreeBlock(objects, handledId)) skip.add(object.id);
  }
  const descendants = subtreeBlock(objects, id).filter((object) => object.id !== id && !skip.has(object.id));
  if (!descendants.length) return objects;

  const scaleX = before.sizeX === 0 ? 1 : after.sizeX / before.sizeX;
  const scaleY = before.sizeY === 0 ? 1 : after.sizeY / before.sizeY;
  const deltaRotation = after.rotation - before.rotation;
  const shiftX = after.x - before.x;
  const shiftY = after.y - before.y;
  if (scaleX === 1 && scaleY === 1 && deltaRotation === 0 && shiftX === 0 && shiftY === 0) return objects;

  const radians = (deltaRotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const moved = new Map<string, BasePose>();
  for (const object of descendants) {
    // Поворот и масштаб идут вокруг пивота родителя — точки `base.x/base.y`.
    const dx = (object.base.x - before.x) * scaleX;
    const dy = (object.base.y - before.y) * scaleY;
    moved.set(object.id, {
      ...object.base,
      x: before.x + dx * cos - dy * sin + shiftX,
      y: before.y + dx * sin + dy * cos + shiftY,
      rotation: object.base.rotation + deltaRotation,
      sizeX: object.base.sizeX * scaleX,
      sizeY: object.base.sizeY * scaleY,
    });
  }
  return objects.map((object) => (moved.has(object.id) ? { ...object, base: moved.get(object.id) as BasePose } : object));
}
