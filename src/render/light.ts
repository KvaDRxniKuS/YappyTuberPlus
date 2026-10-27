import type { LightShape, LightSpec, NormalMapSpec, RigObject } from "../types";
import { DEFAULT_LIGHT } from "../types";

/**
 * Освещение и карты нормалей.
 *
 * Свет — это пятно поверх сцены: градиент от цвета у центра к цвету у края,
 * вырезанный формой. Светлый rgba подсвечивает, тёмный затеняет, поэтому
 * отдельного «режима тени» не нужно — цвет и есть режим. Аддитивное наложение
 * добавлено для настоящего свечения: тёмный цвет в нём не работает, зато
 * яркий не «замыливает» сцену полупрозрачной плёнкой.
 */

export const LIGHT_SHAPES: Array<{ id: LightShape; label: string; hint: string }> = [
  { id: "circle", label: "Круг", hint: "Радиус от центра: обычная лампа или тень" },
  { id: "sector", label: "Сектор", hint: "Доля окружности: луч прожектора, свет из-за угла" },
  { id: "rect", label: "Прямоугольник", hint: "Ровное пятно: окно, экран, полоса света" },
  { id: "triangle", label: "Треугольник", hint: "Конус света от вершины" },
  { id: "screen", label: "Весь экран", hint: "Виньетка или общий тон на всю сцену" },
];

/** Приводит настройки света к рабочим значениям: битый JSON не должен ломать рендер. */
export function normalizeLight(raw: unknown): LightSpec {
  const source = raw && typeof raw === "object" ? raw as Partial<LightSpec> : {};
  const shape = LIGHT_SHAPES.some((entry) => entry.id === source.shape) ? source.shape! : DEFAULT_LIGHT.shape;
  return {
    shape,
    angle: clamp(Number(source.angle) || DEFAULT_LIGHT.angle, 1, 360),
    radius: clamp(Number(source.radius) || DEFAULT_LIGHT.radius, 1, 20000),
    colorStart: color(source.colorStart, DEFAULT_LIGHT.colorStart),
    colorEnd: color(source.colorEnd, DEFAULT_LIGHT.colorEnd),
    softness: clamp(Number(source.softness ?? DEFAULT_LIGHT.softness), 0, 100),
    brightness: clamp(Number(source.brightness ?? DEFAULT_LIGHT.brightness), 0, 200),
    blend: source.blend === "add" ? "add" : "normal",
    // Высота: галка «половина радиуса» либо своё число. Старые пресеты о ней
    // не знают — получают авто, и блик выглядит естественно без настройки.
    heightMode: source.heightMode === "manual" ? "manual" : "auto",
    height: clamp(Number(source.height ?? DEFAULT_LIGHT.height) || DEFAULT_LIGHT.height, 1, 20000),
    specular: clamp(Number(source.specular ?? DEFAULT_LIGHT.specular), 0, 200),
  };
}

/** Нормали: сила 0…200 %, ссылка на файл и признак «видео играет». */
export function normalizeNormal(raw: unknown): NormalMapSpec | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Partial<NormalMapSpec>;
  if (typeof source.src !== "string" || !source.src) return undefined;
  return {
    src: source.src,
    strength: clamp(Number(source.strength ?? 100), 0, 200),
    animate: source.animate !== false,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

/** Цвет только в виде rgba/rgb/hex: мусор заменяем значением по умолчанию. */
function color(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) return text;
  if (/^rgba?\([\d\s.,%]+\)$/i.test(text)) return text;
  return fallback;
}

/** Цвет с изменённой альфой: яркость света — это множитель прозрачности. */
export function withAlpha(value: string, alpha: number): string {
  const clamped = clamp(alpha, 0, 1);
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const text = hex[1].length === 3
      ? hex[1].split("").map((part) => part + part).join("")
      : hex[1];
    const r = parseInt(text.slice(0, 2), 16);
    const g = parseInt(text.slice(2, 4), 16);
    const b = parseInt(text.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${round(clamped)})`;
  }
  const match = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
  if (!match) return value;
  const parts = match[1].split(",").map((part) => part.trim());
  if (parts.length < 3) return value;
  return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${round(clamped)})`;
}

