import type { LightShape } from "../types";
import { assetUrl } from "../engine/assets";
import { SPECULAR_EXPOSURE, SPECULAR_REACH } from "./material";
import { alphaOf, withAlpha } from "./light";

/**
 * Объём от нормалей: проход освещения на WebGL2.
 *
 * Canvas 2D умеет рисовать пятно света, но не умеет считать, как поверхность
 * повёрнута к этому пятну — а именно из этого получается объём. Поэтому после
 * отрисовки сцены холст уходит текстурой в WebGL2, где для каждой точки
 * считается наклон поверхности из карты нормалей и добавка света.
 *
 * Проход ничего не перерисовывает заново: пятна, градиенты, маски и порядок
 * слоёв остаются за Canvas 2D, а WebGL только затемняет и подсвечивает уже
 * нарисованное там, где у объекта есть карта нормалей. Значит, свет никогда не
 * красит пустое место и не спорит с разметкой редактора — и откат без WebGL2
 * ничего не ломает, просто пропадает объём.
 */

/** Свет в координатах холста: пятно уже сведено с камерой и масштабом. */
export interface LightSample {
  /** Центр пятна в пикселях холста. */
  x: number;
  y: number;
  /** Радиус в пикселях холста. */
  radius: number;
  /** Поворот пятна, радианы. */
  rotation: number;
  shape: LightShape;
  angle: number;
  softness: number;
  colorStart: string;
  colorEnd: string;
  brightness: number;
  blend: "normal" | "add";
  /** Высота света над холстом в пикселях холста: без неё блик плоский. */
  height: number;
  /** Сила блика этого света 0…200 %. */
  specular: number;
}

/** Объект с картой нормалей: матрица «локальные координаты → пиксели холста». */
/**
 * Канал материала для шейдера.
 *
 * `mode`: 0 — константа из инспектора, 1 — свой файл канала, 2 — буква
 * упакованной карты. Режим решает рендер (`rigCanvas`), а не шейдер: там же,
 * где известно, есть ли файл на самом деле.
 */
export interface ChannelBinding {
  mode: 0 | 1 | 2;
  /** Буква упакованной карты: 0 R, 1 G, 2 B, 3 A. */
  channel: number;
  value: number;
  /** Свой файл канала (`mode: 1`). */
  src: string | null;
}

/** Материал объекта в проходе объёма. */
export interface MaterialBinding {
  roughness: ChannelBinding;
  metallic: ChannelBinding;
  ao: ChannelBinding;
  /** Цвет свечения 0…1 и сила 0…2. */
  emissive: { color: [number, number, number]; strength: number; src: string | null };
  /** Упакованная карта: из неё читаются каналы с `mode: 2`. */
  packed: string | null;
  /** Общая сила блика материала 0…2. */
  specular: number;
  /** Отражение диэлектрика из IOR: 0.04 у «обычного» (IOR 1.5), 0.028 у кожи. */
  f0: number;
  /** Окружение сцены: цвет 0…1 и уровень 0…2. */
  environment: { color: [number, number, number]; level: number };
}

/** Всё, что нужно проходу: карта нормалей и (необязательно) материал. */
export interface ShadeSample {
  /** Матрица 3×3 по столбцам: [a, b, 0, c, d, 0, e, f, 1]. */
  matrix: number[];
  /** Рамка картинки в локальных координатах: left, top, width, height. */
  rect: [number, number, number, number];
  /** Карта нормалей; `null` — поверхность плоская. */
  normal: { src: string; strength: number } | null;
  /** Материал; `null` — прежний вид (объём от нормалей). */
  material: MaterialBinding | null;
  /** Сила нормалей 0…2: общая для обоих режимов. */
  strength: number;
}

/**
 * Что собрал проход отрисовки: светильники сцены.
 *
 * Объектов с картой нормалей здесь нет: объём считается каждому объекту сразу
 * после его отрисовки, в его собственном слое (`shadeLayer`), иначе он
 * просвечивал бы сквозь объекты выше.
 */
export interface LightingCollector {
  lights: LightSample[];
}

export function createCollector(): LightingCollector {
  return { lights: [] };
}

export function resetCollector(collector: LightingCollector): void {
  collector.lights.length = 0;
}

/** Сколько светильников уходит в шейдер: больше — лишние не считаются. */
export const MAX_LIGHTS = 8;

/**
 * Число, которое уходит в текст шейдера. GLSL ES 3.00 не приводит `int` к
 * `float`: `#define SPECULAR_EXPOSURE 6` и дальше `float * 6` — это ошибка
 * компиляции, драйвер не собирает программу, `giveUp` выключает объём целиком,
 * и выглядит это как «карты нормалей перестали работать». Поэтому литерал
 * всегда пишется с точкой.
 */
export function glslFloat(value: number): string {
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}


/**
 * Порог «тёмный тексель — это не нормаль, а пустое место».
 *
 * У единичной нормали максимум компоненты не меньше 1/√3 ≈ 0.577, а в карте
 * каждая компонента закодирована как (n + 1) / 2, то есть самая тёмная
 * допустимая нормаль ярче 0.79. Значит всё, что темнее 0.25, нормалью быть не
 * может: это заливка «здесь ничего нет». Такую зону карта отдаёт как
 * прозрачную — она не даёт объёма и не перекрывает чужие карты.
 */
export const NORMAL_COVERAGE_DARK = 0.08;

/** Верхняя граница того же порога: темнее — пусто, светлее — нормаль. */
export const NORMAL_COVERAGE_LIT = 0.25;

