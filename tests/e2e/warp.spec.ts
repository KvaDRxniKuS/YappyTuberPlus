import { expect, test } from "@playwright/test";
import type { RigObject } from "../../src/types";
import { DEFAULT_BASE } from "../../src/types";
import {
  affineFromTriangles, defaultWarp, moveWarpCorner, moveWarpFrame, normalizeWarp, pointInQuad,
  resizeWarpFrame, rotateWarpFrame, warpGrabAt, warpHandlesAt, warpMoved, warpQuad,
} from "../../src/render/warp";

/** Простой спрайт 200×100: углы деформации считаются в его координатах. */
function sprite(patch: Partial<RigObject> = {}): RigObject {
  return {
    id: "sprite",
    name: "Спрайт",
    kind: "sprite",
    enabled: true,
    image: null,
    parentId: null,
    pivot: { x: 0.5, y: 0.5 },
    base: { ...DEFAULT_BASE },
    script: "",
    width: 200,
    height: 100,
    ...patch,
  };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

test("деформация: пустая зона — вся картинка, углы не смещены", () => {
  const object = sprite({ warp: defaultWarp() });
  const quad = warpQuad(object).map((point) => ({ x: round(point.x), y: round(point.y) }));
  expect(quad).toEqual([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }]);
  expect(warpMoved(object)).toBe(false);
});

test("деформация: зона считается в долях картинки, углы — в процентах зоны", () => {
  const warp = defaultWarp();
  // Зона — правая половина картинки: x 50 %, ширина 50 %.
  warp.enabled = true;
  warp.frame = { x: 0.5, y: 0, width: 0.5, height: 1, rotation: 0 };
  // Правый верхний угол подтянут влево на 20 % ширины зоны (100 px → 20 px).
  warp.corners.tr = { x: -20, y: 10 };
  const object = sprite({ warp });
  const quad = warpQuad(object);
  expect(quad.map((point) => ({ x: round(point.x), y: round(point.y) }))).toEqual([
    { x: 100, y: 0 },
    { x: 180, y: 10 },
    { x: 200, y: 100 },
    { x: 100, y: 100 },
  ]);
  expect(warpMoved(object)).toBe(true);
});

test("деформация: параметр скрипта добавляется к настройке инспектора", () => {
  const warp = defaultWarp();
  warp.enabled = true;
  warp.corners.bl = { x: 10, y: 0 };
  const object = sprite({ warp });
  // Статика одна: 10 % ширины зоны (200 px) — это 20 px.
  expect(round(warpQuad(object, null)[3].x)).toBe(20);
  // Скрипт раскачивает угол: 10 % + 40 % = 50 % → 100 px.
  const values = { ...DEFAULT_BASE, warpBLx: 40, warpBLy: -50 } as never;
  expect(round(warpQuad(object, values as never)[3].x)).toBe(100);
  expect(round(warpQuad(object, values as never)[3].y)).toBe(50);
  // Кадр без параметров (старое ядро) ничего не ломает.
  const plain = { ...DEFAULT_BASE } as never;
  expect(round(warpQuad(object, plain as never)[3].x)).toBe(20);
  expect(round(warpQuad(object, plain as never)[3].y)).toBe(100);
});

test("деформация: точка внутри четырёхугольника и снаружи", () => {
  const quad = [{ x: 0, y: 0 }, { x: 100, y: 10 }, { x: 100, y: 100 }, { x: 0, y: 60 }];
  expect(pointInQuad({ x: 50, y: 40 }, quad)).toBe(true);
  expect(pointInQuad({ x: 99, y: 2 }, quad)).toBe(false);
  expect(pointInQuad({ x: 50, y: 90 }, quad)).toBe(false);
});

test("деформация: ручки зоны растят её от противоположного края", () => {
  const object = sprite();
  const start = { ...defaultWarp(), enabled: true };
  const moved = moveWarpFrame(start, object, 20, 10);
  expect(round(moved.frame.x)).toBe(0.1);
  expect(round(moved.frame.y)).toBe(0.1);

  // Тянем левый край вправо на 40 px: ширина уменьшается, правый край стоит.
  const resized = resizeWarpFrame(moved, "left", object, 40, 0);
  expect(round(resized.frame.width)).toBe(0.8);
  // Левый край уехал на 20 + 40 = 60 px, то есть 0.3 картинки.
  expect(round(resized.frame.x)).toBe(0.3);

  // Верхняя ручка: высота уменьшается, а низ остаётся на месте.
  const shorter = resizeWarpFrame(start, "top", object, 0, 20);
  expect(round(shorter.frame.height)).toBe(0.8);
  expect(round(shorter.frame.y)).toBe(0.2);
});

