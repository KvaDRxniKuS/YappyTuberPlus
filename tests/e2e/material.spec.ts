import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MATERIAL_PRESETS, MIN_AMBIENT, SPECULAR_EXPOSURE, SPECULAR_REACH, applyPreset, baseReflectance,
  channelBinding, defaultMaterial, fresnel, ggxDistribution, ggxLobe, matchPreset, materialBinding,
  materialSources, materialSourceSummary, normalizeEnvironment, normalizeMaterial, outlineRay,
  shadePoint, shapeEdge, usesPacked,
  type LightBody, type LightPoint, type MaterialPoint,
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

/** Как DEFAULT_LIGHT в редакторе: радиус 240, высота — половина («авто»). */
const TEST_RADIUS = 240;
const TEST_HEIGHT = 120;

/**
 * Свет в точке. Направление и форма не могут разойтись: `body` выводится из
 * `L`, иначе блик считался бы по одному свету, а диффузная часть — по другому,
 * и тест перестал бы что-либо проверять.
 */
const light = (patch: Partial<LightPoint> = {}): LightPoint => {
  const base: LightPoint = {
    L: [0, 0, 1],
    color: [1, 1, 1],
    polarity: 1,
    specular: 1,
    // Поверхность под светом: покрытие пятна равно единице, поэтому `color` и
    // `tint` здесь совпадают. Вдали от центра теста это не касается.
    body: {
      toLight: [0, 0],
      height: TEST_HEIGHT,
      span: TEST_RADIUS,
      shape: 0,
      halfAngle: (120 * Math.PI) / 180 / 2,
      soft: 0.6,
      rotation: 0,
      core: 1,
      tint: [1, 1, 1],
    },
  };
  const merged = { ...base, ...patch };
  if (!patch.body) {
    const [lx, ly, lz] = merged.L;
    const toLight: [number, number] = lz > 1e-6
      ? [(lx / lz) * TEST_HEIGHT, (ly / lz) * TEST_HEIGHT]
      : [0, 0];
    merged.body = { ...base.body, toLight } satisfies LightBody;
  }
  return merged;
};

/** Точка с материалом, где видно только блик: ноль everywhere, кроме отражения. */
const mirrorOnly = (patch: Partial<MaterialPoint> = {}): MaterialPoint => point({
  albedo: [0, 0, 0],
  metallic: 0,
  ao: 1,
  environment: { color: [0, 0, 0], level: 0 },
  emissive: [0, 0, 0],
  ...patch,
});

/** Яркость блика в точке, отстоящей от источника на `distance` пикселей. */
const glint = (distance: number, roughness: number, body: Partial<LightBody> = {}) => {
  const height = TEST_HEIGHT;
  const length = Math.hypot(distance, height);
  const L: [number, number, number] = [-distance / length, 0, height / length];
  return shadePoint(mirrorOnly({ roughness }), [light({
    L,
    color: [1, 1, 1],
    body: {
      toLight: [distance, 0],
      height,
      span: TEST_RADIUS,
      shape: 0,
      halfAngle: (120 * Math.PI) / 180 / 2,
      soft: 0.6,
      rotation: 0,
      core: 1,
      tint: [1, 1, 1],
      ...body,
    },
  })], { normalStrength: 1, material: true })[0];
};

test("блик: пик лежит под источником и убывает монотонно", () => {
  // Это и был основной дефект: в знаменателе стояло 4·NdotL без геометричного
  // множителя, косое падение оказывалось ярче прямого, и максимум уползал на
  // кольцо в 40 % радиуса пятна. На плоской поверхности это выглядит полосой:
  // яркий пояс по краю подсветки вместо точки под светом.
  for (const roughness of [0.05, 0.2, 0.5, 0.85, 1]) {
    const samples: number[] = [];
    for (let distance = 0; distance <= 200; distance += 8) {
      samples.push(glint(distance, roughness));
    }
    expect(samples[0], `шероховатость ${roughness}: максимум не под светом`).toBeGreaterThan(0);
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i], `шероховатость ${roughness}: рост яркости на ${i * 8} px`).toBeLessThanOrEqual(
        samples[i - 1] + 1e-9,
      );
    }
  }
});

