import { DEFAULT_BASE, DEFAULT_MODULES, DEFAULT_OVERLAY, type BasePose, type RigObject, type RigPreset } from "../types";

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

/**
 * The demo swaps two mouth sprites: open while the character speaks, otherwise
 * a closed smile. Both values приходят из модуля `mic`: `mic.talking` — флаг
 * разговора, `mic.speak` — сглаженная громкость. Если модуль выключен, входы
 * дают нули и рот остаётся закрытым.
 */
export const TALKING_OPEN = "mic.talking > 0 or mic.speak > 0.02 ? 1 : 0";
export const TALKING_CLOSED = "mic.talking > 0 or mic.speak > 0.02 ? 0 : 1";

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
): RigObject => ({ id, name, kind, enabled: true, parentId, image, width, height, base: objectBase, script, pivot });

/** Пустой пресет для кнопки «Создать»: без демо-персонажа и модулей. */
export function createEmptyPreset(name = "Без названия"): RigPreset {
  return {
    version: 2,
    name,
    canvas: { width: 1000, height: 600 },
    globals: "",
    runtime: { fpsMode: "limited", fpsLimit: 60 },
    overlay: { ...DEFAULT_OVERLAY },
    modules: [],
    objects: [],
  };
}

export function createDemoPreset(): RigPreset {
  return {
    version: 2,
    name: "Mochi — стартовый риг",
    canvas: { width: 1000, height: 600 },
    globals: `blink = auto.blink
breath = sin(time * 2 * pi / 4) * 0.5 + 0.5`,
    runtime: { fpsMode: "limited", fpsLimit: 60 },
    overlay: { ...DEFAULT_OVERLAY },
    modules: DEFAULT_MODULES.map((module) => ({ ...module, config: { ...module.config } })),
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
        rotation: "inherit + sin(time * 1.6) * 2.2 + mic.speak * 1.5",
        // Голова выше тела по слою: тело стоит в структуре выше и при равном
        // слое перекрывало бы подбородок (правило «верхняя строка — поверх»).
        layer: "inherit + 0.5",
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
      object("mouth", "Рот · открыт", "sprite", "head_group", "/assets/demo/mouth_open.png", 140, 70, base(500, 300, { layer: 2 }), childScript({
        sizeX: "inherit * (0.85 + max(mic.speak, mic.talking * 0.6) * 0.3)",
        sizeY: "inherit * (0.4 + max(mic.speak, mic.talking * 0.6) * 1.7 + 0.05 * sin(time * 18))",
        visible: TALKING_OPEN,
        layer: "inherit + 1",
      })),
      object("mouth_closed", "Рот · закрыт", "sprite", "head_group", "/assets/demo/mouth_closed.png", 140, 70, base(500, 300, { layer: 2 }), childScript({
        visible: TALKING_CLOSED,
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

/**
 * Older demo presets stored in the browser only have the open mouth. Adds the
 * closed sprite (and the speaking rule) without touching anything else.
 */
export function withDemoMouth(preset: RigPreset): RigPreset {
  const open = preset.objects.find(
    (object) => object.id === "mouth" && object.image?.startsWith("/assets/demo/mouth"),
  );
  if (!open || preset.objects.some((object) => object.id === "mouth_closed")) return preset;

  const closed: RigObject = {
    ...open,
    id: "mouth_closed",
    name: "Рот · закрыт",
    image: "/assets/demo/mouth_closed.png",
    base: { ...open.base },
    script: open.script.replace(/^visible\s*=.*$/m, `visible = ${TALKING_CLOSED}`),
  };
  if (!/^visible\s*=/m.test(closed.script)) closed.script += `\nvisible = ${TALKING_CLOSED}`;

  const objects = preset.objects.map((object) => {
    if (object.id !== "mouth") return object;
    const speaking = object.script.replace(/^visible\s*=.*$/m, `visible = ${TALKING_OPEN}`);
    return { ...object, script: /^visible\s*=/m.test(object.script) ? speaking : `${object.script}\nvisible = ${TALKING_OPEN}` };
  });
  const index = objects.findIndex((object) => object.id === "mouth");
  objects.splice(index + 1, 0, closed);
  return { ...preset, objects };
}

/**
 * Миграция стартового рига: добавляет закрытый рот и поднимает группу головы по
 * слою. Второе нужно после перехода на правило «верхняя строка структуры —
 * поверх нижней»: в демо тело стоит выше головы и при равном слое перекрывало бы
 * подбородок у ранее сохранённых пресетов.
 */
export function migrateDemoPreset(preset: RigPreset): RigPreset {
  const migrated = withDemoMouth(preset);
  const head = migrated.objects.find((object) => object.id === "head_group");
  if (!head || /^\s*layer\s*=/m.test(head.script)) return migrated;
  const objects = migrated.objects.map((object) => object.id === "head_group"
    ? { ...object, script: `${object.script.replace(/\s+$/, "")}\nlayer = inherit + 0.5` }
    : object);
  return { ...migrated, objects };
}
