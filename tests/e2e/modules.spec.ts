import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  moduleDefaults, moduleDefinition, normalizeDefinition, registerDefinitions,
} from "../../src/modules/registry";
import {
  composeValues, ensureModules, migrateLegacyScript, sanitizeModuleName, uniqueModuleName, validateModules,
} from "../../src/modules/values";
import { normalizeModules } from "../../src/engine/preset";
import { createDemoPreset, createEmptyPreset } from "../../src/data/demoPreset";
import { DEFAULT_MODULES, type ModuleInstance, type RigPreset } from "../../src/types";

/**
 * В браузере шаблоны читаются из папки `modules` через fetch, а в Node его нет —
 * поэтому тесты кладут те же JSON-файлы в библиотеку руками.
 */
test.beforeAll(() => {
  const directory = join(process.cwd(), "public", "modules");
  const index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")) as { modules: string[] };
  const definitions = index.modules
    .map((id) => normalizeDefinition(JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"))))
    .filter((definition) => definition !== null);
  registerDefinitions(definitions);
});

const module = (name: string, type: string, extra: Partial<ModuleInstance> = {}): ModuleInstance => ({
  name,
  type,
  enabled: true,
  source: moduleDefinition(type).audio ? "live" : "manual",
  config: moduleDefaults(moduleDefinition(type)),
  ...extra,
});

test("библиотека шаблонов читается из папки modules", () => {
  expect(moduleDefinition("loudness").inputs.map((input) => input.name)).toEqual(["speak", "loudness", "db", "talking"]);
  expect(moduleDefinition("autoblink").inputs.map((input) => input.name)).toEqual(["blink"]);
  expect(moduleDefinition("manual").inputs.map((input) => input.name)).toEqual(["value"]);
  // Поля с настройками есть у каждого нового модуля.
  expect(moduleDefinition("autoblink").fields.map((field) => field.key)).toContain("period");
  expect(moduleDefinition("manual").fields.map((field) => field.key)).toContain("mode");
});

test("входы собираются как <модуль>.<вход> для включённых модулей", () => {
  const modules = [
    module("mic_left", "loudness"),
    module("mic_right", "loudness"),
    module("off", "loudness", { enabled: false }),
  ];
  const values = composeValues(modules, {
    audio: {
      mic_left: { speak: 0.6, loudness: 0.8, db: -18, talking: 1 },
      mic_right: { speak: 0.1, loudness: 0.2, db: -44, talking: 0 },
      off: { speak: 1, loudness: 1, db: 0, talking: 1 },
    },
    manual: {},
    auto: {},
  });
  expect(values["mic_left.talking"]).toBe(1);
  expect(values["mic_right.db"]).toBe(-44);
  // Выключенный модуль не попадает в словарь вообще.
  expect(Object.keys(values).filter((key) => key.startsWith("off."))).toHaveLength(0);
});

test("выключенный вход не уходит в кадр", () => {
  const mic = module("mic", "loudness", { disabledInputs: ["db", "loudness"] });
  const values = composeValues([mic], {
    audio: { mic: { speak: 0.5, loudness: 0.6, db: -20, talking: 1 } },
    manual: {},
    auto: {},
  });
  expect(values["mic.speak"]).toBe(0.5);
  expect(values["mic.db"]).toBeUndefined();
  expect(values["mic.loudness"]).toBeUndefined();
});

test("ручной модуль берёт значение из ползунка, авто-модуль — из таймера", () => {
  const manual = module("manual", "manual");
  const auto = module("auto", "autoblink");
  const values = composeValues([manual, auto], {
    audio: {},
    manual: { "manual.value": 0.4 },
    auto: { "auto.blink": 1 },
  });
  expect(values["manual.value"]).toBe(0.4);
  expect(values["auto.blink"]).toBe(1);
});

test("границы ручного и авто-модуля берутся из настроек экземпляра", () => {
  const manual = module("manual", "manual", { config: { ...moduleDefinition("manual").defaults, min: -5, max: 5 } });
  const auto = module("auto", "autoblink", { config: { ...moduleDefinition("autoblink").defaults, min: 0.2, max: 0.9 } });
  // Пока ползунок не трогали, ручной вход стоит на минимуме своих границ.
  const values = composeValues([manual, auto], { audio: {}, manual: {}, auto: {} });
  expect(values["manual.value"]).toBe(-5);
  expect(values["auto.blink"]).toBe(0.2);
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
  expect(blinking.script).toContain("auto.blink");
  expect(blinking.used).toContain("auto");

  const manualBlink = migrateLegacyScript("x = manual.blink * 2");
  expect(manualBlink.script).toBe("x = auto.blink * 2");
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
  expect(fixed.modules.map((item) => item.name)).toEqual(["mic", "auto", "manual"]);
  expect(fixed.globals).toContain("auto.blink");
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
  expect(fixed.modules.map((item) => item.name)).toContain("viseme");
  expect(fixed.objects[0].script).toBe("x = viseme.a * 10");
});

test("нормализация модулей отбрасывает дубли, чужие типы и лишние входы", () => {
  const modules = normalizeModules([
    { name: "mic", type: "loudness", enabled: true, source: "live", config: { gain: 2, threshold: -1000 } },
    { name: "mic", type: "manual", enabled: true },
    { name: "weird", type: "unknown-type", enabled: false },
    { name: "auto", type: "autoblink", enabled: true, disabledInputs: ["blink", "нет-такого"] },
    { name: "", type: "manual" },
  ]);
  expect(modules).toHaveLength(3);
  // Усиление сохраняется, а порог зажимается в границы поля.
  expect(modules[0].config.gain).toBe(2);
  expect(modules[0].config.threshold).toBe(-80);
  // Неизвестный шаблон не подменяется на Manual: иначе модуль молча получит
  // единственный вход `manual.value` вместо своих.
  expect(modules[1].type).toBe("unknown-type");
  expect(modules[2].source).toBe("manual");
  // Неизвестное имя входа отбрасывается, известное остаётся выключенным.
  expect(modules[2].disabledInputs).toEqual(["blink"]);
  expect(validateModules(modules)).toEqual(["Шаблон «unknown-type» не найден в папке modules"]);
});

test("неизвестный шаблон не теряет настройки, виземы и источник", () => {
  const visemes = [{ name: "o_umlaut", label: "ö", templates: [new Array(32).fill(0.17)] }];
  const modules = normalizeModules([
    { name: "future", type: "future-module", enabled: true, source: "live", config: { visemes, gain: 2 } },
  ]);
  expect(modules[0].type).toBe("future-module");
  expect(modules[0].source).toBe("live");
  // Калибровки и свои звуки переживают открытие пресета.
  expect(modules[0].config.visemes).toEqual(visemes);
  expect(modules[0].config.gain).toBe(2);
});

test("демо-пресет и пустой пресет согласованы с модулями", () => {
  const demo = createDemoPreset();
  expect(demo.modules).toHaveLength(DEFAULT_MODULES.length);
  expect(demo.globals).toContain("auto.blink");
  expect(demo.objects.some((object) => object.script.includes("mic.talking"))).toBe(true);
  expect(createEmptyPreset("x").modules).toEqual([]);
});
