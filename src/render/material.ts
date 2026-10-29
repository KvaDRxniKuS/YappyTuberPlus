import {
  DEFAULT_CHANNEL, DEFAULT_ENVIRONMENT, DEFAULT_MATERIAL, MAX_IOR, MIN_IOR, f0FromIor,
  type ChannelSpec, type EmissiveSpec, type EnvironmentSpec, type MaterialSpec,
} from "../types";

/**
 * Материал поверхности: чистая математика, без canvas и WebGL.
 *
 * Зачем отдельный модуль, а не только шейдер: те же формулы считают лист-дебаг
 * в примере (`scripts/material-math.mjs`) и проверки в тестах. Шейдер — это
 * перенос этих функций на GLSL; если они разойдутся, это ловит тест на числах,
 * а не глаз через неделю.
 *
 * Модель — Cook-Torrance с распределением GGX и аппроксимацией Шлика:
 * дешёво на 8 светов и совпадает с тем, что видно в 3D-редакторах.
 */

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Гладкий переход 1 → 0 между `edge0` и `edge1`: то же, что `smoothstep` в GLSL. */
function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Минимум окружения: у металла диффузной части нет вовсе, и без отражения он
 * чёрный вне пятна света — ровно так «половина куба» и пропадала.
 */
export const MIN_AMBIENT = 0.35;

/**
 * Экспозиция отражения: во сколько раз блик ярче самой подсветки холста.
 *
 * Свет на холсте — полупрозрачная дымка, а в отражении он виден как тело
 * источника. Без множителя отражение диэлектрика (4 % по Шлику) тонуло в
 * диффузной части и глаз не различал блика вовсе. Это ручная экспозиция, а не
 * физика: потолок усиления больше не нужен — лепесток ограничен своим
 * максимумом по построению.
 */
export const SPECULAR_EXPOSURE = 6;


/**
 * Половина ширины чистого GGX по углу: θ½ = √(√2 − 1)·α = 0.64359·roughness².
 * Через неё шероховатость превращается в угол — ту же единицу, в которой
 * измеряются тело источника и пиксель холста.
 */
export const LOBE_HALF_RATIO = 0.64359;
/** Пол ширины блика: доля углового тела света — 15 %. */
export const SPECULAR_BODY_FLOOR = 0.15;
/** Шаг одного пикселя холста в доле блика (сглаживание, не размытие). */
export const SPECULAR_PIXEL_FLOOR = 1;

/**
 * Колено экспозиции блика: F0, выше которого поверхность и так отражает
 * заметно и подтягивать её не за чем. У диэлектрика F0 = 4 % (0.04) — он
 * получает почти всю экспозицию; у металла F0 = цвет объекта (обычно 0.5…1) —
 * он получает единицу. Без колена металл под лампой выбеливался в пятно:
 * `0.55 · 6` — это 3.3, а не отражение лампы.
 */
export const SPECULAR_EXPOSURE_KNEE = 0.32;

/**
 * Досягаемость блика в радиусах пятна. За краем подсветки света нет, а
 * отражение есть: оно спадает к этой границе плавно, а не обрывается по ней —
 * иначе край пятна было видно полосой поперёк поверхности.
 */
export const SPECULAR_REACH = 1.8;

export interface Channel {
  value: number;
  file: string | null;
  from: "value" | "file" | "packed";
  packedChannel: "r" | "g" | "b" | "a";
}

/** Канал как значение 0…1 в инспекторе — с проверкой того, что пришло из файла. */
export function normalizeChannel(raw: unknown, fallback: ChannelSpec): ChannelSpec {
  if (!raw || typeof raw !== "object") return { ...fallback };
  const source = raw as Partial<ChannelSpec>;
  const from = source.from === "file" || source.from === "packed" ? source.from : "value";
  // Буква канала по умолчанию — своя у каждого канала (ORM: R окклюзия,
  // G шероховатость, B металл), а не всегда «R».
  const channel = source.packedChannel === "r" || source.packedChannel === "g"
    || source.packedChannel === "b" || source.packedChannel === "a"
    ? source.packedChannel
    : fallback.packedChannel;
  return {
    value: clamp(Number(source.value ?? fallback.value) || 0, 0, 1),
    file: typeof source.file === "string" && source.file ? source.file : null,
    // Режим — это намерение человека, а не следствие выбранного файла: нажав
    // «файл», он ждёт переключатель, даже пока файла нет. Что читать, решает
    // `channelBinding`: без файла — константу.
    from,
    packedChannel: channel,
  };
}

