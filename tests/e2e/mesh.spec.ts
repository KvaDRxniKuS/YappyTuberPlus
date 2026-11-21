import { expect, test } from "@playwright/test";
import {
  MESH_MAX, applyOffsets, artArea, artFromGrid, artFromOutline, clampGrid, defaultMesh, deleteArtPoint,
  deleteTriangle, earClip, edgeMap, flipDiagonal, gridCorners, gridIndex, gridMoved, gridTriangles,
  migrateWarp, mirrorPoint, meshIsZoneQuad, meshOf, meshVertices, normalizeMesh, paramOffsets, regularGrid,
  resizeGrid, sampleGrid, shiftNode, splitEdge, validateArt, addTriangle, hasTriangle,
  BRUSH_DEFAULT, MIRROR_DEFAULT, brushGrid, brushWeights, mirrorAcross, mirrorNode, moveNodeMirrored,
  normalizeBrush, normalizeMirror, smoothGrid, symmetrizeGrid, mergeArt,
} from "../../src/engine/mesh";
import { defaultWarp } from "../../src/render/warp";
import { DEFAULT_BASE, type RigObject } from "../../src/types";

/*
 * Артмеш и сетка — данные и геометрия. Всё это чистые функции: ни DOM, ни ядра,
 * поэтому проверяется без браузера, как и блок состояний.
 */

function object(patch: Partial<RigObject> = {}): RigObject {
  return {
    id: "o1", name: "Глаз", kind: "sprite", enabled: true, image: null,
    parentId: null, pivot: { x: 0.5, y: 0.5 }, base: { ...DEFAULT_BASE },
    script: "", width: 200, height: 100, ...patch,
  };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

test("пустая деформация: нарезка и сетка регулярные 2×2", () => {
  const mesh = defaultMesh();
  expect(mesh.enabled).toBe(false);
  expect(mesh.frame).toEqual({ x: 0, y: 0, width: 1, height: 1, rotation: 0 });
  // Узлы идут построчно: левый верхний, правый верхний, левый нижний, правый нижний.
  expect(mesh.art.points).toEqual([
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 },
  ]);
  // Диагональ — как у старой деформации: из левого верхнего в правый нижний.
  expect(mesh.art.triangles).toEqual([0, 1, 3, 0, 3, 2]);
  expect(mesh.deform.points).toEqual(mesh.art.points);
  expect(gridMoved(mesh.deform)).toBe(false);
});

test("сетка: индекс узла, четыре угла и треугольники", () => {
  expect(gridIndex(3, 0, 0)).toBe(0);
  expect(gridIndex(3, 2, 0)).toBe(2);
  expect(gridIndex(3, 1, 1)).toBe(4);
  // 3×2 — это три узла по ширине и два по высоте: одна ячейка по высоте.
  const grid = regularGrid(3, 2);
  expect(grid.points).toHaveLength(6);
  expect(gridCorners(grid)).toEqual([0, 2, 5, 3]);
  expect(gridTriangles(3, 2)).toHaveLength((3 - 1) * (2 - 1) * 2 * 3);
});

test("густота: целое 2…32, шкала нелинейная", () => {
  expect(clampGrid(1)).toBe(2);
  expect(clampGrid(99)).toBe(MESH_MAX);
  expect(clampGrid(6.4)).toBe(6);
  expect(clampGrid("мусор" as unknown)).toBe(2);
  expect(artFromGrid(4, 3).points).toHaveLength(12);
  expect(artFromGrid(4, 3).triangles).toHaveLength((4 - 1) * (3 - 1) * 2 * 3);
  expect(artArea(artFromGrid(4, 3))).toBe(1);
});

test("миграция: старая деформация становится ровно той же геометрией", () => {
  const warp = defaultWarp();
  const plain = migrateWarp(warp);
  expect(plain.enabled).toBe(false);
  // Без смещений сетка совпадает с нарезкой: картинка не меняется.
  expect(plain.deform.points).toEqual(plain.art.points);
  expect(meshIsZoneQuad(plain)).toBe(true);

  warp.enabled = true;
  warp.frame = { x: 0.2, y: 0.1, width: 0.5, height: 0.6, rotation: 15 };
  warp.corners = {
    tl: { x: 0, y: 0 }, tr: { x: 10, y: -5 }, br: { x: 0, y: 0 }, bl: { x: -10, y: 5 },
  };
  const mesh = migrateWarp(warp);
  expect(mesh.enabled).toBe(true);
  expect(mesh.frame).toEqual(warp.frame);
  // Смещения углов — те же проценты, но в долях зоны.
  // tr, br, bl, tl — в порядке узлов сетки.
  expect(mesh.deform.points[1]).toEqual({ x: 1.1, y: -0.05 });
  expect(mesh.deform.points[3]).toEqual({ x: 1, y: 1 });
  expect(mesh.deform.points[2]).toEqual({ x: -0.1, y: 1.05 });
  expect(mesh.deform.points[0]).toEqual({ x: 0, y: 0 });
});

