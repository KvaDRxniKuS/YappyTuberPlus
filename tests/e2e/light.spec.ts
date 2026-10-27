import { test, expect } from "@playwright/test";
import {
  alphaOf, gradientRadius, lightBounds, normalizeLight, normalizeNormal, paintLight, solidOf, traceLight, withAlpha,
} from "../../src/render/light";
import { makeLight, normalizePreset } from "../../src/engine/preset";
import { DEFAULT_LIGHT, type RigObject, type RigPreset } from "../../src/types";

/*
 * Свет и карты нормалей проверяются без браузера: путь пятна и градиент
 * записываются тем же способом, что и в тестах рендера.
 */

function recordingContext() {
  const calls: string[] = [];
  const stops: string[] = [];
  const context = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "",
    save() { calls.push("save"); },
    restore() { calls.push("restore"); },
    beginPath() { calls.push("begin"); },
    closePath() {},
    moveTo(x: number, y: number) { calls.push(`move ${round(x)},${round(y)}`); },
    lineTo(x: number, y: number) { calls.push(`line ${round(x)},${round(y)}`); },
    rect(x: number, y: number, width: number, height: number) {
      calls.push(`rect ${round(x)},${round(y)} ${round(width)}x${round(height)}`);
    },
    arc(_x: number, _y: number, radius: number, start: number) {
      calls.push(`arc r${round(radius)} a${round((start * 180) / Math.PI)}`);
    },
    fill() { calls.push("fill"); },
    createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) {
      calls.push(`gradient ${round(x0)},${round(y0)},${round(r0)} → ${round(x1)},${round(y1)},${round(r1)}`);
      return { addColorStop: (offset: number, color: string) => stops.push(`${round(offset)} ${color}`) };
    },
  };
  return { context, calls, stops };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function lightObject(spec: Partial<typeof DEFAULT_LIGHT> = {}): RigObject {
  return makeLight("lamp", "Лампа", 400, 300, spec, { width: 1000, height: 2000 });
}

test("свет: настройки приводятся к рабочим значениям", () => {
  const base = normalizeLight(null);
  expect(base.shape).toBe("circle");
  expect(base.blend).toBe("normal");
  expect(base.radius).toBe(DEFAULT_LIGHT.radius);

  // Битые числа и мусорные цвета не должны ломать рендер.
  const broken = normalizeLight({ shape: "star" as never, radius: -5, brightness: 5000, softness: -3, colorStart: "красный" });
  expect(broken.shape).toBe("circle");
  expect(broken.radius).toBe(1);
  expect(broken.brightness).toBe(200);
  expect(broken.softness).toBe(0);
  expect(broken.colorStart).toBe(DEFAULT_LIGHT.colorStart);

  // Все формы из списка принимаются: форма — это то, что видит пользователь.
  for (const shape of ["circle", "sector", "rect", "triangle", "screen"] as const) {
    expect(normalizeLight({ shape }).shape).toBe(shape);
  }
});

