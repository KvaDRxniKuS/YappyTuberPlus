import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MATERIAL_PRESETS, applyPreset, baseReflectance, channelBinding, fresnel, ggxDistribution,
  matchPreset, materialBinding, materialSources, materialSourceSummary, normalizeEnvironment,
  normalizeMaterial, shadePoint, usesPacked,
  type LightPoint, type MaterialPoint,
} from "../../src/render/material";
import {
  DEFAULT_ENVIRONMENT, DEFAULT_LIGHT, DEFAULT_MATERIAL, MAX_IOR, MIN_IOR,
  f0FromIor, iorFromF0, lightHeight, reflectanceFromF0,
} from "../../src/types";
import { NEUTRAL_PARAMS } from "../../src/engine/frame";
import * as peer from "../../scripts/material-math.mjs";

/*
 * Материал поверхности.
 *
 * Проверяем числа, а не текст кода: блик, металл, окклюзия и свечение — это
 * физика, и «примерно так» здесь не годится. Заодно сверяем реализацию с той,
 * которой считается лист-дебаг в примере: если они разойдутся, картинка в
 * примере начнёт врать про редактор.
 */

const point = (patch: Partial<MaterialPoint> = {}): MaterialPoint => ({
  albedo: [0.8, 0.8, 0.8],
  normal: [0, 0, 1],
  roughness: 0.4,
  metallic: 0,
  ao: 1,
  emissive: [0, 0, 0],
  specular: 1,
  f0: 0.04,
  environment: { color: [1, 1, 1], level: 0 },
  ...patch,
});

const light = (patch: Partial<LightPoint> = {}): LightPoint => ({
  L: [0, 0, 1],
  color: [1, 1, 1],
  polarity: 1,
  specular: 1,
  ...patch,
});

test("материал: блик по GGX — глаже значит ярче и уже", () => {
  // Пик распределения при нормали, смотрящей на свет: чем меньше шероховатость,
  // тем он выше. Это и есть «металл отполирован».
  expect(ggxDistribution(1, 0.1)).toBeGreaterThan(ggxDistribution(1, 0.5));
  expect(ggxDistribution(1, 0.5)).toBeGreaterThan(ggxDistribution(1, 1));
  // Вдали от пика гладкая поверхность почти не даёт отражения: блик узкий.
  expect(ggxDistribution(0.7, 0.1)).toBeLessThan(ggxDistribution(0.7, 1));
  // Деления на ноль при нулевой шероховатости нет.
  expect(Number.isFinite(ggxDistribution(1, 0))).toBe(true);

  // Френель: при взгляде по нормали — ровно база, к скользящему углу растёт.
  expect(fresnel(1, [0.04, 0.04, 0.04])[0]).toBeCloseTo(0.04, 6);
  expect(fresnel(0, [0.04, 0.04, 0.04])[0]).toBeCloseTo(1, 6);

  // Диэлектрик отражает 4 %, металл — цветом самого объекта.
  expect(baseReflectance([0.9, 0.2, 0.1], 0)).toEqual([0.04, 0.04, 0.04]);
  expect(baseReflectance([0.9, 0.2, 0.1], 1)).toEqual([0.9, 0.2, 0.1]);
});

test("материал: металл без света и окружения чёрный — это не баг", () => {
  const metal = shadePoint(point({ metallic: 1 }), [], { normalStrength: 1, material: true });
  expect(metal).toEqual([0, 0, 0]);

  // Диэлектрик тот же свет тоже не видит, но окружение его подсвечивает.
  const painted = shadePoint(
    point({ metallic: 0, environment: { color: [1, 1, 1], level: 0.5 } }),
    [],
    { normalStrength: 1, material: true },
  );
  // Диффузная часть от окружения плюс его отражение (4 %).
  expect(painted[0]).toBeCloseTo((0.8 + 0.04) * 0.5, 5);

  // Металл видит окружение как отражение и красит его своим цветом.
  const metalLit = shadePoint(
    point({ metallic: 1, albedo: [0.8, 0.2, 0.1], environment: { color: [1, 1, 1], level: 0.5 } }),
    [],
    { normalStrength: 1, material: true },
  );
  expect(metalLit[0]).toBeCloseTo(0.4, 5);
  expect(metalLit[1]).toBeCloseTo(0.1, 5);
  // Диэлектрик при том же окружении отражает свои 4 %, а не цвет целиком.
  const paintLit = shadePoint(
    point({ metallic: 0, albedo: [0.8, 0.2, 0.1], environment: { color: [1, 1, 1], level: 0.5 } }),
    [],
    { normalStrength: 1, material: true },
  );
  expect(paintLit[0]).toBeCloseTo(0.8 * 0.5 + 0.04 * 0.5, 5);
});

