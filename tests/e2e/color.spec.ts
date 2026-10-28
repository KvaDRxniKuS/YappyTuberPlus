import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeDefinition, registerDefinitions, moduleDefaults } from "../../src/modules/registry";
import { composeValues, instanceInputs } from "../../src/modules/values";
import { channelColorAt, colorChannels, resetColorState } from "../../src/modules/color";
import { applyColors, colorFieldsOf, colorText, parseColor, resolvedColors } from "../../src/render/color";
import { makeLight, makeShape, makeText, normalizePreset } from "../../src/engine/preset";
import { PRESET_FORMAT } from "../../src/version";
import type { ModuleInstance, RigObject, RigPreset } from "../../src/types";

/*
 * Цвет из модуля.
 *
 * Проверяем две вещи, которые легко разъезжаются: математику палитры (режимы —
 * это функции времени, их видно на числах) и подстановку цвета в объект (своя
 * альфа, пропавший канал, отсутствие привязки). Ядро в этом не участвует: цвет
 * живёт рядом с кадром, поэтому всё проверяется без WASM и без браузера.
 */

const directory = join(process.cwd(), "public", "modules");
const index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")) as { modules: string[] };
const definitions = index.modules
  .map((id) => normalizeDefinition(JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"))))
  .filter((definition): definition is NonNullable<typeof definition> => definition !== null);
registerDefinitions(definitions);

function presetOf(objects: RigObject[], modules: ModuleInstance[] = []): RigPreset {
  return { ...normalizePreset({ version: PRESET_FORMAT, name: "сцена", canvas: { width: 1000, height: 600 }, objects: [] })!, objects, modules };
}

function colorModule(config: Record<string, unknown> = {}): ModuleInstance {
  return {
    name: "color_1",
    type: "color",
    enabled: true,
    source: "manual",
    config: { ...moduleDefaults({ id: "color", title: "Цвет", kind: "color", format: 1, inputs: [], fields: [], defaults: {} } as never), ...config },
  };
}

const channel = colorChannels(colorModule())[0];

test("цвет: строка цвета разбирается в числа и собирается обратно", () => {
  expect(parseColor("#ff0000")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
  expect(parseColor("#00ff0080")?.a).toBeCloseTo(0.502, 3);
  expect(parseColor("rgba(255, 226, 170, 0.55)")).toEqual({ r: 1, g: 226 / 255, b: 170 / 255, a: 0.55 });
  expect(parseColor("rgb(0 0 255)")).toEqual({ r: 0, g: 0, b: 1, a: 1 });
  // Непонятное — не чёрный: иначе «привязал цвет» выглядело бы как «объект пропал».
  expect(parseColor("не цвет")).toBeNull();
  expect(parseColor(null)).toBeNull();

  expect(colorText({ r: 1, g: 0, b: 0, a: 0.5 })).toBe("rgba(255, 0, 0, 0.5)");
  expect(parseColor(colorText({ r: 0.2, g: 0.4, b: 0.6, a: 1 })))
    .toEqual({ r: 51 / 255, g: 102 / 255, b: 153 / 255, a: 1 });
});

test("цвет: у объекта перечислены только те цвета, которые у него есть", () => {
  const light = makeLight("l", "Свет", 100, 100);
  const shape = makeShape("s", "Фигура", 100, 100, 10, 10);
  const text = makeText("t", "Текст", 10, 10);
  expect(colorFieldsOf(light)).toEqual(["lightStart", "lightEnd"]);
  expect(colorFieldsOf(shape)).toEqual(["fill", "stroke"]);
  expect(colorFieldsOf(text)).toEqual(["text", "textStroke"]);
  // Материал добавляет свечение, спрайт без материала цветов не имеет.
  const glow = { ...light, material: undefined };
  expect(colorFieldsOf(glow)).toEqual(["lightStart", "lightEnd"]);
});

test("цвет: подстановка меняет строку цвета, не трогая остальное", () => {
  const light = makeLight("l", "Свет", 100, 100);
  const preset = presetOf([light]);
  light.colors = { lightStart: { module: "color_1", channel: "c1" } };

  const colors = resolvedColors(preset, {
    "color_1.c1_r": 0, "color_1.c1_g": 1, "color_1.c1_b": 0, "color_1.c1_a": 0.25,
  });
  expect(Object.keys(colors)).toEqual(["l"]);

  const shown = applyColors(preset, colors);
  expect(shown).not.toBe(preset);
  expect(shown.objects[0].light?.colorStart).toBe("rgba(0, 255, 0, 0.55)");
  // Край света не привязан — остался свой, вместе со своей прозрачностью.
  expect(shown.objects[0].light?.colorEnd).toBe(light.light?.colorEnd);
  // Исходный пресет не изменился: подстановка — копия на кадр.
  expect(preset.objects[0].light?.colorStart).toBe(light.light?.colorStart);
});

test("цвет: прозрачность своя по умолчанию, из канала — только по галке", () => {
  const light = makeLight("l", "Свет", 100, 100);
  const values = { "color_1.c1_r": 0, "color_1.c1_g": 0, "color_1.c1_b": 1, "color_1.c1_a": 0.25 };

  const own = presetOf([{ ...light, colors: { lightEnd: { module: "color_1", channel: "c1" } } }]);
  const kept = applyColors(own, resolvedColors(own, values));
  // Альфа края осталась своя (у света там 0) — иначе свет стал бы жёстким кругом.
  expect(kept.objects[0].light?.colorEnd).toBe("rgba(0, 0, 255, 0)");

  const takeAlpha = presetOf([{ ...light, colors: { lightEnd: { module: "color_1", channel: "c1", alpha: true } } }]);
  const taken = applyColors(takeAlpha, resolvedColors(takeAlpha, values));
  expect(taken.objects[0].light?.colorEnd).toBe("rgba(0, 0, 255, 0.25)");
});

test("цвет: пропавший модуль оставляет свой цвет, без привязок сцена та же", () => {
  const shape = { ...makeShape("s", "Фигура", 100, 100, 10, 10), colors: { fill: { module: "color_9", channel: "c1" } } };
  const preset = presetOf([shape]);
  // Канала нет во входах — подставлять нечего.
  expect(resolvedColors(preset, {})).toEqual({});
  expect(applyColors(preset, {})).toBe(preset);

  // А без привязок словарь пуст даже при живых значениях.
  const plain = presetOf([makeShape("s2", "Фигура", 100, 100, 10, 10)]);
  expect(resolvedColors(plain, { "color_1.c1_r": 1, "color_1.c1_g": 0, "color_1.c1_b": 0 })).toEqual({});
});

test("модуль цвета: режимы считают цвет по времени", () => {
  resetColorState();
  const [base] = colorChannels(colorModule());
  // Статичный — первый цвет палитры и ничего больше.
  const still = channelColorAt({ ...base, mode: "static" }, 12);
  expect(still).toEqual(parseColor(base.colors[0].color));

  // Круг идёт по палитре: через шаг (2 секунды при 100 %) цвет второй.
  const cycle = { ...base, mode: "cycle" as const };
  expect(channelColorAt(cycle, 0)).toEqual(parseColor(base.colors[0].color));
  expect(channelColorAt(cycle, 2)).toEqual(parseColor(base.colors[1].color));

  // Последовательность держит цвет своё время и не смешивает соседние.
  const sequence = { ...base, mode: "sequence" as const };
  expect(channelColorAt(sequence, 0)).toEqual(parseColor(base.colors[0].color));
  expect(channelColorAt(sequence, 0.9)).toEqual(parseColor(base.colors[0].color));
  expect(channelColorAt(sequence, 1.1)).toEqual(parseColor(base.colors[1].color));

  // Дыхание возвращается к первому цвету: полный круг — туда и обратно.
  const breathe = { ...base, mode: "breathe" as const };
  expect(channelColorAt(breathe, 0)).toEqual(parseColor(base.colors[0].color));
  expect(channelColorAt(breathe, 4)).toEqual(parseColor(base.colors[0].color));

  // Волна крутит оттенок: два разных момента — два разных цвета.
  const wave = { ...base, mode: "wave" as const };
  expect(channelColorAt(wave, 0)).not.toEqual(channelColorAt(wave, 1.5));

  // Случайный детерминирован: одно и то же окно времени даёт один цвет.
  const random = { ...base, mode: "random" as const };
  expect(channelColorAt(random, 3)).toEqual(channelColorAt(random, 3));
});

test("модуль цвета: пять входов на канал, значения 0…1, реакция на вход", () => {
  const module = colorModule();
  const specs = instanceInputs(module);
  expect(specs.map((spec) => spec.name)).toEqual(["c1_r", "c1_g", "c1_b", "c1_a", "c1_level"]);

  const values = composeValues([module], { audio: {}, manual: {}, auto: {}, now: 0, dt: 1 / 30 });
  for (const part of ["r", "g", "b", "a", "level"]) {
    const value = values[`color_1.c1_${part}`];
    expect(Number.isFinite(value), part).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  }

  // Реакция: яркость ведёт вход другого модуля, цвет стоит первым из палитры.
  resetColorState();
  const reacting = colorModule({
    channels: [
      {
        name: "c1", label: "Основной", mode: "react",
        colors: [{ color: "#ff0000", hold: 1 }],
        speed: 100, phase: 0, brightness: 100, smooth: 0,
        react: { module: "manual_1", input: "value" },
      },
    ],
  });
  const manual: ModuleInstance = {
    name: "manual_1", type: "manual", enabled: true, source: "manual",
    config: { ...moduleDefaults({ id: "manual", title: "Manual", kind: "manual", format: 1, inputs: [], fields: [], defaults: {} } as never), mode: "number", min: 0, max: 1, step: 0.01 },
  };
  const active = composeValues([reacting, manual], {
    audio: {}, auto: {}, now: 1000, dt: 1 / 30, manual: { "manual_1.value": 0.5 },
  });
  // Половина входа — половина яркости: красный 1 стал 0.5, остальные нули.
  expect(active["color_1.c1_r"]).toBeCloseTo(0.5, 2);
  expect(active["color_1.c1_g"]).toBeCloseTo(0, 2);
  expect(active["color_1.c1_level"]).toBeCloseTo(0.25, 2);
});

test("цвет: оверлей получает цвета вместе с кадром", () => {
  const protocol = readFileSync(join(process.cwd(), "src", "overlay", "protocol.ts"), "utf8");
  expect(protocol).toContain("export type FrameColors");
  expect(protocol).toContain("colors?: FrameColors");

  const host = readFileSync(join(process.cwd(), "src", "overlay", "host.ts"), "utf8");
  expect(host).toContain("setColors(colors: FrameColors)");
  expect(host).toContain("colors: Object.keys(this.colors).length ? this.colors : undefined");

  const app = readFileSync(join(process.cwd(), "src", "overlay", "OverlayApp.tsx"), "utf8");
  expect(app).toContain("applyColors(current, colors)");
});

test("цвет: секция в «Поведении» и шаблон в палитре", () => {
  const behaviour = readFileSync(join(process.cwd(), "src", "components", "BehaviourPanel.tsx"), "utf8");
  expect(behaviour).toContain("<Palette size={13} /> Цвет");
  expect(behaviour).toContain("<option value=\"\">свой цвет</option>");
  expect(behaviour).toContain("colorFieldsOf(object)");

  expect(index.modules).toContain("color");
  const template = JSON.parse(readFileSync(join(directory, "color.json"), "utf8")) as { kind: string };
  expect(template.kind).toBe("color");

  const scene = readFileSync(join(process.cwd(), "src", "components", "Scene.tsx"), "utf8");
  expect(scene).toContain("applyColors(preset, colors)");
});
