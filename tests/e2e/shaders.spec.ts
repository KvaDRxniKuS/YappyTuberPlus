import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { lightDirection } from "../../scripts/material-math.mjs";
import { invertMatrix3 } from "../../src/render/lighting";
import { join } from "node:path";

/*
 * Шейдеры проверяются без WebGL: сам шейдер — это текст, а ошибка компиляции
 * живёт именно в тексте.
 *
 * Повод прямой: во фрагментном шейдере объёма стояли переменные `flat` и
 * `packed`. Оба слова зарезервированы в GLSL ES, драйвер отказывался собирать
 * программу, `giveUp` выключал объём навсегда — и карта нормалей и PBR «не
 * работали», хотя весь код был на месте. Ни один тест этого не видел: браузера
 * с WebGL в прогоне нет, а проверки шейдера были текстовые и по смыслу.
 *
 * Поэтому здесь проверяется единственное, что можно проверить без драйвера:
 * текст шейдера не использует зарезервированных слов. Список — из спецификации
 * GLSL ES (разделы «Reserved Keywords» у 1.00 и 3.00); всё, что попало в
 * переменную, функцию или параметр, ловится до запуска.
 */

/** Зарезервированные слова GLSL ES 1.00 и 3.00: объявлять их нельзя. */
const RESERVED = [
  "asm", "class", "union", "enum", "typedef", "template", "this", "packed", "goto",
  "switch", "default", "inline", "noinline", "volatile", "public", "static", "extern",
  "external", "interface", "long", "short", "double", "half", "fixed", "unsigned",
  "superp", "input", "output", "hvec2", "hvec3", "hvec4", "fvec2", "fvec3", "fvec4",
  "sampler3D", "sampler1D", "sampler1DShadow", "sampler2DShadow", "sampler2DRect",
  "sampler3DRect", "sampler2DRectShadow", "sizeof", "cast", "namespace", "using",
  "row_major", "precise", "flat", "smooth", "noperspective", "layout", "patch",
  "subroutine", "common", "partition", "active", "filter", "resource", "sample",
  "coherent", "restrict", "readonly", "writeonly", "atomic_uint", "image1D",
  "image2D", "image3D", "imageCube", "imageBuffer", "iimage1D", "iimage2D",
  "iimage3D", "iimageCube", "iimageBuffer", "uimage1D", "uimage2D", "uimage3D",
  "uimageCube", "uimageBuffer", "sampler1DArray", "sampler2DArray",
  "sampler1DArrayShadow", "sampler2DArrayShadow", "isampler1D", "isampler2D",
  "isampler3D", "isamplerCube", "usampler1D", "usampler2D", "usampler3D",
  "usamplerCube", "sampler2DMS", "isampler2DMS", "usampler2DMS",
];

/** Идентификаторы текста шейдера: комментарии в расчёт не идут. */
function identifiersOf(shader: string): string[] {
  const code = shader.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  return code.match(/\b[A-Za-z_]\w*\b/g) ?? [];
}

/** Зарезервированные слова, которые в шейдере что-то объявляют. */
function reservedOf(shader: string): string[] {
  const found = new Set(identifiersOf(shader));
  return RESERVED.filter((word) => found.has(word));
}

/** Все шейдеры файла: каждый начинается с `#version 300 es`. */
function shadersOf(source: string): string[] {
  return [...source.matchAll(/`(#version 300 es[\s\S]*?)`/g)].map((match) => match[1]);
}

const lighting = readFileSync(join(process.cwd(), "src", "render", "lighting.ts"), "utf8");

test("шейдеры: ни одного зарезервированного слова GLSL", () => {
  const shaders = shadersOf(lighting);
  // Четыре программы: нормали (вершины + фрагмент) и объём (вершины + фрагмент).
  expect(shaders.length).toBe(4);
  for (const shader of shaders) {
    const first = shader.slice(0, shader.indexOf("`")).split("\n")[0];
    expect(reservedOf(shader), `шейдер с ${first}`).toEqual([]);
  }
});

