import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLINK_OUTPUT_BASE, autoBlinkEyeInput, autoBlinkInputs, autoBlinkOutputs, blinkRandom, blinkSeed,
  blinkSpread, blinkState, blinkTick, sanitizeBlinkName, uniqueBlinkName,
  type BlinkOutput,
} from "../../src/modules/autoblink";
import { composeValues } from "../../src/modules/values";
import { normalizeDefinition, registerDefinitions } from "../../src/modules/registry";
import { DEFAULT_MODULES, type ModuleInstance } from "../../src/types";
import { DEFAULT_BEHAVIOUR, behaviourBlock, readBehaviour } from "../../src/engine/behaviour";
import type { RigObject } from "../../src/types";

/*
 * Модуль «Моргание»: несколько выводов и семечко.
 *
 * Проверяем числа, а не текст: таймер — это расписание, и «примерно так» здесь
 * не годится. Главное, что сторожат тесты:
 *
 * 1. старый пресет с полями наверху (`period`, `hold`…) превращается в один
 *    вывод `blink`, поэтому формулы `auto.blink` продолжают работать;
 * 2. у каждого вывода свой вход и свои границы;
 * 3. два вывода с одинаковыми числами **не** моргают в такт — за это отвечает
 *    семечко, замешанное на именах модуля и вывода;
 * 4. один и тот же пресет моргает одинаково: семечко делает рисунок повторяемым.
 */

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

const output = (patch: Partial<BlinkOutput> = {}): BlinkOutput => ({ ...BLINK_OUTPUT_BASE, ...patch });

const blinkModule = (config: Record<string, unknown>, name = "auto"): ModuleInstance => ({
  name,
  type: "autoblink",
  enabled: true,
  source: "manual",
  // Настройки как в старом пресете: без слияния с шаблоном, иначе проверка
  // переноса полей наверх ничего не проверит.
  config,
});

test("старый пресет: поля наверху становятся единственным выводом blink", () => {
  const module = blinkModule({ period: 6000, hold: 200, jitter: 10, min: 0.2, max: 0.8 });
  const outputs = autoBlinkOutputs(module);
  expect(outputs).toHaveLength(1);
  expect(outputs[0]).toMatchObject({ name: "blink", period: 6000, hold: 200, jitter: 10, min: 0.2, max: 0.8, seed: 0 });
  // Входы экземпляра — из выводов, а не из шаблона.
  expect(autoBlinkInputs(module).map((input) => input.name)).toEqual(["blink"]);
  expect(autoBlinkInputs(module)[0]).toMatchObject({ min: 0.2, max: 0.8 });
});

test("несколько выводов: вход на каждый, имена уникальны, границы свои", () => {
  const module = blinkModule({
    outputs: [
      { name: "blink", label: "Глаза", period: 4200, hold: 140, jitter: 35, min: 0, max: 1, seed: 0 },
      { name: "blink", label: "Брови", period: 9000, hold: 300, jitter: 60, min: 0.1, max: 0.5, seed: 7 },
      { name: "Blink!2", label: "", period: 1, hold: 99999, jitter: 500, min: 0.9, max: 0.2, seed: 99999 },
    ],
  });
  const outputs = autoBlinkOutputs(module);
  expect(outputs.map((item) => item.name)).toEqual(["blink", "blink_2", "blink_2_2"]);
  // Имена пригодны для скрипта, а пустая подпись берётся из имени.
  expect(outputs[1].label).toBe("Брови");
  expect(outputs[2].label).toBe("blink_2_2");
  // Границы полей приводятся к допустимым, а min/max не переворачиваются.
  expect(outputs[2].period).toBe(500);
  expect(outputs[2].hold).toBe(2000);
  expect(outputs[2].jitter).toBe(90);
  expect(outputs[2].seed).toBe(9999);
  expect(outputs[2].min).toBeLessThan(outputs[2].max);
  // Входов столько же, сколько выводов.
  expect(autoBlinkInputs(module).map((input) => input.name)).toEqual(["blink", "blink_2", "blink_2_2"]);
  expect(autoBlinkInputs(module)[1].min).toBe(0.1);
});

