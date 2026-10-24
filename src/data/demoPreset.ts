import { DEFAULT_BASE, DEFAULT_OVERLAY, type BasePose, type RigObject, type RigPreset } from "../types";

export const rootScript = (overrides: Partial<Record<string, string>> = {}) => `
x = 0
y = 0
rotation = 0
sizeX = 1
sizeY = 1
skewX = 0
skewY = 0
opacity = 1
visible = 1
layer = 0
`.trim().split("\n").map((line) => {
  const name = line.split("=")[0].trim();
  return overrides[name] !== undefined ? `${name} = ${overrides[name]}` : line;
}).join("\n");

export const childScript = (overrides: Partial<Record<string, string>> = {}) => `
x = inherit + follow(offset, parent).x
y = inherit + follow(offset, parent).y
rotation = inherit
sizeX = inherit
sizeY = inherit
skewX = inherit
skewY = inherit
opacity = inherit
visible = inherit
layer = inherit
`.trim().split("\n").map((line) => {
  const name = line.split("=")[0].trim();
  return overrides[name] !== undefined ? `${name} = ${overrides[name]}` : line;
}).join("\n");

const base = (x: number, y: number, overrides: Partial<BasePose> = {}): BasePose => ({
  ...DEFAULT_BASE, x, y, ...overrides,
});

const object = (
  id: string,
  name: string,
  kind: RigObject["kind"],
  parentId: string | null,
  image: string | null,
  width: number,
  height: number,
  objectBase: BasePose,
  script: string,
  pivot = { x: 0.5, y: 0.5 },
): RigObject => ({ id, name, kind, parentId, image, width, height, base: objectBase, script, pivot });

export function createDemoPreset(): RigPreset {
  return {
    version: 2,
    name: "Mochi — стартовый риг",
    canvas: { width: 1000, height: 600 },
    globals: `blink_min = 2500
blink_max = 6500
blink = max(autoblink(blink_min, blink_max), signal.blink)
breath = sin(time * 2 * pi / 4) * 0.5 + 0.5`,
    runtime: { fpsMode: "limited", fpsLimit: 60 },
    overlay: { ...DEFAULT_OVERLAY },
    objects: [
      object("character", "Персонаж", "group", null, null, 500, 520, base(500, 330), rootScript({
        x: "sin(time * 0.8) * 5",
        y: "sin(time * 2 * pi / 4) * 4",
      })),
      object("body", "Тело", "sprite", "character", "/assets/demo/body.png", 280, 300, base(500, 410), childScript({
        rotation: "inherit + sin(time * 2 * pi / 4) * 1.2",
        sizeY: "inherit * (0.995 + breath * 0.01)",
      })),
      object("head_group", "Голова · группа", "group", "body", null, 380, 300, base(500, 225), childScript({
        rotation: "inherit + sin(time * 1.6) * 2.2 + speak * 1.5",
      })),
      object("head", "Голова", "sprite", "head_group", "/assets/demo/head.png", 360, 290, base(500, 225), childScript()),
      object("eye_left", "Глаз · левый", "sprite", "head_group", "/assets/demo/eye.png", 72, 96, base(435, 215, { layer: 2 }), childScript({
        sizeY: "inherit * (1 - blink * 0.9)",
        layer: "inherit + 1",
      })),
      object("eye_right", "Глаз · правый", "sprite", "head_group", "/assets/demo/eye.png", 72, 96, base(565, 215, { layer: 2 }), childScript({
        sizeY: "inherit * (1 - blink * 0.9)",
        layer: "inherit + 1",
      })),
      object("mouth", "Рот", "sprite", "head_group", "/assets/demo/mouth.png", 140, 70, base(500, 300, { layer: 2 }), childScript({
        sizeX: "inherit * (0.85 + speak * 0.3)",
        sizeY: "inherit * (0.4 + speak * 1.7 + 0.05 * sin(time * 18))",
        layer: "inherit + 1",
      })),
      object("arm_left", "Рука · левая", "sprite", "body", "/assets/demo/arm.png", 100, 250, base(355, 325, { rotation: 8, layer: -2 }), childScript({
        rotation: "inherit + 7 + sin(time * 1.8) * 4",
        layer: "inherit - 2",
      }), { x: 0.5, y: 0.15 }),
      object("arm_right", "Рука · правая", "sprite", "body", "/assets/demo/arm.png", 100, 250, base(645, 325, { rotation: -8, layer: -2, sizeX: -1 }), childScript({
        rotation: "inherit - 7 - sin(time * 1.8) * 4",
        layer: "inherit - 2",
      }), { x: 0.5, y: 0.15 }),
    ],
  };
}
