import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  alphaOf, gradientRadius, lightBounds, normalizeLight, normalizeNormal, paintLight, solidOf, traceLight, withAlpha,
} from "../../src/render/light";
import { makeLight, normalizePreset } from "../../src/engine/preset";
import { collect, multiplyAffine, normalSample, objectMatrix } from "../../src/render/rigCanvas";
import {
  createCollector, lightingAvailable, NORMAL_COVERAGE_DARK, NORMAL_COVERAGE_LIT, resetCollector, shadeLayer, viewportOf,
} from "../../src/render/lighting";
import { DEFAULT_BASE, DEFAULT_LIGHT, type RigObject, type RigPreset } from "../../src/types";
import { DEFAULT_BEHAVIOUR, behaviourBlock, readBehaviour, writeBehaviour } from "../../src/engine/behaviour";

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
    fill() { calls.push(`fill ${this.globalCompositeOperation}`); },
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
  // Обычное наложение ложится только на нарисованное: на прозрачном фоне OBS
  // не появляется цветной прямоугольник.
  expect(paint.calls).toContain("fill source-atop");

  const glow = recordingContext();
  paintLight(glow.context as unknown as CanvasRenderingContext2D, { ...lamp, light: { ...lamp.light!, blend: "add" } }, canvas, 1);
  expect(glow.calls).toContain("fill lighter");
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