test("деформация: углы тянутся в процентах зоны и не выходят за предел", () => {
  const object = sprite();
  const start = { ...defaultWarp(), enabled: true };
  const moved = moveWarpCorner(start, "tl", object, 20, 10);
  expect(round(moved.corners.tl.x)).toBe(10);
  expect(round(moved.corners.tl.y)).toBe(10);

  const clamped = moveWarpCorner(start, "tl", object, -10_000, 10_000);
  expect(clamped.corners.tl.x).toBe(-100);
  expect(clamped.corners.tl.y).toBe(100);
});

test("деформация: поворот зоны нормализуется в −180…180", () => {
  const start = { ...defaultWarp(), enabled: true };
  expect(round(rotateWarpFrame(start, 370).frame.rotation)).toBe(10);
  expect(round(rotateWarpFrame(start, -370).frame.rotation)).toBe(-10);
});

test("деформация: битый JSON не ломает сцену", () => {
  expect(normalizeWarp(undefined)).toBeUndefined();
  const warp = normalizeWarp({
    enabled: "да",
    frame: { x: "мусор", width: 0, height: -5, rotation: 900 },
    corners: { tl: { x: 500, y: null }, tr: null },
  });
  expect(warp?.enabled).toBe(false);
  expect(warp?.frame.x).toBe(0);
  expect(warp?.frame.width).toBe(0.01);
  expect(warp?.frame.height).toBe(0.01);
  expect(warp?.frame.rotation).toBe(360);
  expect(warp?.corners.tl).toEqual({ x: 100, y: 0 });
  expect(warp?.corners.tr).toEqual({ x: 0, y: 0 });
});

test("деформация: аффинное преобразование по трём точкам точное", () => {
  const matrix = affineFromTriangles(
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }],
    [{ x: 5, y: 5 }, { x: 15, y: 3 }, { x: 9, y: 17 }],
  );
  expect(matrix).not.toBeNull();
  const apply = (point: { x: number; y: number }) => ({
    x: round(matrix!.a * point.x + matrix!.c * point.y + matrix!.e),
    y: round(matrix!.b * point.x + matrix!.d * point.y + matrix!.f),
  });
  expect(apply({ x: 0, y: 0 })).toEqual({ x: 5, y: 5 });
  expect(apply({ x: 10, y: 0 })).toEqual({ x: 15, y: 3 });
  expect(apply({ x: 0, y: 10 })).toEqual({ x: 9, y: 17 });
  // Вырожденный треугольник: преобразования нет, рендер просто пропустит кусок.
  expect(affineFromTriangles([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }], [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }])).toBeNull();
});

/** Матрица без поворота и масштаба: координаты содержимого = координаты сцены. */
const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

test("деформация: ручки ловятся мышью — углы, поворот, тело зоны", () => {
  const object = sprite({ pivot: { x: 0, y: 0 }, warp: { ...defaultWarp(), enabled: true } });
  const values = { ...DEFAULT_BASE } as never;
  const handles = warpHandlesAt(object, values, 0, 0, IDENTITY, 1);
  // Ручка поворота — над серединой верхней стороны, на 18 экранных пикселей.
  expect(round(handles.rotation.x)).toBe(100);
  expect(round(handles.rotation.y)).toBe(-18);

  // Угол картинки: тянем за правый нижний.
  const corner = warpGrabAt(object, values, 0, 0, IDENTITY, 1, { x: 198, y: 98 });
  expect(corner).toEqual({ kind: "corner", corner: "br" });

  // Тело зоны: внутри — перетаскивание целиком.
  expect(warpGrabAt(object, values, 0, 0, IDENTITY, 1, { x: 100, y: 50 })).toEqual({ kind: "move" });

  // Ручка размера: середина правой стороны.
  const side = warpGrabAt(object, values, 0, 0, IDENTITY, 1, { x: 200, y: 50 });
  expect(side).toEqual({ kind: "handle", handle: "right" });

  // Мимо — ничего не хватаем, клик уходит дальше по сцене.
  expect(warpGrabAt(object, values, 0, 0, IDENTITY, 1, { x: 400, y: 400 })).toBeNull();

  // Зум учитывается: на 2× радиусы ручек вдвое меньше, а тело зоны ловится.
  expect(warpGrabAt(object, values, 0, 0, IDENTITY, 2, { x: 190, y: 60 })).toEqual({ kind: "move" });
  expect(warpGrabAt(object, values, 0, 0, IDENTITY, 1, { x: 190, y: 60 })).toEqual({ kind: "move" });
});