test("имена выводов: латиница, цифры и подчёркивание", () => {
  expect(sanitizeBlinkName("Blink 2")).toBe("blink_2");
  expect(sanitizeBlinkName("2")).toBe("b_2");
  expect(sanitizeBlinkName("!!!")).toBe("blink");
  expect(uniqueBlinkName([output({ name: "blink" })], "blink")).toBe("blink_2");
  expect(uniqueBlinkName([output({ name: "blink" }), output({ name: "blink_2" })], "blink")).toBe("blink_3");
});

test("значения двух выводов доходят до скрипта под своими именами", () => {
  const module = blinkModule({
    outputs: [
      { name: "blink", label: "Глаза", period: 4200, hold: 140, jitter: 35, min: 0, max: 1, seed: 0 },
      { name: "brow", label: "Брови", period: 9000, hold: 300, jitter: 60, min: 0.1, max: 0.5, seed: 3 },
    ],
  });
  const values = composeValues([module], {
    audio: {},
    manual: {},
    auto: { "auto.blink": 1, "auto.brow": 0.25 },
  });
  expect(values["auto.blink"]).toBe(1);
  expect(values["auto.brow"]).toBe(0.25);
  // Выключенный вход не уходит в кадр вовсе.
  const hidden = composeValues([{ ...module, disabledInputs: ["brow"] }], {
    audio: {},
    manual: {},
    auto: { "auto.blink": 1, "auto.brow": 0.25 },
  });
  expect(hidden["auto.blink"]).toBe(1);
  // Выключенный вход не просто равен нулю — его нет в кадре вовсе.
  expect(hidden["auto.brow"]).toBeUndefined();
});

test("семечко: одинаковые числа у двух выводов дают разные рисунки", () => {
  // Одно и то же семечко, разные имена выводов — разные ключи генератора.
  expect(blinkSeed(42, "auto", "blink")).not.toBe(blinkSeed(42, "auto", "blink_2"));
  // Разные семечки того же вывода — тоже разные.
  expect(blinkSeed(42, "auto", "blink")).not.toBe(blinkSeed(43, "auto", "blink"));
  // Один и тот же пресет — один и тот же рисунок: семечко повторяемо.
  expect(blinkSeed(42, "auto", "blink")).toBe(blinkSeed(42, "auto", "blink"));

  const stream = (name: string) => {
    const random = blinkRandom(42, "auto", name);
    return Array.from({ length: 5 }, () => random.next());
  };
  expect(stream("blink")).not.toEqual(stream("blink_2"));
  expect(stream("blink")).toEqual(stream("blink"));
});

test("расписание: интервал, длительность и разброс соблюдены", () => {
  // Без разброса интервал ровно такой, как задан.
  const steady = output({ period: 4000, hold: 200, jitter: 0, seed: 11 });
  const state = blinkState(1000, steady, "auto");
  // Первое моргание — не сразу: от половины до целого интервала.
  expect(state.next - 1000).toBeGreaterThanOrEqual(2000);
  expect(state.next - 1000).toBeLessThanOrEqual(4000);
  // Момент моргания запоминаем до шага: таймер сдвигает его сам.
  const blink = state.next;
  // До моргания вход стоит на минимуме, в моргании — на максимуме.
  expect(blinkTick(state, steady, blink - 1)).toBe(steady.min);
  expect(blinkTick(state, steady, blink)).toBe(steady.max);
  expect(blinkTick(state, steady, blink + 100)).toBe(steady.max);
  // Длительность вышла — вход вернулся на минимум.
  expect(blinkTick(state, steady, blink + 400)).toBe(steady.min);
  // Следующее моргание — ровно через интервал: разброс нулевой.
  expect(state.next - blink).toBeGreaterThanOrEqual(steady.period);

  // Разброс 90 % на коротком интервале не превращается в «моргание без паузы».
  expect(blinkSpread(output({ period: 1000, hold: 900, jitter: 90 })).shortest).toBeGreaterThanOrEqual(940);
  const wide = blinkSpread(output({ period: 4000, hold: 100, jitter: 50 }));
  expect(wide.shortest).toBeCloseTo(2000, 6);
  expect(wide.longest).toBeCloseTo(6000, 6);
});

