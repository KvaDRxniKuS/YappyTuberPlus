import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { moduleDefaults, moduleDefinition, normalizeDefinition, registerDefinitions } from "../../src/modules/registry";
import { composeValues, instanceInputs } from "../../src/modules/values";
import { normalizeModules } from "../../src/engine/preset";
import {
  averageSpectrum, computeVisemes, normalizeVisemes, sanitizeVisemeName, uniqueVisemeName, unitVector,
  VISEME_BANDS,
} from "../../src/modules/viseme";
import type { ModuleInstance, VisemeEntry } from "../../src/types";

test.beforeAll(() => {
  const directory = join(process.cwd(), "public", "modules");
  const index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")) as { modules: string[] };
  const definitions = index.modules
    .map((id) => normalizeDefinition(JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"))))
    .filter((definition) => definition !== null);
  registerDefinitions(definitions);
});

/** Спектр-«горб»: полосы вокруг центра. Форма важнее громкости. */
function shape(center: number, width = 4): number[] {
  return unitVector(Array.from({ length: VISEME_BANDS }, (_, index) => Math.exp(-((index - center) ** 2) / (2 * width * width))));
}

function visemeModule(visemes: VisemeEntry[], extra: Partial<ModuleInstance> = {}): ModuleInstance {
  return {
    name: "mouth",
    type: "viseme",
    enabled: true,
    source: "live",
    config: { ...moduleDefaults(moduleDefinition("viseme")), visemes, normalize: true, gate: -50 },
    ...extra,
  };
}

const entries = (): VisemeEntry[] => [
  { name: "a", label: "a", template: shape(8) },
  { name: "o", label: "o", template: shape(18) },
];

test("шаблон viseme берёт звук, но входы задаёт экземпляр", () => {
  const definition = moduleDefinition("viseme");
  expect(definition.audio).toBe(true);
  expect(definition.inputs).toHaveLength(0);
  // База a, e, i, o, u приходит из шаблона и редактируема.
  const module = visemeModule([]);
  expect(instanceInputs(module).map((spec) => spec.name)).toEqual(["a", "e", "i", "o", "u"]);
  const custom = visemeModule(entries());
  expect(instanceInputs(custom).map((spec) => spec.name)).toEqual(["a", "o"]);
  expect(instanceInputs(custom)[0]).toMatchObject({ min: 0, max: 1 });
});

test("значение виземы — похожесть спектра, в тишине ноль", () => {
  const module = visemeModule(entries());
  const loud = { bands: shape(8), db: -12, speak: 0.7, loudness: 0.7, talking: 1 };
  const values = composeValues([module], { audio: { mouth: loud }, manual: {}, auto: {} });
  expect(values["mouth.a"]).toBeGreaterThan(values["mouth.o"]);
  expect(values["mouth.a"]).toBeGreaterThan(0.5);

  // Ниже порога гейта виземы нулевые даже при «правильной» форме спектра.
  const quiet = { bands: shape(8), db: -70, speak: 0, loudness: 0.01, talking: 0 };
  const silent = composeValues([module], { audio: { mouth: quiet }, manual: {}, auto: {} });
  expect(silent["mouth.a"]).toBe(0);
  expect(silent["mouth.o"]).toBe(0);
});

test("нормализация приводит сумму к единице, но не оживляет тишину", () => {
  const normalized = normalizeVisemes({ a: 0.8, o: 0.8 });
  expect(normalized.a).toBeCloseTo(0.5, 6);
  expect(normalized.o).toBeCloseTo(0.5, 6);
  expect(normalizeVisemes({ a: 0, o: 0 })).toEqual({ a: 0, o: 0 });
});

test("калибровка: средний спектр не зависит от громкости", () => {
  const quiet = averageSpectrum([shape(8).map((value) => value * 0.01), shape(8).map((value) => value * 0.02)]);
  const loud = averageSpectrum([shape(8), shape(8)]);
  expect(quiet).not.toBeNull();
  expect(loud).not.toBeNull();
  const length = (loud as number[]).reduce((sum, value) => sum + value * value, 0);
  expect(length).toBeCloseTo(1, 6);
  expect((quiet as number[])[8]).toBeCloseTo((loud as number[])[8], 6);
  expect(averageSpectrum([])).toBeNull();
});

test("имена визем: латиница в скрипте, подпись любая", () => {
  expect(sanitizeVisemeName("ö")).toBe("o_umlaut");
  expect(sanitizeVisemeName("ä")).toBe("a_umlaut");
  expect(sanitizeVisemeName("ы")).toBe("y");
  expect(sanitizeVisemeName("О")).toBe("o");
  expect(sanitizeVisemeName("2 звук")).toBe("v_2_zvuk");
  const list: VisemeEntry[] = [{ name: "o", label: "о", template: null }];
  expect(uniqueVisemeName(list, "ö")).toBe("o_umlaut");
  expect(uniqueVisemeName([...list, { name: "o_umlaut", label: "ö", template: null }], "ö")).toBe("o_umlaut_2");
});

test("ключи визем считаются по экземпляру, а не по шаблону", () => {
  const module = visemeModule(entries());
  const values = computeVisemes(module, shape(8), -10);
  expect(Object.keys(values)).toEqual(["a", "o"]);
  expect(values.a).toBeGreaterThan(values.o);
});

test("пресет сохраняет калибровки и чистит битые имена", () => {
  const modules = normalizeModules([
    { ...visemeModule(entries()), config: { visemes: entries(), normalize: false }, disabledInputs: ["a", "нет"] },
  ]);
  expect(modules).toHaveLength(1);
  const stored = modules[0].config.visemes as VisemeEntry[];
  expect(stored.map((entry) => entry.name)).toEqual(["a", "o"]);
  expect(stored[0].template).toHaveLength(VISEME_BANDS);
  // Выключенным остаётся только существующий вход.
  expect(modules[0].disabledInputs).toEqual(["a"]);
});
