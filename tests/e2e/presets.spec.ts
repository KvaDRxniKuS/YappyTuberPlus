import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeDefinition, registerDefinitions } from "../../src/modules/registry";
import { normalizeModules } from "../../src/engine/preset";
import {
  moduleConstants, presetConstants, presetEntries, presetGlobals, presetInputs, presetIssues,
  presetPreview, presetVariable, rewardInputName,
} from "../../src/modules/presets";
import { composeValues } from "../../src/modules/values";
import { DEFAULT_BEHAVIOUR, behaviourBlock, readBehaviour, writeBehaviour } from "../../src/engine/behaviour";
import { DEFAULT_BASE, type ModuleInstance, type RigObject } from "../../src/types";

/** В Node нет fetch к папке modules: кладём шаблоны в библиотеку руками. */
test.beforeAll(() => {
  const directory = join(process.cwd(), "public", "modules");
  const index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")) as { modules: string[] };
  registerDefinitions(index.modules
    .map((id) => normalizeDefinition(JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"))))
    .filter((definition): definition is NonNullable<typeof definition> => definition !== null));
});

/** Twitch-модуль с двумя наградами: «Лето» и «Зима». */
function twitchModule(): ModuleInstance {
  return {
    name: "twitch",
    type: "twitch",
    enabled: true,
    source: "live",
    config: {
      source: {
        transport: "twitch",
        url: "",
        reconnect: true,
        intervalMs: 1000,
        mapping: [
          { input: "reward", path: "$.payload.event.reward.cost", min: 0, max: 1_000_000, holdMs: 3000 },
          { input: "redeem_summer", path: "$.payload.event.reward.title", min: 0, max: 1, fallback: 1, holdMs: 5000, when: { path: "$.payload.event.reward.title", equals: "Лето" } },
          { input: "redeem_winter", path: "$.payload.event.reward.title", min: 0, max: 1, fallback: 1, holdMs: 5000, when: { path: "$.payload.event.reward.title", equals: "Зима" } },
        ],
      },
    },
  };
}

function presetsModule(config: ModuleInstance["config"] = {}): ModuleInstance {
  const presets = JSON.parse(readFileSync(join(process.cwd(), "public", "modules", "presets.json"), "utf8"));
  return {
    name: "presets_1",
    type: "presets",
    enabled: true,
    source: "manual",
    config: { ...presets.defaults, ...config },
  };
}

test("пресеты: подписи дают имена для скрипта, номера идут по порядку", () => {
  const module = presetsModule({
    presets: [{ name: "summer", label: "Летний костюм" }, { name: "winter", label: "Зимний" }],
  });
  expect(presetEntries(module).map((entry) => entry.name)).toEqual(["summer", "winter"]);
  expect(presetVariable(module)).toBe("preset");

  const inputs = presetInputs(module);
  expect(inputs.map((input) => input.name)).toEqual(["value", "summer", "winter"]);
  expect(inputs[0].max).toBe(1);

  // Имя награды — префикс плюс имя пресета: в модуле Twitch это redeem_summer.
  expect(rewardInputName("redeem", { name: "summer", label: "Лето" })).toBe("redeem_summer");
});

test("пресеты: переменная приводится к пригодному имени, предпросмотр зажат", () => {
  const module = presetsModule({ variable: "Летний Образ", preview: 17 });
  expect(presetVariable(module)).toBe("letnii_obraz");
  // Пресетов два, значит показывать можно только −1, 0 и 1.
  expect(presetPreview(module)).toBe(1);
  expect(presetPreview(presetsModule({ preview: -5 }))).toBe(-1);
});

test("пресеты: константы читаются по короткому и полному имени", () => {
  const modules = [presetsModule(), twitchModule()];
  const constants = presetConstants(modules);
  expect(constants.summer).toBe(0);
  expect(constants.presets_1_summer).toBe(0);
  expect(constants.presets_1_winter).toBe(1);
  // Общий набор включает и состояния manual — здесь их нет, но пресеты есть.
  expect(moduleConstants(modules).winter).toBe(1);
});

test("пресеты: события из наград пишутся в глобальный скрипт сами", () => {
  const modules = [presetsModule(), twitchModule()];
  const globals = presetGlobals(modules, "blink = auto.blink");
  expect(globals).toContain("blink = auto.blink");
  expect(globals).toContain("on start { preset = -1 }");
  expect(globals).toContain("on presets_1.summer.up { preset = 0 }");
  expect(globals).toContain("on twitch.redeem_summer.up { preset = 0 }");
  expect(globals).toContain("on twitch.redeem_winter.up { preset = 1 }");
  expect(globals).toContain("# ── конец пресетов ──");
});

test("пресеты: без галочки «искать среди наград» события наград не пишутся", () => {
  const modules = [presetsModule({ rewardSearch: false }), twitchModule()];
  const globals = presetGlobals(modules, "");
  expect(globals).not.toContain("twitch.redeem_summer");
  expect(globals).toContain("on presets_1.summer.up { preset = 0 }");
});

test("пресеты: недостающая награда — предупреждение, а не поломка", () => {
  const modules = [presetsModule(), twitchModule()];
  const missing = presetsModule({ presets: [{ name: "autumn", label: "Осень" }] });
  const issues = presetIssues(missing, [...modules]);
  expect(issues.some((issue) => issue.includes("twitch.redeem_autumn"))).toBe(true);

  // Переменная занята другим модулем пресетов — тоже предупреждение.
  const other = { ...presetsModule({ variable: "preset" }), name: "presets_2" };
  const clash = presetIssues(presetsModule({ variable: "preset" }), [other, twitchModule()]);
  expect(clash.some((issue) => issue.includes("preset"))).toBe(true);
});

test("пресеты: предпросмотр в панели даёт значения входов", () => {
  const modules = [presetsModule({ preview: 1 }), twitchModule()];
  const values = composeValues(modules, { audio: {}, manual: {}, auto: {} });
  expect(values["presets_1.value"]).toBe(1);
  expect(values["presets_1.winter"]).toBe(1);
  expect(values["presets_1.summer"]).toBe(0);
});

test("пресеты: настройки переживают загрузку пресета", () => {
  const loaded = normalizeModules([{
    name: "presets_1",
    type: "presets",
    enabled: true,
    source: "manual",
    config: {
      presets: [{ name: "летний", label: "Летний" }],
      variable: "look",
      rewardSearch: true,
      rewardModules: ["twitch"],
      rewardPrefixes: ["redeem", "gift"],
      preview: 0,
    },
  }])[0];
  expect(presetVariable(loaded)).toBe("look");
  // Кириллица переводится в латиницу: «й» даёт `i`, как у состояний manual.
  expect(presetEntries(loaded)[0].name).toBe("letnii");
  expect(loaded.config.rewardPrefixes).toEqual(["redeem", "gift"]);
  expect(presetPreview(loaded)).toBe(0);
});

test("поведение: условие по пресетам дописывает множитель в visible", () => {
  const object: RigObject = {
    id: "coat", name: "Куртка", kind: "sprite", enabled: true, image: null, parentId: null,
    pivot: { x: 0.5, y: 0.5 }, base: { ...DEFAULT_BASE }, script: "", width: 100, height: 100,
  };
  const only = { ...DEFAULT_BEHAVIOUR, mouth: "open" as const, presets: [{
    module: "presets_1", variable: "preset", mode: "only" as const, names: ["summer", "winter"],
  }] };
  const block = behaviourBlock(only, object);
  expect(block).toContain("preset == presets_1_summer or preset == presets_1_winter ? 1 : 0");
  // Рот и пресеты перемножаются: одно не отменяет другое.
  expect(block).toMatch(/visible = .+\* \(\(preset ==/);

  const except = { ...only, presets: [{ module: "presets_1", variable: "preset", mode: "except" as const, names: ["winter"] }] };
  expect(behaviourBlock(except, object)).toContain("preset == presets_1_winter ? 0 : 1");

  // Пустой список — условия нет: объект не исчезает у всех подряд.
  const empty = { ...only, presets: [{ module: "presets_1", variable: "preset", mode: "only" as const, names: [] }] };
  expect(behaviourBlock(empty, object)).not.toContain("preset ==");

  // Настройки возвращаются из блока скрипта как есть.
  const written = writeBehaviour(object.script, only, object).script;
  expect(readBehaviour(written).presets).toEqual(only.presets);
});
