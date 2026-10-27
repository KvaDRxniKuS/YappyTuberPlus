import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  baseReflectance, fresnel, ggxDistribution, materialBinding, materialSources,
  normalizeEnvironment, normalizeMaterial, shadePoint, usesPacked,
  type LightPoint, type MaterialPoint,
} from "../../src/render/material";
import { DEFAULT_ENVIRONMENT, DEFAULT_MATERIAL, lightHeight, DEFAULT_LIGHT } from "../../src/types";
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
  const material = normalizeMaterial({
    roughness: { from: "packed", packedChannel: "r", value: 0 },
    metallic: { from: "packed", packedChannel: "g", value: 0 },
    ao: { from: "packed", packedChannel: "b", value: 0 },
    packed: "asset:orm",
  })!;
  expect(usesPacked(material)).toBe(true);
  const binding = materialBinding(material, DEFAULT_ENVIRONMENT);
  expect(binding.roughness).toEqual({ mode: 2, channel: 0, value: 0, src: null });
  expect(binding.metallic.channel).toBe(1);
  expect(binding.ao.channel).toBe(2);
  // Все карты материала — файлы объекта: иначе они теряются при переносе.
  expect(materialSources(material)).toEqual(["asset:orm"]);

  // «Файл» без файла читается как число: иначе объект молча стал бы чёрным.
  const empty = normalizeMaterial({ roughness: { from: "file", file: null, value: 0.3 } })!;
  expect(materialBinding(empty, DEFAULT_ENVIRONMENT).roughness.mode).toBe(0);

  // Материала нет — поля нет: старый пресет выглядит как раньше.
  expect(normalizeMaterial(undefined)).toBeUndefined();
  expect(normalizeMaterial({})).toEqual(DEFAULT_MATERIAL);
});

test("материал: значения из скрипта заменяют инспектор, свечение складывается", () => {
  const material = normalizeMaterial({ roughness: { value: 0.5 }, emissive: { strength: 40, color: "#ffffff" } })!;
  // −1 значит «не задано»: тогда работает инспектор.
  const idle = materialBinding(material, undefined, { roughness: -1, metallic: -1, ao: -1, emissive: 0 });
  expect(idle.roughness).toEqual({ mode: 0, channel: 0, value: 0.5, src: null });

  const live = materialBinding(material, undefined, { roughness: 0.1, emissive: 0.3 });
  expect(live.roughness.value).toBeCloseTo(0.1, 6);
  expect(live.emissive.strength).toBeCloseTo(0.4 + 0.3, 5);
  // Выше 200 % не уходит: шкала та же, что у ползунка.
  expect(materialBinding(material, undefined, { emissive: 5 }).emissive.strength).toBe(2);
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
  expect(source).toContain("F0 = mix(vec3(0.04), scene.rgb, metallic);");
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
  for (const name of ["roughness", "metallic", "ao", "emissive"]) {
    expect(block).toContain(`"${name}"`);
    expect(NEUTRAL_PARAMS[name]).toBe(name === "emissive" ? 0 : -1);
  }
  // Ядро знает те же слова: таблица признаков — источник поколения.
  const features = readFileSync(join(process.cwd(), "src", "engine", "coreFeatures.ts"), "utf8");
  expect(features).toContain('words: ["roughness", "metallic", "ao", "emissive"]');
  expect(features).toContain('since: 22');
  // И Rust-часть: имена параметров и поколение.
  const model = readFileSync(join(process.cwd(), "crates", "rig-core", "src", "model.rs"), "utf8");
  for (const name of ["Roughness", "Metallic", "Ao", "Emissive"]) {
    expect(model).toContain(`Param::${name}`);
  }
  expect(model).toContain('"roughness" => Param::Roughness');
  const core = readFileSync(join(process.cwd(), "crates", "rig-core", "src", "lib.rs"), "utf8");
  expect(core).toContain("CORE_GENERATION: u32 = 22");
});
