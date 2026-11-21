import { expect, test } from "@playwright/test";
import { defaultMesh, regularGrid, shiftNode } from "../../src/engine/mesh";
import {
  artEdgeHit, artPointPoints, deformGeometry, artTriangleHit, drawMeshImage, edgePairs, meshGeometry, meshNodePoints,
  meshMatrix, meshQuad, nearestPoint, zoneDelta, zoneGeometry, zoneOutline, zonePoint,
} from "../../src/render/mesh";
import {
  flipArtEdge, moveArtPoint, moveNode, removeArtPoint, removeArtTriangle, splitArtEdge, splitArtTriangle,
} from "../../src/engine/mesh";
import { DEFAULT_BASE, type MeshSpec, type RigObject, type Vec2 } from "../../src/types";

/*
 * Рендер сетки: геометрия (зона, UV, цели) и сам вызов отрисовки.
 *
 * WebGL2 в тестах нет — это честный запасной путь: Canvas 2D рисует каждый
 * треугольник аффинным преобразованием. Если работает он, картинка не
 * пропадёт и на машине без WebGL2.
 */

function sprite(patch: Partial<RigObject> = {}): RigObject {
  return {
    id: "sprite", name: "Спрайт", kind: "sprite", enabled: true, image: null,
    parentId: null, pivot: { x: 0.5, y: 0.5 }, base: { ...DEFAULT_BASE },
    script: "", width: 200, height: 100, ...patch,
  };
}

function enabled(patch: Partial<MeshSpec> = {}): MeshSpec {
  const mesh = defaultMesh();
  mesh.enabled = true;
  return { ...mesh, ...patch };
}

/** Заглушка контекста: считает вызовы, ничего не рисуя. */
function fakeContext() {
  const calls = { drawImage: 0, clip: 0, transform: 0, save: 0, restore: 0 };
  const ctx = {
    canvas: { width: 800, height: 600 },
    globalAlpha: 1,
    save: () => { calls.save += 1; },
    restore: () => { calls.restore += 1; },
    beginPath: () => undefined,
    rect: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    closePath: () => undefined,
    clip: () => { calls.clip += 1; },
    transform: () => { calls.transform += 1; },
    setTransform: () => undefined,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    drawImage: () => { calls.drawImage += 1; },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const round = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
};
const clean = (points: Vec2[]) => points.map((point) => ({ x: round(point.x), y: round(point.y) }));

test("зона: доли превращаются в пиксели, поворот — вокруг центра", () => {
  const object = sprite({ mesh: enabled() });
  const full = zoneGeometry(object);
  expect(round(full.width)).toBe(200);
  expect(round(full.height)).toBe(100);
  expect(clean([full.toObject(0, 0), full.toObject(1, 1)]))
    .toEqual([{ x: 0, y: 0 }, { x: 200, y: 100 }]);
  // Обратное преобразование: пиксель → доля зоны.
  expect(clean([full.toZone({ x: 50, y: 25 })])).toEqual([{ x: 0.25, y: 0.25 }]);

  const half = zoneGeometry(sprite({ mesh: enabled({ frame: { x: 0.5, y: 0, width: 0.5, height: 1, rotation: 0 } }) }));
  expect(round(half.width)).toBe(100);
  expect(clean([half.toObject(0, 0), half.toObject(1, 1)]))
    .toEqual([{ x: 100, y: 0 }, { x: 200, y: 100 }]);

  // Поворот на 90°: квадратная зона, углы едут по кругу вокруг центра.
  const square = sprite({ width: 100, height: 100, mesh: enabled({ frame: { x: 0, y: 0, width: 1, height: 1, rotation: 90 } }) });
  const rotated = zoneGeometry(square);
  expect(clean([rotated.toObject(0, 0)])).toEqual([{ x: 100, y: 0 }]);
  expect(clean([rotated.toObject(1, 0)])).toEqual([{ x: 100, y: 100 }]);
});

test("геометрия: без сдвигов треугольники совпадают с картинкой", () => {
  const object = sprite({ mesh: enabled() });
  const geometry = meshGeometry(object);
  expect(geometry).not.toBeNull();
  expect(clean(geometry!.targets)).toEqual([
    { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 0, y: 100 }, { x: 200, y: 100 },
  ]);
  expect(geometry!.uv).toEqual([
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 },
  ]);
  expect(geometry!.triangles).toEqual([0, 1, 3, 0, 3, 2]);
});

