import { test, expect } from "@playwright/test";
import { composeValues, ensureModules, migrateLegacyScript, sanitizeModuleName, uniqueModuleName, validateModules } from "../../src/modules/values";
import { normalizeModules } from "../../src/engine/preset";
import { createDemoPreset, createEmptyPreset } from "../../src/data/demoPreset";
import { DEFAULT_MODULES, type RigPreset } from "../../src/types";

test("входы собираются как <модуль>.<вход> для включённых модулей", () => {
  const modules = [
    { name: "mic_left", type: "loudness" as const, enabled: true, source: "live" as const, config: {} },
    { name: "mic_right", type: "loudness" as const, enabled: true, source: "live" as const, config: {} },
    { name: "off", type: "loudness" as const, enabled: false, source: "live" as const, config: {} },
  ];
  const values = composeValues(
    modules,
    {
      mic_left: { speak: 0.6, loudness: 0.8, db: -18, talking: 1 },
      mic_right: { speak: 0.1, loudness: 0.2, db: -44, talking: 0 },
      off: { speak: 1, loudness: 1, db: 0, talking: 1 },
    },
    {},
  );
  expect(values["mic_left.talking"]).toBe(1);
  expect(values["mic_right.db"]).toBe(-44);
  // Выключенный модуль не попадает в словарь вообще.
  expect(values["off.talking"]).toBeUndefined();
  expect(Object.keys(values).filter((key) => key.startsWith("off."))).toHaveLength(0);
});

test("ручной модуль берёт значения из ползунков, а не из звука", () => {
  const modules = [
    { name: "viseme", type: "viseme" as const, enabled: true, source: "manual" as const, config: {} },
  ];
  const values = composeValues(modules, {}, { "viseme.a": 0.4 });
  expect(values["viseme.a"]).toBe(0.4);
  expect(values["viseme.e"]).toBe(0);
});

test("имена модулей пригодны для скрипта и не повторяются", () => {
  expect(sanitizeModuleName("Mic Left")).toBe("mic_left");
  expect(sanitizeModuleName("2mic")).toBe("m_2mic");
  expect(sanitizeModuleName("Микрофон")).toBe("module");
  expect(uniqueModuleName([{ name: "mic" }], "mic")).toBe("mic_2");
  expect(uniqueModuleName([{ name: "mic" }, { name: "mic_2" }], "mic")).toBe("mic_3");
  expect(validateModules([
    { name: "mic", type: "loudness", enabled: true, source: "live", config: {} },
    { name: "mic", type: "loudness", enabled: true, source: "live", config: {} },
  ])).toHaveLength(1);
});

test("старые входы переписываются в имена модулей", () => {
  const migrated = migrateLegacyScript("visible = talking > 0 or speak > 0.02 ? 1 : 0\nsizeX = viseme_a");
  expect(migrated.changed).toBe(true);
  expect(migrated.script).toContain("mic.talking");
  expect(migrated.script).toContain("mic.speak");
  expect(migrated.script).toContain("viseme.a");
  expect(migrated.used.sort()).toEqual(["mic", "viseme"]);

  const blinking = migrateLegacyScript("blink = max(autoblink(1000, 2000), signal.blink)");
  expect(blinking.script).toContain("manual.blink");
  expect(blinking.used).toContain("manual");
});

test("переименование не задевает похожие идентификаторы", () => {
  const migrated = migrateLegacyScript("talking_smooth = 1\nmy_speak = 2\ndb_hold = 3\nx = speed");
  expect(migrated.changed).toBe(false);
  expect(migrated.script).toBe("talking_smooth = 1\nmy_speak = 2\ndb_hold = 3\nx = speed");
});

test("пресет без модулей получает набор модулей и новые имена", () => {
  const legacy = {
    ...createDemoPreset(),
    modules: undefined,
    globals: "blink = max(autoblink(2500, 6500), signal.blink)",
    objects: createDemoPreset().objects.map((object) => ({
      ...object,
      script: object.script.replace(/mic\./g, ""),
    })),
  } as unknown as RigPreset;
  const fixed = ensureModules(legacy);
  expect(fixed.modules.map((module) => module.name)).toEqual(["mic", "manual"]);
  expect(fixed.globals).toContain("manual.blink");
  expect(fixed.objects.some((object) => object.script.includes("mic.talking"))).toBe(true);
});

test("пресет с виземами получает модуль Viseme", () => {
  const legacy = {
    ...createEmptyPreset("test"),
    modules: undefined,
    objects: [{
      id: "a", name: "a", kind: "sprite", enabled: true, image: null, parentId: null,
      pivot: { x: 0.5, y: 0.5 }, base: { ...createDemoPreset().objects[0].base },
      width: 10, height: 10, script: "x = viseme_a * 10",
    }],
  } as unknown as RigPreset;
  const fixed = ensureModules(legacy);
  expect(fixed.modules.map((module) => module.name)).toContain("viseme");
  expect(fixed.objects[0].script).toBe("x = viseme.a * 10");
});

test("нормализация модулей отбрасывает дубли и чужие типы", () => {
  const modules = normalizeModules([
    { name: "mic", type: "loudness", enabled: true, source: "live", config: { gain: 2 } },
    { name: "mic", type: "manual", enabled: true },
    { name: "weird", type: "unknown-type", enabled: false },
    { name: "", type: "manual" },
  ]);
  expect(modules).toHaveLength(2);
  expect(modules[0].config.gain).toBe(2);
  expect(modules[1].type).toBe("manual");
  expect(validateModules(modules)).toHaveLength(0);
});

test("демо-пресет и пустой пресет согласованы с модулями", () => {
  const demo = createDemoPreset();
  expect(demo.modules).toHaveLength(DEFAULT_MODULES.length);
  expect(demo.globals).toContain("manual.blink");
  expect(demo.objects.some((object) => object.script.includes("mic.talking"))).toBe(true);
  expect(createEmptyPreset("x").modules).toEqual([]);
});
