import {test,expect} from "@playwright/test";
import {meshMatrix} from "../../src/render/mesh";
const identity={a:1,b:0,c:0,d:1,e:0,f:0};
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
