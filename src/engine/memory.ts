import { readResources } from "./meter";

/**
 * Память окна, которую браузер отдаёт без нативных вызовов.
 *
 * Смысл — отвечать на вопрос «где растёт» фактом, а не догадкой. Поэтому здесь
 * только те числа, у которых понятно происхождение:
 *
 * - **V8-куча** — объекты JS: состояние React, история скриптов, кеши. Браузер
 *   отдаёт занятое, выделенное и **предел**; предел важен сам по себе: он и есть
 *   тот потолок, который можно поставить флагом `--max-old-space-size`, и пока
 *   занятое далеко от него, виновата не куча.
 * - **DOM** — узлы дерева, панелей и таблиц. Растёт вместе с количеством
 *   объектов и строк, но память узлов браузер не отдаёт: считается штуками.
 * - **Холсты** — пиксели битмапов, 4 байта на пиксель. Это уже не JS-куча:
 *   большой холст живёт вне неё, поэтому «куча маленькая, а процесс большой» —
 *   нормальный случай.
 * - **Медиа** — размеры видеокадров играющих и остановленных элементов.
 * - **Ресурсы** — наша собственная оценка текстур, картинок и буферов рендера
 *   (`reportResources`).
 *
 * Чего здесь **нет**: объёма памяти процессов WebView2 (browser, GPU, network,
 * renderer) и видеопамяти. Эти числа знает только ОС, и получить их можно
 * нативной командой — пока её нет, `WorkMeter` честно пишет, что показывает не
 * всё. Числа OOM не предотвращают: это измерение, а не ограничение.
 */

/** Один замер памяти окна. Байты — байты, пиксели — пиксели. */
export interface MemorySnapshot {
  /** Занято объектов JS. */
  heapUsed: number;
  /** Выделено под кучу. */
  heapTotal: number;
  /** Предел V8: выше него страница получает Out of memory. 0 — браузер не отдаёт. */
  heapLimit: number;
  /** Узлов DOM. */
  domNodes: number;
  /** Холстов в документе. */
  canvases: number;
  /** Пикселей во всех холстах: 4 байта на пиксель. */
  canvasPixels: number;
  /** Медиаэлементов. */
  media: number;
  /** Пикселей видеокадров: `videoWidth × videoHeight` каждого элемента. */
  mediaPixels: number;
  /** Оценка известных RGBA-ресурсов рендера и медиа. */
  resourcesBytes: number;
}

export const EMPTY_MEMORY: MemorySnapshot = {
  heapUsed: 0,
  heapTotal: 0,
  heapLimit: 0,
  domNodes: 0,
  canvases: 0,
  canvasPixels: 0,
  media: 0,
  mediaPixels: 0,
  resourcesBytes: 0,
};

/** Размер в пикселях: у холста и видео он берётся из самих элементов. */
export interface PixelBox {
  width: number;
  height: number;
}

function pixelsOf(boxes: readonly PixelBox[]): { count: number; pixels: number } {
  let pixels = 0;
  for (const box of boxes) {
    if (!Number.isFinite(box.width) || !Number.isFinite(box.height)) continue;
    if (box.width <= 0 || box.height <= 0) continue;
    pixels += box.width * box.height;
  }
  return { count: boxes.length, pixels };
}

/** Холсты: сколько их и сколько пикселей занимают битмапы. */
export function summarizeCanvases(boxes: readonly PixelBox[]): { canvases: number; canvasPixels: number } {
  const { count, pixels } = pixelsOf(boxes);
  return { canvases: count, canvasPixels: pixels };
}

/** Медиа: сколько элементов и сколько пикселей в их видеокадрах. */
export function summarizeMedia(boxes: readonly PixelBox[]): { media: number; mediaPixels: number } {
  const { count, pixels } = pixelsOf(boxes);
  return { media: count, mediaPixels: pixels };
}