const NORMAL_VERTEX = `#version 300 es
in vec2 aPos;
uniform mat3 uMatrix;
uniform vec4 uRect;
uniform vec2 uSize;
uniform vec2 uOrigin;
out vec2 vUv;
void main() {
  vUv = aPos;
  vec2 local = uRect.xy + aPos * uRect.zw;
  vec3 device = uMatrix * vec3(local, 1.0);
  // Матрица объекта считается в пикселях всего холста, а рисуем мы только его
  // рамку: начало координат переносится в угол рамки, размер равен её размеру.
  vec2 inside = device.xy - uOrigin;
  // Рамка объекта растягивается на всю текстуру нормалей: проход объёма читает
  // её координатой vUv от 0 до 1, то есть по рамке, а не по холсту. Y не
  // переворачивается: у кадрового буфера строка 0 — низ, у текстуры v = 0 —
  // та же строка, поэтому «верх объекта» и vUv.y = 0 оказываются вместе.
  gl_Position = vec4(inside.x / uSize.x * 2.0 - 1.0, inside.y / uSize.y * 2.0 - 1.0, 0.0, 1.0);
}`;

const NORMAL_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uMap;
uniform float uStrength;
out vec4 outColor;
void main() {
  vec4 map = texture(uMap, vUv);
  // Чёрная или прозрачная зона карты — «здесь пусто»: объёма нет, соседние
  // карты она не перекрывает. Порог безопасен: любая настоящая нормаль ярче
  // 0.79, потому что у единичного вектора максимум компоненты больше 1/√3.
  float level = max(max(map.r, map.g), map.b);
  float cover = smoothstep(${glslFloat(NORMAL_COVERAGE_DARK)}, ${glslFloat(NORMAL_COVERAGE_LIT)}, level);
  // Карта без альфы приходит с alpha = 1 — правило ей не мешает.
  cover *= smoothstep(0.02, 0.5, map.a);
  vec3 texel = map.rgb * 2.0 - 1.0;
  // В карте нормалей +Y смотрит вверх, а на холсте Y растёт вниз.
  vec2 xy = vec2(texel.x, -texel.y) * uStrength;
  float len = length(xy);
  if (len > 1.0) { xy /= len; len = 1.0; }
  outColor = vec4(xy * 0.5 + 0.5, len * cover, 1.0);
}`;

const VOLUME_VERTEX = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos;
  gl_Position = vec4(aPos.x * 2.0 - 1.0, 1.0 - aPos.y * 2.0, 0.0, 1.0);
}`;

