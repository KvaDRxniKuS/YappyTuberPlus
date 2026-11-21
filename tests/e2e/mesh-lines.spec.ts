import { expect, test } from "@playwright/test";
import {
  addArtLine, addArtPoint, artArea, artFromGrid, artLines, deleteArtPoint, edgeKey, nearestArtLine,
  normalizeArt, pointSegmentDistance, removeArtLine,
} from "../../src/engine/mesh";
import type { ArtMesh, Vec2 } from "../../src/types";

/*
 * Триангуляция руками: точки и линии.
 *
 * Линии двух видов — ручные (их не перерезать) и автоматические (из
 * треугольников). Всё это чистые функции, поэтому проверяется без браузера.
 */

/** Есть ли такая линия в треугольнике нарезки. */
function hasLine(art: ArtMesh, a: number, b: number): boolean {
  return [...artLines(art).manual, ...artLines(art).auto].some(([x, y]) => edgeKey(x, y) === edgeKey(a, b));
}

/** Пересекаются ли две линии внутри (общие концы не в счёт). */
function crosses(art: ArtMesh, a: number, b: number, c: number, d: number): boolean {
  const p = art.points[a];
  const q = art.points[b];
  const r = art.points[c];
  const s = art.points[d];
  const rx = q.x - p.x;
  const ry = q.y - p.y;
  const sx = s.x - r.x;
  const sy = s.y - r.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return false;
  const t = ((r.x - p.x) * sy - (r.y - p.y) * sx) / denom;
  const u = ((r.x - p.x) * ry - (r.y - p.y) * rx) / denom;
  return t > 1e-7 && t < 1 - 1e-7 && u > 1e-7 && u < 1 - 1e-7;
}

test("у базовой нарезки 2×2 автоматические линии, ручных нет", () => {
  const art = artFromGrid(2, 2);
  const { auto, manual } = artLines(art);
  // Четыре стороны и одна диагональ 0–3.
  expect(manual).toHaveLength(0);
  expect(auto).toHaveLength(5);
  expect(hasLine(art, 0, 3)).toBe(true);
});

test("новая точка делит треугольник и соединяется с его вершинами", () => {
  const art = artFromGrid(2, 2);
  const before = artArea(art);
  const next = addArtPoint(art, { x: 0.5, y: 0.5 })!;
  expect(next).not.toBeNull();
  expect(next.points).toHaveLength(5);
  // Треугольник под точкой делится на три.
  expect(next.triangles).toHaveLength(4 * 3);
  // Площадь не изменилась: точка не растянула картинку.
  expect(artArea(next)).toBeCloseTo(before, 6);
  // Линии от новой точки — автоматические.
  const { auto } = artLines(next);
  const from = auto.filter(([a, b]) => a === 4 || b === 4);
  expect(from).toHaveLength(4);
  expect(next.manual ?? []).toHaveLength(0);
});

test("точка на линии делит её, а не висит в стороне", () => {
  const art = artFromGrid(2, 2);
  const before = artArea(art);
  // Середина диагонали 0–3.
  const next = addArtPoint(art, { x: 0.5, y: 0.5 });
  // В 2×2 центр лежит и на диагонали, и внутри треугольника — проверяем сторону.
  const onSide = addArtPoint(artFromGrid(2, 2), { x: 0.5, y: 0 });
  expect(onSide).not.toBeNull();
  expect(artArea(onSide!)).toBeCloseTo(before, 6);
  expect(next).not.toBeNull();
});

test("ручная линия режет автоматические и остаётся на месте", () => {
  const art = artFromGrid(2, 2);
  const before = artArea(art);
  // Вторая диагональ квадрата: она перерезает автоматическую 0–3.
  expect(crosses(art, 1, 2, 0, 3)).toBe(true);
  const next = addArtLine(art, 1, 2)!;
  expect(next).not.toBeNull();
  expect(next.manual).toEqual([[1, 2]]);
  // Покрытие сохранилось, а старая диагональ исчезла: её перерезали.
  expect(artArea(next)).toBeCloseTo(before, 6);
  expect(hasLine(next, 1, 2)).toBe(true);
  expect(hasLine(next, 0, 3)).toBe(false);
  // Квадрат делится на два треугольника: ручная линия заменила диагональ.
  expect(next.triangles).toHaveLength(2 * 3);
  // Ни одна автоматическая линия не режет ручную.
  for (const [a, b] of artLines(next).auto) {
    expect(crosses(next, a, b, 1, 2)).toBe(false);
  }
});

