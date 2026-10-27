import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

/*
 * Пример «кубик с нормалями» — это не картинка «на глаз», а сверка с
 * математикой: нормаль каждой видимой грани посчитана поворотом куба. Тест
 * читает PNG и проверяет, что в файлах лежит именно то, что должно, — иначе
 * пример молча разойдётся с рендером и станет учить неправильному.
 *
 * Заодно здесь закреплена конвенция карты: **OpenGL, зелёный вверх**. Верхняя
 * грань куба смотрит вверх, значит её зелёный канал заметно выше 0.5. Если
 * кто-то однажды «починит» канал, пример это покажет.
 */

const DIRECTORY = join(process.cwd(), "examples", "normal-cube");

interface Rgba {
  width: number;
  height: number;
  data: Buffer;
}

/** Минимальный декодер PNG: 8 бит на канал, без интерлейса — как пишет генератор. */
function decode(file: string): Rgba {
  const buffer = readFileSync(join(DIRECTORY, file));
  let offset = 8;
  let width = 0;
  let height = 0;
  const parts: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect(body[8]).toBe(8);
      expect(body[9]).toBe(6);
    } else if (type === "IDAT") {
      parts.push(body);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const data = Buffer.alloc(width * height * 4);
  const stride = width * 4;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    // Генератор пишет только фильтр 0: читать остальные фильтры незачем.
    expect(filter).toBe(0);
    raw.copy(data, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { width, height, data };
}

const at = (image: Rgba, x: number, y: number) => {
  const index = (y * image.width + x) * 4;
  return [0, 1, 2, 3].map((c) => image.data[index + c] / 255);
};

test("пример: картинка и карта нормалей на месте и одного размера", () => {
  const color = decode("cube.png");
  const normal = decode("cube-normal.png");
  expect(color.width).toBe(512);
  expect(color.height).toBe(512);
  expect(normal.width).toBe(color.width);
  expect(normal.height).toBe(color.height);
  // Вне куба — прозрачно: объём не должен цепляться за пустое место.
  for (const [x, y] of [[4, 4], [507, 4], [4, 507], [507, 507]]) {
    expect(at(color, x, y)[3]).toBe(0);
    expect(at(normal, x, y)[3]).toBe(0);
  }
});

test("пример: нормали граней — единичные векторы в конвенции OpenGL", () => {
  const normal = decode("cube-normal.png");
  // По одной точке внутри каждой видимой грани.
  const faces: Array<{ point: [number, number]; expect: [number, number, number] }> = [
    { point: [256, 150], expect: [0.5, 0.908, 0.788] }, // верх: смотрит вверх
    { point: [150, 340], expect: [0.147, 0.296, 0.788] }, // левая: смотрит влево
    { point: [370, 340], expect: [0.854, 0.296, 0.788] }, // правая: смотрит вправо
  ];
  for (const face of faces) {
    const [r, g, b, a] = at(normal, ...face.point);
    expect(a).toBe(1);
    expect(r).toBeCloseTo(face.expect[0], 2);
    expect(g).toBeCloseTo(face.expect[1], 2);
    expect(b).toBeCloseTo(face.expect[2], 2);
    // Единичный вектор: сумма квадратов ≈ 1.
    const length = Math.hypot(r * 2 - 1, g * 2 - 1, b * 2 - 1);
    expect(length).toBeCloseTo(1, 2);
  }
  // Зелёный вверх: у верхней грани он выше, чем у боковых.
  expect(at(normal, 256, 150)[1]).toBeGreaterThan(at(normal, 150, 340)[1]);
  expect(at(normal, 256, 150)[1]).toBeGreaterThan(at(normal, 370, 340)[1]);
});

test("пример: лист-дебаг показывает свет сверху и перевёрнутый зелёный", () => {
  const sheet = decode("cube-debug.png");
  expect(sheet.width).toBeGreaterThan(512);
  expect(sheet.height).toBe(sheet.width);
  // Верхняя грань при свете сверху светлее боковых, при перевёрнутом зелёном —
  // темнее: именно эту разницу и надо увидеть глазами.
  const top = (panel: number) => {
    const x = Math.round(24 + (panel % 2) * (512 + 24) + 256);
    const y = Math.round(24 + Math.floor(panel / 2) * (512 + 24) + 150);
    return at(sheet, x, y);
  };
  const sideOf = (panel: number) => {
    const x = Math.round(24 + (panel % 2) * (512 + 24) + 150);
    const y = Math.round(24 + Math.floor(panel / 2) * (512 + 24) + 340);
    return at(sheet, x, y);
  };
  expect(top(1)[0]).toBeGreaterThan(sideOf(1)[0]);
  expect(top(3)[0]).toBeLessThan(sideOf(3)[0]);
  // Перед правкой исходника подпись панели тоже видна: цвет картинки.
  expect(top(0)[0]).toBeCloseTo(sideOf(0)[0], 2);
});
