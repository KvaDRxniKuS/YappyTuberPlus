import type { Rgba } from "./color";

/**
 * Средний цвет области сцены.
 *
 * Ambient-модуль answers «какого цвета вот этот кусок картинки». В браузере нет
 * доступа к чужим окнам, но своя сцена у нас есть всегда — и её можно честно
 * усреднить.
 *
 * Две части:
 *
 * 1. **Счёт** (`averageBox`) — чистая функция над массивом пикселей: её проверяет
 *    тест, ей всё равно, откуда взялась картинка.
 * 2. **Захват** (`sceneSampler`) — уменьшенная копия сцены. Холст редактора не
 *    годится: в нём сетка, выделение и серый фон вокруг артборда. Поэтому сцена
 *    рисуется второй раз — маленькой, без интерфейса, и уже она усредняется.
 *
 * Усреднение идёт по «видимому»: цвет взвешивается на альфу. Прозрачный участок
 * не подсвечивает светом — иначе пустое место давало бы цвет фона.
 */

export interface SampleArea {
  /** Центр по горизонтали, доля ширины кадра 0…1. */
  x: number;
  /** Центр по вертикали, доля высоты кадра 0…1. */
  y: number;
  /** Сторона квадрата, доля меньшей стороны кадра 0…1. */
  size: number;
}

/** Длинная сторона уменьшенной копии: для среднего цвета больше не нужно. */
export const SAMPLE_SIDE = 128;

export interface SamplePixels {
  width: number;
  height: number;
  /** RGBA подряд, как у `ImageData`. */
  data: ArrayLike<number>;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Средний цвет квадрата вокруг точки.
 *
 * `blur` — сколько пикселей **уменьшенной копии** добавить по краям: это и есть
 * «сила размытия для выборки». Ноль — ровно квадрат `size`, больше — шире и
 * мягче, поэтому резкая граница не мигает одним пикселем.
 *
 * Возвращает `null`, только если пикселей нет вовсе. Полностью прозрачная
 * область — не «нет данных», а честный прозрачный цвет: привязка оставит свой
 * цвет объекта, а не погасит его.
 */
export function averageBox(pixels: SamplePixels, area: SampleArea, blur = 0): Rgba | null {
  const { width, height, data } = pixels;
  if (!(width > 0) || !(height > 0) || data.length < width * height * 4) return null;
  const centerX = clamp01(area.x) * width;
  const centerY = clamp01(area.y) * height;
  const side = Math.max(1, clamp01(area.size) * Math.min(width, height));
  const half = side / 2 + Math.max(0, Number.isFinite(blur) ? blur : 0);
  const x0 = Math.max(0, Math.floor(centerX - half));
  const x1 = Math.min(width - 1, Math.ceil(centerX + half));
  const y0 = Math.max(0, Math.floor(centerY - half));
  const y1 = Math.min(height - 1, Math.ceil(centerY + half));
  let alpha = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const index = (y * width + x) * 4;
      const a = data[index + 3] / 255;
      alpha += a;
      red += (data[index] / 255) * a;
      green += (data[index + 1] / 255) * a;
      blue += (data[index + 2] / 255) * a;
      count += 1;
    }
  }
  if (!count) return null;
  const visible = alpha > 1e-6 ? alpha : 0;
  return {
    r: visible ? red / visible : 0,
    g: visible ? green / visible : 0,
    b: visible ? blue / visible : 0,
    a: alpha / count,
  };
}

/** Уменьшенная копия сцены: холст, куда `Scene` рисует кадр для замера. */
class SceneSampler {
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private pixels: SamplePixels | null = null;
  private requested = false;
  private width = 0;
  private height = 0;

  /** Замер нужен: модуль ambient включён и смотрит на свою сцену. */
  request(): void {
    this.requested = true;
  }

  /** Замер больше не нужен: модулей ambient нет. */
  stop(): void {
    this.requested = false;
  }

  get wanted(): boolean {
    return this.requested;
  }

  /**
   * Куда рисовать замер. `null` — рисовать некуда (нет документа или замер не
   * просили): вызывающий просто ничего не делает.
   *
   * `scale` — во сколько раз сцена уменьшена: на него умножается контекст,
   * поэтому рисовать нужно в координатах артборда, как обычно.
   */
  prepare(canvasWidth: number, canvasHeight: number): { ctx: CanvasRenderingContext2D; scale: number } | null {
    if (!this.requested || typeof document === "undefined") return null;
    if (!(canvasWidth > 0) || !(canvasHeight > 0)) return null;
    const scale = SAMPLE_SIDE / Math.max(canvasWidth, canvasHeight);
    const width = Math.max(1, Math.round(canvasWidth * scale));
    const height = Math.max(1, Math.round(canvasHeight * scale));
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.context = this.canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!this.context) return null;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.pixels = null;
    }
    this.width = width;
    this.height = height;
    this.context.setTransform(scale, 0, 0, scale, 0, 0);
    this.context.clearRect(0, 0, canvasWidth, canvasHeight);
    return { ctx: this.context, scale };
  }

  /** Кадр нарисован: читаем пиксели и снимаем запрос. */
  commit(): void {
    if (!this.canvas || !this.context) return;
    try {
      this.pixels = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height);
    } catch {
      // Холст «испорчен» чужим источником — молча живём без замера.
      this.pixels = null;
    }
    this.requested = false;
  }

  /** Средний цвет области последнего замера. `null` — замера ещё не было. */
  sample(area: SampleArea, blur = 0): Rgba | null {
    if (!this.pixels) return null;
    return averageBox(this.pixels, area, blur);
  }

  reset(): void {
    this.pixels = null;
    this.requested = false;
    this.width = 0;
    this.height = 0;
  }
}

export const sceneSampler = new SceneSampler();