function normalizeEmissive(raw: unknown): EmissiveSpec {
  const fallback = DEFAULT_MATERIAL.emissive;
  if (!raw || typeof raw !== "object") return { ...fallback };
  const source = raw as Partial<EmissiveSpec>;
  return {
    color: typeof source.color === "string" && /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(source.color)
      ? source.color
      : fallback.color,
    strength: clamp(Number(source.strength ?? 0) || 0, 0, 200),
    file: typeof source.file === "string" && source.file ? source.file : null,
  };
}

/**
 * Материал из файла: `undefined` — материала нет, объект рисуется по-старому.
 *
 * Так честнее, чем «материал по умолчанию у всех»: набор полей в JSON означает
 * решение пользователя, а его отсутствие — прежний вид, который не должен
 * измениться ни на пиксель.
 */
export function normalizeMaterial(raw: unknown): MaterialSpec | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Partial<MaterialSpec>;
  return {
    roughness: normalizeChannel(source.roughness, DEFAULT_MATERIAL.roughness),
    metallic: normalizeChannel(source.metallic, DEFAULT_MATERIAL.metallic),
    ao: normalizeChannel(source.ao, DEFAULT_MATERIAL.ao),
    emissive: normalizeEmissive(source.emissive),
    packed: typeof source.packed === "string" && source.packed ? source.packed : null,
    specular: clamp(Number(source.specular ?? 100) || 0, 0, 200),
    // IOR: у старого файла поля нет — берём «обычный диэлектрик» 1.5.
    ior: clamp(Number(source.ior ?? DEFAULT_MATERIAL.ior) || DEFAULT_MATERIAL.ior, MIN_IOR, MAX_IOR),
  };
}

/**
 * Материал «как в первый раз»: значения по умолчанию и ни одной карты.
 *
 * Отдельная функция, а не `{ ...DEFAULT_MATERIAL }`, потому что каналы и
 * свечение — вложенные объекты: при мелкой копии они остались бы общими с
 * умолчаниями, и правка одного объекта меняла бы «умолчание» для всех
 * остальных. Сброс обязан отвязывать все карты: упакованную, свои файлы
 * каналов и карту свечения — иначе после сброса материал продолжал бы читать
 * старую картинку, и «сбросить» означало бы только половину.
 */
export function defaultMaterial(): MaterialSpec {
  return {
    roughness: { ...DEFAULT_MATERIAL.roughness, file: null, from: "value" },
    metallic: { ...DEFAULT_MATERIAL.metallic, file: null, from: "value" },
    ao: { ...DEFAULT_MATERIAL.ao, file: null, from: "value" },
    emissive: { ...DEFAULT_MATERIAL.emissive, file: null },
    packed: null,
    specular: DEFAULT_MATERIAL.specular,
    ior: DEFAULT_MATERIAL.ior,
  };
}

export function normalizeEnvironment(raw: unknown): EnvironmentSpec {
  const source = raw && typeof raw === "object" ? raw as Partial<EnvironmentSpec> : {};
  return {
    color: typeof source.color === "string" && /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(source.color)
      ? source.color
      : DEFAULT_ENVIRONMENT.color,
    level: clamp(Number(source.level ?? 0) || 0, 0, 200),
  };
}

/**
 * Значение канала в точке: `texture` — тексель из карты (0…1), `constant` — из
 * инспектора. Когда файла нет, шейдер берёт константу.
 */
export interface ChannelRuntime {
  /** Тексель канала; `null` — значения нет, берётся константа. */
  sample: [number, number, number] | null;
  value: number;
}

/** Что нужно шейдеру от материала в точке (для тестов и дебага). */
export interface MaterialPoint {
  albedo: [number, number, number];
  normal: [number, number, number];
  roughness: number;
  metallic: number;
  ao: number;
  emissive: [number, number, number];
  /** Сила блика материала 0…2. */
  specular: number;
  /** Отражение диэлектрика: из IOR, 0.04 у «обычного» (IOR 1.5). */
  f0: number;
  /** Окружение: цвет и уровень 0…2. */
  environment: { color: [number, number, number]; level: number };
}