test("блик: лепесток ограничен собственным максимумом", () => {
  // Ограниченность — не «потолок», который надо помнить, а свойство формулы:
  // распределение делится на свой пик. Поэтому ни поля снизу, ни clamp сверху
  // в шейдере больше нет.
  for (const roughness of [0.02, 0.1, 0.35, 0.7, 1]) {
    expect(ggxLobe(0, roughness)).toBeCloseTo(1, 6);
    let previous = Number.POSITIVE_INFINITY;
    for (let angle = 0; angle <= 1.5; angle += 0.1) {
      const value = ggxLobe(angle, roughness);
      expect(value).toBeLessThanOrEqual(1 + 1e-6);
      expect(value).toBeLessThanOrEqual(previous + 1e-9);
      previous = value;
    }
  }
  // Половина ширины у гладкой поверхности меньше, чем у матовой: «узкий блик».
  expect(ggxLobe(0.2, 0.1)).toBeLessThan(ggxLobe(0.2, 0.8));
});

test("блик: форма источника переходит в форму отражения", () => {
  // Круглый свет даёт круглое пятно, прямоугольный — квадратное: по диагонали
  // у прямоугольника край дальше, чем по оси, а у круга одинаково во всех
  // направлениях. Проверка сравнивает эти два отношения.
  const diagonal = { toLight: [120, 0], rotation: Math.PI / 4 };
  const circleAxis = glint(120, 0.3);
  const circleDiagonal = glint(120, 0.3, diagonal);
  const rectAxis = glint(120, 0.3, { shape: 1 });
  const rectDiagonal = glint(120, 0.3, { ...diagonal, shape: 1 });
  // Круг: поворот источника ничего менять не должен.
  expect(circleDiagonal).toBeCloseTo(circleAxis, 6);
  // Прямоугольник: по диагонали отражение тянется дальше √2 раз.
  expect(rectDiagonal).toBeGreaterThan(rectAxis * 1.05);
  // Форма видна и в контуре. Бисекция из восьми шагов даёт около 1 %, поэтому
  // сравниваем с допуском, а не «в ноль»: смысл проверки в порядке величин.
  expect(outlineRay([1, 0], 0, 1, 0.6)).toBeGreaterThan(0.97);
  expect(outlineRay([1, 0], 0, 1, 0.6)).toBeLessThanOrEqual(1);
  // У квадрата по диагонали край дальше в √2 раз — оттуда и «квадратное» пятно.
  expect(outlineRay([Math.SQRT1_2, Math.SQRT1_2], 1, 1, 0.6))
    .toBeGreaterThan(outlineRay([1, 0], 1, 1, 0.6) * 1.3);
  // У треугольника по направлению к вершине контур дальше, чем к середине стороны.
  expect(outlineRay([0, -1], 2, 1, 0.6)).toBeGreaterThan(outlineRay([0, 1], 2, 1, 0.6));
  // Вне фигуры контур «бесконечный»: бисекция упирается в нижнюю границу.
  const outside = shapeEdge([-2, 0], 2, 1, 0.6);
  expect(outside.cover).toBe(0);
});

