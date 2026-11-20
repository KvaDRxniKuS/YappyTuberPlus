import { expect, test } from "@playwright/test";
import { bendFrame, deformOffset } from "../../src/render/bend";
import { shiftNode } from "../../src/engine/mesh";
import { objectMatrix, staticValues, transformPoint } from "../../src/render/rigCanvas";
import { DEFAULT_BASE, type ObjectFrame, type RigFrame, type RigObject, type RigPreset } from "../../src/types";

/*
 * «Деформируется родителем».
 *
 * Сцена рисует объекты плоско, поэтому изгиб — это смещение места ребёнка на
 * величину, на которую ушла точка его центра на сетке родителя. Проверяется
 * без браузера: матрицы, зона и сетка — чистые функции.
 */

function object(patch: Partial<RigObject> = {}): RigObject {
  return {
    id: "o1", name: "Голова", kind: "sprite", enabled: true, image: null,
    parentId: null, pivot: { x: 0.5, y: 0.5 }, base: { ...DEFAULT_BASE, x: 0, y: 0 },
    script: "", width: 200, height: 200, ...patch,
  };
}

/** Сетка, у которой правый нижний узел уехал вправо на 10 % зоны. */
function meshOfShifted(): RigObject["mesh"] {
  return {
    enabled: true,
    frame: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    art: { points: [], triangles: [], auto: null },
    deform: shiftNode({ cols: 2, rows: 2, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }] }, 3, 0.1, 0),
  };
}

function frameOf(objects: RigObject[]): RigFrame {
  const values: Record<string, ObjectFrame> = {};
  // Значения по умолчанию: в кадре всегда полный набор параметров, иначе
  // матрица посчиталась бы с NaN.
  for (const item of objects) values[item.id] = staticValues(item);
  return { objects: values } as RigFrame;
}

function presetOf(objects: RigObject[]): RigPreset {
  return { ...({ objects } as RigPreset) };
}

/** Пиксели картинки → мир: та же матрица, по которой рисует сцена. */
function world(object: RigObject, content: { x: number; y: number }): { x: number; y: number } {
  const values = staticValues(object);
  const matrix = objectMatrix(object, values);
  const left = -object.pivot.x * object.width;
  const top = -object.pivot.y * object.height;
  const local = { x: left + content.x, y: top + content.y };
  return {
    x: matrix.a * local.x + matrix.c * local.y + matrix.e,
    y: matrix.b * local.x + matrix.d * local.y + matrix.f,
  };
}

test("сдвиг узла сетки виден в точке мира: правый нижний угол ушёл вправо", () => {
  const parent = object({ mesh: meshOfShifted() });
  // Точка в правом нижнем углу зоны: узел 3 уехал на 10 % ширины зоны, то есть
  // на 20 px при ширине 200.
  const corner = world(parent, { x: parent.width, y: parent.height });
  const offset = deformOffset(parent, staticValues(parent), corner);
  expect(offset.x).toBeCloseTo(20, 6);
  expect(offset.y).toBeCloseTo(0, 6);
  // Левый верхний угол не двигался: там узел на месте.
  expect(deformOffset(parent, staticValues(parent), world(parent, { x: 0, y: 0 }))).toEqual({ x: 0, y: 0 });
  // За зоной картинка не деформируется — и изгиба там нет.
  const shifted = object({ mesh: { ...meshOfShifted(), frame: { x: 0.5, y: 0, width: 0.5, height: 1, rotation: 0 } } });
  expect(deformOffset(shifted, staticValues(shifted), world(shifted, { x: 10, y: 200 }))).toEqual({ x: 0, y: 0 });
});

test("выключенная сетка и объект без сетки не гнут ничего", () => {
  const off = object({ mesh: { ...meshOfShifted()!, enabled: false } });
  expect(deformOffset(off, staticValues(off), { x: 100, y: 100 })).toEqual({ x: 0, y: 0 });
  expect(deformOffset(object(), staticValues(object()), { x: 100, y: 100 })).toEqual({ x: 0, y: 0 });
});

test("ребёнок едет вместе с деформированным местом родителя", () => {
  const parent = object({ mesh: meshOfShifted() });
  const child = object({ id: "eye", name: "Глаз", parentId: "o1", width: 40, height: 40 });
  const preset = presetOf([parent, child]);
  // Ребёнок стоит в правом нижнем углу родителя — там же, где уехал узел.
  // Центр ребёнка — его база, у родителя база (0, 0), поэтому правый нижний
  // угол в мире и есть (100, 100).
  const frame = frameOf([parent, child]);
  frame.objects.eye = { ...(frame.objects.eye ?? ({} as ObjectFrame)), x: 100, y: 100 } as ObjectFrame;
  const bent = bendFrame(preset, frame)!;
  expect(bent.objects.eye.x).toBeCloseTo(100 + 20, 6);
  // Верхний левый ребёнок стоит на месте.
  const frame2 = frameOf([parent, child]);
  frame2.objects.eye = { ...(frame2.objects.eye ?? ({} as ObjectFrame)), x: -100, y: -100 } as ObjectFrame;
  expect(bendFrame(preset, frame2)!.objects.eye.x).toBeCloseTo(-100, 6);
});

test("галка выключена — ребёнок жёсткий, пивот идёт за базой родителя", () => {
  const parent = object({ mesh: meshOfShifted() });
  const stiff = object({ id: "eye", parentId: "o1", deformParent: false, width: 40, height: 40 });
  const preset = presetOf([parent, stiff]);
  const frame = frameOf([parent, stiff]);
  frame.objects.eye = { ...(frame.objects.eye ?? ({} as ObjectFrame)), x: 100, y: 100 } as ObjectFrame;
  expect(bendFrame(preset, frame)!.objects.eye.x).toBe(100);
});

test("вложенные деформеры складываются, а выключенный родитель цепочку рвёт", () => {
  const root = object({ id: "body", mesh: meshOfShifted() });
  const middle = object({ id: "head", parentId: "body", mesh: meshOfShifted() });
  const leaf = object({ id: "eye", parentId: "head", width: 40, height: 40 });
  const preset = presetOf([root, middle, leaf]);
  const frame = frameOf([root, middle, leaf]);
  // Голова стоит там же, где уехал угол тела: 100 + 20.
  frame.objects.head = { ...(frame.objects.head ?? ({} as ObjectFrame)), x: 100, y: 100 } as ObjectFrame;
  frame.objects.eye = { ...(frame.objects.eye ?? ({} as ObjectFrame)), x: 100, y: 100 } as ObjectFrame;
  const bent = bendFrame(preset, frame)!;
  // Смещение головы от тела + смещение глаза от головы: оба узла уехали.
  expect(bent.objects.head.x).toBeCloseTo(120, 6);
  expect(bent.objects.eye.x).toBeGreaterThan(120);
  // Голова выключена — глаз за ней больше не гнётся.
  middle.deformParent = false;
  expect(bendFrame(presetOf([root, middle, leaf]), frame)!.objects.eye.x).toBeCloseTo(120, 6);
});