const VOLUME_FRAGMENT = `#version 300 es
precision highp float;
#define MAX_LIGHTS ${MAX_LIGHTS}
/**
 * Экспозиция отражения и досягаемость блика за краем пятна. Обе числа — из
 * src/render/material.ts, чтобы шейдер и эталонная реализация не могли
 * разойтись: подстановка происходит при сборке строки шейдера.
 */
#define SPECULAR_EXPOSURE ${glslFloat(SPECULAR_EXPOSURE)}
#define SPECULAR_REACH ${glslFloat(SPECULAR_REACH)}
in vec2 vUv;

uniform sampler2D uScene;
uniform sampler2D uNormals;
uniform sampler2D uPacked;
uniform sampler2D uRoughTex;
uniform sampler2D uMetalTex;
uniform sampler2D uAoTex;
uniform sampler2D uEmissiveTex;

uniform vec2 uCanvas;
uniform vec2 uOrigin;
uniform vec2 uSize;
/**
 * Обратная матрица объекта и его прямоугольник: по ним считается UV карт.
 *
 * Читать карты по vUv нельзя: vUv идёт по рамке-боксу, а в боксе есть
 * паддинг под размытие края, зависящий от масштаба камеры, и при повороте он
 * вообще описан вокруг повёрнутого прямоугольника. Карта, натянутая на бокс,
 * «плыла» и растягивалась при движении и зуме — а это выглядело как деформация
 * самой карты ORM. UV объекта от камеры не зависит.
 */
uniform mat3 uInverse;
uniform vec4 uUvRect;
/** Пикселей холста на единицу объекта: в них считаются направления на свет. */
uniform float uScale;
uniform int uCount;
uniform vec4 uColor0[MAX_LIGHTS];
uniform vec4 uColor1[MAX_LIGHTS];
uniform vec4 uGeom[MAX_LIGHTS];
uniform vec4 uShape[MAX_LIGHTS];
/** x — высота света над холстом, y — сила блика этого света 0…2. */
uniform vec4 uLightExtra[MAX_LIGHTS];

/** 0 — прежний объём от нормалей, 1 — материал (GGX). */
uniform int uMaterial;
uniform int uHasNormal;
uniform float uNormalStrength;

/** Канал: 0 — константа, 1 — свой файл, 2 — канал упакованной карты. */
uniform int uRoughMode;
uniform int uMetalMode;
uniform int uAoMode;
uniform int uRoughChannel;
uniform int uMetalChannel;
uniform int uAoChannel;
uniform float uRoughValue;
uniform float uMetalValue;
uniform float uAoValue;
uniform float uSpecular;
/** Отражение диэлектрика из IOR: 0.04 у «обычного» (IOR 1.5), 0.028 у кожи. */
uniform float uF0;

uniform int uEmissiveMode;
uniform vec3 uEmissiveColor;
uniform float uEmissiveStrength;
/** Окружение: rgb — цвет, w — уровень 0…2. */
uniform vec4 uEnvironment;

out vec4 outColor;

// Знаковая площадь внутри треугольника: > 0 значит «внутри».
float triangleInside(vec2 p) {
  vec2 a = vec2(0.0, -1.0);
  vec2 b = vec2(0.866025, 0.5);
  vec2 c = vec2(-0.866025, 0.5);
  float d1 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  float d2 = (c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x);
  float d3 = (a.x - c.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x);
  return min(d1, min(d2, d3));
}

/**
 * Форма источника: 0 в центре фигуры, 1 на её краю; cover — мягкая стенка
 * (у треугольника и сектора это и есть сама фигура).
 *
 * Функция одна на подсветку холста и на блик: первая вызывает её с радиусом
 * пятна, второй — с «телом» источника. Поэтому у прямоугольного света
 * отражение прямоугольное, у треугольного — треугольное, и поворот у них
 * общий. local уже поделен на масштаб: для формы «весь экран» это диагональ
 * холста, и ветка отличается только им.
 */
float shapeEdge(vec2 local, float shape, float halfAngle, float soft, out float cover) {
  cover = 1.0;
  if (shape < 0.5) return length(local);
  if (shape < 1.5) return max(abs(local.x), abs(local.y));
  if (shape < 2.5) {
    cover = clamp(triangleInside(local) / max(soft * 0.35, 0.001), 0.0, 1.0);
    return length(local) / 1.5;
  }
  if (shape < 3.5) {
    float dir = atan(local.x, -local.y);
    cover = clamp((halfAngle - abs(dir)) / max(soft * halfAngle, 0.001), 0.0, 1.0);
    return length(local);
  }
  return length(local);
}

/**
 * Насколько далеко по направлению dir лежит край формы источника: угловой
 * контур света. Бисекция идёт по той же функции формы, поэтому блик наследует
 * и треугольник, и сектор, и поворот — всё, что умеет сам свет.
 */
float outlineRay(vec2 dir, float shape, float halfAngle, float soft) {
  float low = 0.05;
  float high = 3.0;
  for (int step = 0; step < 8; step++) {
    float mid = (low + high) * 0.5;
    float insideCover = 1.0;
    if (shapeEdge(dir * mid, shape, halfAngle, soft, insideCover) <= 1.0 && insideCover > 0.0) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}

/** Значение канала в точке: константа, свой файл или буква упакованной карты. */
float channelValue(int mode, int channel, float constant, sampler2D own, vec2 uv) {
  if (mode == 0) return constant;
  if (mode == 1) return texture(own, uv).r;
  // «packed» тоже зарезервировано в GLSL — переменная названа «тексель».
  vec4 packedTexel = texture(uPacked, uv);
  if (channel == 0) return packedTexel.r;
  if (channel == 1) return packedTexel.g;
  if (channel == 2) return packedTexel.b;
  return packedTexel.a;
}

/** Распределение GGX: чем меньше шероховатость, тем уже и ярче блик. */
float ggx(float NdotH, float roughness) {
  float alpha = max(roughness * roughness, 0.002);
  float a2 = alpha * alpha;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265 * d * d);
}

/**
 * Доля лепестка GGX: 1 в точном зеркальном направлении, 0.5 на половине его
 * ширины. Это то же распределение, что ggx, но делённое на собственный
 * максимум, — поэтому блик ограничен сверху по построению и не нуждается ни в
 * поле снизу, ни в потолке усиления.
 *
 * Прежний множитель D / (4·NdotL) требовал и того и другого: без полок он
 * делал косое падение ярче прямого (1/NdotL растёт быстрее, чем убывает D), и
 * на плоской поверхности максимум уползал на кольцо в 40 % радиуса пятна.
 * Отсюда и «полоса» вместо точки: яркий пояс шёл по краю подсветки.
 */
float ggxLobe(float angle, float roughness) {
  float alpha = max(roughness * roughness, 0.002);
  return ggx(cos(angle), roughness) * 3.14159265 * alpha * alpha;
}

void main() {
  vec4 scene = texture(uScene, vUv);
  vec4 nrm = texture(uNormals, vUv);
  // Покрытие × сила: без карты нормалей объёма нет.
  float volume = nrm.a * nrm.b * 2.0;
  bool material = uMaterial == 1;

  // Нормаль поверхности. Без карты — плоская, без всяких «−1».
  vec2 nxy = uHasNormal == 1 ? (nrm.rg * 2.0 - 1.0) * uNormalStrength : vec2(0.0);
  float nlen = length(nxy);
  if (nlen > 1.0) { nxy /= nlen; nlen = 1.0; }
  vec3 n = vec3(nxy, sqrt(max(1.0 - nlen * nlen, 0.05)));

  if (!material && (uCount == 0 || volume <= 0.001)) { outColor = scene; return; }
  if (material && scene.a <= 0.001) { outColor = scene; return; }

  vec2 p = uOrigin + vUv * uSize;
  // UV карт — из матрицы объекта, а не из рамки: тогда карта лежит ровно на
  // картинке при любом повороте, масштабе и зуме камеры.
  vec2 localPoint = (uInverse * vec3(p, 1.0)).xy;
  vec2 uv = clamp((localPoint - uUvRect.xy) / uUvRect.zw, 0.0, 1.0);
  float accum = 0.0;
  // Материал: накопленное освещение, тень от тёмных светов и блики.
  vec3 lightSum = vec3(0.0);
  float shadowSum = 0.0;
  vec3 specSum = vec3(0.0);

  // Каналы материала читаются один раз на точку, а не в каждом свете.
  float roughness = 1.0;
  float metallic = 0.0;
  float occlusion = 1.0;
  vec3 F0 = vec3(0.04);
  if (material) {
    roughness = clamp(channelValue(uRoughMode, uRoughChannel, uRoughValue, uRoughTex, uv), 0.02, 1.0);
    metallic = clamp(channelValue(uMetalMode, uMetalChannel, uMetalValue, uMetalTex, uv), 0.0, 1.0);
    occlusion = clamp(channelValue(uAoMode, uAoChannel, uAoValue, uAoTex, uv), 0.0, 1.0);
    // Металл красит отражение цветом объекта, диэлектрик — своим F0 из IOR.
    F0 = mix(vec3(uF0), scene.rgb, metallic);
  }

  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uCount) break;
    vec4 color0 = uColor0[i];
    vec4 color1 = uColor1[i];
    vec2 center = uGeom[i].xy;
    float radius = max(uGeom[i].z, 1.0);
    float rot = uGeom[i].w;
    float shape = uShape[i].x;
    float halfAngle = max(radians(uShape[i].y) * 0.5, 0.001);
    float soft = clamp(uShape[i].z, 0.0, 0.999);
    float polarity = uShape[i].w;

    vec2 rel = p - center;
    float c = cos(rot);
    float s = sin(rot);
    // Для формы «весь экран» масштабом служит диагональ холста, остальное —
    // радиус пятна. Дальше одна и та же функция считает и пятно, и блик.
    float span = shape < 3.5 ? radius : max(length(uCanvas), 1.0);
    vec2 local = vec2(c * rel.x + s * rel.y, -s * rel.x + c * rel.y) / span;

    float cover = 1.0;
    float d = shapeEdge(local, shape, halfAngle, soft, cover);
    bool inPatch = d <= 1.0 && cover > 0.0;
    float kernel = 1.0 - soft;
    float t = clamp((d - kernel) / max(1.0 - kernel, 0.001), 0.0, 1.0);
    float a = mix(color0.a, color1.a, t) * cover;
    if (!material) {
      // Прежний проход объёма: только пятно подсветки, ни на пиксель шире.
      if (!inPatch || a <= 0.0005) continue;
    } else if (!inPatch && d > SPECULAR_REACH) {
      // За пределами досягаемости блика считать нечего: остаётся окружение.
      continue;
    }

    // Направление на свет: настоящее смещение до центра пятна плюс высота
    // света. Горизонталь нельзя нормировать отдельно: единичный вектор против
    // высоты в сотни пикселей даёт (0, 0, 1) для всей сцены, свет светит строго
    // сверху, и карты нормалей, шероховатости и металла перестают отзываться на
    // положение пятна — блик стоит на месте, рельеф выглядит нарисованным.
    //
    // Считается в единицах объекта (uScale — пикселей на единицу): тогда
    // «пол» высоты не превращает свет в прожектор сверху при мелком масштабе,
    // а наклон остаётся тем же, что и при крупном.
    vec2 toLight = (center - p) / uScale;
    vec3 lightDir = normalize(vec3(toLight, max(uLightExtra[i].x / uScale, 0.001)));
    float delta = dot(n, lightDir) - lightDir.z;
    accum += delta * a * polarity;

    if (material) {
      float NdotL = dot(n, lightDir);
      if (polarity < 0.5) {
        // Тёмный свет — тень: блика не даёт, только гасит диффузную часть.
        if (inPatch) shadowSum += a * 0.9;
      } else if (NdotL > 0.0) {
        // Диффузная часть — это и есть подсветка холста, она остаётся внутри
        // пятна. Блик живёт по своим правилам: отражение видно и там, куда
        // само пятно не дотянулось.
        if (inPatch) lightSum += color0.rgb * a * NdotL;
        // Полувектор источника и взгляда смотрит ровно на нормаль там, где
        // поверхность повёрнута к зеркальному отражению. Значит, угол между
        // H и n — это «насколько мимо блика» лежит точка: ноль в центре
        // пятна, рост к краям. Такая геометрия работает на любом наклоне
        // грани, в отличие от трассировки отражённого луча: под ортографической
        // камерой он на грани круче 45° уходит за спину, и блика нет вовсе.
        vec3 H = normalize(lightDir + vec3(0.0, 0.0, 1.0));
        float NdotH = clamp(dot(n, H), 0.0, 1.0);
        float angDev = acos(NdotH);
        // Шлик по-прежнему по полувектору и взгляду: V у нас смотрит вдоль
        // нормали холста, поэтому VdotH = H.z, а не NdotH.
        float k = pow(1.0 - max(H.z, 0.0), 5.0);
        vec3 F = F0 + (1.0 - F0) * k;
        // Угловой радиус тела источника: его отражение и есть блик. Край
        // формы берётся в направлении отклонения, поэтому у прямоугольного
        // света пятно прямоугольное, у треугольного — треугольное, поворот общий.
        float dist = max(length(vec3(rel, max(uLightExtra[i].x, 1.0))), 1.0);
        float body = max(span * (1.0 - soft), span * 0.15);
        // Пол в 15 % тела держит глянцевый блик от схлопывания в субпиксель:
        // без него «зеркало» молча пропадало на ровном месте.
        float psi = max(atan(body, dist), 0.02);
        vec2 dev = H.xy - n.xy * NdotH;
        vec2 dirH = vec2(c * dev.x + s * dev.y, -s * dev.x + c * dev.y)
          / max(length(dev), 1e-5);
        float lobe = ggxLobe(
          max(angDev - psi * outlineRay(dirH, shape, halfAngle, soft) * 0.15, 0.0),
          roughness
        );
        // Узкий блик чуть ярче широкого — так глянец читается на мелком зуме.
        // Потолка усилению больше не нужно: лепесток ограничен сам собой.
        float amp = mix(1.0, 2.0, 1.0 - roughness) * SPECULAR_EXPOSURE
          * uSpecular * uLightExtra[i].y;
        float reach = color0.a * (1.0 - smoothstep(1.0, SPECULAR_REACH, d));
        specSum += color0.rgb * F * (lobe * reach * amp * NdotL);
      }
    }
  }

  if (!material) {
    if (abs(accum) <= 0.0005) { outColor = scene; return; }
    // Больше единицы — не выбеливать: предел объёма держим мягким.
    float scale = 1.0 + clamp(accum, -0.9, 2.0) * volume;
    outColor = vec4(clamp(scene.rgb * max(scale, 0.0), 0.0, 1.0), scene.a);
    return;
  }

  // Окклюзия гасит диффузную часть и окружение, блик не трогает.
  float shade = clamp(occlusion * (1.0 - clamp(shadowSum, 0.0, 1.0)), 0.0, 1.0);
  // Минимум окружения: металл вне пятна света иначе чёрный, потому что
  // диффузной части у него нет вовсе, а отражать нечего. Это не «подсветка
  // ради красоты»: даже в тёмной комнате поверхность что-то отражает.
  vec3 ambient = uEnvironment.rgb * max(uEnvironment.w, 0.35);
  // Окружение — отражение: у металла красится его цветом (F0), у диэлектрика
  // даёт свои 4 %. Иначе металл был бы чёрным даже в светлой комнате.
  vec3 ambientReflect = F0 * ambient + scene.rgb * (1.0 - metallic) * ambient;
  vec3 diffuse = scene.rgb * (1.0 - metallic) * lightSum;
  vec3 emissive = vec3(0.0);
  if (uEmissiveStrength > 0.0) {
    emissive = uEmissiveColor * uEmissiveStrength;
    if (uEmissiveMode == 1) emissive *= texture(uEmissiveTex, uv).rgb;
  }
  // uSpecular уже учтён в amp: второй множитель гасил бы блик дважды.
  vec3 rgb = (diffuse + ambientReflect) * shade + specSum + emissive;
  outColor = vec4(clamp(rgb, 0.0, 8.0), scene.a);
}`;

