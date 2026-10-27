import type { ObjectFrame, RigFrame, RigObject, RigPreset } from "../types";
import { NEUTRAL_PARAMS } from "../engine/frame";
import { resolveLayer } from "../engine/layers";
import { frontness, structurePaths } from "../engine/structure";
import { DEFAULT_MEDIA, MediaAssets, MaskMedia } from "./media";
import { assetUrl } from "../engine/assets";
import { drawTextObject, textContent, type TextChannel } from "./text";
import { defaultShape, traceItem, tracePath, traceShape } from "./shape";
import { drawWarpedImage, warpEnabled } from "./warp";
import type { MaskSpec, ShapeSpec } from "../types";

/**
 * Shared Canvas 2D renderer. The editor scene and the OBS overlay use the same
 * code path, so a preset looks identical in both places. The renderer only
 * reads prepared frames: it never advances simulation state.
 */

export const NEUTRAL_VALUES: ObjectFrame = NEUTRAL_PARAMS;

/** Decoded sprite images, shared between redraws and keyed by image source. */
export class SpriteAssets {
  private images = new Map<string, HTMLImageElement>();
  private listeners = new Set<() => void>();

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Starts decoding any image that is not in the cache yet.
   *
   * `object.image` — это либо обычный путь (`/assets/demo/head.png`), либо
   * `asset:<id>` в хранилище webview. Во втором случае URL появляется только
   * после чтения файла, поэтому вызов повторяется по событию хранилища.
   */
  sync(objects: RigObject[]): void {
    const sources: Array<string | null> = [];
    for (const object of objects) {
      // Маска-файл рисуется через тот же спрайтовый кэш: она тоже картинка.
      sources.push(object.image, object.mask?.kind === "file" ? object.mask.file : null);
    }
    for (const source of sources) {
      if (!source) continue;
      const url = assetUrl(source);
      if (!url) continue;
      const existing = this.images.get(source);
      if (existing?.dataset.source === url) continue;
      const image = existing ?? new Image();
      image.decoding = "async";
      image.onload = () => { this.emit(); };
      image.onerror = () => { this.emit(); };
      image.dataset.source = url;
      image.src = url;
      this.images.set(source, image);
    }
  }

