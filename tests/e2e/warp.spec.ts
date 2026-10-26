import { expect, test } from "@playwright/test";
import type { RigObject } from "../../src/types";
import { DEFAULT_BASE } from "../../src/types";
import {
  affineFromTriangles, defaultWarp, moveWarpCorner, moveWarpFrame, normalizeWarp, pointInQuad,
  resizeWarpFrame, rotateWarpFrame, warpMoved, warpQuad,
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

test("деформация: формула скрипта важнее статики, без кадра — статика", () => {
  const warp = defaultWarp();
  warp.enabled = true;
  warp.corners.bl = { x: 10, y: 0 };
  const object = sprite({ warp });
  // В кадре есть параметр угла — берём его.
  const values = { ...DEFAULT_BASE, warpBLx: 40, warpBLy: -50 } as never;
  // 40 % ширины зоны (200 px) — это 80 px от левого края.
  expect(round(warpQuad(object, values as never)[3].x)).toBe(80);
  expect(round(warpQuad(object, values as never)[3].y)).toBe(50);
  // Кадр без параметров (старое ядро) — статические настройки.
  expect(round(warpQuad(object, null)[3].x)).toBe(20);
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
