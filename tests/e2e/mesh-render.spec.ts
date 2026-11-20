import { expect, test } from "@playwright/test";
import { defaultMesh, regularGrid, shiftNode } from "../../src/engine/mesh";
import { drawMeshImage, meshGeometry, meshQuad, zoneGeometry } from "../../src/render/mesh";
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

test("отрисовка: картинка с дырой под зоной плюс треугольники", () => {
  const object = sprite({ mesh: enabled() });
  const { ctx, calls } = fakeContext();
  expect(drawMeshImage(ctx, {} as CanvasImageSource, object, 200, 100)).toBe(true);
  // Один раз — картинка вокруг зоны, два — треугольники нет: у 2×2 их две пары.
  expect(calls.drawImage).toBe(3);
  expect(calls.clip).toBe(3);
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
  expect(calls.drawImage).toBe(3);
});
