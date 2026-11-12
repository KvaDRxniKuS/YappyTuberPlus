import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AO_FLOOR, MATERIAL_PRESETS, MIN_AMBIENT, SPECULAR_EDGE_BLUR, SPECULAR_EXPOSURE,
  SPECULAR_EXPOSURE_KNEE, SPECULAR_PIXEL_FLOOR, applyPreset, baseReflectance, channelBinding,
  defaultMaterial, fresnel, matchPreset, materialBinding, materialSources, materialSourceSummary,
  normalizeEnvironment, normalizeMaterial, occluded, reflectRay, reflectedLocal, shadePoint, shapeEdge,
  specularDim, specularEdgeBlur, specularMask,
  usesPacked,
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

/**
 * Точка металла для блика: альбедо у металла — это F0 отражения, поэтому оно
 * не нулевое; окружение чёрное, диффуза нет — значит видно только отражение.
 */
const mirrorMetal = (patch: Partial<MaterialPoint> = {}): MaterialPoint => point({
  albedo: [0.8, 0.8, 0.8],
  metallic: 1,
  ao: 1,
  environment: { color: [0, 0, 0], level: 0 },
  ...patch,
});

/**
 * Яркость отражения в точке. `toLight` — смещение от точки к центру пятна: та
 * же величина, что уходит в шейдер, поэтому знак и направление совпадают.
 */