test("объект: новая сетка, старый warp или ничего", () => {
  expect(meshOf(object())).toBeUndefined();
  const warp = defaultWarp();
  warp.enabled = true;
  expect(meshOf(object({ warp }))?.enabled).toBe(true);
  const mesh = defaultMesh();
  mesh.enabled = true;
  expect(meshOf(object({ mesh }))?.enabled).toBe(true);
  // Новая сетка главнее: старую читаем, только пока новой нет.
  expect(meshOf(object({ mesh, warp }))?.art.points).toEqual(mesh.art.points);
});

test("пресет: битая сетка пересобирается, битая нарезка отбрасывается", () => {
  const mesh = defaultMesh();
  const broken = normalizeMesh({ enabled: true, art: mesh.art, deform: { cols: 3, rows: 3, points: [] } });
  expect(broken?.deform.points).toHaveLength(9);
  expect(broken?.deform.cols).toBe(3);
  const noArt = normalizeMesh({ enabled: true, deform: mesh.deform, art: { points: [], triangles: [] } });
  expect(noArt?.art.points).toHaveLength(4);
  // Треугольник с индексом вне точек не попадает в нарезку.
  const art = normalizeMesh({
    art: { points: mesh.art.points, triangles: [0, 1, 9, 0, 1, 2], auto: null },
    deform: mesh.deform,
  })?.art;
  expect(art?.triangles).toEqual([0, 1, 2]);
  expect(normalizeMesh("мусор" as unknown)).toBeUndefined();
});

test("сетка считается билинейно: регулярная ничего не двигает", () => {
  const grid = regularGrid(2, 2);
  expect(sampleGrid(grid, 0.25, 0.75)).toEqual({ x: 0.25, y: 0.75 });
  // Правый нижний узел сетки 2×2 — индекс 3.
  const moved = shiftNode(grid, 3, 0.1, -0.2);
  const center = sampleGrid(moved, 0.5, 0.5);
  // Центр сетки 2×2 — среднее четырёх узлов.
  expect(round(center.x)).toBe(round(0.5 + 0.1 / 4));
  expect(round(center.y)).toBe(round(0.5 - 0.2 / 4));
  // Угол, который не трогали, стоит на месте.
  expect(sampleGrid(moved, 0, 1)).toEqual({ x: 0, y: 1 });
});

test("смена густоты сохраняет форму", () => {
  // 4×4: узлы на третях. Двигаем центр (2,2) — он попадает в выборку.
  const dense = shiftNode(regularGrid(4, 4), gridIndex(4, 2, 2), 0.1, 0.05);
  const coarse = resizeGrid(dense, 3, 3);
  expect(coarse.points).toHaveLength(9);
  // Центр 3×3 — билинейная выборка из четырёх центральных узлов 4×4.
  expect(coarse.points[gridIndex(3, 1, 1)]).toEqual({ x: 0.525, y: 0.513 });
  // Углы не едут никуда: форма держится за них.
  expect(coarse.points[0]).toEqual({ x: 0, y: 0 });
  expect(coarse.points[8]).toEqual({ x: 1, y: 1 });
  // Обратно: 3×3 → 6×6 не теряет ни угол, ни центр.
  const again = resizeGrid(coarse, 6, 6);
  expect(again.points).toHaveLength(36);
  expect(again.points[35]).toEqual({ x: 1, y: 1 });
  // Центр сохраняется: у 6×6 узла в точке 0.5 нет, поэтому сверяем выборку.
  const center = sampleGrid(again, 0.5, 0.5);
  expect(Math.abs(center.x - coarse.points[gridIndex(3, 1, 1)].x)).toBeLessThan(0.02);
  expect(Math.abs(center.y - coarse.points[gridIndex(3, 1, 1)].y)).toBeLessThan(0.02);
  // То же количество — та же сетка, без пересчёта.
  expect(resizeGrid(coarse, 3, 3)).toBe(coarse);
});