  get(source: string | null): HTMLImageElement | null {
    if (!source) return null;
    return this.images.get(source) || null;
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

export function staticValues(object: RigObject): ObjectFrame {
  return {
    ...NEUTRAL_VALUES,
    visible: object.enabled === false ? 0 : object.base.visible,
    layer: object.base.layer,
  };
}

/** 2D affine matrix in canvas order: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export interface Affine {
  a: number; b: number; c: number; d: number; e: number; f: number;
}

export function multiplyAffine(left: Affine, right: Affine): Affine {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f,
  };
}

export function invertAffine(matrix: Affine): Affine {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!determinant) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const { a, b, c, d, e, f } = matrix;
  return {
    a: d / determinant,
    b: -b / determinant,
    c: -c / determinant,
    d: a / determinant,
    e: (c * f - d * e) / determinant,
    f: (b * e - a * f) / determinant,
  };
}

export function transformPoint(matrix: Affine, x: number, y: number): { x: number; y: number } {
  return {
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f,
  };
}

/**
 * translate(base + dynamic) · rotate · scale · skew, computed with plain
 * arithmetic: no DOMMatrix allocation in the per-sprite hot path.
 *
 * Масштаб стоит перед перекосом: угол наклона задаётся в «своих» единицах
 * спрайта и не меняется от `sizeX/sizeY`. Перекос при этом остаётся вокруг
 * пивота (начало координат объекта): пивот неподвижен, а грань, которая дальше
 * от него, при том же угле проходит большее расстояние.
 */
export function objectMatrix(object: RigObject, values: ObjectFrame): Affine {
  const radians = (object.base.rotation + values.rotation) * Math.PI / 180;
  const skewX = Math.tan((object.base.skewX + values.skewX) * Math.PI / 180);
  const skewY = Math.tan((object.base.skewY + values.skewY) * Math.PI / 180);
  const translate: Affine = { a: 1, b: 0, c: 0, d: 1, e: object.base.x + values.x, f: object.base.y + values.y };
  const rotate: Affine = { a: Math.cos(radians), b: Math.sin(radians), c: -Math.sin(radians), d: Math.cos(radians), e: 0, f: 0 };
  const skew: Affine = { a: 1, b: skewY, c: skewX, d: 1, e: 0, f: 0 };
  const scale: Affine = {
    a: object.base.sizeX * values.sizeX, b: 0, c: 0,
    d: object.base.sizeY * values.sizeY, e: 0, f: 0,
  };
  return multiplyAffine(multiplyAffine(multiplyAffine(translate, rotate), scale), skew);
}

/**
 * Объекты в порядке отрисовки: слой, затем структура.
 *
 * Порядок считается здесь, а не берётся из кадра движка, по двум причинам:
 * слой из скрипта и базовый слой должны действовать одинаково в любой момент
 * (в том числе на паузе, когда кадр не обновляется), а при равном слое поверх
 * обязан быть тот, кто выше в структуре, — индекс в массиве пресета про это
 * не знает. Смена слоя применяется сразу, без перезапуска движка.
 */
export function orderedObjects(preset: RigPreset, frame: RigFrame | null): RigObject[] {
  const sprites = preset.objects.filter((object) => object.kind !== "group");
  const paths = structurePaths(preset.objects);
  const layerOf = (object: RigObject) => resolveLayer(preset.objects, frame, object);
  return [...sprites].sort((a, b) => (layerOf(a) - layerOf(b))
    || frontness(paths.get(a.id), paths.get(b.id)));
}

export interface DrawRigOptions {
  /** Draw a wireframe box for sprites whose image has not decoded yet. */
  placeholders?: boolean;
  /** Line width scale for placeholders (editor zoom). */
  lineScale?: number;
  /**
   * Показывать спрайты, скрытые скриптом (по текущим входам), полупрозрачным
   * «призраком» вместо полного исчезновения. Так при остановке симуляции видно,
   * что рот или глаз на сцене есть, просто сейчас им положено быть невидимыми.
   */
  ghosts?: boolean;
  /** Прозрачность призрака; 0.25 по умолчанию. */
  ghostAlpha?: number;
  /** Медиа-объекты: звук и видео. Без него медиа рисуется заглушкой. */
  media?: MediaAssets;
  /** Видео-маски: маской бывает и фильм, тогда видно его текущий кадр. */
  maskMedia?: MaskMedia;
  /** Текстовый канал модулей: подстановки в шаблоне текстового объекта. */
  texts?: TextChannel;
}

/**
 * Скрыт ли спрайт именно скриптом. Глаз в дереве (`enabled`) и базовое
 * `visible` — это осознанно скрытые объекты, их призраками не показываем.
 */
export function scriptHidden(object: RigObject, values: { visible: number }): boolean {
  return values.visible === 0 && object.enabled !== false && object.base.visible !== 0;
}

/**
 * Draws every visible sprite in scene coordinates. The caller owns the
 * transform (camera, letterboxing) and the background.
 */
export function drawRig(
  ctx: CanvasRenderingContext2D,
  preset: RigPreset,
  frame: RigFrame | null,
  assets: SpriteAssets,
  options: DrawRigOptions = {},
): void {
  const zoom = options.lineScale ?? 1;
  const ghostAlpha = options.ghostAlpha ?? 0.25;
  for (const object of orderedObjects(preset, frame)) {
    const values = frame?.objects[object.id] || staticValues(object);
    const ghost = values.visible === 0 && options.ghosts === true && scriptHidden(object, values);
    if (values.visible === 0 && !ghost) continue;
    const opacity = Math.min(1, Math.max(0, object.base.opacity * values.opacity));
    if (opacity === 0 || values.sizeX === 0 || values.sizeY === 0) continue;
    const matrix = objectMatrix(object, values);
    const left = -object.pivot.x * object.width;
    const top = -object.pivot.y * object.height;
    const alpha = ghost ? opacity * ghostAlpha : opacity;
    // Маска работает через отдельный холст: объект рисуется в него, маска
    // вырезается композитом, и только потом результат ложится на сцену.
    // Маску на маску не ставим: у фигуры её контуры и есть видимость.
    const masked = object.kind !== "group" && object.kind !== "shape" && !!object.mask
      && maskReady(object.mask, preset, assets, options);
    // Сила маски — параметр `mask`: 1 режет по контуру, 0 показывает объект
    // целиком, дробное значение смешивает два варианта. Кадр старого ядра
    // этого параметра не знает — тогда маска работает как настроена.
    const strength = masked ? maskStrength(values) : 0;
    if (masked && strength > 0) {
      drawMasked(ctx, preset, frame, assets, options, object, matrix, left, top, alpha * strength);
      if (strength >= 1) continue;
      // Проявление маски: вторая копия объекта идёт обычным путём, поэтому
      // сумма двух половин даёт ровно ту картинку, что была до маски.
      drawPlain(ctx, object, frame, assets, options, zoom, matrix, left, top, alpha * (1 - strength));
      continue;
    }
    drawPlain(ctx, object, frame, assets, options, zoom, matrix, left, top, alpha);
  }
}

/**
 * Сила маски из параметра `mask`: 1 — режет по контуру, 0 — объект целиком.
 *
 * Кадр старого ядра параметра не знает: тогда маска работает так, как
 * настроена в инспекторе, а не исчезает.
 */
export function maskStrength(values: ObjectFrame): number {
  const value = values.mask;
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/** Обычная отрисовка объекта: трансформа, содержимое, без маски. */
function drawPlain(
  ctx: CanvasRenderingContext2D,
  object: RigObject,
  frame: RigFrame | null,
  assets: SpriteAssets,
  options: DrawRigOptions,
  zoom: number,
  matrix: Affine,
  left: number,
  top: number,
  alpha: number,
): void {
  ctx.save();
  ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
  ctx.globalAlpha = alpha;
  if (object.kind === "shape") {
    // Контуры живут в координатах рамки объекта: пивот и поворот те же, что
    // у спрайта, поэтому фигура — обычный объект сцены.
    ctx.translate(left, top);
    drawShapeObject(ctx, object);
    ctx.restore();
    return;
  }
  drawObjectContent(ctx, object, frame, assets, options, zoom);
  ctx.restore();
}

/** Содержимое объекта: картинка, медиа или текст. Трансформа уже применена. */
function drawObjectContent(
  ctx: CanvasRenderingContext2D,
  object: RigObject,
  frame: RigFrame | null,
  assets: SpriteAssets,
  options: DrawRigOptions,
  zoom: number,
): void {
  const left = -object.pivot.x * object.width;
  const top = -object.pivot.y * object.height;
  if (object.kind === "text") {
    drawTextObject(ctx, object, textContent(object, frame, options.texts));
    return;
  }
  if (object.kind === "media") {
    const spec = object.media ?? DEFAULT_MEDIA;
    const video = spec.type === "video" ? options.media?.video(object.id) : null;
    const picture = video ?? (spec.type === "image" ? options.media?.image(object.id) : null);
    const width = spec.type === "video" && video
      ? object.width || video.videoWidth
      : object.width;
    const height = spec.type === "video" && video
      ? object.height || video.videoHeight
      : object.height;
    const boxLeft = -object.pivot.x * width;
    const boxTop = -object.pivot.y * height;
    if (picture && warpEnabled(object)) {
      // Деформация считается в координатах картинки: переносим начало туда,
      // где у медиа-объекта начинается его рамка.
      ctx.save();
      ctx.translate(boxLeft, boxTop);
      drawWarpedImage(ctx, picture, object, width, height, frame?.objects[object.id]);
      ctx.restore();
    } else if (picture) {
      ctx.drawImage(picture, boxLeft, boxTop, width, height);
    } else if (options.placeholders) {
      // Звук и ещё не загруженное видео: в редакторе видно место объекта,
      // в оверлее ничего не рисуется.
      drawMediaPlaceholder(ctx, spec.type, object, spec.fileName, left, top, 1 / zoom);
    }
    return;
  }
  const image = assets.get(object.image);
  if (image?.complete && image.naturalWidth > 0) {
    if (warpEnabled(object)) {
      ctx.save();
      ctx.translate(left, top);
      drawWarpedImage(ctx, image, object, object.width, object.height, frame?.objects[object.id]);
      ctx.restore();
    } else {
      ctx.drawImage(image, left, top, object.width, object.height);
    }
  } else if (options.placeholders) {
    ctx.fillStyle = "#505965";
    ctx.fillRect(left, top, object.width, object.height);
    ctx.strokeStyle = "#8994a1";
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(left, top, object.width, object.height);
  }
}

/** Фигура: заливка и обводка каждого контура. */
export function drawShapeObject(ctx: CanvasRenderingContext2D, object: RigObject): void {
  const spec: ShapeSpec = object.shape ?? defaultShape(object.width, object.height);
  if (!spec.draw) return;
  for (const item of spec.items) {
    ctx.beginPath();
    traceItem(ctx, item);
    if (spec.fill) {
      ctx.fillStyle = spec.fill;
      ctx.fill();
    }
    if (spec.strokeWidth > 0 && spec.stroke) {
      ctx.strokeStyle = spec.stroke;
      ctx.lineWidth = spec.strokeWidth;
      ctx.stroke();
    }
  }
}

/**
 * Можно ли применить маску.
 *
 * Иначе маска без содержимого (нет фигуры, файла или точек) стёрла бы объект
 * целиком, и «пропал спрайт» выглядело бы как поломка пресета.
 */
function maskReady(
  mask: MaskSpec,
  preset: RigPreset,
  assets: SpriteAssets,
  options: DrawRigOptions,
): boolean {
  if (mask.kind === "shape") return preset.objects.some((item) => item.kind === "shape" && item.id === mask.shapeId);
  if (mask.kind === "file") {
    if (!mask.file) return false;
    // Видео-маска: кадр есть, как только фильм догрузился.
    if (options?.maskMedia?.get(mask.file)) return true;
    return !!assets.get(mask.file);
  }
  return mask.points.length >= 3;
}

/** Отдельный холст для маски: переиспользуется между кадрами и объектами. */
let maskCanvas: HTMLCanvasElement | null = null;

function maskLayer(main: HTMLCanvasElement): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === "undefined") return null;
  if (!maskCanvas) maskCanvas = document.createElement("canvas");
  if (maskCanvas.width !== main.width || maskCanvas.height !== main.height) {
    maskCanvas.width = main.width;
    maskCanvas.height = main.height;
  }
  const ctx = maskCanvas.getContext("2d");
  return ctx ? { canvas: maskCanvas, ctx } : null;
}

/** Объект с маской: содержимое на отдельный холст, вырезание, композит. */
function drawMasked(
  ctx: CanvasRenderingContext2D,
  preset: RigPreset,
  frame: RigFrame | null,
  assets: SpriteAssets,
  options: DrawRigOptions,
  object: RigObject,
  matrix: Affine,
  left: number,
  top: number,
  alpha: number,
): void {
  const layer = maskLayer(ctx.canvas);
  if (!layer) return;
  const { canvas, ctx: layerCtx } = layer;
  // Трансформация главного холста включает камеру и масштаб экрана: у
  // отдельного холста она должна быть точно такой же, иначе маска не совпадёт
  // с объектом.
  const transform = ctx.getTransform();
  const feather = object.mask?.feather ?? 0;
  // Область работы — рамка самого объекта в пикселях холста, а не весь холст.
  // Каждый кадр маска раньше чистила и склеивала все пиксели сцены: на
  // большом холсте с несколькими масками это и было главной нагрузкой.
  // Содержимое рисуется только внутри рамки, поэтому снаружи её нечего ни
  // стирать, ни склеивать; запас нужен лишь на сглаживание и размытие края.
  const box = contentBox(transform, matrix, object, canvas.width, canvas.height, left, top, feather);
  if (!box) return;
  layerCtx.setTransform(1, 0, 0, 1, 0, 0);
  layerCtx.clearRect(box.x, box.y, box.width, box.height);
  layerCtx.setTransform(transform);
  layerCtx.save();
  layerCtx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
  layerCtx.globalAlpha = alpha;
  drawObjectContent(layerCtx, object, frame, assets, options, options.lineScale ?? 1);
  layerCtx.restore();

  layerCtx.save();
  layerCtx.setTransform(transform);
  layerCtx.globalCompositeOperation = object.mask?.invert ? "destination-out" : "destination-in";
  if (feather > 0) layerCtx.filter = `blur(${feather}px)`;
  paintMask(layerCtx, preset, frame, assets, object, object.mask!, matrix, left, top, options);
  layerCtx.restore();

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Пиксели переносятся один к одному: источник и приёмник — та же область.
  ctx.drawImage(canvas, box.x, box.y, box.width, box.height, box.x, box.y, box.width, box.height);
  ctx.restore();
}

/** Прямоугольник маски в пикселях холста: рамка объекта плюс запас на край. */
function contentBox(
  transform: DOMMatrix,
  matrix: Affine,
  object: RigObject,
  canvasWidth: number,
  canvasHeight: number,
  left: number,
  top: number,
  feather: number,
): { x: number; y: number; width: number; height: number } | null {
  const combined = multiplyAffine({
    a: transform.a, b: transform.b, c: transform.c, d: transform.d, e: transform.e, f: transform.f,
  }, matrix);
  const corners = [
    [left, top],
    [left + object.width, top],
    [left, top + object.height],
    [left + object.width, top + object.height],
  ].map(([x, y]) => transformPoint(combined, x, y));
  const scale = Math.max(
    Math.hypot(combined.a, combined.b),
    Math.hypot(combined.c, combined.d),
    0.0001,
  );
  // Размытие края живёт в единицах объекта: в пикселях холста оно в `scale` раз
  // больше. Пара пикселей сверху — на сглаживание самого края картинки.
  const pad = Math.ceil((feather * 3 + 2) * scale) + 2;
  const minX = Math.min(...corners.map((point) => point.x)) - pad;
  const minY = Math.min(...corners.map((point) => point.y)) - pad;
  const maxX = Math.max(...corners.map((point) => point.x)) + pad;
  const maxY = Math.max(...corners.map((point) => point.y)) + pad;
  const x = Math.max(0, Math.floor(minX));
  const y = Math.max(0, Math.floor(minY));
  const width = Math.min(canvasWidth, Math.ceil(maxX)) - x;
  const height = Math.min(canvasHeight, Math.ceil(maxY)) - y;
  if (width < 1 || height < 1) return null;
  return { x, y, width, height };
}

/** Нарисовать саму маску белым: видимость решает её альфа. */
function paintMask(
  ctx: CanvasRenderingContext2D,
  preset: RigPreset,
  frame: RigFrame | null,
  assets: SpriteAssets,
  object: RigObject,
  mask: MaskSpec,
  matrix: Affine,
  left: number,
  top: number,
  options: DrawRigOptions,
): void {
  ctx.fillStyle = "#fff";
  if (mask.kind === "shape") {
    const shape = preset.objects.find((item) => item.kind === "shape" && item.id === mask.shapeId);
    if (!shape) return;
    const values = frame?.objects[shape.id] || staticValues(shape);
    const shapeMatrix = objectMatrix(shape, values);
    // Фигура может быть скрыта и анимирована: маска берёт её текущее место.
    ctx.transform(shapeMatrix.a, shapeMatrix.b, shapeMatrix.c, shapeMatrix.d, shapeMatrix.e, shapeMatrix.f);
    ctx.translate(-shape.pivot.x * shape.width, -shape.pivot.y * shape.height);
    ctx.beginPath();
    traceShape(ctx, shape.shape ?? defaultShape(shape.width, shape.height));
    // evenodd: внутренний контур становится дыркой — так удобнее делать рамки.
    ctx.fill("evenodd");
    return;
  }
  if (mask.kind === "file") {
    // Маска-картинка или маска-фильм: у видео берём текущий кадр, и тогда
    // маска живёт — прозрачное видео даёт движущееся «окно».
    const video = mask.file ? options.maskMedia?.get(mask.file) ?? null : null;
    const picture: CanvasImageSource | null = video ?? (mask.file ? assets.get(mask.file) : null);
    if (!picture) return;
    ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    ctx.translate(left, top);
    // Маска растягивается по рамке объекта: альфа (у видео — яркость кадра с
    // альфой) решает, что видно.
    ctx.drawImage(picture, 0, 0, object.width, object.height);
    return;
  }
  if (mask.points.length < 3) return;
  ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
  ctx.translate(left, top);
  ctx.beginPath();
  tracePath(ctx, mask.points, false, true);
  ctx.fill();
}

/** Заглушка медиа-объекта в редакторе: звук не видно, но найти его надо. */
function drawMediaPlaceholder(
  ctx: CanvasRenderingContext2D,
  type: "image" | "video" | "audio",
  object: RigObject,
  fileName: string,
  left: number,
  top: number,
  line: number,
): void {
  ctx.fillStyle = type === "audio" ? "#2f3b45cc" : "#505965";
  ctx.fillRect(left, top, object.width, object.height);
  ctx.strokeStyle = "#8994a1";
  ctx.lineWidth = line;
  ctx.strokeRect(left, top, object.width, object.height);
  const caption = fileName || (type === "audio" ? "звук" : type === "video" ? "видео" : "файл");
  const size = Math.max(10, Math.min(object.height / 4, object.width / Math.max(4, caption.length * 0.6)));
  ctx.fillStyle = "#dfe6ee";
  ctx.font = `${size}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(caption, left + object.width / 2, top + object.height / 2, object.width * 0.9);
}

export interface ViewTransform {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Maps preset canvas coordinates into a viewport of the given size.
 * Used by the overlay window; the editor has its own interactive camera.
 */
export function viewTransform(
  mode: RigPreset["overlay"]["scaleMode"],
  canvas: { width: number; height: number },
  viewWidth: number,
  viewHeight: number,
): ViewTransform {
  if (mode === "pixel") return { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
  if (mode === "stretch") {
    const scaleX = viewWidth / canvas.width;
    const scaleY = viewHeight / canvas.height;
    return { scaleX, scaleY, offsetX: 0, offsetY: 0 };
  }
  const fit = Math.min(viewWidth / canvas.width, viewHeight / canvas.height);
  const cover = Math.max(viewWidth / canvas.width, viewHeight / canvas.height);
  const scale = mode === "cover" ? cover : fit;
  return {
    scaleX: scale,
    scaleY: scale,
    offsetX: (viewWidth - canvas.width * scale) / 2,
    offsetY: (viewHeight - canvas.height * scale) / 2,
  };
}