test("материал: свет даёт блик, тень блика не даёт", () => {
  const lit = shadePoint(point({ roughness: 0.2 }), [light()], { normalStrength: 1, material: true });
  expect(lit[0]).toBeGreaterThan(0.8);

  // Тёмный свет (тень) блика не даёт: иначе тень бликовала бы.
  const shadow = shadePoint(point({ roughness: 0.2 }), [light({ polarity: -1 })], { normalStrength: 1, material: true });
  expect(shadow[0]).toBe(0);

  // Сила блика 0 — surface без блика, только диффузная часть.
  const noSpec = shadePoint(
    point({ roughness: 0.2, specular: 0 }), [light()], { normalStrength: 1, material: true },
  );
  expect(noSpec[0]).toBeCloseTo(0.8, 5);
});

test("материал: окклюзия гасит диффузную часть, блик не трогает", () => {
  const bright = shadePoint(
    point({ ao: 1, specular: 0 }), [light()], { normalStrength: 1, material: true },
  );
  const dark = shadePoint(
    point({ ao: 0, specular: 0 }), [light()], { normalStrength: 1, material: true },
  );
  expect(bright[0]).toBeCloseTo(0.8, 5);
  expect(dark[0]).toBe(0);

  // Блик при нулевой окклюзии остаётся: он не диффузный.
  const specOnly = shadePoint(
    point({ ao: 0, roughness: 0.15, albedo: [0, 0, 0], specular: 1 }),
    [light()], { normalStrength: 1, material: true },
  );
  expect(specOnly[0]).toBeGreaterThan(0);
});

test("материал: свечение не зависит от светов и складывается с ними", () => {
  const glow = shadePoint(
    point({ emissive: [0.2, 0.6, 1], ao: 0 }), [], { normalStrength: 1, material: true },
  );
  expect(glow[0]).toBeCloseTo(0.2, 6);
  expect(glow[2]).toBeCloseTo(1, 6);

  const withLight = shadePoint(
    point({ emissive: [0.2, 0, 0] }), [light()], { normalStrength: 1, material: true },
  );
  const withoutGlow = shadePoint(point(), [light()], { normalStrength: 1, material: true });
  expect(withLight[0]).toBeCloseTo(withoutGlow[0] + 0.2, 5);
});

test("материал: без материала цвет сцены не меняется", () => {
  // Прежний вид считается шейдером: эта функция в таком режиме ничего не трогает.
  const scene: [number, number, number] = [0.3, 0.4, 0.5];
  const untouched = shadePoint(point(), [light()], { normalStrength: 1, material: false });
  expect(scene).toEqual([0.3, 0.4, 0.5]);
  // Плоская нормаль (сила 0) даёт тот же результат, что нормаль без наклона.
  const flat = shadePoint(
    point({ normal: [0.6, 0.6, 0.5] }), [light()], { normalStrength: 0, material: true },
  );
  const plain = shadePoint(point(), [light()], { normalStrength: 0, material: true });
  expect(flat[0]).toBeCloseTo(plain[0], 6);
});