test("вершины: нарезка прогоняется через сетку, ключ двигает только цель", () => {
  const mesh = defaultMesh();
  const plain = meshVertices(mesh);
  expect(plain.targets).toEqual(plain.params);
  const shifted = meshVertices(mesh, { "3": { x: 0.1, y: 0 } });
  expect(shifted.params).toEqual(plain.params);
  // Правый нижний угол уехал, остальные — нет.
  expect(shifted.targets[3]).toEqual({ x: 1.1, y: 1 });
  expect(shifted.targets[0]).toEqual({ x: 0, y: 0 });
  // Смещение не портит саму сетку объекта.
  expect(mesh.deform.points[3]).toEqual({ x: 1, y: 1 });
});

test("старые параметры углов двигают крайние узлы сетки", () => {
  const mesh = defaultMesh();
  expect(paramOffsets(mesh, null)).toBeUndefined();
  expect(paramOffsets(mesh, { warpTLx: 0, warpTLy: 0 } as never)).toBeUndefined();
  const offsets = paramOffsets(mesh, { warpTLx: 10, warpBLy: -20 } as never);
  // tl — индекс 0, bl — индекс 2.
  expect(offsets).toEqual({ "0": { x: 0.1, y: 0 }, "2": { x: 0, y: -0.2 } });
  const grid = applyOffsets(mesh.deform, offsets);
  expect(grid.points[2]).toEqual({ x: 0, y: 0.8 });
  // На сетке 4×4 параметры двигают те же четыре угла, а не середины.
  const dense = regularGrid(4, 4);
  expect(paramOffsets({ ...mesh, deform: dense }, { warpBRx: 5 } as never))
    .toEqual({ [String(gridCorners(dense)[2])]: { x: 0.05, y: 0 } });
});

test("нарезка: разрезать ребро", () => {
  const art = artFromGrid(2, 2);
  const split = splitEdge(art, 0, 1);
  expect(split).not.toBeNull();
  expect(split!.points).toHaveLength(5);
  expect(split!.points[4]).toEqual({ x: 0.5, y: 0 });
  // Ребро принадлежит одному треугольнику: было 2, стало 3.
  expect(split!.triangles).toHaveLength(9);
  expect(artArea(split!)).toBe(1);
  expect(validateArt(split!)).toEqual([]);
  expect(split!.auto).toBeNull();
  // Ребра, которого нет, и петли не разрезаются.
  expect(splitEdge(split!, 0, 0)).toBeNull();
  expect(splitEdge(art, 0, 4)).toBeNull();
});

test("нарезка: перевернуть диагональ", () => {
  const art = artFromGrid(2, 2);
  const flipped = flipDiagonal(art, 0, 3);
  expect(flipped).not.toBeNull();
  expect(flipped!.triangles).toHaveLength(6);
  expect(hasTriangle(flipped!, 2, 1, 3)).toBe(true);
  expect(hasTriangle(flipped!, 0, 3, 1)).toBe(false);
  expect(artArea(flipped!)).toBe(1);
  expect(validateArt(flipped!)).toEqual([]);
  // У ребра только один владелец — переворачивать нечего.
  expect(flipDiagonal(art, 0, 1)).toBeNull();
  // Невыпуклый четырёхугольник не переворачивается: треугольники легли бы друг на друга.
  const bent = { ...art, points: [...art.points], auto: null };
  bent.points[3] = { x: 0.2, y: 0.6 };
  expect(flipDiagonal(bent, 0, 3)).toBeNull();
});

test("нарезка: добавить и удалить треугольник, удалить точку", () => {
  const art = artFromGrid(2, 2);
  // Диагональ уже есть — второй такой треугольник не нужен.
  expect(addTriangle(art, 0, 1, 3)).toBeNull();
  expect(addTriangle(art, 0, 1, 9)).toBeNull();
  expect(addTriangle(art, 0, 0, 1)).toBeNull();
  // Нулевая площадь: точка на ребре.
  const flat = { ...art, points: [...art.points, { x: 0.5, y: 0 }], auto: null };
  expect(addTriangle(flat, 0, 4, 1)).toBeNull();
  // Новая точка внутри картинки — треугольник добавляется.
  const inner = { ...art, points: [...art.points, { x: 0.5, y: 0.5 }], auto: null };
  const added = addTriangle(inner, 0, 1, 4);
  expect(added).not.toBeNull();
  expect(added!.triangles).toHaveLength(9);
  expect(validateArt(added!)).toEqual([]);

  const removed = deleteTriangle(added!, 2);
  expect(removed.triangles).toHaveLength(6);
  // Последний треугольник не удаляется.
  const single = { points: art.points, triangles: [0, 1, 2], auto: null };
  expect(deleteTriangle(single, 0)).toBe(single);
});