test("геометрия: зона смещает UV, а сетка — цели", () => {
  const mesh = enabled({ frame: { x: 0.5, y: 0, width: 0.5, height: 1, rotation: 0 } });
  const object = sprite({ mesh });
  const geometry = meshGeometry(object)!;
  // Картинка берётся из правой половины: UV тоже оттуда.
  expect(geometry.uv[0]).toEqual({ x: 0.5, y: 0 });
  expect(geometry.uv[1]).toEqual({ x: 1, y: 0 });
  // А на объекте точка стоит там, где её поставила зона.
  expect(clean(geometry.targets)).toEqual([
    { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 },
  ]);

  // Сдвинутый узел тянет за собой только свою точку.
  const moved = enabled({ deform: shiftNode(regularGrid(2, 2), 3, 0.1, 0) });
  const shifted = meshGeometry(sprite({ mesh: moved }))!;
  expect(clean(shifted.targets)[3]).toEqual({ x: 220, y: 100 });
  expect(clean(shifted.targets)[0]).toEqual({ x: 0, y: 0 });
});

test("геометрия: смещение ключа складывается с параметрами скрипта", () => {
  const object = sprite({ mesh: enabled() });
  const base = meshGeometry(object, 200, 100, null, { "3": { x: 0.1, y: 0.2 } })!;
  expect(clean(base.targets)[3]).toEqual({ x: 220, y: 120 });
  // Параметр `warp` и ключ двигают один узел: смещения складываются.
  const both = meshGeometry(object, 200, 100, { warpBRx: 10 } as never, { "3": { x: 0.1, y: 0 } })!;
  expect(clean(both.targets)[3]).toEqual({ x: 240, y: 100 });
});

test("рамка объекта: деформация расширяет четырёхугольник", () => {
  const object = sprite({ mesh: enabled() });
  expect(clean(meshQuad(object))).toEqual([
    { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 },
  ]);
  const moved = sprite({ mesh: enabled({ deform: shiftNode(regularGrid(2, 2), 3, 0.2, 0.3) }) });
  expect(clean(meshQuad(moved))).toEqual([
    { x: 0, y: 0 }, { x: 240, y: 0 }, { x: 240, y: 130 }, { x: 0, y: 130 },
  ]);
});

test("отрисовка: только треугольники без фоновой копии", () => {
  const object = sprite({ mesh: enabled() });
  const { ctx, calls } = fakeContext();
  expect(drawMeshImage(ctx, {} as CanvasImageSource, object, 200, 100)).toBe(true);
  // Один раз — картинка вокруг зоны, два — треугольники нет: у 2×2 их две пары.
  expect(calls.drawImage).toBe(2);
  expect(calls.clip).toBe(2);
  // Выключенная сетка — рендер обычный, вызовов нет.
  const off = sprite({ mesh: { ...enabled(), enabled: false } });
  const quiet = fakeContext();
  expect(drawMeshImage(quiet.ctx, {} as CanvasImageSource, off, 200, 100)).toBe(false);
  expect(quiet.calls.drawImage).toBe(0);
  // Объект без сетки тоже не перехватывается.
  expect(drawMeshImage(quiet.ctx, {} as CanvasImageSource, sprite(), 200, 100)).toBe(false);
});

test("отрисовка: правленый артмеш рисуется без «дыры»", () => {
  const mesh = enabled();
  const art = { ...mesh.art, points: [...mesh.art.points, { x: 0.5, y: 0.5 }], auto: null };
  const { ctx, calls } = fakeContext();
  expect(drawMeshImage(ctx, {} as CanvasImageSource, sprite({ mesh: { ...mesh, art } }), 200, 100)).toBe(true);
  // Картинка целиком не кладётся: нарезка сама знает, что рисовать.
  expect(calls.drawImage).toBe(2);
  expect(calls.clip).toBe(2);
});