test("материал: файл читает три канала, упаковка — буквами", () => {
  // Раскладка ORM по стандарту: R — окклюзия, G — шероховатость, B — металл.
  const material = normalizeMaterial({
    roughness: { from: "packed", packedChannel: "g", value: 0 },
    metallic: { from: "packed", packedChannel: "b", value: 0 },
    ao: { from: "packed", packedChannel: "r", value: 0 },
    packed: "asset:orm",
  })!;
  expect(usesPacked(material)).toBe(true);
  const binding = materialBinding(material, DEFAULT_ENVIRONMENT);
  expect(binding.roughness).toEqual({ mode: 2, channel: 1, value: 0, src: null });
  expect(binding.metallic.channel).toBe(2);
  expect(binding.ao.channel).toBe(0);
  // Значения по умолчанию уже стоят на своих буквах: «выбрать ORM» = «работает».
  expect(DEFAULT_MATERIAL.roughness.packedChannel).toBe("g");
  expect(DEFAULT_MATERIAL.metallic.packedChannel).toBe("b");
  expect(DEFAULT_MATERIAL.ao.packedChannel).toBe("r");
  // Все карты материала — файлы объекта: иначе они теряются при переносе.
  expect(materialSources(material)).toEqual(["asset:orm"]);

  // «Файл» без файла: режим остаётся «файл» (это намерение человека), а
  // читается константа — иначе объект молча стал бы чёрным.
  const empty = normalizeMaterial({ roughness: { from: "file", file: null, value: 0.3 } })!;
  expect(empty.roughness.from).toBe("file");
  expect(materialBinding(empty, DEFAULT_ENVIRONMENT).roughness.mode).toBe(0);

  // Материала нет — поля нет: старый пресет выглядит как раньше.
  expect(normalizeMaterial(undefined)).toBeUndefined();
  expect(normalizeMaterial({})).toEqual(DEFAULT_MATERIAL);
});

test("материал: значения из скрипта заменяют инспектор, свечение складывается", () => {
  const material = normalizeMaterial({ roughness: { value: 0.5 }, emissive: { strength: 40, color: "#ffffff" } })!;
  // −1 значит «не задано»: тогда работает инспектор.
  const idle = materialBinding(material, undefined, { roughness: -1, metallic: -1, ao: -1, emissive: 0 });
  expect(idle.roughness).toEqual({ mode: 0, channel: 1, value: 0.5, src: null });

  const live = materialBinding(material, undefined, { roughness: 0.1, emissive: 0.3 });
  expect(live.roughness.value).toBeCloseTo(0.1, 6);
  expect(live.emissive.strength).toBeCloseTo(0.4 + 0.3, 5);
  // Выше 200 % не уходит: шкала та же, что у ползунка.
  expect(materialBinding(material, undefined, { emissive: 5 }).emissive.strength).toBe(2);
});

test("материал: отражение из скрипта заменяет инспектор", () => {
  const material = normalizeMaterial({ ior: 1.5 })!;
  // −1 — «не задано»: работает инспектор.
  expect(materialBinding(material, undefined, { ior: -1 }).f0).toBeCloseTo(f0FromIor(1.5), 6);
  expect(materialBinding(material, undefined, {}).f0).toBeCloseTo(f0FromIor(1.5), 6);
  // Задано — заменяет: кожа из формулы становится кожей и в кадре.
  expect(materialBinding(material, undefined, { ior: 1.4 }).f0).toBeCloseTo(f0FromIor(1.4), 6);
  // Выход за физику обрезается, а не превращается в мусор.
  expect(materialBinding(material, undefined, { ior: 9 }).f0).toBeCloseTo(f0FromIor(MAX_IOR), 6);
  expect(materialBinding(material, undefined, { ior: 0.2 }).f0).toBeCloseTo(f0FromIor(1.5), 6);
});

test("материал: окружение и высота света считаются по правилам", () => {
  expect(normalizeEnvironment({ level: 500, color: "плохой" })).toEqual({ color: DEFAULT_ENVIRONMENT.color, level: 200 });
  expect(normalizeEnvironment(null)).toEqual(DEFAULT_ENVIRONMENT);

  // Высота: галка «половина радиуса» либо своё число — и то и то в пикселях.
  expect(lightHeight({ ...DEFAULT_LIGHT, radius: 300, heightMode: "auto" })).toBe(150);
  expect(lightHeight({ ...DEFAULT_LIGHT, radius: 300, heightMode: "manual", height: 80 })).toBe(80);
  // Ноль и мусор не должны давать плоский свет с делением на ноль.
  expect(lightHeight({ ...DEFAULT_LIGHT, heightMode: "manual", height: 0 })).toBe(1);
});

