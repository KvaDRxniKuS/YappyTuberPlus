import type { Rgba } from "./color";
import { averageBox, SAMPLE_SIDE, type SampleArea } from "./sceneSample";

/**
 * Средний цвет участка скриншота OBS.
 *
 * OBS отдаёт картинку строкой `data:image/png;base64,…`: её нужно декодировать
 * и усреднить. Декодирование — обычный `Image` (браузер умеет только так), а
 * уменьшаем мы её сами: `GetSourceScreenshot` с `imageWidth: 128` и так отдаёт
 * маленькую картинку, но её размер зависит от пропорций источника.
 *
 * Всё, что здесь есть, живо только в браузере: в тестах проверяется математика
 * (`averageBox`) и арифметика трансформации (`areaOnScene`), а не этот файл.
 */

let canvas: HTMLCanvasElement | null = null;
let context: CanvasRenderingContext2D | null = null;

function target(width: number, height: number): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  if (!canvas) {
    canvas = document.createElement("canvas");
    context = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!context) return null;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return context;
}

/** Картинка из строки данных: ждём `onload`, иначе пикселей нет. */
function decode(url: string): Promise<HTMLImageElement | null> {
  if (typeof Image === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/** Средний цвет участка картинки OBS. `null` — картинку не разобрали. */
export async function sampleImage(url: string, area: SampleArea, blur = 0): Promise<Rgba | null> {
  const image = await decode(url);
  if (!image || !image.width || !image.height) return null;
  const scale = Math.min(1, SAMPLE_SIDE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const ctx = target(width, height);
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  try {
    const pixels = ctx.getImageData(0, 0, width, height);
    // `blur` задан в пикселях исходного кадра — переводим в пиксели уменьшенной
    // копии, иначе на маленьком скриншоте размытие съело бы весь участок.
    return averageBox(pixels, area, blur * scale);
  } catch {
    return null;
  }
}
