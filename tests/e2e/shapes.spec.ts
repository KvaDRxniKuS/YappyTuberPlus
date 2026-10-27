import { expect, test } from "@playwright/test";
import { createDemoPreset } from "../../src/data/demoPreset";
import { makeShape, normalizePreset } from "../../src/engine/preset";
import { writeMaskBlock } from "../../src/engine/maskScript";
import {
  defaultMask, defaultShape, formatPoints, insertIndexFor, makeItem, nearestPoint, normalizeMask,
  normalizeShape, parsePoints, penAction, readSmoothing, smoothingOf, tracePath, uniqueItemId,
} from "../../src/render/shape";
import { orderedObjects } from "../../src/render/rigCanvas";
import type { RigPreset } from "../../src/types";

/** Пресет с фигурой и спрайтом, у которого маска из этой фигуры. */
function presetWithShape() {
  const preset = createDemoPreset();
  const shape = makeShape("mask_shape", "Маска", 320, 220, 500, 300);
  const sprite = preset.objects.find((object) => object.id === "head")!;
  const mask = { ...defaultMask(), kind: "shape" as const, shapeId: shape.id };
  const objects = [
    ...preset.objects.map((object) => (object.id === sprite.id
      // Маска живёт в скрипте объекта: поле в пресете — её отражение.
      ? { ...object, mask, script: writeMaskBlock(object.script, mask) }
      : object)),
    shape,
  ];
  return { ...preset, objects };
}

test("точки маски читаются из строки и возвращаются в неё", () => {
  expect(parsePoints("10,20; 30,40")).toEqual([{ x: 10, y: 20 }, { x: 30, y: 40 }]);
  // Перевод строки и пробелы между координатами — тоже разделители.
  expect(parsePoints("10 20\n30 40")).toEqual([{ x: 10, y: 20 }, { x: 30, y: 40 }]);
  // Неполные пары и мусор отбрасываются, а не превращаются в нули.
  expect(parsePoints("1,2; 3; мусор; 4,5")).toEqual([{ x: 1, y: 2 }, { x: 4, y: 5 }]);
  expect(formatPoints([{ x: 1, y: 2 }, { x: 3, y: 4 }])).toBe("1, 2; 3, 4");
});

test("фигура без данных получает прямоугольник по рамке объекта", () => {
  const shape = normalizeShape(undefined, 320, 220);
  expect(shape.items).toHaveLength(1);
  expect(shape.items[0].kind).toBe("rect");
  expect(shape.items[0].width).toBe(320);
  expect(shape.items[0].height).toBe(220);
  expect(shape.draw).toBe(true);

  // Отрицательная обводка — это ноль, а не «рисуем в минус».
  expect(normalizeShape({ strokeWidth: -4 }).strokeWidth).toBe(0);
  // Контуры сохраняются, неизвестный вид становится прямоугольником.
  const custom = normalizeShape({
    items: [{ kind: "blob", width: 10, height: 20 }, { kind: "path", points: "1,2; 3,4", smooth: true }],
  });
  expect(custom.items.map((item) => item.kind)).toEqual(["rect", "path"]);
  expect(custom.items[1].points).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  // Старое поле `smooth: true` разворачивается в полное сглаживание точек.
  expect(custom.items[1].smoothPoints).toEqual([100, 100]);
});

test("маска без источника не создаётся, с источником читается", () => {
  expect(normalizeMask(undefined)).toBeUndefined();
  expect(normalizeMask({ kind: "unknown" })).toBeUndefined();
  const mask = normalizeMask({ kind: "points", points: "0,0; 10,0; 10,10", invert: true, feather: -3 });
  expect(mask?.kind).toBe("points");
  expect(mask?.points).toHaveLength(3);
  expect(mask?.invert).toBe(true);
  // Мягкий край не бывает отрицательным.
  expect(mask?.feather).toBe(0);
});

test("пресет сохраняет фигуру и маску, а не превращает их в спрайты", () => {
  const preset = presetWithShape();
  const loaded = normalizePreset(JSON.parse(JSON.stringify(preset))) as RigPreset;
  const shape = loaded.objects.find((object) => object.id === "mask_shape")!;
  expect(shape.kind).toBe("shape");
  expect(shape.shape?.items[0].kind).toBe("rect");
  // Рамка фигуры — её размер: по нему считается пивот и попадание мышью.
  expect([shape.width, shape.height]).toEqual([320, 220]);
  const head = loaded.objects.find((object) => object.id === "head")!;
  expect(head.mask?.kind).toBe("shape");
  expect(head.mask?.shapeId).toBe("mask_shape");
  // У объектов без маски поле не появляется: пресет не копит пустые ключи.
  const body = loaded.objects.find((object) => object.id === "body")!;
  expect(body.mask).toBeUndefined();
  expect(body.shape).toBeUndefined();
});