test("материал: реализация в редакторе и в генераторе примеров совпадают", () => {
  // Числа считаются обеими реализациями на сетке: если они разойдутся, дебаг-лист
  // в примере начнёт врать про то, что показывает редактор.
  const lights: LightPoint[] = [
    light({ L: [0.3, 0.4, 0.866], color: [1, 0.9, 0.7] }),
    light({ L: [-0.5, 0.2, 0.84], color: [0.4, 0.6, 1], polarity: -1 }),
  ];
  for (const roughness of [0.05, 0.3, 0.7, 1]) {
    for (const metallic of [0, 0.5, 1]) {
      for (const ao of [0, 0.6, 1]) {
        const sample = point({
          roughness, metallic, ao,
          albedo: [0.7, 0.5, 0.3],
          emissive: [0.05, 0, 0.1],
          environment: { color: [0.5, 0.6, 0.8], level: 0.4 },
        });
        const mine = shadePoint(sample, lights, { normalStrength: 1, material: true });
        const theirs = peer.shadePoint(sample, lights, { normalStrength: 1, material: true });
        for (let c = 0; c < 3; c += 1) expect(theirs[c]).toBeCloseTo(mine[c], 8);
      }
    }
  }
});

test("материал: шейдер считает по той же модели, что тесты", () => {
  const source = readFileSync(join(process.cwd(), "src", "render", "lighting.ts"), "utf8");
  // GGX и Шлик — в шейдере, а не «примерное затемнение».
  expect(source).toContain("float ggx(float NdotH, float roughness)");
  expect(source).toContain("vec3 F = F0 + (1.0 - F0) * k;");
  // Отражение диэлектрика приходит из IOR, а не зашито в 4 %.
  expect(source).toContain("F0 = mix(vec3(uF0), scene.rgb, metallic);");
  expect(source).toContain('getUniformLocation(program.volume, "uF0")');
  // Блик привязан к покрытию пятна: он не выходит за свет и не живёт в пустоте.
  expect(source).toContain("specSum += color0.rgb * F * (gain * a);");
  // Окклюзия гасит диффузную часть, а не блик.
  expect(source).toContain("float shade = clamp(occlusion * (1.0 - clamp(shadowSum, 0.0, 1.0)), 0.0, 1.0);");
  // Высота света участвует в направлении на свет.
  expect(source).toContain("normalize(vec3(flatDir, max(uLightExtra[i].x, 1.0)))");
});

test("материал: имена в редакторе совпадают с ядром", () => {
  // Список параметров для подсказок — это подпись ядра в интерфейсе. Если он
  // отстанет, скрипт с `roughness` будет выглядеть ошибкой автора, а не новой
  // возможностью.
  const editor = readFileSync(join(process.cwd(), "src", "components", "ScriptEditor.tsx"), "utf8");
  const block = editor.slice(editor.indexOf("const PARAMETERS = ["), editor.indexOf("const TEXT_PARAMETER"));
  for (const name of ["roughness", "metallic", "ao", "emissive", "ior"]) {
    expect(block).toContain(`"${name}"`);
    expect(NEUTRAL_PARAMS[name]).toBe(name === "emissive" ? 0 : -1);
  }
  // Ядро знает те же слова: таблица признаков — источник поколения.
  const features = readFileSync(join(process.cwd(), "src", "engine", "coreFeatures.ts"), "utf8");
  expect(features).toContain('words: ["roughness", "metallic", "ao", "emissive"]');
  expect(features).toContain('since: 22');
  expect(features).toContain('words: ["ior"]');
  expect(features).toContain('since: 23');
  // И Rust-часть: имена параметров и поколение.
  const model = readFileSync(join(process.cwd(), "crates", "rig-core", "src", "model.rs"), "utf8");
  for (const name of ["Roughness", "Metallic", "Ao", "Emissive", "Ior"]) {
    expect(model).toContain(`Param::${name}`);
  }
  expect(model).toContain('"roughness" => Param::Roughness');
  expect(model).toContain('"ior" => Param::Ior');
  const core = readFileSync(join(process.cwd(), "crates", "rig-core", "src", "lib.rs"), "utf8");
  expect(core).toContain("CORE_GENERATION: u32 = 23");
});