test("деформация: ручка поворота едет вместе с поворотом зоны", () => {
  const warp = { ...defaultWarp(), enabled: true };
  warp.frame = { ...warp.frame, rotation: 90 };
  const object = sprite({ pivot: { x: 0, y: 0 }, warp });
  const handles = warpHandlesAt(object, null, 0, 0, IDENTITY, 1);
  // Зона повернулась: её «верхняя» сторона стала правой, ручка ушла вправо
  // от середины этой стороны — на 18 пикселей наружу.
  expect(round(handles.rotation.x)).toBe(168);
  expect(round(handles.rotation.y)).toBe(50);
});

test("деформация: поворот зоны считается от центра, а не от угла", () => {
  const object = sprite({ pivot: { x: 0, y: 0 }, warp: { ...defaultWarp(), enabled: true } });
  const grab = warpGrabAt(object, null, 0, 0, IDENTITY, 1, { x: 100, y: -18 });
  expect(grab?.kind).toBe("rotation");
  if (grab?.kind !== "rotation") return;
  expect(round(grab.center.x)).toBe(100);
  expect(round(grab.center.y)).toBe(50);
});

test("деформация: «Зона» и «Углы» — разные инструменты", () => {
  const object = sprite({ pivot: { x: 0, y: 0 }, warp: { ...defaultWarp(), enabled: true } });
  const values = { ...DEFAULT_BASE } as never;
  const grab = (point: { x: number; y: number }, mode: "frame" | "corners") =>
    warpGrabAt(object, values, 0, 0, IDENTITY, 1, point, mode);

  // Угол картинки ловится только инструментом углов. Пока деформации нет,
  // угол картинки совпадает с углом зоны, поэтому смотрим на сдвинутый угол:
  // правый нижний уехал на 50 % влево-вверх.
  const bent = sprite({ pivot: { x: 0, y: 0 }, warp: { ...defaultWarp(), enabled: true, corners: { ...defaultWarp().corners, br: { x: -50, y: -50 } } } });
  const grabBent = (point: { x: number; y: number }, mode: "frame" | "corners") =>
    warpGrabAt(bent, values, 0, 0, IDENTITY, 1, point, mode);
  // Угол картинки теперь в (100, 50): его ловит только «Углы».
  expect(grabBent({ x: 100, y: 50 }, "corners")).toEqual({ kind: "corner", corner: "br" });
  // А в «Зоне» эта точка — тело зоны, и рамка не тянется за угол.
  expect(grabBent({ x: 100, y: 50 }, "frame")).toEqual({ kind: "move" });
  // Угол зоны (200, 100) в «Углах» не ловится, а в «Зоне» это ручка размера.
  expect(grabBent({ x: 200, y: 100 }, "corners")).toBeNull();
  expect(grabBent({ x: 200, y: 100 }, "frame")).toEqual({ kind: "handle", handle: "br" });

  // Сторона зоны и тело — только инструментом зоны.
  expect(grab({ x: 200, y: 50 }, "frame")).toEqual({ kind: "handle", handle: "right" });
  expect(grab({ x: 200, y: 50 }, "corners")).toBeNull();
  expect(grab({ x: 100, y: 50 }, "frame")).toEqual({ kind: "move" });
  expect(grab({ x: 100, y: 50 }, "corners")).toBeNull();

  // Поворот зоны — тоже инструмент зоны.
  expect(grab({ x: 100, y: -18 }, "frame")?.kind).toBe("rotation");
  expect(grab({ x: 100, y: -18 }, "corners")).toBeNull();
});