const glintAt = (
  makePoint: (patch: Partial<MaterialPoint>) => MaterialPoint,
  toLight: [number, number],
  patch: Partial<MaterialPoint>,
  body: Partial<LightBody> = {},
): number => {
  const length = Math.hypot(toLight[0], toLight[1], TEST_HEIGHT) || 1;
  const L: [number, number, number] = [toLight[0] / length, toLight[1] / length, TEST_HEIGHT / length];
  return shadePoint(makePoint(patch), [light({
    L,
    color: [1, 1, 1],
    body: {
      toLight,
      height: TEST_HEIGHT,
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

/** Блик в точке на оси X: точка отстоит от центра света на `distance`. */
const along = (distance: number): [number, number] => [-distance, 0];

/** Блик диэлектрика: 4 % отражения без альбедо и без окружения. */
const glint = (distance: number, roughness: number, body: Partial<LightBody> = {}) =>
  glintAt(mirrorOnly, along(distance), { roughness }, body);

/** Блик металла: альбедо = F0, поэтому отражение видно целиком. */
const metalGlint = (
  distance: number,
  roughness: number,
  body: Partial<LightBody> = {},
  patch: Partial<MaterialPoint> = {},
) => glintAt(mirrorMetal, along(distance), { roughness, ...patch }, body);

test("блик: отражённый луч на плоской поверхности смотрит в зрителя", () => {
  // Из этого и следует, что отражение источника равно его силуэту: луч из
  // плоской точки уходит прямо в камеру и попадает туда же, где стоит лампа.
  expect(reflectRay([0, 0, 1])).toEqual([0, 0, 1]);
  const tilted = reflectRay([Math.SQRT1_2, 0, Math.SQRT1_2]);
  expect(tilted[0]).toBeCloseTo(1, 6);
  expect(tilted[2]).toBeCloseTo(0, 6);
  // Грань круче 45° отражать нечего: луч уходит за плоскость холста, и это не
  // потеря блика, а физика наклона.
  expect(reflectRay([0.866, 0, 0.5])[2]).toBeLessThan(0);
  expect(reflectedLocal([0, 0], reflectRay([0.866, 0, 0.5]), 1, 0, TEST_HEIGHT, TEST_RADIUS)).toBeNull();

  // Плоская нормаль: попадание равно самой точке, в каких бы единицах ни мерить.
  expect(reflectedLocal([0.3, -0.2], reflectRay([0, 0, 1]), 1, 0, TEST_HEIGHT, TEST_RADIUS))
    .toEqual([0.3, -0.2]);
  // Наклон 30°: R = (0.866, 0, 0.5), поэтому точка «уезжает» на 0.866 радиуса —
  // так изображение источника едет по рельефу.
  const shifted = reflectedLocal(
    [0, 0], reflectRay([0.5, 0, Math.sqrt(0.75)]), 1, 0, TEST_HEIGHT, TEST_RADIUS,
  )!;
  expect(shifted[0]).toBeCloseTo(0.866, 3);
  // Вдвое выше свет — вдвое дальше сдвиг: высота входит множителем, а не углом.
  const higher = reflectedLocal(
    [0, 0], reflectRay([0.5, 0, Math.sqrt(0.75)]), 1, 0, TEST_HEIGHT * 2, TEST_RADIUS,
  )!;
  expect(higher[0]).toBeCloseTo(shifted[0] * 2, 3);
});

test("блик: при нулевой шероховатости отражение равно силуэту источника", () => {
  // Металл: диффузной части нет, окружение чёрное — всё видимое и есть блик.
  const center = metalGlint(0, 0.02);
  expect(center).toBeGreaterThan(0.5);
  // Внутри силуэта яркость одна и та же: это изображение лампы, а не точка с
  // гало вокруг неё. Раньше на 40 px оставалась пятая часть пика — отсюда и
  // «блик виден только в центре пятна».
  expect(metalGlint(120, 0.02)).toBeCloseTo(center, 2);
  expect(metalGlint(TEST_RADIUS * 0.9, 0.02)).toBeCloseTo(center, 2);
  // За краем силуэта отражения нет вовсе.
  expect(metalGlint(TEST_RADIUS * 1.4, 0.02)).toBe(0);
  // Край силуэта резкий: ровно на границе — половина яркости.
  const edge = metalGlint(TEST_RADIUS, 0.02);
  expect(edge).toBeGreaterThan(center * 0.35);
  expect(edge).toBeLessThan(center * 0.65);
});

test("блик: шероховатость размывает край отражения, а не сужает лепесток", () => {
  // Ширина ползунка работает на всём ходу: край размывается ровно на столько,
  // на сколько просят, и не зависит от «полов» ширины лепестка.
  expect(specularEdgeBlur(0, TEST_RADIUS)).toBeCloseTo(SPECULAR_PIXEL_FLOOR / TEST_RADIUS, 9);
  expect(specularEdgeBlur(1, TEST_RADIUS)).toBeCloseTo(SPECULAR_EDGE_BLUR, 9);
  let previous = 0;
  for (const roughness of [0.02, 0.2, 0.4, 0.6, 0.8, 1]) {
    const blur = specularEdgeBlur(roughness, TEST_RADIUS);
    expect(blur).toBeGreaterThan(previous);
    previous = blur;
  }
  // Мелкий источник размывается на те же доли своего радиуса, но пиксельный пол
  // у него крупнее — это сглаживание края, а не размытие.
  expect(specularEdgeBlur(0, 20)).toBeGreaterThan(specularEdgeBlur(0, 400));

  // Маска: 1 в центре, половина на краю силуэта, 0 за ним.
  expect(specularMask(0, 0.1)).toBeCloseTo(1, 9);
  expect(specularMask(1, 0.1)).toBeCloseTo(0.5, 9);
  expect(specularMask(2, 0.1)).toBe(0);
  // Ослабление: шире изображение — ниже пик, иначе матовая поверхность
  // отражала бы столько же света, сколько зеркало.
  expect(specularDim(0)).toBe(1);
  expect(specularDim(1)).toBeLessThan(specularDim(0.2));

  // И в картинке: чем шероховатее, тем шире видимая зона отражения и ниже пик.
  const sharp = metalGlint(0, 0.02);
  const matte = metalGlint(0, 1);
  expect(matte).toBeLessThan(sharp);
  expect(metalGlint(TEST_RADIUS * 1.3, 1)).toBeGreaterThan(0);
  expect(metalGlint(TEST_RADIUS * 1.3, 0.02)).toBe(0);
});

test("блик: форма источника переходит в форму отражения", () => {
  // Точка на диагонали круга уже за краем силуэта (расстояние = радиусу), а у
  // прямоугольника та же точка внутри: отражение прямоугольное, а не круглое.
  const diagonal: [number, number] = [-TEST_RADIUS / Math.SQRT2, -TEST_RADIUS / Math.SQRT2];
  const base = { roughness: 0.02 };
  const circle = glintAt(mirrorMetal, diagonal, base);
  const rect = glintAt(mirrorMetal, diagonal, base, { shape: 1 });
  expect(rect).toBeGreaterThan(circle * 1.5);
  // Угол прямоугольника лежит на диагонали (√2 радиуса), а его сторона — на
  // 1. Поворот на 45° подставляет под диагональ сторону, и отражение тает до
  // половины — ровно как у круга на том же расстоянии.
  const turned = glintAt(mirrorMetal, diagonal, base, { shape: 1, rotation: Math.PI / 4 });
  expect(turned).toBeLessThan(rect);
  expect(turned).toBeCloseTo(circle, 6);
  // Сектор отражается только внутри своего угла: точка выше центра попадает в
  // луч, а повёрнутый на 180° сектор её уже не освещает — отражения нет.
  const sector = { shape: 3, halfAngle: Math.PI / 12 };
  const above: [number, number] = [0, TEST_RADIUS * 0.5];
  expect(glintAt(mirrorMetal, above, { roughness: 0.02 }, sector)).toBeGreaterThan(0);
  expect(glintAt(mirrorMetal, above, { roughness: 0.02 }, { ...sector, rotation: Math.PI })).toBe(0);
});

test("блик: диэлектрик бликует тише металла, и его тянет экспозиция", () => {
  // Пластик бликует всегда — вопрос только в яркости. Экспозиция нужна ровно
  // потому, что 4 % отражения без неё не видно на фоне диффузной части.
  const plastic = glint(0, 0.02);
  const metal = metalGlint(0, 0.02);
  expect(plastic).toBeGreaterThan(0);
  expect(plastic).toBeLessThan(metal);
  expect(SPECULAR_EXPOSURE).toBeGreaterThan(1);
  expect(SPECULAR_EXPOSURE_KNEE).toBeGreaterThan(0.04);
  // Сила блика 0 — отражения нет вовсе: ползунок не «уменьшает», а выключает.
  expect(metalGlint(0, 0.02, {}, { specular: 0 })).toBe(0);
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

test("окклюзия: гасит непрямой свет с полом, блик не трогает", () => {
  // AO — про непрямой свет. Ноль окклюзии раньше стирал материал до чёрного
  // силуэта: у металла видимый цвет и есть отражение окружения.
  expect(occluded(1)).toBe(1);
  expect(occluded(0)).toBeCloseTo(AO_FLOOR, 9);
  expect(AO_FLOOR).toBeGreaterThan(0.2);

  const bright = shadePoint(point({ ao: 1, specular: 0 }), [light()], { normalStrength: 1, material: true });
  const dark = shadePoint(point({ ao: 0, specular: 0 }), [light()], { normalStrength: 1, material: true });
  // Прямой свет окклюзия не гасит: в обоих случаях диффузная часть полная.
  expect(bright[0]).toBeCloseTo(0.8 + (0.8 + 0.04) * MIN_AMBIENT, 5);
  expect(dark[0]).toBeCloseTo(0.8 + (0.8 + 0.04) * MIN_AMBIENT * AO_FLOOR, 5);
  // Металл при нулевой окклюзии остаётся видимым, а не чёрным.
  const metal = shadePoint(point({ metallic: 1, ao: 0 }), [], { normalStrength: 1, material: true });
  expect(metal[0]).toBeCloseTo(0.8 * MIN_AMBIENT * AO_FLOOR, 5);
  expect(metal[0]).toBeGreaterThan(0.05);

  // Блик окклюзия не трогает вовсе: он не непрямой свет.
  const glints = [0, 0.4, 1].map((ao) => metalGlint(0, 0.02, {}, { ao }));
  expect(glints[1]).toBeCloseTo(glints[0], 9);
  expect(glints[2]).toBeCloseTo(glints[0], 9);
  expect(glints[0]).toBeGreaterThan(0.5);
});

test("материал: свечение не зависит от светов и складывается с ними", () => {
  const glow = shadePoint(
    point({ emissive: [0.2, 0.6, 1], ao: 0, environment: { color: [0, 0, 0], level: 0 } }),
    [],
    { normalStrength: 1, material: true },
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
  // Отражение диэлектрика приходит из IOR, а не зашито в 4 %.
  expect(source).toContain("F0 = mix(vec3(uF0), scene.rgb, metallic);");
  expect(source).toContain('getUniformLocation(program.volume, "uF0")');
  // Блик — отражение силуэта источника: луч, пересечение с плоскостью света,
  // форма в координатах источника. Никакого лепестка вокруг точки больше нет.
  expect(source).toContain("vec3 ray = vec3(2.0 * n.z * n.xy, 2.0 * n.z * n.z - 1.0);");
  expect(source).toContain("vec2 hit = reflectedLocal(local, ray, c, s, height, span);");
  expect(source).toContain("float dRefl = shapeEdge(hit, shape, halfAngle, soft, coverHit);");
  expect(source).toContain("float mask = coverHit > 0.0");
  expect(source).not.toContain("specLobe");
  expect(source).not.toContain("SPECULAR_REACH");
  // Числа модели приходят из `material.ts`, а не удвоены литералами.
  expect(source).toContain("vec2 reflectedLocal(vec2 local, vec3 ray, float cosRotation, float sinRotation,");
  expect(source).toContain("float specularEdgeBlur(float roughness, float span)");
  expect(source).toContain("float specularMask(float dRefl, float blur)");
  expect(source).toContain("#define SPECULAR_EDGE_BLUR ${glslFloat(SPECULAR_EDGE_BLUR)}");
  expect(source).toContain("#define SPECULAR_BLUR_DIM ${glslFloat(SPECULAR_BLUR_DIM)}");
  expect(source).toContain("#define AO_FLOOR ${glslFloat(AO_FLOOR)}");
  // Блик не зависит от NdotL: это яркость отражения, а не косинус падения.
  expect(source).toContain("* (mask * exposure * uSpecular * uLightExtra[i].y);");
  // Окклюзия гасит непрямой свет и не трогает ни прямой свет, ни блик.
  expect(source).toContain("float indirect = AO_FLOOR + (1.0 - AO_FLOOR) * clamp(occlusion, 0.0, 1.0);");
  expect(source).toContain("vec3 rgb = (diffuse + ambientReflect * indirect) * shade + specSum + emissive;");
  // Диффузная часть остаётся внутри пятна, отражение живёт по своему лучу.
  expect(source).toContain("if (inPatch) lightSum += color0.rgb * a * NdotL;");
  // README ведёт в руководство, иначе его никто не найдёт.
  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
  expect(readme).toContain("docs/MATERIALS.md");
  // Ползунок силы блика у света — то, что обещает руководство.
  const lightSection = readFileSync(join(process.cwd(), "src", "components", "LightSection.tsx"), "utf8");
  expect(lightSection).toContain("Сила блика");
  expect(lightSection).toContain("specular");
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
  // Поколение не дублируем числом: сверяем ядро с паспортом редактора, иначе
  // каждая правка контракта ломала бы тест вместо проверки.
  const core = readFileSync(join(process.cwd(), "crates", "rig-core", "src", "lib.rs"), "utf8");
  const passport = readFileSync(join(process.cwd(), "src", "version.ts"), "utf8");
  const coreSlot = /\bcore:\s*(\d+)/.exec(passport)?.[1];
  expect(coreSlot).toBeTruthy();
  expect(core).toContain(`CORE_GENERATION: u32 = ${coreSlot}`);
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
  // Экспозиция тянет слабый F0 чуть сильнее (колено 0.32), поэтому отношение
  // не ровно 0.0278/0.04, а около 0.72 — «примерно на треть слабее».
  expect(skin / plastic).toBeGreaterThan(0.65);
  expect(skin / plastic).toBeLessThan(0.8);
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

test("блик показывает профиль света, а не его центр", () => {
  // Свет с мягким краем: яркий в центре (core) и тихий у края (edge). Раньше
  // блик заливался альфой центра на всей площади отражения — зеркало показывало
  // трафарет света: ровное пятно, «как будто наоборот с максимальной
  // шероховатостью». Теперь яркость берётся там, куда попал отражённый луч.
  const body = { soft: 0.6, core: 1, edge: 0 } as const;
  const centre = metalGlint(0, 0.02, body);
  const middle = metalGlint(TEST_RADIUS * 0.7, 0.02, body);
  const rim = metalGlint(TEST_RADIUS * 0.95, 0.02, body);
  // Ядро ярче края, спад монотонный: у отражения появился пик.
  expect(centre).toBeGreaterThan(middle);
  expect(middle).toBeGreaterThan(rim);
  expect(rim / centre).toBeLessThan(0.3);
  // Ровный свет (без `edge`) остаётся ровным: старое поведение не сдвинулось.
  const flatCentre = metalGlint(0, 0.02);
  const flatRim = metalGlint(TEST_RADIUS * 0.95, 0.02);
  expect(flatRim / flatCentre).toBeGreaterThan(0.9);
  // Профиль не отменяет шероховатость: на матовой поверхности пик ниже.
  expect(metalGlint(0, 1, body)).toBeLessThan(centre);
});
