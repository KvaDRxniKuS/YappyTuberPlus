import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { lightDirection } from "../../scripts/material-math.mjs";
import { SHADER_SOURCES, glslFloat, invertMatrix3 } from "../../src/render/lighting";
import { SPECULAR_EXPOSURE, SPECULAR_REACH } from "../../src/render/material";
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
 * Поэтому здесь проверяется то, что видно по тексту: зарезервированные слова
 * (список — из спецификации GLSL ES, разделы «Reserved Keywords» у 1.00 и 3.00),
 * висячие запятые в списках аргументов и целые числа там, где ждёт float.
 *
 * Список неполный, но ровно по факту: `flat` и `packed`, потом `f(a, b,)` и
 * `#define SPECULAR_EXPOSURE 6`. Три из четырёх пойманы человеком, четвёртое —
 * тестом ниже. Всё это — ошибки одного рода: их не видит ни TypeScript (текст
 * шейдера для него строка), ни глаз, а следствием всегда «карты нормалей и
 * материал перестали работать», потому что `giveUp` выключает объём целиком.
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

/** Все программы: четыре текста, каждый начинается с `#version 300 es`. */
const SHADERS = Object.entries(SHADER_SOURCES);

const lighting = readFileSync(join(process.cwd(), "src", "render", "lighting.ts"), "utf8");

test("шейдеры: ни одного зарезервированного слова GLSL", () => {
  // Четыре программы: нормали (вершины + фрагмент) и объём (вершины + фрагмент).
  expect(SHADERS.map(([name]) => name)).toEqual([
    "normalVertex", "normalFragment", "volumeVertex", "volumeFragment",
  ]);
  for (const [name, shader] of SHADERS) {
    expect(reservedOf(shader), `шейдер ${name}`).toEqual([]);
  }
});

/*
 * Два способа убить шейдер, которые не видны ни в редакторе, ни в сборке.
 *
 *  · `f(a, b,)` — JS терпит висячую запятую, GLSL нет: «syntax error,
 *    unexpected RIGHT_PAREN»;
 *  · `#define SPECULAR_EXPOSURE 6`, а дальше `float * 6` — GLSL ES 3.00 не
 *    приводит int к float: «wrong operand types».
 *
 * Следствие в обоих случаях одно: программа не собирается, объём выключается, и
 * пользователь видит «нормали не работают». Числа в текст шейдера поэтому уходят
 * через glslFloat(), а проверяется собранный текст — тот самый, что видит драйвер.
 */
test("шейдеры: ни висячей запятой, ни целого числа в float-месте", () => {
  for (const [name, source] of SHADERS) {
    expect(source, `шейдер ${name}`).toContain("#version 300 es");
    // Ни в вызовах, ни в инициализаторах.
    expect(source, `шейдер ${name}`).not.toMatch(/,\s*[)}]/);
    // Числовые define'ы — только вещественные. кроме счётчика цикла: MAX_LIGHTS
    // живёт в int-контексте и там ему место.
    const ints = [...source.matchAll(/^#define ([A-Z_]+) (\S+)$/gm)]
      .filter(([, macro, value]) => macro !== "MAX_LIGHTS" && /^-?\d+$/.test(value))
      .map(([, macro, value]) => `${macro} = ${value}`);
    expect(ints, `шейдер ${name}: целые литералы`).toEqual([]);
  }
});

test("шейдер объёма: числа материала подставлены вещественными литералами", () => {
  const volume = SHADER_SOURCES.volumeFragment;
  // Не «6» и не «1.8000000000000002 — а ровно то, что принимает GLSL.
  expect(volume).toContain(`#define SPECULAR_EXPOSURE ${glslFloat(SPECULAR_EXPOSURE)}`);
  expect(volume).toContain(`#define SPECULAR_REACH ${glslFloat(SPECULAR_REACH)}`);
  expect(volume).not.toContain(`#define SPECULAR_EXPOSURE ${SPECULAR_EXPOSURE}\n`);
});

test("glslFloat: целое число становится вещественным литералом", () => {
  expect(glslFloat(6)).toBe("6.0");
  expect(glslFloat(0)).toBe("0.0");
  expect(glslFloat(-2)).toBe("-2.0");
  expect(glslFloat(1.8)).toBe("1.8");
  expect(glslFloat(0.35)).toBe("0.35");
  expect(glslFloat(1e-5)).toBe("0.00001");
  // Экспонента — уже float, вторую точку не просит.
  expect(glslFloat(1e21)).toBe("1e+21");
});

test("шейдер объёма: нормаль и упакованная карта названы не зарезервированными словами", () => {
  const volume = SHADER_SOURCES.volumeFragment;
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
  const volume = SHADER_SOURCES.volumeFragment;
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
  const volume = SHADER_SOURCES.volumeFragment;
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
  const volume = SHADER_SOURCES.volumeFragment;
  // Блик — лепесток GGX, нормированный на собственный максимум. Прежняя схема
  // (D, делённая на 4·NdotL, с полкой снизу и потолком сверху) делала косое
  // падение ярче прямого: на плоской поверхности максимум уползал на кольцо, и
  // вместо точки под источником была полоса по краю пятна.
  expect(volume).toContain("float lobe = specLobe(angDev, width);");
  expect(volume).toContain("float specLobe(float angle, float halfWidth)");
  // Колено экспозиции: без него металл с F0 = цвет объекта выбеливал пол-пятна.
  expect(volume).toContain("float exposure = mix(1.0, SPECULAR_EXPOSURE,");
  expect(volume).not.toContain("4.0 * max(NdotL, 0.02)");
  expect(volume).not.toContain("clamp(D / denom");
  // Отражение не обрезается краем пятна: оно спадает до SPECULAR_REACH плавно,
  // а подсветка холста остаётся внутри пятна.
  expect(volume).toContain("float reach = color0.a * (1.0 - smoothstep(1.0, SPECULAR_REACH, d));");
  expect(volume).toContain("if (inPatch) lightSum += color0.rgb * a * NdotL;");
  // Форма блика берётся из той же функции, что и форма пятна: прямоугольный
  // свет даёт прямоугольное отражение.
  expect(volume).toContain("float d = shapeEdge(local, shape, halfAngle, soft, cover);");
  expect(volume).toContain("float outlineRay(vec2 dir, float shape, float halfAngle, float soft)");
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