test("расписание: два вывода с одинаковыми настройками не совпадают", () => {
  // Одинаковые числа, разные имена: первые моргания обязаны разойтись.
  const same = { period: 4200, hold: 140, jitter: 35, min: 0, max: 1, seed: 0 };
  const first = blinkState(0, output({ ...same, name: "blink" }), "auto");
  const second = blinkState(0, output({ ...same, name: "blink_2" }), "auto");
  expect(first.next).not.toBeCloseTo(second.next, 3);

  // И два вывода одного модуля с одинаковым семечком — тоже.
  const seed = 12345;
  const a = blinkRandom(seed, "auto", "blink");
  const b = blinkRandom(seed, "auto", "blink_2");
  expect(a.next()).not.toBe(b.next());
});

test("глаз берёт вывод blink, а если его нет — первый", () => {
  expect(autoBlinkEyeInput(blinkModule({ outputs: [
    { name: "brow", label: "Брови", period: 4200, hold: 140, jitter: 35, min: 0, max: 1, seed: 0 },
    { name: "blink", label: "Глаза", period: 4200, hold: 140, jitter: 35, min: 0, max: 1, seed: 0 },
  ] }))).toBe("blink");
  expect(autoBlinkEyeInput(blinkModule({ outputs: [
    { name: "brow", label: "Брови", period: 4200, hold: 140, jitter: 35, min: 0, max: 1, seed: 0 },
  ] }))).toBe("brow");
});

test("поведение: видимость глаза читает выбранный вывод", () => {
  const object = {
    id: "eye", name: "Глаз", kind: "sprite", script: "",
    width: 100, height: 100, pivot: { x: 0.5, y: 0.5 },
  } as unknown as RigObject;
  const closed = behaviourBlock({ ...DEFAULT_BEHAVIOUR, eye: "closed", eyeModule: "auto", eyeInput: "blink_2" }, object);
  expect(closed).toContain("auto.blink_2");
  expect(closed).not.toContain("auto.blink ");
  const open = behaviourBlock({ ...DEFAULT_BEHAVIOUR, eye: "open", eyeModule: "auto", eyeInput: "brow" }, object);
  expect(open).toContain("1 - auto.brow");
  // Пустое имя входа не оставляет формулу без входа: работаем как раньше.
  const fallback = behaviourBlock({ ...DEFAULT_BEHAVIOUR, eye: "closed", eyeModule: "auto", eyeInput: "" }, object);
  expect(fallback).toContain("auto.blink");
});

test("поведение: имя вывода переживает чтение блока из скрипта", () => {
  const script = [
    "// @behaviour {\"eye\":\"closed\",\"eyeModule\":\"auto\",\"eyeInput\":\"blink_2\"}",
    "visible = auto.blink_2",
  ].join("\n");
  expect(readBehaviour(script).eyeInput).toBe("blink_2");
  // Старый блок без поля читается с именем по умолчанию.
  const old = "// @behaviour {\"eye\":\"closed\",\"eyeModule\":\"auto\"}";
  expect(readBehaviour(old).eyeInput).toBe("blink");
});

test("шаблон модуля: стартовый вывод и никаких полей в шаблоне", () => {
  const template = JSON.parse(readFileSync(join(process.cwd(), "public", "modules", "autoblink.json"), "utf8")) as {
    inputs: Array<{ name: string }>;
    fields: unknown[];
    defaults: { outputs: BlinkOutput[] };
  };
  // Первый вход остаётся в шаблоне: по нему видно, что модуль вообще отдаёт.
  expect(template.inputs.map((input) => input.name)).toEqual(["blink"]);
  expect(template.fields).toEqual([]);
  expect(template.defaults.outputs).toHaveLength(1);
  expect(template.defaults.outputs[0]).toMatchObject({ name: "blink", period: 4200, seed: 0 });
});

test("новый пресет: у модуля моргания есть вывод с настройками и семечком", () => {
  const auto = DEFAULT_MODULES.find((module) => module.type === "autoblink");
  expect(auto).toBeTruthy();
  const outputs = autoBlinkOutputs(auto!);
  expect(outputs).toHaveLength(1);
  expect(outputs[0].name).toBe("blink");
  expect(outputs[0].seed).toBe(0);
  expect(Number.isFinite(outputs[0].period)).toBe(true);
});