/**
 * Собранные тексты программ — наружу для проверок. Тестам нужен ровно тот
 * текст, который уходит в GL: с подставленными числами. Иначе проверка
 * зарезервированных слов и литералов смотрит в шаблон, а драйвер — в
 * результат, и расход («шейдер не собирается») виден только пользователю.
 */
export const SHADER_SOURCES = {
  normalVertex: NORMAL_VERTEX,
  normalFragment: NORMAL_FRAGMENT,
  volumeVertex: VOLUME_VERTEX,
  volumeFragment: VOLUME_FRAGMENT,
};

interface Programs {
  gl: WebGL2RenderingContext;
  normal: WebGLProgram;
  volume: WebGLProgram;
  quad: WebGLBuffer;
  normalFramebuffer: WebGLFramebuffer;
  normalTexture: WebGLTexture;
  /** Размер буфера нормалей: пересоздаём только при смене размера холста. */
  width: number;
  height: number;
}

let state: Programs | null = null;
let failed = false;

/** Есть ли WebGL2 и собрались ли шейдеры: решается один раз. */
export function lightingAvailable(): boolean {
  if (failed) return false;
  if (state) return true;
  return init();
}

/** Принудительный отказ: среда без WebGL2 или ошибка шейдера — не повод падать. */
function giveUp(reason: unknown): null {
  failed = true;
  state = null;
  // Один раз в консоль: в обычной работе это не сообщение, а диагностика.
  console.warn("Объём от карт нормалей выключен:", reason);
  return null;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log || "shader");
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  if (!vs || !fs) throw new Error("shader");
  const program = gl.createProgram();
  if (!program) throw new Error("program");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  // Атрибут один и всегда в нулевой точке — так проще связывать.
  gl.bindAttribLocation(program, 0, "aPos");
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(log || "link");
  }
  return program;
}

