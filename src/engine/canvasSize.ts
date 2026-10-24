/**
 * Размер холста сцены. Правка идёт прямо по подписи у артборда, поэтому текст
 * разбираем терпимо: «1280 × 720», «1280x720», «1280 720», «1280,720».
 */
export interface CanvasSize {
  width: number;
  height: number;
}

/** Ниже 16 px артборд не помещает даже служебные направляющие. */
export const MIN_CANVAS = 16;
/** Верхняя граница — запас под один крупный холст 8K с обеих сторон. */
export const MAX_CANVAS = 16384;

export function parseCanvasSize(text: string): CanvasSize | null {
  // Дробную часть берём только через точку: запятая остаётся разделителем пар.
  const numbers = (String(text).match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (numbers.length < 2) return null;
  const width = Math.round(numbers[0]);
  const height = Math.round(numbers[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < MIN_CANVAS || height < MIN_CANVAS) return null;
  if (width > MAX_CANVAS || height > MAX_CANVAS) return null;
  return { width, height };
}

export function sameCanvasSize(a: CanvasSize, b: CanvasSize): boolean {
  return a.width === b.width && a.height === b.height;
}

/** Подпись размера в интерфейсе: `1280 × 720`. */
export function formatCanvasSize(size: CanvasSize): string {
  return `${size.width} × ${size.height}`;
}