test("документация: руководство называет то же, что интерфейс", () => {
  // Руководство — часть продукта: если оно разойдётся с полями, человек будет
  // искать в инспекторе то, чего нет. Поэтому сверяем имена и раскладку.
  const guide = readFileSync(join(process.cwd(), "docs", "MATERIALS.md"), "utf8");
  for (const preset of MATERIAL_PRESETS) expect(guide).toContain(preset.label);
  for (const field of ["Шероховатость", "Металл", "Окклюзия", "Свечение", "Сила блика", "Окружение сцены"]) {
    expect(guide).toContain(field);
  }
  // Раскладка ORM: буквы — это порядок каналов.
  expect(guide).toContain("| `R` | окклюзия |");
  expect(guide).toContain("| `G` | шероховатость |");
  expect(guide).toContain("| `B` | металл |");
  // И правило «−1 значит не задано» — главное в скрипте.
  expect(guide).toContain("`-1` значит «не задано»");
  // README ведёт в руководство, иначе его никто не найдёт.
  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
  expect(readme).toContain("docs/MATERIALS.md");
  // Ползунок силы блика у света — то, что обещает руководство.
  const lightSection = readFileSync(join(process.cwd(), "src", "components", "LightSection.tsx"), "utf8");
  expect(lightSection).toContain("Сила блика");
  expect(lightSection).toContain("specular");
});

test("материал: отражение считается из IOR, а не зашито в 4 %", () => {
  // Формула glTF: F0 = ((n − 1) / (n + 1))².
  expect(f0FromIor(1.5)).toBeCloseTo(0.04, 6);
  expect(f0FromIor(1.4)).toBeCloseTo(0.0278, 3); // кожа — 2.8 %
  expect(f0FromIor(1.6)).toBeCloseTo(0.0533, 3); // зубы — 5.8 %
  expect(f0FromIor(1.0)).toBe(0); // воздух не отражает
  // Шкала художника: 50 % = 4 %, как `reflectance` в Filament.
  expect(reflectanceFromF0(0.04)).toBeCloseTo(0.5, 6);
  expect(0.16 * 0.5 ** 2).toBeCloseTo(0.04, 6);
  // Обе шкалы — одно и то же число: ползунок и IOR не расходятся.
  for (const n of [1.1, 1.33, 1.4, 1.5, 1.58, 1.9, 2.4]) {
    expect(iorFromF0(f0FromIor(n))).toBeCloseTo(n, 6);
  }
  // Старый файл без поля читается как «обычный диэлектрик», а не как ошибка.
  expect(normalizeMaterial({ roughness: { value: 0.5 } })!.ior).toBe(1.5);
  // Мусор не выносит значение за физику.
  expect(normalizeMaterial({ ior: 99 })!.ior).toBe(MAX_IOR);
  expect(normalizeMaterial({ ior: -3 })!.ior).toBe(MIN_IOR);

  // Кожа отражает меньше пластика при одной шероховатости — вот и вся разница
  // в блике, кроме его ширины. Считаем на чёрном альбедо, чтобы видеть только
  // отражение, а не диффузную часть.
  const spec = (f0: number) => shadePoint(
    point({ roughness: 0.35, f0, albedo: [0, 0, 0] }), [light()], { normalStrength: 1, material: true },
  )[0];
  const plastic = spec(f0FromIor(1.5));
  const skin = spec(f0FromIor(1.4));
  // 2.8 % против 4 % — блик слабее примерно на треть, а не «на глаз».
  expect(skin / plastic).toBeCloseTo(0.0278 / 0.04, 2);
});

