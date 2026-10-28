import {
  DEFAULT_CHANNEL, DEFAULT_ENVIRONMENT, DEFAULT_MATERIAL,
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
  const channel = source.packedChannel === "g" || source.packedChannel === "b" || source.packedChannel === "a"
    ? source.packedChannel
    : "r";
  return {
    value: clamp(Number(source.value ?? fallback.value) || 0, 0, 1),
    file: typeof source.file === "string" && source.file ? source.file : null,
    // Ссылка на файл без файла — не выбранный канал: читать нечего, значит
    // константа. Упаковка проверяется отдельно: её файл лежит в `material.packed`.
    from: from === "file" && !source.file ? "value" : from,
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

/** Френель Шлика: у металла отражение красят в цвет альбедо, у диэлектрика — 4 %. */
export function fresnel(VdotH: number, F0: [number, number, number]): [number, number, number] {
  const k = Math.pow(1 - clamp(VdotH, 0, 1), 5);
  return [
    F0[0] + (1 - F0[0]) * k,
    F0[1] + (1 - F0[1]) * k,
    F0[2] + (1 - F0[2]) * k,
  ];
}

/** База отражения: диэлектрик 4 %, металл — цветом самого объекта. */
export function baseReflectance(albedo: [number, number, number], metallic: number): [number, number, number] {
  const m = clamp(metallic, 0, 1);
  return [
    0.04 + (albedo[0] - 0.04) * m,
    0.04 + (albedo[1] - 0.04) * m,
    0.04 + (albedo[2] - 0.04) * m,
  ];
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
  const F0 = baseReflectance([albedoR, albedoG, albedoB], metallic);
  const ambientLevel = clamp(point.environment.level, 0, 2);
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
    const NdotL = dot3(N, light.L);
    if (NdotL <= 0) continue;
    const H = normalize3([light.L[0] + V[0], light.L[1] + V[1], light.L[2] + V[2]]);
    const NdotH = Math.max(dot3(N, H), 1e-4);
    const VdotH = Math.max(dot3(V, H), 0);
    const D = ggxDistribution(NdotH, roughness);
    const F = fresnel(VdotH, F0);
    // Знаменатель 4·NdotL·NdotV: у нас NdotV = N.z, и он не ноль, пока
    // поверхность не повёрнута от зрителя.
    const denom = 4 * Math.max(NdotL, 1e-4) * Math.max(N[2], 1e-4);
    const specScale = (D / denom) * point.specular * Math.max(0, light.polarity);
    const diffScale = NdotL * diffuseWeight;

    for (let c = 0; c < 3; c += 1) {
      const lightColor = light.color[c];
      out[c] += lightColor * (specScale * F[c] + diffScale * (point.albedo[c] as number));
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

/** Готовые наборы материала: то, с чего начинают, а не «пустые поля». */
export const MATERIAL_PRESETS: Array<{ id: string; label: string; patch: Partial<MaterialSpec> }> = [
  { id: "matte", label: "Матовый", patch: { roughness: { ...DEFAULT_CHANNEL(0.9, "g") }, metallic: { ...DEFAULT_CHANNEL(0, "b") } } },
  { id: "plastic", label: "Пластик", patch: { roughness: { ...DEFAULT_CHANNEL(0.35, "g") }, metallic: { ...DEFAULT_CHANNEL(0, "b") } } },
  { id: "metal", label: "Металл", patch: { roughness: { ...DEFAULT_CHANNEL(0.25, "g") }, metallic: { ...DEFAULT_CHANNEL(1, "b") } } },
  { id: "skin", label: "Кожа", patch: { roughness: { ...DEFAULT_CHANNEL(0.55, "g") }, metallic: { ...DEFAULT_CHANNEL(0, "b") } } },
  { id: "neon", label: "Неон", patch: { roughness: { ...DEFAULT_CHANNEL(0.4, "g") }, emissive: { color: "#66e0ff", strength: 120, file: null } } },
];

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
    environment: { color: hexToRgb(env.color), level: env.level / 100 },
  };
}