/**
 * Распределение нормалей GGX: чем меньше `roughness`, тем уже и ярче блик.
 *
 * `NdotH` ограничен снизу: при нуле формула даёт деление на ноль, а разницы
 * между 0 и 1e-4 в кадре не видно.
 */
export function ggxDistribution(NdotH: number, roughness: number): number {
  const alpha = Math.max(roughness * roughness, 0.002);
  const a2 = alpha * alpha;
  const d = NdotH * NdotH * (a2 - 1) + 1;
  return a2 / (Math.PI * d * d);
}

/**
 * Доля блика: 1 в точном зеркальном направлении, 0.5 на полуширине лепестка,
 * дальше — спад по тому же закону, что у GGX по углу (1/θ⁴). Лепесток
 * ограничен своим максимумом по построению, поэтому ни поля снизу, ни потолка
 * усиления не нужно.
 *
 * `√2 − 1 = 0.41421` — множитель, при котором знаменатель равен 2 ровно на
 * полуширине.
 *
 * Причина, по которой отсюда убран прежний множитель `D / (4·NdotL)`: без полок
 * он делал косое падение ярче прямого, и на плоской поверхности максимум
 * уползал на кольцо в 40 % радиуса пятна — «полоса» вместо точки.
 */
export function specLobe(angle: number, halfWidth: number): number {
  const k = ((angle * angle) / Math.max(halfWidth * halfWidth, 1e-8)) * (Math.SQRT2 - 1);
  const d = 1 + k;
  return 1 / (d * d);
}

/**
 * Полуширина лепестка в углах: шероховатость (у GGX это 0.64359·rough²), но не
 * уже 15 % углового тела света и не уже пикселя холста. Второй пол — ответ на
 * жалобу «блика нет»: при шероховатости ниже примерно 0.15 лепесток был мельче
 * пикселя и исчезал. Третий множитель (`psi`) несёт форму источника: край
 * формы в направлении отклонения считает та же `outlineRay`, что и пятно.
 */
export function specLobeWidth(roughness: number, psi: number, dist: number): number {
  const alpha = Math.max(roughness * roughness, 0.002);
  return Math.max(
    LOBE_HALF_RATIO * alpha,
    Math.max(psi * SPECULAR_BODY_FLOOR, SPECULAR_PIXEL_FLOOR / dist),
  );
}

/** Знаковая площадь внутри треугольника: больше нуля значит «внутри». */
function triangleInside(point: [number, number]): number {
  const a: [number, number] = [0, -1];
  const b: [number, number] = [0.866025, 0.5];
  const c: [number, number] = [-0.866025, 0.5];
  const cross = (u: [number, number], v: [number, number], q: [number, number]) =>
    (v[0] - u[0]) * (q[1] - u[1]) - (v[1] - u[1]) * (q[0] - u[0]);
  return Math.min(cross(a, b, point), cross(b, c, point), cross(c, a, point));
}

/**
 * Форма источника: 0 в центре фигуры, 1 на её краю; `cover` — мягкая стенка
 * (у треугольника и сектора это и есть сама фигура).
 *
 * Одна функция на подсветку холста и на блик — поэтому у прямоугольного света
 * отражение прямоугольное, у треугольного — треугольное, и поворот у них
 * общий. `local` уже поделен на масштаб: радиус пятна для подсветки и «тело»
 * источника для блика; для формы «весь экран» масштабом служит диагональ.
 */
export function shapeEdge(
  local: [number, number],
  shape: number,
  halfAngle: number,
  soft: number,
): { d: number; cover: number } {
  if (shape < 0.5) return { d: Math.hypot(local[0], local[1]), cover: 1 };
  if (shape < 1.5) {
    return { d: Math.max(Math.abs(local[0]), Math.abs(local[1])), cover: 1 };
  }
  if (shape < 2.5) {
    return {
      d: Math.hypot(local[0], local[1]) / 1.5,
      cover: clamp(triangleInside(local) / Math.max(soft * 0.35, 0.001), 0, 1),
    };
  }
  if (shape < 3.5) {
    const dir = Math.atan2(local[0], -local[1]);
    return {
      d: Math.hypot(local[0], local[1]),
      cover: clamp((halfAngle - Math.abs(dir)) / Math.max(soft * halfAngle, 0.001), 0, 1),
    };
  }
  return { d: Math.hypot(local[0], local[1]), cover: 1 };
}