function init(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      failIfMajorPerformanceCaveat: false,
    });
    if (!gl) {
      giveUp("нет WebGL2");
      return false;
    }
    const normal = link(gl, NORMAL_VERTEX, NORMAL_FRAGMENT);
    const volume = link(gl, VOLUME_VERTEX, VOLUME_FRAGMENT);
    const quad = gl.createBuffer();
    const normalTexture = gl.createTexture();
    const normalFramebuffer = gl.createFramebuffer();
    if (!quad || !normalTexture || !normalFramebuffer) throw new Error("buffers");
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    state = { gl, normal, volume, quad, normalFramebuffer, normalTexture, width: 0, height: 0 };
    return true;
  } catch (reason) {
    giveUp(reason);
    return false;
  }
}

/** Карта нормалей: картинка или видео, уже декодированные браузером. */
interface TextureSource {
  image: HTMLImageElement | HTMLVideoElement;
  /** Видео и анимация дают новый кадр каждый раз — такую карту льём заново. */
  live: boolean;
}

const sources = new Map<string, TextureSource | null>();

function sourceOf(src: string, animate: boolean): TextureSource | null {
  const key = `${animate ? "a" : "s"}:${src}`;
  if (sources.has(key)) return sources.get(key) ?? null;
  const url = assetUrl(src);
  if (!url) return null;
  const video = animate && /\.(mp4|webm|mov|mkv|m4v)(\?|#|$)/i.test(src);
  if (video) {
    const element = document.createElement("video");
    element.src = url;
    element.muted = true;
    element.loop = true;
    element.playsInline = true;
    element.autoplay = true;
    void element.play().catch(() => undefined);
    sources.set(key, { image: element, live: true });
    return sources.get(key) ?? null;
  }
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  image.onerror = () => sources.set(key, null);
  // Анимированная картинка тоже живая: браузер обновляет её кадр сам.
  sources.set(key, { image, live: animate });
  return sources.get(key) ?? null;
}

/** Сбрасывает кеш карт: пресет сменился, файлов может не стать. */
export function clearNormalSources(): void {
  for (const entry of sources.values()) {
    if (entry && entry.image instanceof HTMLVideoElement) {
      entry.image.pause();
      entry.image.removeAttribute("src");
    }
  }
  sources.clear();
  mapTextures.clear();
}

function ready(texture: TextureSource): boolean {
  const element = texture.image;
  if (element instanceof HTMLVideoElement) return element.readyState >= 2 && element.videoWidth > 0;
  return element.complete && element.naturalWidth > 0;
}

/** Яркость цвета: светлое пятно подсвечивает, тёмное затеняет. */
function polarity(color: string): number {
  const match = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (!match) return 1;
  const [r, g, b] = match[1].split(",").map((part) => Number(part.trim()));
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (!Number.isFinite(luma)) return 1;
  return luma >= 0.5 ? 1 : -1;
}

const SHAPE_ID: Record<LightShape, number> = {
  circle: 0, rect: 1, triangle: 2, sector: 3, screen: 4,
};

function colorParts(value: string): [number, number, number, number] {
  const alpha = alphaOf(value, 1);
  const match = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
  if (!match) {
    // hex: разбираем сами, чтобы не зависеть от разметки цветов в DOM.
    const hex = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
    if (!hex) return [1, 1, 1, alpha];
    const hexColor = withAlpha(`#${hex[1].slice(0, 6)}`, alpha);
    return colorParts(hexColor);
  }
  const parts = match[1].split(",").map((part) => Number(part.trim()));
  return [
    Math.min(1, Math.max(0, (parts[0] ?? 255) / 255)),
    Math.min(1, Math.max(0, (parts[1] ?? 255) / 255)),
    Math.min(1, Math.max(0, (parts[2] ?? 255) / 255)),
    alpha,
  ];
}

function ensureSize(target: Programs, width: number, height: number): void {
  if (target.width === width && target.height === height) return;
  const { gl } = target;
  target.width = width;
  target.height = height;
  gl.bindTexture(gl.TEXTURE_2D, target.normalTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.normalFramebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.normalTexture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/** Рамка работы в пикселях холста: объём считается только внутри неё. */
export interface ShadeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Где в кадровом буфере WebGL лежит рамка объекта.
 *
 * Две системы координат не совпадают: у холста Y растёт вниз, у кадрового
 * буфера — вверх. Вьюпорт с `y = 0` кладёт содержимое в **низ** буфера, а
 * `drawImage` читает сверху, поэтому объект подменялся прозрачностью и пропадал.
 * Функция переводит строки холста в строки буфера; она же в тестах — чтобы
 * арифметика не разъехалась с рендером.
 *
 * Если рамка выше буфера, она прижимается к нулю: читать всё равно нечего.
 */
export function viewportOf(box: ShadeBox, canvasHeight: number): { x: number; y: number; width: number; height: number } {
  const height = Math.min(box.height, canvasHeight);
  const y = Math.max(0, canvasHeight - box.y - height);
  return { x: Math.max(0, box.x), y, width: box.width, height };
}

/** Копия рамки слоя: в WebGL уходит только она, а не весь холст. */
let scratch: HTMLCanvasElement | null = null;

function scratchOf(source: HTMLCanvasElement, box: ShadeBox): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  if (!scratch) scratch = document.createElement("canvas");
  if (scratch.width !== box.width) scratch.width = box.width;
  if (scratch.height !== box.height) scratch.height = box.height;
  const ctx = scratch.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, box.width, box.height);
  ctx.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  return scratch;
}

/**
 * Объём одного объекта: его слой → текстура → WebGL2 → обратно в тот же слой.
 *
 * Объём считается **по объекту**, а не по готовой сцене. Причина в слоях:
 * общий буфер нормалей на весь холст закрашивал пиксели, которые уже заняты
 * объектами выше, и объём нижнего объекта просвечивал сквозь них. Здесь слой
 * содержит только сам объект, поэтому объём принадлежит ему: всё, что нарисуют
 * после, его перекрывает, а прозрачные пиксели ничего не подсвечивают.
 *
 * Работа ограничена рамкой объекта (`box`), поэтому цена кадра зависит от
 * размера объекта, а не от размера холста.
 *
 * Возвращает `true`, если объём посчитан. Любая неготовность (нет WebGL2, карта
 * ещё грузится, шейдер не собрался) — это `false`, и слой остаётся ровно таким,
 * каким его нарисовал Canvas 2D.
 */
export function shadeLayer(
  layer: HTMLCanvasElement,
  sample: ShadeSample,
  lights: LightSample[],
  box: ShadeBox,
): boolean {
  // Света в сцене может не быть вовсе: материал и свечение от него не зависят,
  // и раньше именно этот выход гасил неон «при любых обстоятельствах».
  if (!lights.length && !sample.material) return false;
  if (box.width < 2 || box.height < 2) return false;
  if (!lightingAvailable() || !state) return false;
  if (!sample.normal && !sample.material) return false;
  const program = state;
  const source = scratchOf(layer, box);
  if (!source) return false;

  // Каждая карта грузится асинхронно: пока файла нет, объёма просто нет, а
  // объект остаётся на месте. Материал без карт работает по константам.
  const normalSource = sample.normal;
  const normalStrength = normalSource ? normalSource.strength / 100 : 0;
  const normalTexture = normalSource && normalSource.strength > 0
    ? readySource(normalSource.src)
    : null;
  const material = sample.material;
  // Материал считается и без карты нормалей: тогда поверхность плоская, но
  // блик, металл и окклюзия работают. Ждать карту незачем — иначе на время
  // загрузки молча пропадал бы весь материал. Совсем без материала и без
  // карты считать нечего.
  if (!normalTexture && !material) return false;
  const bindings = material
    ? [material.roughness, material.metallic, material.ao].map((channel) => (
      channel.mode === 1 ? readySource(channel.src) : null
    ))
    : [];
  // Свой файл канала ещё грузится — канал читает константу (см. `modeOf`), а
  // не отменяет проход: иначе один недокачанный файл гасил весь материал, и
  // объект выглядел плоским без всякой причины на экране.

  const gl = program.gl;
  const width = box.width;
  const height = box.height;

  try {
    // Буферы держим размером холста: рамка объекта гуляет с камерой, и
    // пересоздавать текстуры на каждый её сдвиг незачем. Вьюпорт и размеры
    // рамки уходят в шейдер.
    if (gl.canvas.width !== layer.width || gl.canvas.height !== layer.height) {
      gl.canvas.width = layer.width;
      gl.canvas.height = layer.height;
    }
    ensureSize(program, layer.width, layer.height);

    // Проход объёма рисует в том месте кадрового буфера, где рамка лежит на
    // холсте: буфер считает строки снизу, холст — сверху.
    const viewport = viewportOf(box, layer.height);

    // 1. Карта нормалей объекта. Текстуру нормалей проход объёма читает по
    // рамке объекта (vUv от 0 до 1), поэтому рамка занимает весь буфер.
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.normalFramebuffer);
    gl.viewport(0, 0, layer.width, layer.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);
    if (normalTexture) {
      gl.useProgram(program.normal);
      gl.bindBuffer(gl.ARRAY_BUFFER, state.quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(gl.getUniformLocation(program.normal, "uSize"), width, height);
      gl.uniform2f(gl.getUniformLocation(program.normal, "uOrigin"), box.x, box.y);
      gl.uniformMatrix3fv(gl.getUniformLocation(program.normal, "uMatrix"), false, new Float32Array(sample.matrix));
      gl.uniform4f(gl.getUniformLocation(program.normal, "uRect"), sample.rect[0], sample.rect[1], sample.rect[2], sample.rect[3]);
      gl.uniform1f(gl.getUniformLocation(program.normal, "uStrength"), Math.min(2, Math.max(0, normalStrength)));
      gl.uniform1i(gl.getUniformLocation(program.normal, "uMap"), 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, createMapTexture(gl, `${normalSource!.src}|${normalTexture.live}`, normalTexture));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // 2. Слой объекта: текстура, обратно — с объёмом и материалом.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
    gl.useProgram(program.volume);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneTexture(gl, source));
    gl.uniform1i(gl.getUniformLocation(program.volume, "uScene"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, normalTexture ? program.normalTexture : white(gl));
    gl.uniform1i(gl.getUniformLocation(program.volume, "uNormals"), 1);

    // Каналы материала: упакованная карта, свои файлы и константы. На каждую
    // текстуру — свой блок, неиспользованные получают белую заглушку.
    const packed = material?.packed ? readySource(material.packed) : null;
    const bindChannel = (index: number, unit: number, name: string, source: TextureSource | null) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, source
        ? createMapTexture(gl, `${name}|${source.live}`, source)
        : white(gl));
      gl.uniform1i(gl.getUniformLocation(program.volume, name), unit);
    };
    bindChannel(0, 2, "uPacked", packed);
    bindChannel(1, 3, "uRoughTex", bindings[0] ?? null);
    bindChannel(2, 4, "uMetalTex", bindings[1] ?? null);
    bindChannel(3, 5, "uAoTex", bindings[2] ?? null);
    const emissiveTexture = material?.emissive.src ? readySource(material.emissive.src) : null;
    bindChannel(4, 6, "uEmissiveTex", emissiveTexture);

    gl.uniform1i(gl.getUniformLocation(program.volume, "uMaterial"), material ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(program.volume, "uHasNormal"), normalTexture ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(program.volume, "uNormalStrength"), Math.min(2, Math.max(0, sample.strength)));
    if (material) {
      // Режим канала: файла нет — читаем константу, а не пустую текстуру.
      const modeOf = (channel: ChannelBinding, source: TextureSource | null) => {
        if (channel.mode === 1) return source ? 1 : 0;
        if (channel.mode === 2) return packed ? 2 : 0;
        return 0;
      };
      const setChannel = (prefix: string, channel: ChannelBinding, source: TextureSource | null) => {
        gl.uniform1i(gl.getUniformLocation(program.volume, `u${prefix}Mode`), modeOf(channel, source));
        gl.uniform1i(gl.getUniformLocation(program.volume, `u${prefix}Channel`), channel.channel);
        gl.uniform1f(gl.getUniformLocation(program.volume, `u${prefix}Value`), channel.value);
      };
      setChannel("Rough", material.roughness, bindings[0] ?? null);
      setChannel("Metal", material.metallic, bindings[1] ?? null);
      setChannel("Ao", material.ao, bindings[2] ?? null);
      gl.uniform1f(gl.getUniformLocation(program.volume, "uSpecular"), Math.min(2, Math.max(0, material.specular)));
      gl.uniform1f(gl.getUniformLocation(program.volume, "uF0"), Math.min(0.16, Math.max(0, material.f0)));
      gl.uniform1i(gl.getUniformLocation(program.volume, "uEmissiveMode"), emissiveTexture ? 1 : 0);
      gl.uniform3f(
        gl.getUniformLocation(program.volume, "uEmissiveColor"),
        material.emissive.color[0], material.emissive.color[1], material.emissive.color[2],
      );
      gl.uniform1f(gl.getUniformLocation(program.volume, "uEmissiveStrength"), Math.min(2, Math.max(0, material.emissive.strength)));
      gl.uniform4f(
        gl.getUniformLocation(program.volume, "uEnvironment"),
        material.environment.color[0], material.environment.color[1], material.environment.color[2],
        Math.min(2, Math.max(0, material.environment.level)),
      );
    }
    // Размер всего холста нужен только форме «весь экран»: её радиус — диагональ.
    gl.uniform2f(gl.getUniformLocation(program.volume, "uCanvas"), layer.width, layer.height);
    gl.uniform2f(gl.getUniformLocation(program.volume, "uOrigin"), box.x, box.y);
    gl.uniform2f(gl.getUniformLocation(program.volume, "uSize"), width, height);
    // UV карт считается от объекта: обратная матрица и его прямоугольник.
    const inverse = invertMatrix3(sample.matrix);
    gl.uniformMatrix3fv(gl.getUniformLocation(program.volume, "uInverse"), false, inverse);
    gl.uniform4f(gl.getUniformLocation(program.volume, "uUvRect"), ...sample.rect);
    // Масштаб объекта в пикселях холста: в этих единицах считаются направления
    // на свет, поэтому «пол» высоты не зависит от зума.
    gl.uniform1f(gl.getUniformLocation(program.volume, "uScale"), Math.max(
      Math.hypot(sample.matrix[0], sample.matrix[1]), 0.0001,
    ));

    const used = lights.slice(0, MAX_LIGHTS);
    const color0 = new Float32Array(MAX_LIGHTS * 4);
    const color1 = new Float32Array(MAX_LIGHTS * 4);
    const geom = new Float32Array(MAX_LIGHTS * 4);
    const shape = new Float32Array(MAX_LIGHTS * 4);
    const extra = new Float32Array(MAX_LIGHTS * 4);
    used.forEach((light, index) => {
      const start = colorParts(light.colorStart);
      const end = colorParts(light.colorEnd);
      const level = Math.min(2, Math.max(0, light.brightness / 100));
      color0.set([start[0], start[1], start[2], start[3] * level], index * 4);
      color1.set([end[0], end[1], end[2], end[3] * level], index * 4);
      geom.set([light.x, light.y, Math.max(1, light.radius), light.rotation], index * 4);
      shape.set([
        SHAPE_ID[light.shape] ?? 0,
        light.angle,
        Math.min(1, Math.max(0, light.softness / 100)),
        polarity(light.colorStart),
      ], index * 4);
      // Высота света в пикселях холста: она же масштабируется камерой.
      extra.set([Math.max(1, light.height), Math.min(2, Math.max(0, light.specular / 100)), 0, 0], index * 4);
    });
    gl.uniform1i(gl.getUniformLocation(program.volume, "uCount"), used.length);
    gl.uniform4fv(gl.getUniformLocation(program.volume, "uColor0"), color0);
    gl.uniform4fv(gl.getUniformLocation(program.volume, "uColor1"), color1);
    gl.uniform4fv(gl.getUniformLocation(program.volume, "uGeom"), geom);
    gl.uniform4fv(gl.getUniformLocation(program.volume, "uShape"), shape);
    gl.uniform4fv(gl.getUniformLocation(program.volume, "uLightExtra"), extra);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 3. Обратно в слой: рамка заменяется целиком, «copy» внутри отсечения.
    const context = layer.getContext("2d");
    if (!context) return false;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.beginPath();
    context.rect(box.x, box.y, width, height);
    context.clip();
    context.globalAlpha = 1;
    context.globalCompositeOperation = "copy";
    // Копия рамки один к одному. Два разворота гасят друг друга: вьюпорт кладёт
    // содержимое объекта туда, где рамка лежит на холсте, а чтение `drawImage`
    // идёт сверху — в итоге строки совпадают с рамкой, а не с её отражением.
    // Читать по `viewport.y` нельзя: это строка буфера снизу, и объект уезжает
    // по вертикали в обратную сторону от камеры.
    context.drawImage(gl.canvas, box.x, box.y, width, height, box.x, box.y, width, height);
    context.restore();
    disposeSceneTexture(gl);
    return true;
  } catch (reason) {
    console.warn("Объём от карты нормалей пропущен:", reason);
    return false;
  }
}

