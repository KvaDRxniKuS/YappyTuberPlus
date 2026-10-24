import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { moduleDefaults, moduleDefinition, normalizeDefinition, registerDefinitions } from "../../src/modules/registry";
import { composeValues, instanceInputs } from "../../src/modules/values";
import { normalizeModules } from "../../src/engine/preset";
import {
  averageSpectrum, bandFrequency, bestSimilarity, computeVisemes, discriminativeWeights, normalizeVisemes,
  sanitizeVisemeName, spectrumShape, uniqueVisemeName, unitVector, visemeNameAllowed, weightSpectrum, VISEME_BANDS,
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

/** Синтетические гласные: форманты + спад АЧХ (как у настоящего голоса). */
const FORMANTS: Record<string, number[]> = {
  a: [730, 1090, 2440],
  e: [530, 1840, 2480],
  i: [270, 2290, 3010],
  o: [570, 840, 2410],
  u: [300, 870, 2240],
};

function vowel(name: string, pitch = 120, shift = 0): number[] {
  const formants = FORMANTS[name];
  const amplitudes = Array.from({ length: VISEME_BANDS }, (_, index) => {
    const hz = bandFrequency(index);
    let decibels = -3 * Math.log2(hz / 80);
    formants.forEach((formant, position) => {
      const distance = Math.log2(hz / (formant * (1 + shift)));
      decibels += ([12, 10, 8][position] * Math.exp(-(distance * distance) / (2 * 0.11 * 0.11))) / (1 + position * 0.35);
    });
    return Math.pow(10, decibels / 20);
  });
  // Гармоники голоса: от основного тона, затухают.
  for (let harmonic = 1; harmonic * pitch < 8000; harmonic += 1) {
    const hz = harmonic * pitch;
    if (hz < 80) continue;
    const index = Array.from({ length: VISEME_BANDS }, (_, position) => bandFrequency(position))
      .findIndex((center) => center >= hz);
    if (index >= 0) amplitudes[index] *= 1 + 0.4 * Math.exp(-harmonic / 6);
  }
  return spectrumShape(amplitudes);
}

function visemeModule(visemes: VisemeEntry[], extra: Partial<ModuleInstance> = {}): ModuleInstance {
  return {
    name: "mouth",
    type: "viseme",
    enabled: true,
    source: "live",
    config: {
      ...moduleDefaults(moduleDefinition("viseme")),
      visemes, normalize: true, gate: -50, contrast: 3,
    },
    ...extra,
  };
}

const entries = (): VisemeEntry[] => [
  { name: "a", label: "a", templates: [shape(8)] },
  { name: "o", label: "o", templates: [shape(18)] },
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

test("несколько вариантов записи усиливают визему", () => {
  const single: VisemeEntry[] = [{ name: "o", label: "o", templates: [vowel("o", 110)] }];
  const many: VisemeEntry[] = [{ name: "o", label: "o", templates: [vowel("o", 110), vowel("o", 180), vowel("o", 250)] }];
  const sound = vowel("o", 200);
  expect(bestSimilarity(sound, many[0].templates)).toBeGreaterThan(bestSimilarity(sound, single[0].templates));

  // Варианты переживают сохранение в пресет.
  const modules = normalizeModules([visemeModule(many)]);
  const stored = modules[0].config.visemes as VisemeEntry[];
  expect(stored[0].templates).toHaveLength(3);
  expect(stored[0].templates[0]).toHaveLength(VISEME_BANDS);
});

test("синтетические гласные различаются по форме, а не по громкости", () => {
  const templates: VisemeEntry[] = Object.keys(FORMANTS).map((name) => ({
    name, label: name, templates: [vowel(name, 100), vowel(name, 180), vowel(name, 260)],
  }));
  for (const [name, formants] of Object.entries(FORMANTS)) {
    expect(formants.length).toBe(3);
    for (const pitch of [95, 140, 220]) {
      const bands = vowel(name, pitch);
      const scores = templates.map((entry) => [entry.name, bestSimilarity(bands, entry.templates)] as const);
      const best = scores.reduce((left, right) => (right[1] > left[1] ? right : left));
      expect(best[0], `${name}@${pitch}`).toBe(name);
    }
  }
});

test("контраст увеличивает разрыв между своим и чужим звуком", () => {
  const templates: VisemeEntry[] = Object.keys(FORMANTS).map((name) => ({
    name, label: name, templates: [vowel(name, 150)],
  }));
  const bands = vowel("a", 150);
  const soft = computeVisemes(visemeModule(templates, { config: { visemes: templates, gate: -50, contrast: 1, normalize: false } }), bands, -10);
  const sharp = computeVisemes(visemeModule(templates, { config: { visemes: templates, gate: -50, contrast: 6, normalize: false } }), bands, -10);
  const gap = (values: Record<string, number>) => values.a - Math.max(values.e, values.i, values.o, values.u);
  expect(gap(sharp)).toBeGreaterThan(gap(soft));
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
  // Ручной ввод имени принимает только допустимые символы.
  expect(visemeNameAllowed("o_umlaut2")).toBe(true);
  expect(visemeNameAllowed("ö")).toBe(false);
  expect(visemeNameAllowed("a b")).toBe(false);
  const list: VisemeEntry[] = [{ name: "o", label: "о", templates: [] }];
  expect(uniqueVisemeName(list, "ö")).toBe("o_umlaut");
  expect(uniqueVisemeName([...list, { name: "o_umlaut", label: "ö", templates: [] }], "ö")).toBe("o_umlaut_2");
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
  expect(stored[0].templates[0]).toHaveLength(VISEME_BANDS);
  // Выключенным остаётся только существующий вход.
  expect(modules[0].disabledInputs).toEqual(["a"]);
});

test("веса полос по калибровкам повышают разрыв между гласными", () => {
  const entries: VisemeEntry[] = Object.keys(FORMANTS).map((name) => ({
    name,
    label: name,
    templates: [vowel(name, 105), vowel(name, 165), vowel(name, 230)],
  }));
  const weights = discriminativeWeights(entries.flatMap((entry) => entry.templates));
  expect(weights).not.toBeNull();
  expect(weights).toHaveLength(VISEME_BANDS);

  /** Средний разрыв «свой звук минус лучший чужой» по всем гласным и тонам. */
  const margin = (useWeights: number[] | null): number => {
    let total = 0;
    let count = 0;
    for (const name of Object.keys(FORMANTS)) {
      for (const pitch of [95, 140, 200]) {
        const bands = vowel(name, pitch);
        const scores = entries.map((entry) => [entry.name, bestSimilarity(bands, entry.templates, useWeights)] as const);
        const own = scores.find(([key]) => key === name)![1];
        const other = Math.max(...scores.filter(([key]) => key !== name).map(([, value]) => value));
        total += own - other;
        count += 1;
      }
    }
    return total / count;
  };
  expect(margin(weights)).toBeGreaterThan(margin(null));

  // Сравнивать не с чем: одна запись — обычный косинус.
  expect(discriminativeWeights([])).toBeNull();
  expect(discriminativeWeights([entries[0].templates[0]])).toBeNull();
  // Веса не меняют длину вектора: сравниваются формы, а не масштаб.
  const weighted = weightSpectrum(entries[0].templates[0], weights);
  expect(weighted.reduce((sum, value) => sum + value * value, 0)).toBeCloseTo(1, 6);
});

test("новый модуль визем: свои звуки, латиница в имени, варианты записи", () => {
  // Калибровки хранятся в конфиге экземпляра, а не в шаблоне.
  const module = visemeModule(entries(), { config: { visemes: entries(), normalize: true, gate: -50, contrast: 3 } });
  const stored = normalizeModules([module])[0].config.visemes as VisemeEntry[];
  expect(stored.map((entry) => entry.name)).toEqual(["a", "o"]);
  expect(stored[0].templates[0]).toHaveLength(VISEME_BANDS);
  expect(stored[0].templates[0][8]).not.toBe(0);
});