test("шейдер объёма: нормаль и упакованная карта названы не зарезервированными словами", () => {
  const volume = shadersOf(lighting).find((shader) => shader.includes("uMaterial") && shader.includes("ggx"));
  expect(volume).toBeTruthy();
  // Те же слова, что были ошибкой: `flat` и `packed`. Имена по смыслу, а не по
  // старой привычке.
  expect(volume).toContain("vec3 lightDir = normalize(vec3(toLight, max(uLightExtra[i].x / uScale, 0.001)));");
  expect(volume).toContain("vec4 packedTexel = texture(uPacked, uv);");
});

/*
 * Направление на свет — не мелочь оформления, а причина «мёртвых» карт.
 *
 * Горизонталь до пятна когда-то нормировалась до единицы, а высота света
 * оставалась в пикселях (авто — половина радиуса, у лампы 240 это 120). Вектор
 * (0, 0, 120) — это свет строго сверху для любой точки сцены: пятно гуляет,
 * яркость меняется, а наклон поверхности к свету — нет. Карта нормалей
 * выглядела нарисованной, блик не двигался, шероховатость и металл ничего не
 * показывали. Проверяем и текст шейдера, и саму формулу числами.
 */
test("шейдер объёма: смещение до света не нормируется отдельно от высоты", () => {
  const volume = shadersOf(lighting).find((shader) => shader.includes("uMaterial") && shader.includes("ggx"));
  expect(volume).toBeTruthy();
  // Ни деления смещения на его длину, ни отдельной единичной горизонтали.
  expect(volume).not.toContain("flatDir");
  expect(volume).not.toContain("toLight / toLightLen");
  // Смещение и высота уходят в один normalize — значит, в одних единицах.
  // Единицы — объекта, а не холста: иначе при мелком масштабе высота упирается
  // в «пол» и свет снова светит сверху для всей сцены.
  expect(volume).toContain("vec2 toLight = (center - p) / uScale;");
  expect(volume).toContain("normalize(vec3(toLight, max(uLightExtra[i].x / uScale, 0.001)))");
});

/*
 * Карты читаются по UV объекта, а не по рамке-боксу.
 *
 * `vUv` идёт по боксу, а в боксе есть паддинг под размытие края, и он зависит
 * от масштаба камеры: карта, натянутая на бокс, ползла и растягивалась при
 * зуме и повороте — это и выглядело как «ORM деформируется от камеры».
 */
test("шейдер объёма: UV карт считается от объекта, а не от рамки", () => {
  const volume = shadersOf(lighting).find((shader) => shader.includes("uMaterial") && shader.includes("ggx"));
  expect(volume).toBeTruthy();
  expect(volume).toContain("uniform mat3 uInverse;");
  expect(volume).toContain("vec2 uv = clamp((localPoint - uUvRect.xy) / uUvRect.zw, 0.0, 1.0);");
  // Буфер сцены и буфер нормалей по-прежнему читаются рамкой: они в ней и лежат.
  expect(volume).toContain("vec4 scene = texture(uScene, vUv);");
  expect(volume).toContain("vec4 nrm = texture(uNormals, vUv);");
  // Каналы и карта свечения — только по UV объекта.
  expect(volume).toContain("channelValue(uRoughMode, uRoughChannel, uRoughValue, uRoughTex, uv)");
  expect(volume).toContain("texture(uEmissiveTex, uv)");
  // Обратная матрица в JS считается той же формулой, что и в примере.
  const inverse = invertMatrix3([2, 0, 0, 0, 2, 0, 10, 20, 1]);
  expect(inverse[0]).toBeCloseTo(0.5, 6);
  expect(inverse[1]).toBeCloseTo(0, 6);
  // Точка (30, 60) в холсте — это (10, 20) в объекте с масштабом 2 и сдвигом.
  expect((inverse[0] * 30 + inverse[3] * 60 + inverse[6])).toBeCloseTo(10, 5);
  expect(inverse[6]).toBeCloseTo(-5, 6);
  expect(inverse[7]).toBeCloseTo(-10, 6);
});

/* Блик — пятно, а не полоска: усиление ограничено и посчитано один раз. */
/*
 * Свечение не зависит от светильников.
 *
 * Материал и его свечение считаются и в пустой сцене: раньше и проход объёма,
 * и сама отрисовка требовали хотя бы одного света в сцене — и неон молчал при
 * любых настройках, хотя к свету отношения не имеет.
 */