test("отрисовка: старая деформация идёт тем же путём", () => {
  const warp = {
    enabled: true,
    frame: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    corners: { tl: { x: 0, y: 0 }, tr: { x: 10, y: 0 }, br: { x: 0, y: 0 }, bl: { x: 0, y: 0 } },
  };
  const object = sprite({ warp });
  const geometry = meshGeometry(object)!;
  expect(clean(geometry.targets)[1]).toEqual({ x: 220, y: 0 });
  const { ctx, calls } = fakeContext();
  expect(drawMeshImage(ctx, {} as CanvasImageSource, object, 200, 100)).toBe(true);
  expect(calls.drawImage).toBe(2);
});

test("ручки: узлы сетки и точки нарезки в координатах картинки", () => {
  const object = sprite({ mesh: enabled() });
  expect(clean(meshNodePoints(object))).toEqual([
    { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 0, y: 100 }, { x: 200, y: 100 },
  ]);
  expect(clean(artPointPoints(object))).toEqual(clean(meshNodePoints(object)));
  // Точки нарезки едут за сеткой: это их итоговое положение.
  const moved = sprite({ mesh: enabled({ deform: shiftNode(regularGrid(2, 2), 3, 0.1, 0) }) });
  expect(clean(artPointPoints(moved))[3]).toEqual({ x: 220, y: 100 });
  const shifted = moveNode(enabled(), 3, 0.1, 0);
  expect(clean(meshNodePoints({ ...object, mesh: shifted }))[3]).toEqual({ x: 220, y: 100 });
});

test("попадания: ближайшая точка, ребро и треугольник", () => {
  const object = sprite({ mesh: enabled() });
  const points = artPointPoints(object);
  expect(nearestPoint(points, { x: 5, y: 5 }, 12)).toBe(0);
  expect(nearestPoint(points, { x: 100, y: 50 }, 12)).toBeNull();
  expect(nearestPoint(points, { x: 205, y: 95 }, 12)).toBe(3);
  // Ребро снизу: от (0,100) до (200,100).
  const bottom = artEdgeHit(object, { x: 100, y: 102 }, 6)!;
  expect([bottom.a, bottom.b].sort()).toEqual([2, 3]);
  // Диагональ 0→3 проходит через центр.
  const diagonal = artEdgeHit(object, { x: 101, y: 51 }, 6)!;
  expect([diagonal.a, diagonal.b].sort()).toEqual([0, 3]);
  // Далеко от рёбер и диагонали — попадания нет.
  expect(artEdgeHit(object, { x: 150, y: 50 }, 5)).toBeNull();
  // Диагональ идёт из левого верхнего в правый нижний, поэтому точка под ней —
  // второй треугольник, а над ней — первый.
  expect(artTriangleHit(object, { x: 20, y: 20 })).toBe(1);
  expect(artTriangleHit(object, { x: 180, y: 80 })).toBe(0);
  expect(artTriangleHit(object, { x: 300, y: 300 })).toBeNull();
  // Пары без повторов: каждая сторона и общая диагональ по одному разу.
  expect(edgePairs(object)).toHaveLength(5);
  expect(edgePairs(object).map((pair) => [...pair].sort().join(":")))
    .toEqual(["0:1", "1:3", "0:3", "2:3", "0:2"]);
});

test("зона: смещение в пикселях переводится в доли, точка — тоже", () => {
  const object = sprite({ mesh: enabled() });
  const delta = zoneDelta(object, { x: 10, y: 10 }, { x: 30, y: 35 });
  expect(delta.x).toBeCloseTo(0.1, 9);
  expect(delta.y).toBeCloseTo(0.25, 9);
  const point = zonePoint(object, { x: 50, y: 25 });
  expect(point.x).toBeCloseTo(0.25, 9);
  expect(point.y).toBeCloseTo(0.25, 9);
  expect(clean(zoneOutline(object))).toEqual([
    { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 },
  ]);
  // У повёрнутой зоны смещение вдоль экрана даёт смещение по осям зоны.
  const turned = sprite({ width: 100, height: 100, mesh: enabled({ frame: { x: 0, y: 0, width: 1, height: 1, rotation: 90 } }) });
  const turnedDelta = zoneDelta(turned, { x: 0, y: 0 }, { x: 10, y: 0 });
  expect(Math.abs(turnedDelta.y)).toBeCloseTo(0.1, 6);
  expect(Math.abs(turnedDelta.x)).toBeCloseTo(0, 6);
});