test("ручная линия не перерезает другую ручную", () => {
  const art = addArtLine(artFromGrid(2, 2), 1, 2)!;
  // Теперь 0–3 упирается в ручную 1–2.
  expect(addArtLine(art, 0, 3)).toBeNull();
});

test("линия по уже существующему ребру становится ручной", () => {
  const art = artFromGrid(2, 2);
  const next = addArtLine(art, 0, 3)!;
  expect(next.manual).toEqual([[0, 3]]);
  expect(artArea(next)).toBeCloseTo(artArea(art), 6);
  expect(artLines(next).manual).toHaveLength(1);
  expect(artLines(next).auto).toHaveLength(4);
});

test("удаление внутренней линии переворачивает диагональ, а не рвёт картинку", () => {
  const art = artFromGrid(2, 2);
  const before = artArea(art);
  const next = removeArtLine(art, 0, 3);
  expect(hasLine(next, 0, 3)).toBe(false);
  expect(hasLine(next, 1, 2)).toBe(true);
  expect(artArea(next)).toBeCloseTo(before, 6);
});

test("удаление ручной линии снимает ограничение", () => {
  const art = addArtLine(artFromGrid(2, 2), 1, 2)!;
  const next = removeArtLine(art, 1, 2);
  expect(next.manual ?? []).toHaveLength(0);
  expect(hasLine(next, 1, 2)).toBe(false);
  expect(artArea(next)).toBeCloseTo(artArea(art), 6);
});

test("удаление крайней линии убирает покрытие — это видно на спрайте", () => {
  const art = artFromGrid(2, 2);
  const before = artArea(art);
  const next = removeArtLine(art, 0, 1);
  expect(hasLine(next, 0, 1)).toBe(false);
  expect(next.triangles.length / 3).toBe(1);
  expect(artArea(next)).toBeCloseTo(before / 2, 6);
});

test("удаление точки уносит её линии и сдвигает индексы ручных", () => {
  const art = addArtPoint(artFromGrid(2, 2), { x: 0.5, y: 0.5 })!;
  const manual = addArtLine(art, 4, 0)!;
  const next = deleteArtPoint(manual, 4);
  expect(next.points).toHaveLength(4);
  expect(next.manual ?? []).toHaveLength(0);
  // Карта индексов: точка 4 ушла, остальные на месте.
  expect(next.triangles.every((index) => index < 4)).toBe(true);
});

test("ручные линии переживают запись и чтение нарезки", () => {
  const art = addArtLine(artFromGrid(2, 2), 1, 2)!;
  const parsed = normalizeArt(JSON.parse(JSON.stringify(art)))!;
  expect(parsed.manual).toEqual([[1, 2]]);
  // Мусор в ручных линиях не ломает нарезку.
  const broken = normalizeArt({ ...art, manual: [[1, 2], [9, 10], [2, 2], "нет"] })!;
  expect(broken.manual).toEqual([[1, 2]]);
});

test("ближайшая линия ищется по расстоянию до отрезка", () => {
  const art = artFromGrid(2, 2);
  const points: Vec2[] = art.points.map((point) => ({ x: point.x * 100, y: point.y * 100 }));
  // Курсор рядом со стороной 0–1 (верхняя сторона квадрата).
  const hit = nearestArtLine(points, art, { x: 50, y: 4 }, 10)!;
  expect(hit).not.toBeNull();
  expect(edgeKey(hit.a, hit.b)).toBe(edgeKey(0, 1));
  expect(hit.manual).toBe(false);
  // Дальше допуска — не попадание.
  expect(nearestArtLine(points, art, { x: 50, y: 70 }, 10)).toBeNull();
  expect(pointSegmentDistance({ x: 50, y: 40 }, { x: 0, y: 0 }, { x: 100, y: 0 })).toBeCloseTo(40, 6);
});

