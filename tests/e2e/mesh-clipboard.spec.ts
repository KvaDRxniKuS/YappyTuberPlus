import { expect, test } from "@playwright/test";
import { askPasteMode, heldMesh, holdMesh, pasteMesh } from "../../src/engine/meshClipboard";
import { MIRROR_DEFAULT, defaultMesh, shiftNode } from "../../src/engine/mesh";
import type { MeshSpec } from "../../src/types";

/*
 * Копирование и перенос сетки между объектами.
 *
 * Буфер общий и живёт в памяти; проверяется без браузера. Главное правило:
 * нарезка не переезжает — она принадлежит картинке, а не форме.
 */

function withGrid(cols: number, rows: number): MeshSpec {
  const mesh = defaultMesh();
  const points = Array.from({ length: cols * rows }, (_, index) => ({
    x: (index % cols) / (cols - 1),
    y: Math.floor(index / cols) / (rows - 1),
  }));
  return { ...mesh, enabled: true, deform: { cols, rows, points } };
}

test("буфер держит копию: правка исходной сетки её не меняет", () => {
  const source = withGrid(2, 2);
  holdMesh(source);
  source.deform.points[0].x = 0.5;
  expect(heldMesh()?.deform.points[0].x).toBe(0);
  // Пустой буфер — честный null.
  holdMesh(null);
  expect(heldMesh()).toBeNull();
});

test("одинаковая густота вставляется без вопросов, разная — с вопросом", () => {
  const target = withGrid(3, 3);
  expect(askPasteMode(target, withGrid(3, 3))).toBe(false);
  expect(askPasteMode(target, withGrid(4, 4))).toBe(true);
  // Другая нарезка при той же сетке тоже требует выбора.
  const other = withGrid(3, 3);
  other.art = { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], triangles: [0, 1, 2], auto: null };
  expect(askPasteMode(target, other)).toBe(true);
});

test("«Перенести» заменяет форму и ось, но не нарезку и не зону", () => {
  const target = withGrid(3, 3);
  target.frame = { x: 0.1, y: 0.2, width: 0.5, height: 0.4, rotation: 10 };
  const source = withGrid(5, 5);
  source.deform = shiftNode(source.deform, 6, 0.05, -0.02);
  source.mirror = { ...MIRROR_DEFAULT, on: true, x: 0.4 };
  source.brush = { on: true, radius: 0.3, hardness: 0.7 };
  const next = pasteMesh(target, source, "transfer");
  expect(next.deform.cols).toBe(5);
  expect(next.deform.points[6]).toEqual(source.deform.points[6]);
  // Ось симметрии — часть сетки: переехала вместе с ней.
  expect(next.mirror?.x).toBe(0.4);
  // Нарезка, зона и кисть остались своими.
  expect(next.art).toEqual(target.art);
  expect(next.frame).toEqual(target.frame);
  expect(next.brush).toEqual(target.brush);
  // Исходная сетка не изменилась: вставка копирует точки.
  expect(source.deform.points[6]).toEqual(next.deform.points[6]);
});

test("«Пересчитать на текущую» оставляет густоту, а форму раскладывает", () => {
  const target = withGrid(3, 3);
  const source = withGrid(2, 2);
  source.deform = shiftNode(source.deform, 3, 0.1, 0);
  const next = pasteMesh(target, source, "resample");
  expect(next.deform.cols).toBe(3);
  expect(next.deform.points).toHaveLength(9);
  // Угол источника у правого нижнего узла сохранился: сетка гуще, форма та же.
  expect(next.deform.points[8]).toEqual({ x: 1.1, y: 1 });
  expect(next.art).toEqual(target.art);
});

test("«Сбросить» даёт регулярную сетку текущего размера", () => {
  const target = withGrid(4, 3);
  const next = pasteMesh(target, withGrid(2, 2), "reset");
  expect(next.deform.cols).toBe(4);
  expect(next.deform.rows).toBe(3);
  expect(next.deform.points[0]).toEqual({ x: 0, y: 0 });
  // 4 столбца: последний узел первого ряда — третий по счёту.
  expect(next.deform.points[3].x).toBe(1);
  // Ноль сравниваем с допуском: у регулярной сетки он бывает `-0`.
  expect(next.deform.points[3].y).toBeCloseTo(0, 10);
});