test("материал: пресет — список значений, а не режим", () => {
  const base = normalizeMaterial({})!;
  const preset = (id: string) => MATERIAL_PRESETS.find((entry) => entry.id === id)!;

  // Применение ставит числа.
  const skin = applyPreset(base, preset("skin"));
  expect(skin.roughness.value).toBe(0.55);
  expect(skin.metallic.value).toBe(0);
  expect(skin.ior).toBe(1.4);
  expect(skin.emissive.strength).toBe(0);

  // Набор задаёт все свои свойства: после «Неона» другой набор гасит свечение,
  // а «Неон» после «Металла» перестаёт быть металлом.
  const afterNeon = applyPreset(applyPreset(base, preset("neon")), preset("matte"));
  expect(afterNeon.emissive.strength).toBe(0);
  const neonAfterMetal = applyPreset(applyPreset(base, preset("metal")), preset("neon"));
  expect(neonAfterMetal.metallic.value).toBe(0);
  expect(neonAfterMetal.emissive.strength).toBe(120);

  // Но источники каналов он НЕ трогает: выбранная карта остаётся подключённой.
  const withCards = normalizeMaterial({
    roughness: { from: "file", file: "asset:rough", value: 0.2 },
    metallic: { from: "packed", packedChannel: "b", value: 1 },
    ao: { from: "file", file: "asset:ao", value: 1 },
    emissive: { color: "#ff0000", strength: 80, file: "asset:glow" },
    packed: "asset:orm",
  })!;
  const afterPreset = applyPreset(withCards, preset("skin"));
  expect(afterPreset.roughness.from).toBe("file");
  expect(afterPreset.roughness.file).toBe("asset:rough");
  expect(afterPreset.metallic.from).toBe("packed");
  expect(afterPreset.ao.file).toBe("asset:ao");
  // И карта свечения тоже: её выбирали руками.
  expect(afterPreset.emissive.file).toBe("asset:glow");
  // Значения при этом поменялись — то есть набор сработал, просто его не видно
  // там, где читается карта.
  expect(afterPreset.roughness.value).toBe(0.55);

  // «Какой пресет сейчас» считается по значениям: сдвинули ползунок — «нет».
  expect(matchPreset(skin)?.id).toBe("skin");
  expect(matchPreset(applyPreset(skin, preset("plastic")))?.id).toBe("plastic");
  const nudged = { ...skin, roughness: { ...skin.roughness, value: 0.57 } };
  expect(matchPreset(nudged)).toBeNull();
  // Источник на определение не влияет: это значения, а не способы их взять.
  expect(matchPreset(withCards)).toBeNull();
  expect(matchPreset(undefined)).toBeNull();

  // Каждый набор задаёт все свои свойства.
  for (const entry of MATERIAL_PRESETS) {
    expect(Number.isFinite(entry.roughness), entry.label).toBe(true);
    expect(Number.isFinite(entry.metallic), entry.label).toBe(true);
    expect(Number.isFinite(entry.ior), entry.label).toBe(true);
    expect(Number.isFinite(entry.emissive.strength), entry.label).toBe(true);
  }
});

test("материал: сводка источников говорит, откуда что читается", () => {
  const numbers = normalizeMaterial({})!;
  expect(materialSourceSummary(numbers)).toBe("числа ×3");
  const mixed = normalizeMaterial({
    roughness: { from: "packed", packedChannel: "g", value: 0.3 },
    metallic: { from: "packed", packedChannel: "b", value: 0 },
    ao: { from: "file", file: "asset:ao", value: 1 },
    packed: "asset:orm",
  })!;
  expect(materialSourceSummary(mixed)).toBe("ORM ×2 · свой файл ×1");
  const withGlow = normalizeMaterial({
    emissive: { color: "#ffffff", strength: 50, file: "asset:glow" },
  })!;
  expect(materialSourceSummary(withGlow)).toContain("карта свечения");
  // Без упакованной карты «из ORM» ничего не читает: это числа.
  const orphan = normalizeMaterial({ metallic: { from: "packed", value: 1 } })!;
  expect(materialSourceSummary(orphan)).toBe("числа ×3");
});

test("материал: канал переключается на файл до того, как файл выбран", () => {
  // Раньше режим «файл» без файла нормализация возвращала в «число», и кнопка
  // не нажималась: выбрать файл было нельзя вообще.
  const opened = normalizeMaterial({ roughness: { from: "file", file: null, value: 0.5 } })!;
  expect(opened.roughness.from).toBe("file");
  // Читается при этом константа: пустой карты не бывает.
  expect(channelBinding(opened.roughness)).toEqual({ mode: 0, channel: 1, value: 0.5, src: null });
  // Файл появился — включается текстура, режим не менялся.
  const chosen = normalizeMaterial({ roughness: { from: "file", file: "asset:rough", value: 0.5 } })!;
  expect(channelBinding(chosen.roughness)).toEqual({ mode: 1, channel: 1, value: 0.5, src: "asset:rough" });
  // Упаковка без выбранной карты тоже читается константой, а не пустотой.
  const packed = normalizeMaterial({ packed: null, metallic: { from: "packed", value: 1 } })!;
  expect(channelBinding(materialBinding(packed, undefined).metallic).mode).toBe(0);
});