test("фигура участвует в порядке отрисовки, как обычный объект", () => {
  const preset = presetWithShape();
  const ordered = orderedObjects(preset, null).map((object) => object.id);
  expect(ordered).toContain("mask_shape");
  // Группы не рисуются — их нет в списке, а фигура есть.
  expect(ordered).toContain("head");
});

test("перо: ближайшая точка и уникальные имена контуров", () => {
  const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  expect(nearestPoint(points, { x: 96, y: 4 }, 12)).toBe(1);
  expect(nearestPoint(points, { x: 50, y: 50 }, 12)).toBe(-1);
  // Радиус — в координатах сцены, поэтому увеличение учитывается вызывающим.
  expect(nearestPoint(points, { x: 50, y: 50 }, 80)).toBeGreaterThanOrEqual(0);

  const empty = defaultShape(200, 100);
  expect(uniqueItemId(empty, "path")).toBe("path_2");
  const item = makeItem(empty, "ellipse", 200, 100);
  expect(item.kind).toBe("ellipse");
  expect(item.id).toBe("ellipse_2");
  expect(empty.items.some((entry) => entry.id === item.id)).toBe(false);
  expect(empty.items).toHaveLength(1);
});

/** Канва-заглушка: записывает команды, чтобы проверить геометрию без браузера. */
function recorder() {
  const calls: string[] = [];
  const ctx = {
    moveTo: (x: number, y: number) => calls.push(`move ${x} ${y}`),
    lineTo: (x: number, y: number) => calls.push(`line ${x} ${y}`),
    bezierCurveTo: (...args: number[]) => calls.push(`curve ${args.map((value) => Math.round(value)).join(" ")}`),
    closePath: () => calls.push("close"),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

test("перо: сглаживание — свойство точки, а не контура", () => {
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  // Углы: четыре отрезка и замыкание.
  const sharp = recorder();
  tracePath(sharp.ctx, square, [0, 0, 0, 0], true);
  expect(sharp.calls.filter((call) => call.startsWith("curve"))).toHaveLength(0);
  expect(sharp.calls.filter((call) => call.startsWith("line"))).toHaveLength(4);

  // Кривая целиком: в каждом ребре есть Безье.
  const smooth = recorder();
  tracePath(smooth.ctx, square, [100, 100, 100, 100], true);
  expect(smooth.calls.filter((call) => call.startsWith("curve"))).toHaveLength(4);

  // Смешанный контур: сглаживание действует со стороны своей точки, поэтому
  // дуга появляется у каждого ребра, которое касается кривой точки. Точки 0 и 1
  // — углы, 2 и 3 — кривые: три ребра из четырёх становятся дугами, а ребро
  // между двумя углами (0-1) остаётся отрезком.
  const mixed = recorder();
  tracePath(mixed.ctx, square, [0, 0, 100, 100], true);
  expect(mixed.calls.filter((call) => call.startsWith("curve"))).toHaveLength(3);
  expect(mixed.calls.filter((call) => call.startsWith("line"))).toHaveLength(1);

  // Сила влияет на контрольные точки: 100 % уводит их дальше, чем 40 %.
  const strong = recorder();
  const weak = recorder();
  tracePath(strong.ctx, square, [100, 100, 100, 100], false);
  tracePath(weak.ctx, square, [40, 40, 40, 40], false);
  expect(strong.calls[1]).not.toBe(weak.calls[1]);
});

test("перо: одна сглаженная точка между углами даёт дугу", () => {
  // Ровно тот случай, на который жаловались: ползунок точки двигается, а
  // картинка не меняется. Теперь дуга идёт от угла к углу через эту точку.
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const one = recorder();
  tracePath(one.ctx, square, [0, 100, 0, 0], true);
  const curves = one.calls.filter((call) => call.startsWith("curve"));
  expect(curves).toHaveLength(2);
  // Кривая выходит за прямую: контрольные точки смещены от отрезков.
  expect(curves[0]).not.toBe("curve 0 0 0 0 100 0");
});

test("перо: дуга проходит через сглаженную точку без излома", () => {
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const smooth = recorder();
  tracePath(smooth.ctx, square, [0, 100, 0, 0], true);
  // «curve c1x c1y c2x c2y x y»: у соседних рёбер наклон в точке 1 совпадает,
  // иначе на месте «кривой» точки был бы излом.
  const curves = smooth.calls.filter((call) => call.startsWith("curve"));
  const incoming = curves[0].split(" ").map(Number); // ребро 0-1: «curve c1 c2 точка»
  const outgoing = curves[1].split(" ").map(Number); // ребро 1-2: «curve c1 …»
  const point = { x: incoming[5], y: incoming[6] };
  const inVector = { x: point.x - incoming[3], y: point.y - incoming[4] };
  const outVector = { x: outgoing[1] - point.x, y: outgoing[2] - point.y };
  expect(Math.abs(inVector.x * outVector.y - inVector.y * outVector.x)).toBeLessThan(1);
});

test("перо: новая точка встаёт между двумя ближайшими", () => {
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  // Клик по правой стороне — точка встаёт между 1 и 2.
  expect(insertIndexFor(square, { x: 104, y: 50 }, false)).toBe(2);
  // Клик по нижней стороне незамкнутого контура — между 2 и 3.
  expect(insertIndexFor(square, { x: 50, y: 96 }, false)).toBe(3);
  // Нижняя сторона — ребро между 2 и 3, точка встаёт перед третьей.
  expect(insertIndexFor(square, { x: 50, y: 104 }, true)).toBe(3);
  // Замыкающее ребро замкнутого контура (3 → 0) тоже участвует: клик мимо
  // левой стороны вставляет точку в конец, а не выбрасывает её.
  expect(insertIndexFor(square, { x: -4, y: 50 }, true)).toBe(4);
  // В незамкнутом контуре замыкающего ребра нет: левой стороны нет, и точка
  // уходит к ближайшему из настоящих рёбер — к верхнему.
  expect(insertIndexFor(square, { x: -4, y: 50 }, false)).toBe(1);
  // Меньше двух точек — добавляем в конец.
  expect(insertIndexFor([{ x: 0, y: 0 }], { x: 10, y: 10 }, false)).toBe(1);
});

test("перо: старое поле smooth превращается в 100 % у каждой точки", () => {
  const legacy = normalizeShape({ items: [{ kind: "path", points: "0,0; 10,0; 10,10", smooth: true }] });
  expect(legacy.items[0].smoothPoints).toEqual([100, 100, 100]);
  // Новый формат: массив по точкам, лишние значения отбрасываются.
  const perPoint = normalizeShape({ items: [{ kind: "path", points: "0,0; 10,0", smoothPoints: [0, 55, 90] }] });
  expect(perPoint.items[0].smoothPoints).toEqual([0, 55]);
  // Мусор не ломает контур: он читается как угол.
  expect(readSmoothing(["abc", -20, 400], false, 3)).toEqual([0, 0, 100]);
  expect(smoothingOf(perPoint.items[0], 1)).toBe(55);
  expect(smoothingOf(perPoint.items[0], 5)).toBe(0);
});

/** Путь пера из точек со сглаживанием по умолчанию. */
function pathItem(points: Array<{ x: number; y: number }>, closed = false, smoothing: number[] = []) {
  return {
    id: "path_1", kind: "path" as const, x: 0, y: 0, width: 0, height: 0,
    points, smoothPoints: smoothing.length ? smoothing : points.map(() => 0), closed,
  };
}

test("перо: клик по первой точке замыкает контур", () => {
  // Треугольник: клик по первой точке — замыкание, а не перетаскивание её.
  const open = pathItem([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 80 }]);
  expect(penAction(open, { x: 3, y: 2 }, 12)).toEqual({ type: "close" });
  // Уже замкнутый контур: та же точка — обычное перетаскивание.
  const closed = pathItem(open.points, true);
  expect(penAction(closed, { x: 3, y: 2 }, 12)).toEqual({ type: "drag", index: 0 });
  // Двух точек мало для замыкания: контур ещё не из чего собирать.
  const line = pathItem([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  expect(penAction(line, { x: 2, y: 1 }, 12)).toEqual({ type: "drag", index: 0 });
  // Клик по любой другой точке — перетаскивание, не замыкание.
  expect(penAction(open, { x: 100, y: 2 }, 12)).toEqual({ type: "drag", index: 1 });
});

test("перо: Alt меняет тип точки, мимо точек — вставка между ближайшими", () => {
  const square = pathItem([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], false, [0, 100, 100, 0]);
  // Alt по точке: 0 → 100, 100 → 0.
  expect(penAction(square, { x: 100, y: 2 }, 12, true)).toEqual({ type: "toggle-smoothing", index: 1, value: 0 });
  expect(penAction(square, { x: 2, y: 2 }, 12, true)).toEqual({ type: "toggle-smoothing", index: 0, value: 100 });
  // Alt не мешает обычному клику мимо точек: точка вставляется.
  const inserted = penAction(square, { x: 104, y: 50 }, 12, true);
  expect(inserted).toEqual({ type: "insert", index: 2, smoothing: 100 });
  // Вставка в дугу остаётся дугой: новая точка берёт силу более сглаженного
  // соседа, поэтому контур не «выпрямляется» под курсором.
  const curve = pathItem([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], false, [0, 100, 0]);
  expect(penAction(curve, { x: 104, y: 50 }, 12)).toEqual({ type: "insert", index: 2, smoothing: 100 });
  // Вставка в угол углом и остаётся.
  const corners = pathItem([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], false, [0, 0, 0]);
  expect(penAction(corners, { x: 104, y: 50 }, 12)).toEqual({ type: "insert", index: 2, smoothing: 0 });
});