/** Альфа цвета: нужна панели, чтобы показать ползунок прозрачности. */
export function alphaOf(value: string, fallback = 1): number {
  const text = value.trim();
  if (/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) {
    return text.length === 9 ? clamp(parseInt(text.slice(7, 9), 16) / 255, 0, 1) : 1;
  }
  if (/^#([0-9a-f]{3})$/i.test(text)) return 1;
  const match = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (!match) return fallback;
  const parts = match[1].split(",");
  if (parts.length < 4) return 1;
  const alpha = Number(parts[3]);
  return Number.isFinite(alpha) ? clamp(alpha, 0, 1) : fallback;
}

/** Цвет без альфы — для `<input type="color">`, который альфу не понимает. */
export function solidOf(value: string, fallback = "#ffe2aa"): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex) return `#${hex[1].length === 3 ? hex[1].split("").map((p) => p + p).join("") : hex[1]}`;
  const match = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
  if (!match) return fallback;
  const parts = match[1].split(",").map((part) => Number(part.trim()));
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return fallback;
  const channel = (input: number) => Math.max(0, Math.min(255, Math.round(input))).toString(16).padStart(2, "0");
  return `#${channel(parts[0])}${channel(parts[1])}${channel(parts[2])}`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Путь пятна в локальных координатах объекта: начало — пивот, единицы — пиксели.
 *
 * У круга, прямоугольника и треугольника размер задаёт радиус; у сектора —
 * радиус и угол; у «всего экрана» — габариты холста. Форма не замыкается сама:
 * `closePath` для сектора даёт «кусок пирога», а не хорду.
 */
export function traceLight(
  ctx: CanvasRenderingContext2D,
  spec: LightSpec,
  canvas: { width: number; height: number },
): void {
  const radius = Math.max(1, spec.radius);
  switch (spec.shape) {
    case "screen": {
      ctx.rect(-canvas.width, -canvas.height, canvas.width * 2, canvas.height * 2);
      return;
    }
    case "rect": {
      ctx.rect(-radius, -radius, radius * 2, radius * 2);
      return;
    }
    case "triangle": {
      // Равнобедренный треугольник вершиной вверх: конус света от вершины.
      const half = Math.tan(Math.PI / 6) * radius * 1.5;
      ctx.moveTo(0, -radius);
      ctx.lineTo(half, radius * 0.5);
      ctx.lineTo(-half, radius * 0.5);
      ctx.closePath();
      return;
    }
    case "sector": {
      // Угол отсчитывается от «вверх» и делится пополам: луч смотрит вверх.
      const half = (Math.min(360, Math.max(1, spec.angle)) * Math.PI) / 360;
      const start = -Math.PI / 2 - half;
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, start, start + half * 2);
      ctx.closePath();
      return;
    }
    default: {
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.closePath();
    }
  }
}

/**
 * Радиус градиента: у круга и сектора — радиус пятна, у остальных форм —
 * расстояние до самого дальнего угла пятна, чтобы цвет у края был виден.
 */
export function gradientRadius(spec: LightSpec, canvas: { width: number; height: number }): number {
  const radius = Math.max(1, spec.radius);
  switch (spec.shape) {
    case "screen":
      return Math.hypot(canvas.width, canvas.height);
    case "rect":
      return radius * Math.SQRT2;
    case "triangle":
      return radius * 1.5;
    default:
      return radius;
  }
}

/**
 * Нарисовать пятно света. Трансформа объекта уже применена.
 *
 * `opacity` — яркость из кадра (параметр `opacity`): так мерцание и «свет только
 * когда говорю» работают обычными формулами, без отдельного набора параметров
 * в ядре.
 */
export function paintLight(
  ctx: CanvasRenderingContext2D,
  object: RigObject,
  canvas: { width: number; height: number },
  opacity: number,
): void {
  const spec = object.light ?? DEFAULT_LIGHT;
  const level = Math.max(0, Math.min(1, opacity)) * Math.max(0, Math.min(2, spec.brightness / 100));
  if (level <= 0.001) return;
  const reach = gradientRadius(spec, canvas);
  const soft = Math.max(0, Math.min(100, spec.softness)) / 100;
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, reach);
  // Ядро света держит цвет, а дальше он уходит в цвет края: мягкость задаёт,
  // где именно начинается спад.
  gradient.addColorStop(0, withAlpha(spec.colorStart, alphaOf(spec.colorStart) * level));
  const kernel = Math.max(0, Math.min(0.98, 1 - soft));
  gradient.addColorStop(kernel, withAlpha(spec.colorStart, alphaOf(spec.colorStart) * level));
  gradient.addColorStop(1, withAlpha(spec.colorEnd, alphaOf(spec.colorEnd) * level));
  ctx.save();
  // Обычное наложение ложится только на нарисованное: свет освещает объекты, а
  // не пустое место, поэтому в OBS на прозрачном фоне не появляется цветной
  // прямоугольник. «Свечение» складывается с холстом и гаснет к краю пятна
  // само — там, где градиент уходит в прозрачность.
  ctx.globalCompositeOperation = spec.blend === "add" ? "lighter" : "source-atop";
  ctx.fillStyle = gradient;
  ctx.beginPath();
  traceLight(ctx, spec, canvas);
  ctx.fill();
  ctx.restore();
}

/** Габариты руки света: ширина и высота объекта следуют за радиусом. */
export function lightBounds(spec: LightSpec, canvas: { width: number; height: number }): { width: number; height: number } {
  if (spec.shape === "screen") return { width: canvas.width, height: canvas.height };
  const size = Math.max(2, Math.round(spec.radius * 2));
  return { width: size, height: size };
}
