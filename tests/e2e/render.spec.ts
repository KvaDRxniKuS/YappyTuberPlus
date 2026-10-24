import { test, expect } from "@playwright/test";
import {
  drawRig, invertAffine, objectMatrix, orderedSprites, transformPoint, type SpriteAssets,
} from "../../src/render/rigCanvas";
import { createDemoPreset } from "../../src/data/demoPreset";
import type { ObjectFrame, RigFrame } from "../../src/types";

/*
 * The shared Canvas 2D renderer is exercised headlessly through a recording
 * context. This keeps the drawing path (order, alpha, geometry) testable
 * without a browser.
 */

function frameFor(preset: ReturnType<typeof createDemoPreset>, order: string[]): RigFrame {
  const objects: Record<string, ObjectFrame> = {};
  for (const object of preset.objects) {
    objects[object.id] = {
      x: 0, y: 0, rotation: 0, sizeX: 1, sizeY: 1, skewX: 0, skewY: 0,
      opacity: 1, visible: 1, layer: 0,
    };
  }
  return { seq: 5, time: 0.1, dt: 0.016, globals: {}, objects, order, diagnostics: [] };
}

function recordingContext() {
  const calls: string[] = [];
  const context = {
    globalAlpha: 1,
    save() { calls.push("save"); },
    restore() { calls.push("restore"); },
    transform() {},
    drawImage(_image: unknown, x: number, y: number, width: number, height: number) {
      calls.push(`draw ${x.toFixed(1)},${y.toFixed(1)} ${width}x${height} @${(this as { globalAlpha: number }).globalAlpha}`);
    },
    fillRect() {},
    strokeRect() {},
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
  };
  return { calls, context: context as unknown as CanvasRenderingContext2D };
}

const image = { complete: true, naturalWidth: 64 } as HTMLImageElement;
const assets = { get: () => image } as unknown as SpriteAssets;

test("renderer draws sprites in computed order with base pose and opacity", () => {
  const preset = createDemoPreset();
  const order = [...preset.objects.map((object) => object.id)].reverse();
  const frame = frameFor(preset, order);
  const { calls, context } = recordingContext();

  drawRig(context, preset, frame, assets);

  const sprites = orderedSprites(preset, frame).map((object) => object.id);
  // Порядок считает редактор — слой и структура, — а массив `order` из кадра
  // больше не решает, кто поверх: иначе смена слоя ждала бы перезапуска движка.
  expect(sprites).not.toEqual(order.filter((id) => preset.objects.find((object) => object.id === id)?.kind === "sprite"));
  expect(sprites.indexOf("mouth")).toBeGreaterThan(sprites.indexOf("mouth_closed"));
  expect(sprites.indexOf("head")).toBeGreaterThan(sprites.indexOf("eye_left"));
  const draws = calls.filter((call) => call.startsWith("draw "));
  expect(draws).toHaveLength(sprites.length);
  expect(calls.filter((call) => call === "save")).toHaveLength(draws.length);
  expect(calls.filter((call) => call === "restore")).toHaveLength(draws.length);
});

test("renderer skips invisible and collapsed sprites and applies opacity", () => {
  const preset = createDemoPreset();
  const frame = frameFor(preset, preset.objects.map((object) => object.id));
  const sprite = preset.objects.find((object) => object.kind === "sprite")!;
  frame.objects[sprite.id].opacity = 0.5;
  const other = preset.objects.find((object) => object.id !== sprite.id && object.kind === "sprite")!;
  frame.objects[other.id].visible = 0;

  const { calls, context } = recordingContext();
  drawRig(context, preset, frame, assets);
  const draws = calls.filter((call) => call.startsWith("draw "));
  expect(draws.some((call) => call.endsWith("@0.5"))).toBe(true);
  expect(draws.length).toBeLessThan(preset.objects.filter((object) => object.kind === "sprite").length);

  for (const object of preset.objects) frame.objects[object.id].visible = 0;
  const hidden = recordingContext();
  drawRig(hidden.context, preset, frame, assets);
  expect(hidden.calls.filter((call) => call.startsWith("draw "))).toHaveLength(0);
});

test("object matrix composes base pose, rotation and scale", () => {
  const preset = createDemoPreset();
  preset.objects[0].base.x = 100;
  preset.objects[0].base.y = 200;
  preset.objects[0].base.rotation = 90;
  preset.objects[0].base.sizeX = 2;
  preset.objects[0].base.sizeY = 2;
  const values: ObjectFrame = {
    x: 10, y: 0, rotation: 0, sizeX: 1, sizeY: 1, skewX: 0, skewY: 0,
    opacity: 1, visible: 1, layer: 0,
  };
  const matrix = objectMatrix(preset.objects[0], values);
  expect(matrix.e).toBeCloseTo(100 + 10);
  expect(matrix.f).toBeCloseTo(200);
  expect(Math.hypot(matrix.a, matrix.b)).toBeCloseTo(2);
  const point = transformPoint(matrix, 10, 0);
  expect(point.x).toBeCloseTo(110);
  expect(point.y).toBeCloseTo(220);

  // Inverse maps a child point back into the sprite's local space.
  const local = transformPoint(invertAffine(matrix), point.x, point.y);
  expect(local.x).toBeCloseTo(10);
  expect(local.y).toBeCloseTo(0);
});