test("правки нарезки: разрез, переворот, разбиение и удаление", () => {
  const mesh = enabled();
  const split = splitArtEdge(mesh, 0, 1)!;
  expect(split.art.points).toHaveLength(5);
  expect(split.enabled).toBe(true);
  // Переворот диагонали 0→3 даёт две другие пары.
  const flipped = flipArtEdge(mesh, 0, 3)!;
  expect(flipped.art.triangles).toHaveLength(6);
  expect(flipped.art.triangles).not.toEqual(mesh.art.triangles);
  // Разбиение треугольника точкой: три треугольника вместо одного.
  // Точка не на диагонали: иначе один из новых треугольников вырожденный.
  const cut = splitArtTriangle(mesh, 0, { x: 0.25, y: 0.1 })!;
  expect(cut.art.points).toHaveLength(5);
  expect(cut.art.triangles).toHaveLength(12);
  expect(splitArtTriangle(mesh, 9, { x: 0.5, y: 0.5 })).toBeNull();
  // Удаление треугольника и точки.
  expect(removeArtTriangle(cut, 2).art.triangles).toHaveLength(9);
  const dense = splitArtEdge(mesh, 0, 1)!;
  const pruned = removeArtPoint(dense, 4);
  expect(pruned.art.points).toHaveLength(4);
  // Сдвиг точки нарезки не трогает сетку.
  const moved = moveArtPoint(mesh, 3, -0.1, -0.1);
  expect(moved.art.points[3]).toEqual({ x: 0.9, y: 0.9 });
  expect(moved.deform.points).toEqual(mesh.deform.points);
  expect(moved.art.auto).toBeNull();
});

/*
 * Матрица холста сетки: где окажется верх картинки.
 *
 * Проверяем главное, на чём спотыкается WebGL: верх объекта обязан попасть
 * наверх холста. Знак Y здесь один на весь рендер — перепутать его значит
 * перевернуть изображение целиком.
 */

const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Матрица в координатах GLSL: pos = M · (x, y, 1). */
function applyGl(matrix: Float32Array, x: number, y: number): { x: number; y: number } {
  return {
    x: matrix[0] * x + matrix[3] * y + matrix[6],
    y: matrix[1] * x + matrix[4] * y + matrix[7],
  };
}

test("верх картинки — наверху холста, низ — внизу", () => {
  const box = { left: 0, top: 0, width: 100, height: 50 };
  const matrix = meshMatrix(identity, box);
  const top = applyGl(matrix, 0, 0);
  const bottom = applyGl(matrix, 0, 50);
  // У WebGL +1 — верх. Верх картинки обязан быть выше низа.
  expect(top.y).toBeCloseTo(1, 6);
  expect(bottom.y).toBeCloseTo(-1, 6);
  expect(top.x).toBeCloseTo(-1, 6);
  expect(applyGl(matrix, 100, 0).x).toBeCloseTo(1, 6);
});

test("сдвиг камеры и окна не переворачивает картинку", () => {
  const box = { left: 20, top: 10, width: 40, height: 30 };
  const matrix = meshMatrix({ ...identity, e: 20, f: 10 }, box);
  // Левый верхний пиксель картинки (её саму двигает матрица) — левый верхний
  // угол холста.
  const top = applyGl(matrix, 0, 0);
  expect(top.x).toBeCloseTo(-1, 6);
  expect(top.y).toBeCloseTo(1, 6);
  // А край окна — противоположный угол.
  const corner = applyGl(matrix, 40, 30);
  expect(corner.x).toBeCloseTo(1, 6);
  expect(corner.y).toBeCloseTo(-1, 6);
});


test("родитель делит только покрытые треугольники, UV и дырки сохраняются", () => {
  const mesh = enabled();
  mesh.art = { ...mesh.art, triangles: mesh.art.triangles.slice(0, 3), auto: null };
  const source = meshGeometry(sprite({ mesh }))!;
  const bent = deformGeometry(source, (p) => ({ x: p.x + p.y * p.y / 100, y: p.y }));
  expect(bent.triangles).toHaveLength(3 * 64);
  expect(source.triangles).toHaveLength(3);
  expect(bent.uv.slice(0, source.uv.length)).toEqual(source.uv);
  expect(bent.targets[3].x).toBeCloseTo(source.targets[3].x + source.targets[3].y ** 2 / 100);
});