/**
 * Насколько далеко по направлению `dir` лежит край формы источника: угловой
 * контур света. Бисекция идёт по той же `shapeEdge`, поэтому блик наследует и
 * треугольник, и сектор, и поворот — всё, что умеет сам свет.
 *
 * Восемь шагов — это около 1 % по краю: больше не нужно, спорит с ценой пикселя.
 */
export function outlineRay(
  dir: [number, number],
  shape: number,
  halfAngle: number,
  soft: number,
): number {
  let low = 0.05;
  let high = 3;
  for (let step = 0; step < 8; step += 1) {
    const mid = (low + high) / 2;
    const probe = shapeEdge([dir[0] * mid, dir[1] * mid], shape, halfAngle, soft);
    if (probe.d <= 1 && probe.cover > 0) low = mid;
    else high = mid;
  }
  return low;
}

/** Френель Шлика: у металла отражение красят в цвет альбедо, у диэлектрика — 4 %. */
export function fresnel(VdotH: number, F0: [number, number, number]): [number, number, number] {
  const k = Math.pow(1 - clamp(VdotH, 0, 1), 5);
  return [
    F0[0] + (1 - F0[0]) * k,
    F0[1] + (1 - F0[1]) * k,
    F0[2] + (1 - F0[2]) * k,
  ];
}

/**
 * База отражения: у диэлектрика — свой F0 (из IOR), у металла — цвет объекта.
 *
 * Общий 0.04 — это только «обычный диэлектрик» (IOR 1.5). Кожа отражает 2.8 %
 * (IOR 1.4), зубы 5.8 % (1.6), поэтому F0 приходит параметром.
 */
export function baseReflectance(
  albedo: [number, number, number],
  metallic: number,
  f0 = 0.04,
): [number, number, number] {
  const m = clamp(metallic, 0, 1);
  const base = clamp(f0, 0, 1);
  return [
    base + (albedo[0] - base) * m,
    base + (albedo[1] - base) * m,
    base + (albedo[2] - base) * m,
  ];
}

/**
 * Геометрия источника света для блика: те же числа, что уходят в `uGeom` и
 * `uShape` шейдера объёма. Без них отражение нельзя ни посчитать, ни нарисовать
 * формой источника — направление `L` для этого не достаточно.
 */
export interface LightBody {
  /** Смещение от точки к центру пятна, пиксели холста (y вниз). */
  toLight: [number, number];
  /** Высота света над холстом, пиксели холста. */
  height: number;
  /**
   * Масштаб формы, пиксели холста: радиус пятна, а для «весь экран» —
   * диагональ холста. Именно так его видит шейдер.
   */
  span: number;
  /** Форма: 0 круг, 1 прямоугольник, 2 треугольник, 3 сектор, 4 весь экран. */
  shape: number;
  /** Половина раствора сектора в радианах. */
  halfAngle: number;
  /** Мягкость края 0…1. */
  soft: number;
  /** Поворот источника в радианах. */
  rotation: number;
  /** Альфа света в центре пятна: яркость отражения. */
  core: number;
  /** Цвет света в центре пятна, 0…1 на канал: `color0.rgb` шейдера. */
  tint: [number, number, number];
}

/** Один свет в точке: диффузная добавка и блик, уже умноженные на покрытие пятна. */
export interface LightPoint {
  /** Направление на свет (единичный вектор, z > 0). */
  L: [number, number, number];
  /** Цвет света, помноженный на его яркость и покрытие пятна. */
  color: [number, number, number];
  /** Полярность: −1 — тёмный свет (тень), блика не даёт. */
  polarity: number;
  /** Сила блика этого света 0…2. */
  specular: number;
  /** Форма и положение источника: нужны блику, см. `LightBody`. */
  body: LightBody;
}

export interface ShadeOptions {
  /** Сила нормалей 0…2: 0 — поверхность плоская. */
  normalStrength: number;
  /** В `true` материал считается полностью; в `false` — прежний объём. */
  material: boolean;
}

/**
 * Итоговый цвет точки.
 *
 * Без материала (`material: false`) функция не считает ничего: прежний вид —
 * это объём от нормалей, и он остаётся в шейдере (`lighting.ts`), чтобы старые
 * пресеты не сдвинулись ни на пиксель. С материалом — диффузная часть, блик
 * GGX, окклюзия, окружение и свечение.
 */