/** Мегабайты с одним знаком: в статусе нужны цифры, а не точность до байта. */
export function megabytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/**
 * Насколько занята V8-куча, 0…1. `null` — предела браузер не сообщил.
 *
 * Это не «сколько памяти у приложения»: куча — только объекты JS. Доля нужна,
 * чтобы отличить «куча у предела» (её и правда стоит ограничивать флагом) от
 * «куча пустая, а процесс большой» (растёт не JS).
 */
export function heapPressure(snapshot: MemorySnapshot): number | null {
  if (!(snapshot.heapLimit > 0)) return null;
  const used = Math.max(0, snapshot.heapUsed);
  return Math.min(1, used / snapshot.heapLimit);
}

/** Пиксели в мегапикселях: у холста 1920×1080 — примерно 2,1 Мп. */
export function megapixels(pixels: number): number {
  if (!Number.isFinite(pixels) || pixels <= 0) return 0;
  return Math.round((pixels / 1_000_000) * 10) / 10;
}

/**
 * Рост за минуту по истории замеров.
 *
 * Нужен, чтобы отличить «много, но стабильно» от «растёт и не останавливается»:
 * первое — цена открытой сцены, второе — утечка. Окно по умолчанию — минута;
 * пока история короче окна, ответа нет (`null`), а не ноль: ноль значил бы
 * «проверено, роста нет».
 */
export function growthPerMinute(
  history: ReadonlyArray<{ at: number; bytes: number }>,
  windowMs = 60_000,
): number | null {
  if (history.length < 2) return null;
  const last = history[history.length - 1];
  const first = history.find((point) => last.at - point.at <= windowMs) ?? history[0];
  const span = last.at - first.at;
  if (span < windowMs / 2) return null;
  const perMs = (last.bytes - first.bytes) / span;
  return Math.round(perMs * 60_000);
}

/**
 * Замер текущего окна. В Node (тесты, SSR) документа нет — вернутся нули,
 * а не исключение: диагностика не должна ломать кадр.
 */
export function readMemory(): MemorySnapshot {
  const resources = readResources();
  const resourcesBytes = resources.imageBytes + resources.videoBytes + resources.textureBytes
    + resources.bufferBytes + resources.offscreenCanvasBytes;
  if (typeof document === "undefined") return { ...EMPTY_MEMORY, resourcesBytes };
  const memory = (performance as unknown as {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  }).memory;
  const canvasBoxes = Array.from(document.querySelectorAll("canvas"))
    .map((canvas) => ({ width: canvas.width, height: canvas.height }));
  const mediaBoxes = Array.from(document.querySelectorAll("video"))
    .map((video) => ({ width: video.videoWidth, height: video.videoHeight }));
  return {
    heapUsed: memory?.usedJSHeapSize ?? 0,
    heapTotal: memory?.totalJSHeapSize ?? 0,
    heapLimit: memory?.jsHeapSizeLimit ?? 0,
    domNodes: document.getElementsByTagName("*").length,
    ...summarizeCanvases(canvasBoxes),
    ...summarizeMedia(mediaBoxes),
    resourcesBytes,
  };
}

/**
 * Строка про память для статуса.
 *
 * Предел кучи печатается рядом с занятым: без него «JS 300 МБ» ничего не
 * говорит — при пределе 4 ГБ это норма, при пределе 512 МБ это край.
 */
export function memoryText(snapshot: MemorySnapshot): string {
  const parts: string[] = [];
  if (snapshot.heapUsed > 0 || snapshot.heapLimit > 0) {
    const used = Math.round(megabytes(snapshot.heapUsed));
    const limit = Math.round(megabytes(snapshot.heapLimit));
    parts.push(limit > 0 ? `JS ${used}/${limit} МБ` : `JS ${used} МБ`);
  }
  if (snapshot.canvases > 0) parts.push(`холст ${snapshot.canvases} · ${megapixels(snapshot.canvasPixels)} Мп`);
  if (snapshot.resourcesBytes > 0) parts.push(`ресурсы ≈${Math.round(megabytes(snapshot.resourcesBytes))} МБ`);
  if (snapshot.domNodes > 0) parts.push(`DOM ${snapshot.domNodes}`);
  return parts.join(" · ");
}
