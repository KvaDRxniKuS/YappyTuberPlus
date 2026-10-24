import { test, expect } from "@playwright/test";
import { formatCanvasSize, parseCanvasSize, sameCanvasSize } from "../../src/engine/canvasSize";

test("размер холста: подпись принимает разные разделители", () => {
  expect(parseCanvasSize("1280 × 720")).toEqual({ width: 1280, height: 720 });
  expect(parseCanvasSize("1280x720")).toEqual({ width: 1280, height: 720 });
  expect(parseCanvasSize("1280 720")).toEqual({ width: 1280, height: 720 });
  expect(parseCanvasSize("  1920 , 1080 ")).toEqual({ width: 1920, height: 1080 });
  // Дробные значения округляем, лишние числа игнорируем.
  expect(parseCanvasSize("1280.6 × 720.4")).toEqual({ width: 1281, height: 720 });
  expect(parseCanvasSize("300 200 99")).toEqual({ width: 300, height: 200 });
});

test("размер холста: мусор и выход за диапазон отклоняются", () => {
  expect(parseCanvasSize("")).toBeNull();
  expect(parseCanvasSize("1280")).toBeNull();
  expect(parseCanvasSize("ширина высота")).toBeNull();
  expect(parseCanvasSize("0 × 720")).toBeNull();
  expect(parseCanvasSize("15 × 720")).toBeNull();
  expect(parseCanvasSize("20000 × 720")).toBeNull();
});

test("размер холста: подпись и сравнение", () => {
  expect(formatCanvasSize({ width: 1280, height: 720 })).toBe("1280 × 720");
  expect(sameCanvasSize({ width: 1280, height: 720 }, { width: 1280, height: 720 })).toBe(true);
  expect(sameCanvasSize({ width: 1280, height: 720 }, { width: 720, height: 1280 })).toBe(false);
});