export function shadePoint(point: MaterialPoint, lights: LightPoint[], options: ShadeOptions): [number, number, number] {
  const [albedoR, albedoG, albedoB] = point.albedo;
  // Нормаль: сила 0 делает поверхность плоской, как и раньше у карты нормалей.
  const flat: [number, number, number] = [
    point.normal[0] * options.normalStrength,
    point.normal[1] * options.normalStrength,
    point.normal[2] + (1 - options.normalStrength),
  ];
  const length = Math.hypot(flat[0], flat[1], flat[2]) || 1;
  const N: [number, number, number] = [flat[0] / length, flat[1] / length, flat[2] / length];
  const V: [number, number, number] = [0, 0, 1];

  const metallic = clamp(point.metallic, 0, 1);
  // Минимум — как в шейдере (`clamp(…, 0.02, 1.0)`): «зеркало» не должно
  // считаться по-разному в кадре и на листе примера.
  const roughness = clamp(point.roughness, 0.02, 1);
  const F0 = baseReflectance([albedoR, albedoG, albedoB], metallic, point.f0);
  // Минимум окружения: у металла диффузной части нет вовсе, и без отражения
  // он чёрный вне пятна света — ровно так «половина куба» и пропадала.
  const ambientLevel = Math.max(clamp(point.environment.level, 0, 2), MIN_AMBIENT);
  const ambient: [number, number, number] = [
    point.environment.color[0] * ambientLevel,
    point.environment.color[1] * ambientLevel,
    point.environment.color[2] * ambientLevel,
  ];

  // Окружение — это отражение, а не диффузный свет: у металла оно красится его
  // цветом (F0), у диэлектрика даёт свои 4 %. Иначе металл без света был бы
  // всегда чёрным, даже в светлой комнате.
  const out: [number, number, number] = [
    (albedoR * (1 - metallic) + F0[0]) * ambient[0] * point.ao + point.emissive[0],
    (albedoG * (1 - metallic) + F0[1]) * ambient[1] * point.ao + point.emissive[1],
    (albedoB * (1 - metallic) + F0[2]) * ambient[2] * point.ao + point.emissive[2],
  ];
  const diffuseWeight = (1 - metallic) * point.ao;

  for (const light of lights) {
    // Тёмный свет — это тень: в материале он гасит диффузную часть (это делает
    // шейдер), а сам ничего не добавляет.
    if (light.polarity <= 0) continue;
    const body = light.body;
    const cos = Math.cos(body.rotation);
    const sin = Math.sin(body.rotation);
    // Смещение точки от центра света и её координата в системе источника:
    // ровно то же, что считает шейдер (`rel`, `local`).
    const rel: [number, number] = [-body.toLight[0], -body.toLight[1]];
    const inSource: [number, number] = [
      (cos * rel[0] + sin * rel[1]) / body.span,
      (-sin * rel[0] + cos * rel[1]) / body.span,
    ];
    const patch = shapeEdge(inSource, body.shape, body.halfAngle, body.soft);
    // Блик спадает к `SPECULAR_REACH`, а не обрывается краем пятна: за ним
    // подсветки нет, а отражение есть. Диффузную часть это не касается:
    // покрытие пятна уже умножено в `color` (в шейдере за него отвечает `a`).
    const specAllowed = patch.d <= SPECULAR_REACH;
    const NdotL = dot3(N, light.L);
    if (NdotL <= 0) continue;
    const H = normalize3([light.L[0] + V[0], light.L[1] + V[1], light.L[2] + V[2]]);
    // Шлик по полувектору и взгляду: V смотрит вдоль нормали холста,
    // поэтому VdotH = H.z — ровно то же, что в шейдере.
    const F = fresnel(Math.max(H[2], 0), F0);
    // Угол между полувектором и нормалью = «насколько мимо блика» лежит
    // точка: 0 в центре отражения, рост к краям. Берётся именно так, а не
    // трассировкой отражённого луча, потому что под ортографической камерой
    // такой луч на грани круче 45° уходит за спину и блика не было бы вовсе.
    const NdotH = clamp(dot3(N, H), 0, 1);
    const angDev = Math.acos(NdotH);
    // Угловой радиус тела источника: его отражение и есть блик. Край формы
    // берётся в направлении отклонения — поэтому у прямоугольного света пятно
    // прямоугольное, у треугольного — треугольное, поворот общий.
    const dist = Math.max(Math.hypot(rel[0], rel[1], Math.max(body.height, 1)), 1);
    const bulk = Math.max(body.span * (1 - body.soft), body.span * 0.15);
    const dev: [number, number] = [H[0] - N[0] * NdotH, H[1] - N[1] * NdotH];
    const devLen = Math.hypot(dev[0], dev[1]);
    const relLen = Math.hypot(rel[0], rel[1]);
    // Ровно под центром света отклонение нулевое и направление вырождено:
    // тогда направление берём от центра пятна, иначе бисекция контура уходит
    // за свою верхнюю границу и раздувает блик втрое.
    const tangent: [number, number] = devLen > 1e-4
      ? [dev[0] / devLen, dev[1] / devLen]
      : (relLen > 1e-4 ? [rel[0] / relLen, rel[1] / relLen] : [1, 0]);
    const dirH: [number, number] = [
      (cos * tangent[0] + sin * tangent[1]),
      (-sin * tangent[0] + cos * tangent[1]),
    ];
    // Угловой радиус края формы света в направлении отклонения: он решает,
    // какую форму имеет блик, и поворот наследует у самого источника.
    const psi = Math.atan((bulk * outlineRay(dirH, body.shape, body.halfAngle, body.soft)) / dist);
    const lobe = specLobe(angDev, specLobeWidth(roughness, psi, dist));
    // Узкий блик чуть ярче широкого: `mix(1, 2, 1 − roughness)` — это 2 − roughness.
    // Экспозиция нужна слабым отражателям (диэлектрик со своими 4 % тонул бы в
    // диффузной части) и гаснет там, где отражение и так яркое: у металла F0 —
    // цвет объекта, и без колена его пик выбеливал пол-пятна.
    const f0Max = Math.max(F0[0], Math.max(F0[1], F0[2]));
    const exposure = 1 + (SPECULAR_EXPOSURE - 1) * clamp(1 - f0Max / SPECULAR_EXPOSURE_KNEE, 0, 1);
    const amp = (2 - roughness) * exposure;

    const reach = specAllowed ? body.core * (1 - smoothstep(1, SPECULAR_REACH, patch.d)) : 0;
    const specScale = lobe * reach * amp * NdotL * point.specular * light.specular
      * Math.max(0, light.polarity);
    const diffScale = NdotL * diffuseWeight;

    for (let c = 0; c < 3; c += 1) {
      // Диффузная часть идёт через `color`: в нём уже лежит покрытие пятна.
      // Блик — через `tint` и `reach`: отражение видно и там, куда пятно не
      // дотянулось, поэтому множитель покрытия к нему не применяется.
      out[c] += light.color[c] * diffScale * (point.albedo[c] as number)
        + body.tint[c] * F[c] * specScale;
    }
  }

  // Энергия ограничена мягко: 8 близких светов не должны выжигать объект.
  return [
    clamp(out[0], 0, 8),
    clamp(out[1], 0, 8),
    clamp(out[2], 0, 8),
  ];
}