test("точка на ручной диагонали сохраняет обе половины ручными", () => {
  const art = addArtLine(artFromGrid(2, 2), 0, 3)!;
  const next = addArtPoint(art, { x: 0.5, y: 0.5 })!;
  expect(artLines(next).manual).toEqual([[0, 4], [4, 3]]);
  expect(artArea(next)).toBeCloseTo(1, 6);
  expect(next.triangles).toHaveLength(12);
});

test("последние базовые точки удаляемы и пустая нарезка сохраняется", () => {
  let art = artFromGrid(2, 2);
  while (art.points.length) art = deleteArtPoint(art, 0);
  expect(art.triangles).toEqual([]);
  expect(normalizeArt(JSON.parse(JSON.stringify(art)))).toEqual(art);
  art = addArtPoint(art, { x: 0, y: 0 })!;
  art = addArtPoint(art, { x: 1, y: 0 })!;
  art = addArtPoint(art, { x: 0, y: 1 })!;
  expect(artArea(art)).toBeCloseTo(0.5, 6);
});

test("новая точка вне покрытия соединяется с видимой границей", () => {
  const art = artFromGrid(2, 2);
  const next = addArtPoint(art, { x: 1.5, y: 0.5 })!;
  expect(next.points).toHaveLength(5);
  expect(artArea(next)).toBeCloseTo(1.25, 6);
});

test("при переносе внутренней точки её звезда перестраивается без потери покрытия", async () => {
  const { defaultMesh, moveArtPoint } = await import("../../src/engine/mesh");
  const art = addArtPoint(artFromGrid(2, 2), { x: 0.5, y: 0.5 })!;
  const next = moveArtPoint({ ...defaultMesh(), art }, 4, 0.2, -0.1).art;
  expect(artArea(next)).toBeCloseTo(1, 6);
  expect(next.triangles).toHaveLength(12);
  for (const [a,b] of [...artLines(next).auto, ...artLines(next).manual]) {
    for (const [c,d] of [...artLines(next).auto, ...artLines(next).manual]) expect(crosses(next,a,b,c,d)).toBe(false);
  }
});

test("линия не удваивается при добавлении точки почти на ребро", () => {
  const next = addArtPoint(artFromGrid(2, 2), { x: 0.5, y: 0.5001 })!;
  expect(next.points[4].x).toBeCloseTo(next.points[4].y, 6);
  expect(hasLine(next,0,3)).toBe(false);
  const edges = artLines(next).auto.map(([a,b]) => edgeKey(a,b));
  expect(new Set(edges).size).toBe(edges.length);
});

test("два видимых соседа не требуют третьей линии через барьер", () => {
  const art: ArtMesh = {
    points: [{x:0,y:0},{x:0,y:1},{x:1,y:0},{x:1,y:1}],
    triangles: [], manual: [[0,1]], edges: [[0,2],[1,3],[2,3]], auto: null,
  };
  const next = addArtPoint(art,{x:-0.5,y:0.5})!;
  expect(hasLine(next,4,0)).toBe(true);
  expect(hasLine(next,4,1)).toBe(true);
  expect(hasLine(next,4,2)).toBe(false);
  expect(hasLine(next,4,3)).toBe(false);
});

test("многократная вставка и переход точки через авто-линии не создают пересечений", async () => {
  const { defaultMesh, moveArtPoint } = await import("../../src/engine/mesh");
  let art = artFromGrid(2,2);
  for (const point of [{x:0.2,y:0.3},{x:0.7,y:0.4},{x:0.3,y:0.8},{x:0.9,y:0.7}]) art = addArtPoint(art,point)!;
  for (const target of [{x:0.6,y:0.6},{x:0.8,y:0.2},{x:0.4,y:0.7}]) {
    const p = art.points[4];
    art = moveArtPoint({...defaultMesh(),art},4,target.x-p.x,target.y-p.y).art;
    expect(artArea(art)).toBeCloseTo(1,5);
    const edges = [...artLines(art).auto,...artLines(art).manual];
    for (const [a,b] of edges) for (const [c,d] of edges) expect(crosses(art,a,b,c,d)).toBe(false);
  }
});