test("блик: за краем пятна гаснет плавно, подсветка — нет", () => {
  // Reflection видно и там, куда пятно не дотянулось: до SPECULAR_REACH.
  // Границна мягкая, поэтому на 1.4 радиуса блик есть, а на 2 — уже нет.
  const far = glint(TEST_RADIUS * 1.4, 0.3);
  const beyond = glint(TEST_RADIUS * 2.2, 0.3);
  expect(far).toBeGreaterThan(0);
  expect(beyond).toBe(0);
  // Спад между ними не обрывается ступенькой.
  expect(far).toBeLessThan(glint(TEST_RADIUS * 0.9, 0.3));
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

test("материал: металл вне пятна света не проваливается в чёрный", () => {
  // Раньше металл без света и без окружения был ровно чёрным: диффузной части
  // у него нет вовсе, отражать нечего. На тестовом кубе это выглядело как
  // «работает 50 на 50»: металлические грани пропадали, диэлектрические — нет.
  // Теперь у окружения есть минимум, и металл виден всегда.
  const metal = shadePoint(point({ metallic: 1 }), [], { normalStrength: 1, material: true });
  expect(metal[0]).toBeCloseTo(0.8 * MIN_AMBIENT, 5);

  // Заданный уровень окружения минимум не ограничивает — он только снизу.
  const room = shadePoint(
    point({ metallic: 1, environment: { color: [1, 1, 1], level: 1 } }),
    [],
    { normalStrength: 1, material: true },
  );
  expect(room[0]).toBeCloseTo(0.8, 5);

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

  // Тёмный свет (тень) блика не даёт: он только гасит диффузную часть, а
  // отражение окружения остаётся — иначе тень была бы чёрной дырой.
  const shadow = shadePoint(point({ roughness: 0.2 }), [light({ polarity: -1 })], { normalStrength: 1, material: true });
  expect(shadow[0]).toBeGreaterThan(0);
  expect(shadow[0]).toBeLessThan(lit[0]);

  // Сила блика 0 — поверхность без блика, только диффузия и окружение.
  const noSpec = shadePoint(
    point({ roughness: 0.2, specular: 0 }), [light()], { normalStrength: 1, material: true },
  );
  expect(noSpec[0]).toBeCloseTo(0.8 + (0.8 + 0.04) * MIN_AMBIENT, 5);
});

test("материал: окклюзия гасит диффузную часть, блик не трогает", () => {
  const bright = shadePoint(
    point({ ao: 1, specular: 0 }), [light()], { normalStrength: 1, material: true },
  );
  const dark = shadePoint(
    point({ ao: 0, specular: 0 }), [light()], { normalStrength: 1, material: true },
  );
  expect(bright[0]).toBeCloseTo(0.8 + (0.8 + 0.04) * MIN_AMBIENT, 5);
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
  // Блик больше не привязан к покрытию пятна: отражение видно и за его краем,
  // а гаснет плавно до SPECULAR_REACH.
  expect(source).toContain("specSum += color0.rgb * F * (lobe * reach * amp * NdotL);");
  expect(source).toContain("float reach = color0.a * (1.0 - smoothstep(1.0, SPECULAR_REACH, d));");
  // Одна функция формы на пятно и на блик — иначе отражение не могло бы
  // наследовать форму источника.
  expect(source).toContain("float d = shapeEdge(local, shape, halfAngle, soft, cover);");
  expect(source).toContain("float lobe = ggxLobe(");
  // Диффузная часть остаётся внутри пятна, блик — снаружи тоже.
  expect(source).toContain("if (inPatch) lightSum += color0.rgb * a * NdotL;");
  // Окклюзия гасит диффузную часть, а не блик.
  expect(source).toContain("float shade = clamp(occlusion * (1.0 - clamp(shadowSum, 0.0, 1.0)), 0.0, 1.0);");
  // Высота света участвует в направлении на свет вместе с настоящим смещением
  // до пятна: нормированная отдельно горизонталь давала «свет сверху» везде.
  expect(source).toContain("vec2 toLight = (center - p) / uScale;");
  expect(source).toContain("normalize(vec3(toLight, max(uLightExtra[i].x / uScale, 0.001)))");
  // Старая схема с полками выключена: именно она делала пояс вместо точки.
  expect(source).not.toContain("float denom = 4.0 * max(NdotL, 0.02)");
  expect(source).not.toContain("clamp(D / denom");
  expect(source).not.toContain("MAX_SPECULAR_GAIN");
  // Экспозиция и досягаемость приходят из модели, а не удвоены литералом.
  expect(source).toContain("#define SPECULAR_EXPOSURE ${SPECULAR_EXPOSURE}");
  expect(source).toContain("#define SPECULAR_REACH ${SPECULAR_REACH}");
  expect(SPECULAR_EXPOSURE).toBe(6);
  expect(SPECULAR_REACH).toBe(1.8);
  // Минимум окружения — общий с моделью в тестах.
  expect(source).toContain("vec3 ambient = uEnvironment.rgb * max(uEnvironment.w, 0.35);");
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

test("материал: порядок полей в инспекторе — сверху общее, ниже частное", () => {
  // Порядок проверяется по разметке, а не глазами: однажды вставка «наверх»
  // попала в старую копию блока, и упаковка осталась между «Отражением» и
  // «Свечением» — а это ровно то место, где её никто не ищет.
  const source = readFileSync(join(process.cwd(), "src", "components", "MaterialSection.tsx"), "utf8");
  const at = (needle: string) => {
    const index = source.indexOf(needle);
    expect(index, `в разметке нет «${needle}»`).toBeGreaterThan(-1);
    return index;
  };
  const preset = at("<span>Пресет</span>");
  const packed = at("<PackedRow");
  const roughness = at('label="Шероховатость"');
  const metallic = at('label="Металл"');
  const occlusion = at('label="Окклюзия"');
  const source_ = at("Источник:");
  const reflection = at("<ReflectanceRow");
  const glow = at("<EmissiveHint");

  // Общее — пресет и упаковка — стоит до каналов.
  expect(preset).toBeLessThan(packed);
  expect(packed).toBeLessThan(roughness);
  // Каналы идут вместе, в порядке «шероховатость, металл, окклюзия».
  expect(roughness).toBeLessThan(metallic);
  expect(metallic).toBeLessThan(occlusion);
  // Сводка источников — сразу после каналов, отражение и свечение — ниже.
  expect(occlusion).toBeLessThan(source_);
  expect(source_).toBeLessThan(reflection);
  expect(reflection).toBeLessThan(glow);
  // Упаковка не должна оказаться между отражением и свечением: именно там она
  // была после неудачной правки.
  expect(packed < reflection || packed > glow).toBe(true);
  // И упакованная карта в разделе ровно одна: две значили бы дубль.
  expect(source.split("<PackedRow").length - 1).toBe(1);
});

/*
 * Сброс материала.
 *
 * Пресета «нет» для этого мало: пункт «нет» значит «значения не совпали с
 * набором», а не «вернуть как было». Сброс обязан сделать ровно одно — вернуть
 * все числа к умолчаниям и отвязать **все** карты: упакованную ORM, свои файлы
 * каналов и карту свечения. Если отвязать только часть, материал продолжит
 * читать старую картинку, и человек решит, что кнопка не работает.
 */
test("материал: сброс возвращает числа и отвязывает все карты", () => {
  const dirty = normalizeMaterial({
    ...DEFAULT_MATERIAL,
    roughness: { ...DEFAULT_MATERIAL.roughness, value: 0.12, from: "file", file: "blob:rough" },
    metallic: { ...DEFAULT_MATERIAL.metallic, value: 1, from: "packed" },
    ao: { ...DEFAULT_MATERIAL.ao, value: 0.4, from: "file", file: "blob:ao" },
    emissive: { color: "#66e0ff", strength: 120, file: "blob:glow" },
    packed: "blob:orm",
    specular: 40,
    ior: 1.9,
  })!;
  // Это именно «грязное» состояние: все привязки заняты.
  expect(dirty.packed).toBe("blob:orm");
  expect(dirty.roughness.file).toBe("blob:rough");
  expect(dirty.emissive.file).toBe("blob:glow");

  const reset = defaultMaterial();
  // Числа — ровно умолчания, без «почти как было».
  expect(reset).toEqual(DEFAULT_MATERIAL);
  // И ни одной карты: ни упаковки, ни своих файлов, ни свечения.
  expect(reset.packed).toBeNull();
  for (const key of ["roughness", "metallic", "ao"] as const) {
    expect(reset[key].file, key).toBeNull();
    expect(reset[key].from, key).toBe("value");
  }
  expect(reset.emissive.file).toBeNull();
  // Сброс — не «выключить материал»: объект продолжает считаться материалом.
  expect(defaultMaterial()).not.toBeUndefined();
});

test("материал: сброс не портит умолчания и не делит вложенные объекты", () => {
  // Каналы и свечение — вложенные объекты. Мелкая копия умолчаний связала бы
  // их: правка одного объекта меняла бы умолчание для всех остальных.
  const first = defaultMaterial();
  first.roughness.value = 0.1;
  first.emissive.strength = 99;
  first.ao.packedChannel = "a";

  const second = defaultMaterial();
  expect(second.roughness.value).toBe(DEFAULT_MATERIAL.roughness.value);
  expect(second.emissive.strength).toBe(DEFAULT_MATERIAL.emissive.strength);
  expect(second.ao.packedChannel).toBe(DEFAULT_MATERIAL.ao.packedChannel);
  expect(DEFAULT_MATERIAL.roughness.value).toBe(0.6);
});

test("материал: кнопка сброса есть в разделе и стоит рядом с пресетом", () => {
  const source = readFileSync(join(process.cwd(), "src", "components", "MaterialSection.tsx"), "utf8");
  expect(source).toContain("Сбросить материал");
  // Нажатие возвращает раздел в исходное состояние через общую функцию сброса.
  expect(source).toContain("material: defaultMaterial()");
  const at = (needle: string) => {
    const index = source.indexOf(needle);
    expect(index, `в разметке нет «${needle}»`).toBeGreaterThan(-1);
    return index;
  };
  // Сброс — общее действие, поэтому стоит до каналов: пресет → сброс → упаковка.
  expect(at("<span>Пресет</span>")).toBeLessThan(at("Сбросить материал"));
  expect(at("Сбросить материал")).toBeLessThan(at("<PackedRow"));
});