test("объём: материал и свечение работают без светильников в сцене", () => {
  const layer = lighting.slice(lighting.indexOf("export function shadeLayer"));
  expect(layer).toContain("if (!lights.length && !sample.material) return false;");
  const canvas = readFileSync(join(process.cwd(), "src", "render", "rigCanvas.ts"), "utf8");
  expect(canvas).toContain("if (sample && (options.lighting?.lights.length || sample.material)) {");
});

test("шейдер объёма: блик не вырождается в линию и не гасится дважды", () => {
  const volume = shadersOf(lighting).find((shader) => shader.includes("uMaterial") && shader.includes("ggx"));
  expect(volume).toBeTruthy();
  expect(volume).toContain("float denom = 4.0 * max(NdotL, 0.02) * max(n.z, 0.02);");
  expect(volume).toContain("float gain = clamp(D / denom, 0.0, 8.0) * uSpecular * uLightExtra[i].y;");
  // Один множитель силы блика на весь шейдер: в сумме его больше нет.
  expect(volume).toContain("specSum + emissive");
  expect(volume).not.toContain("specSum * uSpecular");
  // Минимум окружения: без него металл чёрный вне пятна света.
  expect(volume).toContain("vec3 ambient = uEnvironment.rgb * max(uEnvironment.w, 0.35);");
});

test("направление на свет: пятно сдвинулось — наклон изменился", () => {
  // Нормаль наклонена вправо на 45°, свет с высотой 120 px (лампа радиусом 240).
  const n = [Math.SQRT1_2, 0, Math.SQRT1_2];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const at = (center: [number, number]) => lightDirection([center[0], center[1]], 120);

  // Свет справа: поверхность развёрнута к нему, NdotL растёт до почти единицы.
  expect(dot(n, at([100, 0]))).toBeGreaterThan(0.9);
  expect(dot(n, at([200, 0]))).toBeGreaterThan(0.9);
  // Свет слева: поверхность отвёрнута, NdotL становится отрицательным.
  expect(dot(n, at([-200, 0]))).toBeLessThan(0);
  // Свет ровно над точкой: честный косинус наклона нормали.
  expect(dot(n, at([0, 0]))).toBeCloseTo(Math.SQRT1_2, 3);

  // Ошибка, которую поймал этот тест: единичная горизонталь против высоты в
  // пикселях даёт один и тот же наклон для любого положения пятна.
  const broken = (center: [number, number]) => {
    const offset = [center[0], center[1]];
    const length = Math.hypot(offset[0], offset[1]);
    const flat2 = length > 0.001 ? [offset[0] / length, offset[1] / length] : [0, 0];
    const l = [flat2[0], flat2[1], 120];
    const size = Math.hypot(l[0], l[1], l[2]);
    return [l[0] / size, l[1] / size, l[2] / size];
  };
  expect(Math.abs(dot(n, broken([200, 0])) - dot(n, broken([-200, 0])))).toBeLessThan(0.05);
  expect(Math.abs(dot(n, at([200, 0])) - dot(n, at([-200, 0])))).toBeGreaterThan(1);
});

test("проверка зарезервированных слов ловит именно ту ошибку", () => {
  // Без этого тест был бы пустым: проверяем, что сканер видит `flat`/`packed`.
  const broken = "#version 300 es\nprecision highp float;\nvoid main() {\n  float flat = 1.0;\n  vec4 packed = vec4(0.0);\n}\n";
  expect(reservedOf(broken)).toEqual(["packed", "flat"]);
  // И что законный текст остаётся чистым.
  expect(reservedOf("#version 300 es\nfloat toLightLen = 1.0;\n")).toEqual([]);
});

/*
 * Вторая часть — про то, что проход объёма не отменяется из-за незагруженного
 * файла. Раньше `bindings.some(channel.mode === 1 && !entry)` возвращал `false`
 * на весь объект: один недокачанный файл канала гасил и материал, и карту
 * нормалей, и на экране не было ни причины, ни подсказки.
 */
test("объём: незагруженный файл канала не отменяет проход", () => {
  const body = lighting.slice(lighting.indexOf("export function shadeLayer"));
  expect(body).not.toContain("bindings.some");
  // Карта нормалей ещё грузится, а материал есть — считаем по плоской нормали.
  expect(body).toContain("if (!normalTexture && !material) return false;");
  // Канал без файла читает константу — режим понижается, а не отменяет проход.
  expect(body).toContain("if (channel.mode === 1) return source ? 1 : 0;");
});