test("объём: свет собирается в пикселях холста, карта нормалей — у своего объекта", () => {
  const collector = createCollector();
  // Камера: сдвиг и масштаб — так свет попадает в экранные пиксели.
  const camera = { a: 0.5, b: 0, c: 0, d: 0.5, e: 100, f: 40 };
  // В браузере это DOMMatrix холста; здесь — та же матрица без DOM.
  const view = { multiply: (matrix: { a: number; b: number; c: number; d: number; e: number; f: number }) => multiplyAffine(camera, matrix) };
  const lamp = makeLight("lamp", "Лампа", 400, 300, { radius: 200, angle: 90, shape: "sector" }, { width: 1000, height: 2000 });
  // Поворот объекта на 90° должен повернуть и пятно.
  const turned = { ...lamp, base: { ...lamp.base, rotation: 90 } };
  collect(collector, view, turned, frameValues(), objectMatrix(turned, frameValues()));
  expect(collector.lights).toHaveLength(1);
  const light = collector.lights[0];
  // Центр: (400, 300) → ×0.5 + (100, 40).
  expect(light.x).toBeCloseTo(300, 5);
  expect(light.y).toBeCloseTo(190, 5);
  // Радиус и поворот масштабируются вместе с камерой.
  expect(light.radius).toBeCloseTo(100, 5);
  expect(light.rotation).toBeCloseTo(Math.PI / 2, 5);
  expect(light.shape).toBe("sector");
  expect(light.angle).toBe(90);

  // Нормали: матрица ведёт локальные координаты картинки в тот же экран.
  const face = {
    id: "face", name: "Лицо", kind: "sprite" as const, enabled: true, image: "asset:face",
    parentId: null, pivot: { x: 0.5, y: 0.5 }, base: { ...DEFAULT_BASE, x: 400, y: 300 },
    script: "", width: 200, height: 100,
    normal: { src: "asset:normal", strength: 150, animate: false },
  };
  // Нормали в общий сбор не попадают: объект получает объём в своём слое.
  collect(collector, view, face, frameValues(), objectMatrix(face, frameValues()));
  expect(collector.lights).toHaveLength(1);
  const normal = normalSample(view, face, objectMatrix(face, frameValues()), -100, -50)!;
  expect(normal.matrix).toEqual([0.5, 0, 0, 0, 0.5, 0, 300, 190, 1]);
  expect(normal.rect).toEqual([-100, -50, 200, 100]);
  expect(normal.strength).toBe(150);

  // Свет без яркости и объект без карты в проход не попадают.
  const dim = { ...lamp, light: { ...lamp.light!, brightness: 0 } };
  collect(collector, view, dim, frameValues(), { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  expect(collector.lights).toHaveLength(1);
  const plain = { ...face, normal: { ...face.normal!, strength: 0 } };
  expect(normalSample(view, plain, objectMatrix(plain, frameValues()), -100, -50)).toBeNull();
  // Карта есть только у спрайта и медиа: свету и фигуре она не положена.
  expect(normalSample(view, turned, objectMatrix(turned, frameValues()), -200, -200)).toBeNull();

  // Сброс перед кадром: буфер не растёт от кадра к кадру.
  resetCollector(collector);
  expect(collector.lights).toHaveLength(0);
});

test("объём: без WebGL2 проход молчит, слой остаётся как есть", () => {
  expect(lightingAvailable()).toBe(false);
  const layer = { width: 40, height: 40 } as HTMLCanvasElement;
  const box = { x: 0, y: 0, width: 40, height: 40 };
  const sample = { matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], rect: [0, 0, 40, 40] as [number, number, number, number], src: "asset:normal", strength: 100 };
  // Нет света — считать нечего.
  expect(shadeLayer(layer, sample, [], box)).toBe(false);
  // Свет есть, но WebGL2 в тестах нет — тихий отказ, картинка не пропадает.
  const light = {
    x: 20, y: 20, radius: 40, rotation: 0, shape: "circle" as const, angle: 360,
    softness: 50, colorStart: "rgba(255, 255, 255, 1)", colorEnd: "rgba(0, 0, 0, 0)",
    brightness: 100, blend: "normal" as const,
  };
  expect(shadeLayer(layer, sample, [light], box)).toBe(false);
});

function frameValues() {
  return {
    x: 0, y: 0, rotation: 0, sizeX: 1, sizeY: 1, skewX: 0, skewY: 0,
    opacity: 1, visible: 1, layer: 0,
  };
}

test("мерцание: волна пишется в opacity и читается обратно", () => {
  const lamp = makeLight("lamp", "Лампа", 400, 300, { radius: 120 });
  // Без глубины мерцания формулы нет: ровный свет не тратит кадр на волну.
  expect(behaviourBlock(DEFAULT_BEHAVIOUR, lamp)).not.toContain("opacity =");

  const sine = { ...DEFAULT_BEHAVIOUR, flickerAmplitude: 0.4, flickerSpeed: 2 };
  const sineBlock = behaviourBlock(sine, lamp);
  expect(sineBlock).toContain("opacity = 1 - 0.4 * (0.5 - 0.5 * sin(time *");
  // Период — 1 / скорость: 2 Гц даёт 12.566 радиан в секунду.
  expect(sineBlock).toContain("12.566");

  // Шум даёт неровное мерцание и у каждого объекта свой seed.
  const noise = { ...sine, flickerStyle: "noise" as const };
  expect(behaviourBlock(noise, lamp)).toContain("noise(");
  expect(behaviourBlock(noise, lamp)).not.toContain("sin(time");

  // Настройки переживают запись и чтение блока.
  const written = writeBehaviour(lamp.script, noise, lamp).script;
  const back = readBehaviour(written);
  expect(back.flickerStyle).toBe("noise");
  expect(back.flickerAmplitude).toBeCloseTo(0.4, 5);
  expect(back.flickerSpeed).toBe(2);
  // Битые значения зажимаются, а не превращаются в текст скрипта.
  expect(readBehaviour(`// @behaviour {"flickerAmplitude":5,"flickerSpeed":0}`)).toMatchObject({
    flickerAmplitude: 1, flickerSpeed: 0.05,
  });
});

test("следование за мышью: доворот в градусах ограничен пределами сустава", () => {
  const head = makeLight("head", "Голова", 400, 300, { radius: 120 });
  const base = { ...DEFAULT_BEHAVIOUR, followMouseModule: "mouse", followMouseRotSmooth: 0 };

  // Ноль по обеим осям — доворота нет: поворот не пишется вовсе.
  expect(behaviourBlock(base, head)).not.toContain("rotation =");

  // Край области справа даёт +30°, снизу — −10°: X поворачивает, Y наклоняет.
  const turned = { ...base, followMouseRotX: 30, followMouseRotY: -10, followMouseStrength: 0 };
  const block = behaviourBlock(turned, head);
  expect(block).toContain("* 30");
  expect(block).toContain("* -10");
  expect(block).toContain("mouse.x");
  expect(block).toContain("mouse.y");
  // Позиция выключена силой 0 — формулы для x и y не появляются.
  expect(block).not.toMatch(/^x = /m);
  expect(block).not.toMatch(/^y = /m);

  // Пределы сустава ограничивают доворот: limit стоит на отклонении от покоя.
  const limited = { ...turned, rotationalLimitLeft: 20, rotationalLimitRight: 40 };
  expect(behaviourBlock(limited, head)).toContain(
    "rotation = 0 + limit(0 + ((mouse.x - 0.5) * 2) * 30 + ((mouse.y - 0.5) * 2) * -10 - (0), -20, 40)",
  );
  const withSmooth = { ...limited, followMouseRotSmooth: 150 };
  const smoothBlock = behaviourBlock(withSmooth, head);
  expect(smoothBlock).toContain("smooth(");
  expect(smoothBlock).toContain("150");
  expect(smoothBlock).toContain("limit(");
  expect(smoothBlock).toContain("-20");
  expect(smoothBlock).toContain("40");

  // Мёртвая зона и инверсия действуют и на доворот: это тот же ход курсора.
  expect(behaviourBlock({ ...base, followMouseRotX: 30, followMouseDead: 0.5 }, head)).toContain("max(abs(");
  expect(behaviourBlock({ ...base, followMouseRotX: 30, followMouseInvert: true }, head)).toContain("(-((");
  // Одна ось — по второй доворота нет (позиция при этом выключена силой 0).
  const onlyX = behaviourBlock({ ...base, followMouseStrength: 0, followMouseRotX: 30 }, head);
  expect(onlyX).toContain("rotation = 0 + ((mouse.x - 0.5) * 2) * 30");
  expect(onlyX).not.toContain("mouse.y");

  // Настройки переживают запись и чтение блока.
  const written = writeBehaviour(head.script, withSmooth, head).script;
  const back = readBehaviour(written);
  expect(back.followMouseRotX).toBe(30);
  expect(back.followMouseRotY).toBe(-10);
  expect(back.followMouseRotSmooth).toBe(150);
  // Битые значения зажимаются в границы, а не превращаются в текст скрипта.
  expect(readBehaviour(`// @behaviour {"followMouseRotX":900,"followMouseRotY":-900}`)).toMatchObject({
    followMouseRotX: 180, followMouseRotY: -180,
  });
});

/*
 * Ориентация буфера нормалей.
 *
 * Две текстуры прохода приходят из разных мест, и хранят строки по-разному:
 * холст льётся в `uScene` без переворота (первая строка данных — верх картинки),
 * а карта нормалей рисуется в кадровый буфер, где строка 0 — это низ вьюпорта.
 * Проход объёма читает обе одним и тем же `vUv` (aPos.y = 0 — верх экрана),
 * поэтому карта обязана лежать в буфере сверху вниз, как холст.
 *
 * Симптом перевёрнутой карты: объём держится не за объект, а зеркалится
 * относительно середины холста и уезжает вместе с камерой. Проверяем формулы,
 * потому что браузерного WebGL в тестах нет.
 */
test("объём: карта нормалей пишется в буфер сверху вниз, как холст", () => {
  const source = readFileSync(join(process.cwd(), "src", "render", "lighting.ts"), "utf8");
  // Вершинный шейдер нормалей: верх объекта идёт в первую строку буфера.
  expect(source).toContain("inside.y / uSize.y * 2.0 - 1.0");
  expect(source).not.toContain("1.0 - device.y");
  // Проход объёма: vUv.y = 0 — верх экрана, и обе текстуры читаются этим vUv.
  expect(source).toContain("1.0 - aPos.y * 2.0");
  expect(source).toContain("texture(uScene, vUv)");
  expect(source).toContain("texture(uNormals, vUv)");
  // Холст льётся без переворота — иначе поехала бы вся сцена, а не карта.
  expect(source).toContain("gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);\n  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);");
});

/*
 * Объём и слои.
 *
 * Объём принадлежит объекту: он считается в слое этого объекта сразу после его
 * отрисовки, поэтому всё нарисованное выше перекрывает его как обычно. Раньше
 * буфер нормалей был общим на весь холст и закрашивал пиксели, уже занятые
 * верхними объектами, — объём нижнего просвечивал сквозь них.
 *
 * Проверяем порядок вызовов и способ композита: браузерного WebGL в тестах нет,
 * а именно эта последовательность и создаёт слоистость.
 */
test("объём: считается по объекту, а не по готовой сцене", () => {
  const rig = readFileSync(join(process.cwd(), "src", "render", "rigCanvas.ts"), "utf8");
  const loop = rig.slice(rig.indexOf("for (const { object, values, ghost, opacity, drawn, matrix } of objects)"));
  expect(loop.length).toBeGreaterThan(0);
  // Сэмпл нормалей и объём — внутри цикла отрисовки, до следующего объекта.
  expect(loop.indexOf("normalSample(view, object")).toBeGreaterThan(0);
  expect(loop.indexOf("drawShaded(")).toBeGreaterThan(loop.indexOf("normalSample(view, object"));
  // Слой объекта уходит в объём целиком, вместе с рамкой работы.
  expect(rig).toContain("shadeLayer(canvas, sample, options.lighting?.lights ?? [], box);");
  // Объект попадает на сцену один раз: слоем, обычным наложением.
  expect(rig).toContain('ctx.globalCompositeOperation = "source-over";');
  // Общего прохода по готовому холсту больше нет ни в редакторе, ни в оверлее.
  for (const file of ["src/components/Scene.tsx", "src/overlay/OverlayApp.tsx"]) {
    expect(readFileSync(join(process.cwd(), file), "utf8")).not.toContain("applyVolume");
  }
  // В слое объём заменяет рамку целиком («copy» внутри отсечения), иначе
  // полупрозрачные края сложились бы дважды.
  const lighting = readFileSync(join(process.cwd(), "src", "render", "lighting.ts"), "utf8");
  expect(lighting).toContain('context.globalCompositeOperation = "copy";');
  expect(lighting).toContain("context.rect(box.x, box.y, width, height);");
  expect(lighting).toContain("context.clip();");
});

/*
 * Чёрная зона карты нормалей.
 *
 * В карте нормалей цвет — это направление поверхности, и «чёрный» там ничего не
 * значит: у единичной нормали максимум компоненты не меньше 1/√3, а после
 * кодирования (n + 1) / 2 самая тёмная допустимая нормаль ярче 0.79. Поэтому
 * тёмный и прозрачный тексель трактуется как «здесь пусто»: зона не даёт
 * объёма и не перекрывает чужие карты.
 */
test("объём: чёрное и прозрачное в карте — «здесь пусто», а не нормаль", () => {
  // Порог обязан быть заметно ниже самой тёмной валидной нормали.
  const darkest = (1 / Math.sqrt(3) + 1) / 2;
  expect(darkest).toBeGreaterThan(0.78);
  expect(NORMAL_COVERAGE_LIT).toBeLessThan(darkest);
  expect(NORMAL_COVERAGE_DARK).toBeLessThan(NORMAL_COVERAGE_LIT);

  const source = readFileSync(join(process.cwd(), "src", "render", "lighting.ts"), "utf8");
  // Пороги подставляются в шейдер из тех же чисел: второго источника нет.
  expect(source).toContain("smoothstep(${NORMAL_COVERAGE_DARK.toFixed(2)}, ${NORMAL_COVERAGE_LIT.toFixed(2)}, level)");
  // Прозрачные пиксели карты — тоже пусто; карта без альфы даёт 1.
  expect(source).toContain("smoothstep(0.02, 0.5, map.a)");
  // Покрытие уходит в синий канал: его читает проход объёма.
  expect(source).toContain("vec4(xy * 0.5 + 0.5, len * cover, 1.0)");
});

/*
 * Куда проход объёма пишет в кадровом буфере.
 *
 * У холста Y растёт вниз, у кадрового буфера — вверх. Вьюпорт с `y = 0` кладёт
 * рамку объекта в низ буфера, а `drawImage` читает сверху: объект подменялся
 * прозрачностью и пропадал при любой силе объёма больше нуля. Здесь закреплено
 * соответствие «строки холста ↔ строки буфера», чтобы это не вернулось.
 */
test("объём: вьюпорт рамки совпадает с рамкой холста, а не с началом координат", () => {
  // Рамка 300×200 в точке (100, 120) на холсте высотой 800.
  expect(viewportOf({ x: 100, y: 120, width: 300, height: 200 }, 800)).toEqual({ x: 100, y: 480, width: 300, height: 200 });
  // Рамка у нижнего края: буфер считает строки от низа, значит y = 0.
  expect(viewportOf({ x: 0, y: 600, width: 50, height: 200 }, 800).y).toBe(0);
  // Рамка у верхнего края садится в последние строки буфера.
  expect(viewportOf({ x: 0, y: 0, width: 50, height: 200 }, 800).y).toBe(600);
  // Рамка выше холста прижимается к нулю, а не уезжает в отрицательные строки.
  expect(viewportOf({ x: 0, y: 10, width: 50, height: 2000 }, 800).y).toBe(0);
  // Сумма «строка буфера + смещение» всегда равна высоте холста.
  for (const box of [{ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 130, width: 10, height: 40 }]) {
    const view = viewportOf(box, 512);
    expect(view.y + box.y + box.height).toBe(512);
  }

  const source = readFileSync(join(process.cwd(), "src", "render", "lighting.ts"), "utf8");
  // Проход объёма рисует по рамке: строки буфера считаются снизу.
  expect(source.match(/gl\.viewport\(viewport\.x, viewport\.y, viewport\.width, viewport\.height\)/g)).toHaveLength(1);
  // Текстура нормалей читается по рамке (vUv от 0 до 1), поэтому её проход
  // занимает весь буфер — иначе карта берётся из чужих строк.
  expect(source).toContain("gl.viewport(0, 0, layer.width, layer.height)");
  // Обратное чтение — копия рамки один к одному: два разворота гасят друг
  // друга. Чтение по viewport.y уводило объект в сторону, обратную камере.
  expect(source).toContain("context.drawImage(gl.canvas, box.x, box.y, width, height, box.x, box.y, width, height);");
  expect(source).not.toContain("context.drawImage(gl.canvas, viewport.x");
});

/*
 * Стык «куда нарисовали — откуда прочитали».
 *
 * Здесь ошибиться легко, и оба раза это ломалось по-разному: объект пропадал
 * (читали пустую область) или уезжал по вертикали в сторону, обратную камере
 * (читали зеркальную строку). Поэтому у каждого прохода своя привязка, и обе
 * проверяются отдельно:
 *
 * - нормали: рамка объекта растянута на весь буфер, потому что проход объёма
 *   читает карту координатой vUv по рамке;
 * - объём: вьюпорт стоит там, где рамка лежит в буфере (снизу вверх);
 * - обратно: копия рамки один к одному, без смещения по строкам.
 *
 * Смещение, посчитанное не в ту сторону, всегда равно «высота холста − y −
 * высота рамки»: при чтении по этой строке объект сдвигается ровно настолько,
 * насколько он далёк от середины, то есть тем сильнее, чем дальше камера.
 */
test("объём: привязка проходов — своя у каждого, обратное чтение без смещения", () => {
  const source = readFileSync(join(process.cwd(), "src", "render", "lighting.ts"), "utf8");
  const body = source.slice(source.indexOf("export function shadeLayer"));
  const normalPass = body.slice(body.indexOf("state.normalFramebuffer"), body.indexOf("2. Слой объекта"));
  const volumePass = body.slice(body.indexOf("2. Слой объекта"), body.indexOf("3. Обратно в слой"));

  // Нормали: весь буфер, размеры рамки уходят в шейдер.
  expect(normalPass).toContain("gl.viewport(0, 0, layer.width, layer.height)");
  expect(normalPass).toContain('"uSize"');
  expect(normalPass).not.toContain("viewport.y");

  // Объём: вьюпорт по рамке, координаты пикселей холста считаются от её угла.
  expect(volumePass).toContain("gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height)");
  expect(volumePass).toContain('"uOrigin"');
  expect(volumePass).toContain('"uSize"');

  // Обратно: рамка копируется один к одному — иначе объект уезжает.
  expect(body).toContain("context.drawImage(gl.canvas, box.x, box.y, width, height, box.x, box.y, width, height);");
});

/*
 * Круг «карта → объём → обратно» в строках холста.
 *
 * Это не греп по коду, а арифметика: где окажется строка r объекта после того,
 * как её проведут через буфер нормалей, вьюпорт объёма и обратное чтение. На
 * этом круге я ошибался дважды — сначала объект пропадал, потом уезжал в
 * сторону, обратную камере. Правильный ответ один: строка возвращается на своё
 * место (в пределах пикселя).
 */
function roundTrip(boxY: number, height: number, canvasHeight: number): number[] {
  const view = viewportOf({ x: 0, y: boxY, width: 1, height }, canvasHeight);
  const rows: number[] = [];
  for (let r = 0; r < height; r += 1) {
    // Нормали: строка r внутри рамки растягивается на всю текстуру, v = r / h.
    const v = r / height;
    // Объём: фрагмент с vUv.y = aPos.y попадает в NDC 1 − 2·vUv вьюпорта.
    const fromBottom = view.y + ((1 - 2 * v + 1) / 2) * height;
    rows.push(canvasHeight - fromBottom - 1);
  }
  return rows;
}

test("объём: строка объекта возвращается на своё место после прохода", () => {
  // Три положения: у верхнего края, по центру, у нижнего.
  for (const boxY of [40, 300, 620]) {
    const rows = roundTrip(boxY, 160, 800);
    rows.forEach((row, r) => expect(Math.abs(row - (boxY + r))).toBeLessThanOrEqual(1));
  }

  // А так выглядело чтение по строке буфера (`viewport.y` вместо `box.y`):
  // рамка подменялась её отражением, и смещение равно «высота − 2·y − высота
  // рамки». В центре оно нулевое — потому баг и не виден сразу, — а у края
  // растёт, и объект уезжает тем сильнее, чем дальше камера.
  const shift = (boxY: number, height: number, canvasHeight: number) =>
    viewportOf({ x: 0, y: boxY, width: 1, height }, canvasHeight).y - boxY;
  expect(shift(320, 160, 800)).toBe(0);
  expect(Math.abs(shift(40, 160, 800))).toBeGreaterThan(Math.abs(shift(320, 160, 800)));
  expect(Math.abs(shift(620, 160, 800))).toBeGreaterThan(Math.abs(shift(320, 160, 800)));
});