test("свет: цвет и прозрачность переводятся друг в друга", () => {
  expect(withAlpha("#ff0000", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
  expect(withAlpha("rgba(10, 20, 30, 0.9)", 0.25)).toBe("rgba(10, 20, 30, 0.25)");
  expect(withAlpha("rgb(10, 20, 30)", 2)).toBe("rgba(10, 20, 30, 1)");
  expect(alphaOf("rgba(10, 20, 30, 0.4)")).toBeCloseTo(0.4, 5);
  expect(alphaOf("#ff000080")).toBeCloseTo(0.502, 2);
  expect(alphaOf("rgb(10, 20, 30)")).toBe(1);
  expect(solidOf("rgba(255, 226, 170, 0.55)")).toBe("#ffe2aa");
});

test("свет: форма пятна и путь", () => {
  const canvas = { width: 1000, height: 2000 };
  const circle = recordingContext();
  traceLight(circle.context as unknown as CanvasRenderingContext2D, normalizeLight({ radius: 100 }), canvas);
  expect(circle.calls).toEqual(["arc r100 a0"]);

  // Сектор — «кусок пирога»: начинается в центре и замыкается.
  const sector = recordingContext();
  traceLight(sector.context as unknown as CanvasRenderingContext2D, normalizeLight({ shape: "sector", angle: 90 }), canvas);
  expect(sector.calls[0]).toBe("move 0,0");
  // Угол отсчитывается от «вверх»: половина сектора уходит влево от вертикали.
  expect(sector.calls[1]).toContain("a-135");

  // Прямоугольник и треугольник рисуются по радиусу, «весь экран» — по холсту.
  const rect = recordingContext();
  traceLight(rect.context as unknown as CanvasRenderingContext2D, normalizeLight({ shape: "rect", radius: 50 }), canvas);
  expect(rect.calls).toEqual(["rect -50,-50 100x100"]);

  const screen = recordingContext();
  traceLight(screen.context as unknown as CanvasRenderingContext2D, normalizeLight({ shape: "screen" }), canvas);
  expect(screen.calls).toEqual(["rect -1000,-2000 2000x4000"]);

  const triangle = recordingContext();
  traceLight(triangle.context as unknown as CanvasRenderingContext2D, normalizeLight({ shape: "triangle", radius: 100 }), canvas);
  expect(triangle.calls).toHaveLength(3);

  // Радиус градиента: у круга — радиус, у прямоугольника — до дальнего угла.
  expect(gradientRadius(normalizeLight({ radius: 100 }), canvas)).toBe(100);
  expect(gradientRadius(normalizeLight({ shape: "rect", radius: 100 }), canvas)).toBeCloseTo(141.42, 1);
});

test("свет: пятно рисуется градиентом и уважает яркость и прозрачность", () => {
  const canvas = { width: 1000, height: 2000 };
  const lamp = lightObject({ colorStart: "rgba(255, 200, 100, 0.8)", colorEnd: "rgba(255, 200, 100, 0)", radius: 200 });
  const paint = recordingContext();
  paintLight(paint.context as unknown as CanvasRenderingContext2D, lamp, canvas, 1);

  expect(paint.calls).toContain("gradient 0,0,0 → 0,0,200");
  // Первый цвет — у центра, дальше ядро и край: обычно цвет уходит в прозрачность.
  expect(paint.stops[0]).toBe("0 rgba(255, 200, 100, 0.8)");
  expect(paint.stops[paint.stops.length - 1]).toBe("1 rgba(255, 200, 100, 0)");

  // Яркость 50 % делит альфу, прозрачность кадра тоже.
  const dim = recordingContext();
  paintLight(dim.context as unknown as CanvasRenderingContext2D, { ...lamp, light: { ...lamp.light!, brightness: 50 } }, canvas, 1);
  expect(dim.stops[0]).toBe("0 rgba(255, 200, 100, 0.4)");

  const hidden = recordingContext();
  paintLight(hidden.context as unknown as CanvasRenderingContext2D, lamp, canvas, 0);
  expect(hidden.calls).toEqual([]);

  // Аддитивное наложение — единственное место, где меняется композит.
  const glow = recordingContext();
  paintLight(glow.context as unknown as CanvasRenderingContext2D, { ...lamp, light: { ...lamp.light!, blend: "add" } }, canvas, 1);
  expect(glow.calls).toContain("fill");
});

test("свет: рамка объекта равна диаметру пятна", () => {
  const lamp = lightObject({ radius: 150 });
  expect(lamp.kind).toBe("light");
  expect(lamp.width).toBe(300);
  expect(lamp.height).toBe(300);
  expect(lightBounds(normalizeLight({ shape: "screen" }), { width: 1000, height: 2000 }))
    .toEqual({ width: 1000, height: 2000 });
});

test("свет и нормали: пресет хранит их только у своих видов", () => {
  const preset = {
    version: 2,
    name: "Сцена",
    canvas: { width: 1000, height: 600 },
    objects: [
      { id: "lamp", name: "Свет", kind: "light", light: { shape: "sector", angle: 60, radius: 300 } },
      // Нормали у света не имеют смысла: карту нормалей получает то, что рисует картинку.
      { id: "lamp2", name: "Свет 2", kind: "light", normal: { src: "asset:n", strength: 50, animate: false } },
      { id: "face", name: "Лицо", kind: "sprite", image: null, normal: { src: "asset:n", strength: 150, animate: false } },
      { id: "video", name: "Вода", kind: "media", media: { type: "video", src: "asset:v" }, normal: { src: "asset:vn" } },
      // У фигуры и текста нормалей нет: свет их не объёмит.
      { id: "shape", name: "Плашка", kind: "shape", normal: { src: "asset:n" } },
    ],
    modules: [],
  } as unknown as RigPreset;

  const normalized = normalizePreset(preset)!;
  const byId = (id: string) => normalized.objects.find((object) => object.id === id)!;

  expect(byId("lamp").light?.shape).toBe("sector");
  expect(byId("lamp").light?.radius).toBe(300);
  expect(byId("lamp").light?.blend).toBe("normal");
  expect(byId("lamp").normal).toBeUndefined();
  expect(byId("lamp2").normal).toBeUndefined();
  expect(byId("face").normal).toEqual({ src: "asset:n", strength: 150, animate: false });
  // Видео-карта по умолчанию играет: объём живой.
  expect(byId("video").normal).toEqual({ src: "asset:vn", strength: 100, animate: true });
  expect(byId("shape").normal).toBeUndefined();

  // Карта без файла — не карта: пустая ссылка не должна попадать в пресет.
  expect(normalizeNormal({ src: "", strength: 100 })).toBeUndefined();
  expect(normalizeNormal({ strength: 100 })).toBeUndefined();
  expect(normalizeNormal({ src: "asset:x", strength: 900 })!.strength).toBe(200);
});
