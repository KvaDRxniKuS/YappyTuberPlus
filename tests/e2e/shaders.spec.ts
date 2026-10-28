import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
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
  // Те же слова, что были ошибкой: `flat` (длина вектора до света) и `packed`
  // (тексель упакованной карты). Имена по смыслу, а не по старой привычке.
  expect(volume).toContain("float toLightLen = length(toLight);");
  expect(volume).toContain("vec4 packedTexel = texture(uPacked, vUv);");
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
