import { test, expect } from "@playwright/test";
import { createDemoPreset, TALKING_CLOSED, TALKING_OPEN, withDemoMouth } from "../../src/data/demoPreset";
import { normalizePreset } from "../../src/engine/preset";
import { existsSync } from "node:fs";

test("demo rig ships an open and a closed mouth in the same place", () => {
  const preset = createDemoPreset();
  const open = preset.objects.find((object) => object.id === "mouth")!;
  const closed = preset.objects.find((object) => object.id === "mouth_closed")!;
  expect(open).toBeTruthy();
  expect(closed).toBeTruthy();
  expect(open.image).toBe("/assets/demo/mouth_open.png");
  expect(closed.image).toBe("/assets/demo/mouth_closed.png");
  expect(closed.parentId).toBe(open.parentId);
  expect(closed.base).toEqual(open.base);
  expect(open.script).toContain(`visible = ${TALKING_OPEN}`);
  expect(closed.script).toContain(`visible = ${TALKING_CLOSED}`);
  // Sprites are committed, so the demo never shows placeholder boxes.
  expect(existsSync(`public${open.image}`)).toBe(true);
  expect(existsSync(`public${closed.image}`)).toBe(true);
  // The closed mouth is listed right after the open one.
  const ids = preset.objects.map((object) => object.id);
  expect(ids.indexOf("mouth_closed")).toBe(ids.indexOf("mouth") + 1);
});

test("presets saved before the closed mouth was added are migrated once", () => {
  const current = createDemoPreset();
  const legacy = {
    ...current,
    objects: current.objects
      .filter((object) => object.id !== "mouth_closed")
      .map((object) => object.id === "mouth"
        ? { ...object, image: "/assets/demo/mouth.png", script: object.script.replace(/^visible\s*=.*$/m, "visible = inherit") }
        : object),
  };
  const migrated = withDemoMouth(normalizePreset(legacy)!);
  expect(migrated.objects.filter((object) => object.id === "mouth_closed")).toHaveLength(1);
  expect(migrated.objects.find((object) => object.id === "mouth")!.script).toContain(`visible = ${TALKING_OPEN}`);
  expect(migrated.objects.find((object) => object.id === "mouth_closed")!.script).toContain(`visible = ${TALKING_CLOSED}`);
  // Untouched objects keep their scripts, and a second pass changes nothing.
  const body = current.objects.find((object) => object.id === "body")!;
  expect(migrated.objects.find((object) => object.id === "body")!.script).toBe(body.script);
  const again = withDemoMouth(migrated);
  expect(again.objects).toHaveLength(migrated.objects.length);
  expect(again.objects).toEqual(migrated.objects);
});

test("a rig without the demo mouth is left untouched", () => {
  const preset = createDemoPreset();
  const custom = {
    ...preset,
    objects: preset.objects
      .filter((object) => !object.id.startsWith("mouth"))
      .concat({ ...preset.objects[1], id: "custom_mouth", image: "/uploads/mouth.png" }),
  };
  expect(withDemoMouth(custom)).toBe(custom);
});

test("the whole demo preset compiles and ticks in the Rust core", async () => {
  const { readFileSync } = await import("node:fs");
  const { instance } = await WebAssembly.instantiate(readFileSync("public/rig_core.wasm"), {});
  const { rig_alloc, rig_free, rig_call, memory } = instance.exports as unknown as {
    rig_alloc: (length: number) => number;
    rig_free: (pointer: number, length: number) => void;
    rig_call: (pointer: number, length: number) => bigint;
    memory: WebAssembly.Memory;
  };
  const call = (request: unknown) => {
    const input = new TextEncoder().encode(JSON.stringify(request));
    const pointer = rig_alloc(input.length);
    new Uint8Array(memory.buffer, pointer, input.length).set(input);
    const packed = rig_call(pointer, input.length);
    rig_free(pointer, input.length);
    const outPointer = Number(packed & 0xffffffffn);
    const outLength = Number((packed >> 32n) & 0xffffffffn);
    const text = new TextDecoder().decode(new Uint8Array(memory.buffer, outPointer, outLength));
    rig_free(outPointer, outLength);
    return JSON.parse(text);
  };

  const preset = createDemoPreset();
  const config = {
    canvas: preset.canvas,
    globals: preset.globals,
    objects: preset.objects.map((object) => ({ ...object, image: null })),
  };
  const validation = call({ op: "validate", config });
  expect(validation.ok, validation.error).toBe(true);

  const created = call({ op: "create", config });
  const inputs = {
    speak: 0, loudness: 0, db: -60, talking: 0,
    viseme_a: 0, viseme_e: 0, viseme_i: 0, viseme_o: 0, viseme_u: 0, signals: {},
  };
  const silent = call({ op: "tick", handle: created.handle, now: 0.016, inputs, paused: false, resetClock: true });
  expect(silent.frame.diagnostics).toEqual([]);
  expect(silent.frame.objects.mouth.visible).toBe(0);
  expect(silent.frame.objects.mouth_closed.visible).toBe(1);

  const speaking = call({ op: "tick", handle: created.handle, now: 0.032, inputs: { ...inputs, talking: 1, speak: 0.5 }, paused: false, resetClock: false });
  expect(speaking.frame.diagnostics).toEqual([]);
  expect(speaking.frame.objects.mouth.visible).toBe(1);
  expect(speaking.frame.objects.mouth_closed.visible).toBe(0);
  // Both mouth sprites are drawn in the same slot, above the head.
  const order = speaking.frame.order;
  expect(order.indexOf("mouth_closed")).toBeGreaterThan(order.indexOf("head"));
  expect(order.indexOf("mouth")).toBeGreaterThan(order.indexOf("head"));
  // Breathing/blink still run.
  expect(speaking.frame.objects.eye_left.sizeY).toBeLessThan(1.5);
  expect(Number.isFinite(speaking.frame.objects.character.x)).toBe(true);
  call({ op: "dispose", handle: created.handle });
});