/** Готовая текстура файла канала или `null`, если файл ещё не пришёл. */
function readySource(src: string | null): TextureSource | null {
  if (!src) return null;
  const texture = sourceOf(src, true);
  return texture && ready(texture) ? texture : null;
}

/** Белая заглушка для неиспользованных сэмплеров: читать из неё безопасно. */
let whiteTexture: WebGLTexture | null = null;

function white(gl: WebGL2RenderingContext): WebGLTexture {
  if (!whiteTexture) {
    whiteTexture = gl.createTexture();
    if (whiteTexture) {
      gl.bindTexture(gl.TEXTURE_2D, whiteTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
      textureSettings(gl);
    }
  }
  return whiteTexture!;
}

function textureSettings(gl: WebGL2RenderingContext): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

/** Текстуры карт нормалей: у каждого файла своя, статичная заливается раз. */
interface MapTexture {
  texture: WebGLTexture;
  live: boolean;
  uploaded: boolean;
}

const mapTextures = new Map<string, MapTexture>();

function createMapTexture(gl: WebGL2RenderingContext, key: string, source: TextureSource): WebGLTexture {
  let entry = mapTextures.get(key);
  if (!entry) {
    const texture = gl.createTexture();
    if (!texture) throw new Error("texture");
    entry = { texture, live: source.live, uploaded: false };
    mapTextures.set(key, entry);
  }
  gl.bindTexture(gl.TEXTURE_2D, entry.texture);
  // Статичную карту заливаем один раз, живую — каждый кадр: видео и
  // анимация дают новый кадр сами.
  if (!entry.uploaded || entry.live) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source.image);
    textureSettings(gl);
    entry.uploaded = true;
  }
  return entry.texture;
}

/**
 * Обратная матрица 3×3 для матрицы объекта (последняя строка всегда 0, 0, 1).
 *
 * Нужна, чтобы из координат холста получить координаты объекта и по ним взять
 * UV карты: камера и поворот на UV влиять не должны.
 */
export function invertMatrix3(matrix: readonly number[]): Float32Array {
  const [a, b, , c, d, , e, f] = matrix;
  const det = a * d - b * c;
  const k = Math.abs(det) < 1e-9 ? 1e6 : 1 / det;
  return new Float32Array([
    d * k, -b * k, 0,
    -c * k, a * k, 0,
    (c * f - d * e) * k, (b * e - a * f) * k, 1,
  ]);
}

let sceneTextureCache: WebGLTexture | null = null;

function sceneTexture(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement): WebGLTexture {
  if (!sceneTextureCache) sceneTextureCache = gl.createTexture();
  const texture = sceneTextureCache!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  textureSettings(gl);
  return texture;
}

function disposeSceneTexture(gl: WebGL2RenderingContext): void {
  gl.activeTexture(gl.TEXTURE0);
}