/** Применить материал к цвету сцены: то, что делает шейдер в каждом пикселе. */
export function applyMaterial(
  scene: [number, number, number],
  point: MaterialPoint,
  lights: LightPoint[],
  options: ShadeOptions,
): [number, number, number] {
  // Без материала цвет сцены остаётся как есть: его уже посчитал Canvas 2D.
  if (!options.material) return scene;
  // С материалом альбедо уже учтено в расчёте: цвет сцены нужен только чтобы
  // сохранить края и прозрачность, поэтому множителя нет.
  return shadePoint(point, lights, options);
}

function dot3(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize3(v: [number, number, number]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/**
 * Готовые наборы материала — это **список значений**, а не режим и не карта.
 *
 * Набор задаёт только числа: шероховатость, металл, отражение и свечение.
 * Источник канала (число, своя карта, буква ORM) он не трогает — иначе нажатие
 * «Кожа» молча отвязывало бы уже выбранную карту шероховатости. Поэтому в
 * наборе нет `ChannelSpec`, а есть голые значения.
 *
 * IOR взят по таблице отрасли (Filament / glTF): пластик и стекло 1.5–1.58,
 * кожа 1.4 (2.8 %), волосы 1.55, зубы 1.6. У металла поле не участвует —
 * металл отражает цветом объекта, — поэтому там нейтральные 1.5.
 */
export interface MaterialPreset {
  id: string;
  label: string;
  /** Шероховатость 0…1. */
  roughness: number;
  /** Металл 0…1. */
  metallic: number;
  /** Отражение диэлектрика (IOR). */
  ior: number;
  /** Свечение: цвет и сила 0…200 %. */
  emissive: { color: string; strength: number };
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  { id: "matte", label: "Матовый", roughness: 0.9, metallic: 0, ior: 1.5, emissive: { color: "#ffffff", strength: 0 } },
  { id: "plastic", label: "Пластик", roughness: 0.35, metallic: 0, ior: 1.5, emissive: { color: "#ffffff", strength: 0 } },
  { id: "metal", label: "Металл", roughness: 0.25, metallic: 1, ior: 1.5, emissive: { color: "#ffffff", strength: 0 } },
  { id: "skin", label: "Кожа", roughness: 0.55, metallic: 0, ior: 1.4, emissive: { color: "#ffffff", strength: 0 } },
  { id: "neon", label: "Неон", roughness: 0.4, metallic: 0, ior: 1.5, emissive: { color: "#66e0ff", strength: 120 } },
];

/**
 * Набор на материал: меняет значения, не трогая источники каналов.
 *
 * Карта шероховатости остаётся подключённой, карта свечения — тоже: их выбирал
 * человек, и терять их от нажатия «Пластик» нельзя.
 */
export function applyPreset(current: MaterialSpec, preset: MaterialPreset): MaterialSpec {
  return {
    ...current,
    roughness: { ...current.roughness, value: preset.roughness },
    metallic: { ...current.metallic, value: preset.metallic },
    ior: preset.ior,
    emissive: { ...current.emissive, color: preset.emissive.color, strength: preset.emissive.strength },
  };
}

/**
 * Какой набор сейчас стоит — или `null`, если ни один.
 *
 * Сравниваются **значения**, а не источники: как только человек сдвинул
 * ползунок, набор перестаёт быть собой, и список честно показывает «нет».
 */
export function matchPreset(material: MaterialSpec | undefined): MaterialPreset | null {
  if (!material) return null;
  const same = (a: number, b: number) => Math.abs(a - b) < 0.005;
  return MATERIAL_PRESETS.find((preset) => (
    same(material.roughness.value, preset.roughness)
    && same(material.metallic.value, preset.metallic)
    && same(material.ior, preset.ior)
    && same(material.emissive.strength, preset.emissive.strength)
    && material.emissive.color.toLowerCase() === preset.emissive.color.toLowerCase()
  )) ?? null;
}

/**
 * Откуда сейчас берутся значения — одной строкой для инспектора.
 *
 * Раскрывать три строки каналов, чтобы понять «а что вообще читается», — лишняя
 * работа; сводка отвечает на это сразу: `ORM · 1 свой файл · 2 числа`.
 */
export function materialSourceSummary(material: MaterialSpec | undefined): string {
  if (!material) return "нет";
  const parts: string[] = [];
  const channels = [material.roughness, material.metallic, material.ao];
  const packed = channels.filter((channel) => channel.from === "packed" && material.packed).length;
  const own = channels.filter((channel) => channel.from === "file" && channel.file).length;
  const numbers = channels.length - packed - own;
  if (packed > 0) parts.push(`ORM ×${packed}`);
  if (own > 0) parts.push(`свой файл ×${own}`);
  if (numbers > 0) parts.push(`числа ×${numbers}`);
  if (material.emissive.file) parts.push("карта свечения");
  return parts.join(" · ") || "числа";
}

/** Файлы материала: всё, что должно попасть в сохранение и папку пресета. */
export function materialSources(material: MaterialSpec | undefined): string[] {
  if (!material) return [];
  const sources = [material.packed, material.emissive.file];
  for (const channel of [material.roughness, material.metallic, material.ao]) {
    if (channel.from === "file") sources.push(channel.file);
  }
  return sources.filter((source): source is string => typeof source === "string" && source.length > 0);
}

/** Канал читается из упакованной карты, а не из своего файла. */
export function usesPacked(material: MaterialSpec | undefined): boolean {
  if (!material?.packed) return false;
  return [material.roughness, material.metallic, material.ao].some((channel) => channel.from === "packed");
}

/** Буква канала → номер для шейдера: 0 R, 1 G, 2 B, 3 A. */
export const PACKED_INDEX: Record<ChannelSpec["packedChannel"], number> = { r: 0, g: 1, b: 2, a: 3 };

/**
 * Канал так, как его читает шейдер.
 *
 * Режим решается по факту: если выбран «свой файл», а файла нет, — читается
 * константа, а не пустая текстура. Иначе объект тихо становился бы чёрным.
 */
export function channelBinding(spec: ChannelSpec): { mode: 0 | 1 | 2; channel: number; value: number; src: string | null } {
  const channel = PACKED_INDEX[spec.packedChannel] ?? 0;
  if (spec.from === "file" && spec.file) return { mode: 1, channel, value: spec.value, src: spec.file };
  if (spec.from === "packed") return { mode: 2, channel, value: spec.value, src: null };
  return { mode: 0, channel, value: spec.value, src: null };
}

/** Цвет вида `#rrggbb` (или `#rrggbbaa`) в три числа 0…1. */
export function hexToRgb(color: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
  if (!match) return [1, 1, 1];
  return [
    parseInt(match[1].slice(0, 2), 16) / 255,
    parseInt(match[1].slice(2, 4), 16) / 255,
    parseInt(match[1].slice(4, 6), 16) / 255,
  ];
}

/** Материал и окружение в виде, который понимает проход объёма. */
export function materialBinding(
  material: MaterialSpec,
  environment: EnvironmentSpec | undefined,
  values?: Record<string, number | undefined>,
): {
  roughness: ReturnType<typeof channelBinding>;
  metallic: ReturnType<typeof channelBinding>;
  ao: ReturnType<typeof channelBinding>;
  emissive: { color: [number, number, number]; strength: number; src: string | null };
  packed: string | null;
  specular: number;
  /** Отражение диэлектрика из IOR: 0.04 у «обычного» (IOR 1.5). */
  f0: number;
  environment: { color: [number, number, number]; level: number };
} {
  const env = environment ?? DEFAULT_ENVIRONMENT;
  // Значение из скрипта: `-1` значит «не задано», и тогда работает инспектор.
  // Свечение складывается — пульсацию пишут прибавлением, а не заменой.
  const live = (key: "roughness" | "metallic" | "ao", channel: ReturnType<typeof channelBinding>) => {
    const value = values?.[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return channel;
    return { mode: 0 as const, channel: channel.channel, value: Math.min(1, value), src: null };
  };
  // Без упакованной карты канал «из карты» читать неоткуда — берём константу.
  const fromPacked = (channel: ChannelSpec) => {
    const binding = channelBinding(channel);
    return binding.mode === 2 && !material.packed
      ? { ...binding, mode: 0 as const }
      : binding;
  };
  const roughness = fromPacked(material.roughness);
  const metallic = fromPacked(material.metallic);
  const ao = fromPacked(material.ao);
  const liveEmissive = values?.emissive;
  const extraGlow = typeof liveEmissive === "number" && Number.isFinite(liveEmissive) ? liveEmissive : 0;
  // Отражение из скрипта: `-1` — «не задано», иначе IOR заменяет инспектор.
  // Ниже 1 показатель преломления не бывает — это уже не физика.
  const liveIor = values?.ior;
  const ior = typeof liveIor === "number" && Number.isFinite(liveIor) && liveIor >= MIN_IOR
    ? Math.min(MAX_IOR, liveIor)
    : material.ior;
  return {
    roughness: live("roughness", roughness),
    metallic: live("metallic", metallic),
    ao: live("ao", ao),
    emissive: {
      color: hexToRgb(material.emissive.color),
      strength: Math.min(2, Math.max(0, material.emissive.strength / 100 + extraGlow)),
      src: material.emissive.file,
    },
    packed: material.packed,
    specular: material.specular / 100,
    // F0 считается здесь, а не в шейдере: одна и та же формула для кадра,
    // тестов и генератора примера.
    f0: f0FromIor(ior),
    environment: { color: hexToRgb(env.color), level: env.level / 100 },
  };
}