test("нарезка: удаление точки перенумеровывает треугольники", () => {
  const art = artFromGrid(2, 2);
  // Точка 0 есть в обоих треугольниках: без неё не остаётся ни одного.
  expect(deleteArtPoint(art, 0)).toBe(art);
  // Меньше трёх точек не бывает: нарезка из трёх точку не отдаёт.
  const single = { points: art.points.slice(0, 3), triangles: [0, 1, 2], auto: null };
  expect(deleteArtPoint(single, 1)).toBe(single);
  // 3×3: разрезали ребро, удалили добавленную точку — индексы снова в диапазоне.
  const dense = artFromGrid(3, 3);
  const split = splitEdge(dense, 0, 1)!;
  expect(split.points).toHaveLength(10);
  const after = deleteArtPoint(split, 9);
  expect(after.points).toHaveLength(9);
  expect(after.triangles.every((value) => value < 9)).toBe(true);
  expect(validateArt(after)).toEqual([]);
  // Площадь упала: вместе с точкой ушли её треугольники, дыра честно видна.
  expect(artArea(after)).toBeLessThan(1);
});

test("автотриангуляция контура: квадрат и уголок без дыр", () => {
  const square = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  expect(earClip(square)).toHaveLength(6);
  // Обход против часовой стрелки даёт те же треугольники, что и по часовой.
  const reversed = [...square].reverse();
  expect(earClip(reversed)).toHaveLength(6);
  const corner = [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.4 },
    { x: 0.4, y: 0.4 }, { x: 0.4, y: 1 }, { x: 0, y: 1 },
  ];
  const triangles = earClip(corner);
  expect(triangles).toHaveLength((corner.length - 2) * 3);
  const area = triangles.reduce((sum, index, at) => (at % 3 === 0
    ? sum + Math.abs(((corner[triangles[at + 1]].x - corner[index].x) * (corner[triangles[at + 2]].y - corner[index].y)
      - (corner[triangles[at + 2]].x - corner[index].x) * (corner[triangles[at + 1]].y - corner[index].y)) / 2)
    : sum), 0);
  // Уголок площадью 0.64: 1 − 0.36.
  expect(round(area)).toBe(0.64);
  expect(artFromOutline(square)?.outline).toEqual([0, 1, 2, 3]);
  expect(artFromOutline([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
});

test("проверка нарезки ловит то, что ломает рендер", () => {
  const art = artFromGrid(2, 2);
  expect(validateArt(art)).toEqual([]);
  expect(validateArt({ ...art, triangles: [0, 1, 9], auto: null })[0]).toContain("индекс вне точек");
  expect(validateArt({ ...art, triangles: [0, 0, 1], auto: null })[0]).toContain("повторная вершина");
  expect(validateArt({ ...art, points: [...art.points], triangles: [0, 1, 2, 0, 1, 2], auto: null }))
    .toContain("треугольник 2: повторяет другой");
  const flat = { ...art, points: [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], triangles: [0, 1, 2], auto: null };
  expect(validateArt(flat)[0]).toContain("нулевая площадь");
});

test("рёбра нарезки сгруппированы по владельцам", () => {
  const art = artFromGrid(2, 2);
  const edges = edgeMap(art);
  expect(edges.size).toBe(5);
  // Диагональ общая у двух треугольников, сторона — у одного.
  expect(edges.get("0:3")).toEqual([0, 1]);
  expect(edges.get("0:1")).toEqual([0]);
});

test("зеркало точки относительно оси", () => {
  // Вертикальная ось через центр: x отражается, y — нет.
  expect(mirrorPoint({ x: 0.2, y: 0.3 }, { x: 0.5, y: 0.5, angle: 90 }))
    .toEqual({ x: 0.8, y: 0.3 });
  // Горизонтальная ось: y отражается.
  expect(mirrorPoint({ x: 0.2, y: 0.3 }, { x: 0.5, y: 0.5, angle: 0 }))
    .toEqual({ x: 0.2, y: 0.7 });
  // Точка на оси остаётся на месте.
  expect(mirrorPoint({ x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5, angle: 90 }))
    .toEqual({ x: 0.5, y: 0.1 });
});

/*
 * Кисть, сглаживание и симметрия. Всё это — правки авторской сетки, поэтому
 * проверяется без сцены: веса, пары узлов и ход к середине соседей.
 */

const VERTICAL = { on: true, x: 0.5, y: 0.5, angle: 90 };
const HORIZONTAL = { on: true, x: 0.5, y: 0.5, angle: 0 };

test("веса кисти: центр единица, край ноль, за краем пусто", () => {
  const center = { x: 100, y: 100 };
  const points = [
    { x: 100, y: 100 },
    { x: 150, y: 100 },
    { x: 200, y: 100 },
    { x: 260, y: 100 },
  ];
  const weights = brushWeights(points, center, 100, 0.5);
  expect(weights[0]).toBe(1);
  // На границе жёсткости вес ещё единица, дальше гаснет.
  expect(weights[1]).toBeCloseTo(1, 6);
  expect(weights[2]).toBeCloseTo(0, 6);
  expect(weights[3]).toBe(0);
  // Жёсткость 1 — резкая граница: всё внутри тянется целиком.
  expect(brushWeights(points, center, 100, 1)[1]).toBe(1);
  // Жёсткость 0 — мягко от самого центра.
  expect(brushWeights(points, center, 100, 0)[1]).toBeLessThan(1);
});

test("мазок двигает узлы с весом, нулевой сдвиг сетку не трогает", () => {
  const grid = regularGrid(3, 3);
  const next = brushGrid(grid, [1, 0.5, 0, 0, 0, 0, 0, 0, 0], 0.1, 0);
  expect(round(next.points[0].x)).toBe(0.1);
  // Узел с весом 0.5 прошёл половину пути — от своего места, а не от нуля.
  expect(round(next.points[1].x)).toBe(0.55);
  expect(round(next.points[2].x)).toBe(1);
  // Простой клик без движения пресет не переписывает.
  expect(brushGrid(grid, [1, 1, 1, 1, 1, 1, 1, 1, 1], 0, 0)).toBe(grid);
});

test("сглаживание тянет внутренние узлы к соседям, край стоит", () => {
  const grid = regularGrid(3, 3);
  const moved = { ...grid, points: grid.points.map((point, index) => (index === 4 ? { x: 0.5, y: 0.7 } : point)) };
  const smooth = smoothGrid(moved, 1);
  // Внутренний узел встал в середину своих соседей.
  expect(round(smooth.points[4].x)).toBe(0.5);
  expect(round(smooth.points[4].y)).toBe(0.5);
  // Крайние узлы не двигаются: иначе сетка сжималась бы с каждым нажатием.
  expect(smooth.points[0]).toEqual(grid.points[0]);
  // Сетка 2×2 — это четыре угла: сглаживать нечего.
  expect(smoothGrid(regularGrid(2, 2))).toEqual(regularGrid(2, 2));
});

test("отражение точки относительно оси: вертикальная и горизонтальная", () => {
  expect(mirrorAcross({ x: 0.2, y: 0.3 }, VERTICAL)).toEqual({ x: 0.8, y: 0.3 });
  expect(mirrorAcross({ x: 0.2, y: 0.3 }, HORIZONTAL)).toEqual({ x: 0.2, y: 0.7 });
  // Узел на оси остаётся на месте.
  expect(mirrorAcross({ x: 0.5, y: 0.3 }, VERTICAL)).toEqual({ x: 0.5, y: 0.3 });
  // Косая ось 45° меняет знак у обеих координат относительно центра.
  expect(mirrorAcross({ x: 0.7, y: 0.2 }, { on: true, x: 0.5, y: 0.5, angle: 45 }))
    .toEqual({ x: 0.2, y: 0.7 });
});

test("пара узлов известна по индексу у осей сетки", () => {
  const grid = regularGrid(3, 3);
  // Левый верхний (0) ↔ правый верхний (2).
  expect(mirrorNode(grid, 0, VERTICAL)).toBe(2);
  expect(mirrorNode(grid, 2, VERTICAL)).toBe(0);
  // Узел на оси пары не имеет.
  expect(mirrorNode(grid, 1, VERTICAL)).toBeNull();
});

test("симметрия при перетаскивании: пара едет зеркально", () => {
  const grid = regularGrid(3, 3);
  const next = moveNodeMirrored(grid, 0, 0.1, 0.05, VERTICAL);
  expect(round(next.points[0].x)).toBe(0.1);
  expect(round(next.points[0].y)).toBe(0.05);
  // Отражённый узел ушёл влево и вниз ровно на столько же.
  expect(round(next.points[2].x)).toBe(0.9);
  expect(round(next.points[2].y)).toBe(0.05);
  // Без пары сдвиг обычный: узлы на оси двигаются по одному.
  expect(moveNodeMirrored(grid, 1, 0.1, 0, VERTICAL).points[1].x).toBe(0.5 + 0.1 > 1 ? 0.5 : 0.6);
});

test("симметризация сводит пары к середине и ставит узлы на ось", () => {
  const grid = regularGrid(3, 3);
  const skewed = { ...grid, points: grid.points.map((point, index) => (index === 2 ? { x: 0.9, y: 0.1 } : point)) };
  const next = symmetrizeGrid(skewed, VERTICAL);
  // Пара проходит полпути: правый узел встал зеркально левому, левый — на
  // середину между собой и отражением правого.
  expect(round(next.points[0].x)).toBe(0.05);
  expect(round(next.points[2].x)).toBe(0.95);
  expect(round(next.points[2].y)).toBe(0.05);
  expect(next.points[2].y).toBe(next.points[0].y);
  // Узлы на оси остаются на месте.
  expect(next.points[1].x).toBe(0.5);
});

test("настройки кисти и оси: битые значения дают разумные", () => {
  expect(normalizeBrush(undefined)).toEqual(BRUSH_DEFAULT);
  expect(normalizeBrush({ on: true, radius: 99, hardness: -3 })).toEqual({ on: true, radius: 2, hardness: 0 });
  expect(normalizeMirror(undefined)).toEqual(MIRROR_DEFAULT);
  // Угол — это прямая: 270° и −90° одно и то же.
  expect(normalizeMirror({ on: true, x: 0.5, y: 0.5, angle: 270 }).angle).toBe(-90);
});

/*
 * Триангуляция руками: контур из кликов.
 *
 * Полигон замыкается двойным кликом (или Enter), после чего «отрезание уха»
 * разбивает его на треугольники. Контур работает и как обрезка: картинка
 * рисуется только внутри треугольников.
 */

test("контур из кликов становится нарезкой", () => {
  // Квадрат против часовой: два треугольника, четыре точки, контур сохранён.
  const art = artFromOutline([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
  expect(art).not.toBeNull();
  expect(art!.points).toHaveLength(4);
  expect(art!.triangles).toHaveLength(6);
  expect(art!.auto).toBeNull();
  expect(art!.outline).toEqual([0, 1, 2, 3]);
  // Меньше трёх точек — не контур.
  expect(artFromOutline([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
});

test("«отрезание уха» разворачивает обход и пропускает вырожденные углы", () => {
  // Тот же квадрат по часовой: обход разворачивается, площадь та же.
  const clockwise = earClip([{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }]);
  expect(clockwise).toHaveLength(6);
  // Три точки на одной прямой — это не контур: площадь нулевая.
  expect(artFromOutline([{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }])).toBeNull();
});

test("второй контур добавляется к нарезке, а не стирает первый", () => {
  const first = artFromOutline([{ x: 0, y: 0 }, { x: 0.4, y: 0 }, { x: 0.4, y: 0.4 }, { x: 0, y: 0.4 }])!;
  const second = artFromOutline([{ x: 0.6, y: 0.6 }, { x: 1, y: 0.6 }, { x: 1, y: 1 }, { x: 0.6, y: 1 }])!;
  const merged = mergeArt(first, second);
  expect(merged.points).toHaveLength(8);
  expect(merged.triangles).toHaveLength(12);
  // Индексы второго контура сдвинуты: он ссылается на свои точки.
  expect(Math.min(...merged.triangles.slice(6))).toBeGreaterThanOrEqual(4);
  expect(merged.auto).toBeNull();
});
