import type { ObjectFrame, RigFrame, RigObject, RigPreset } from "../types";
import { NEUTRAL_PARAMS } from "../engine/frame";
import { resolveLayer } from "../engine/layers";
import { frontness, structurePaths } from "../engine/structure";
import { DEFAULT_MEDIA, MediaAssets } from "./media";
import { assetUrl } from "../engine/assets";
import { drawTextObject, textContent, type TextChannel } from "./text";

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
    for (const object of objects) {
      const source = object.image;
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
    ctx.save();
    ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    ctx.globalAlpha = ghost ? opacity * ghostAlpha : opacity;
    if (object.kind === "text") {
      drawTextObject(ctx, object, textContent(object, frame, options.texts));
      ctx.restore();
      continue;
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
      if (picture) {
        ctx.drawImage(picture, boxLeft, boxTop, width, height);
      } else if (options.placeholders) {
        // Звук и ещё не загруженное видео: в редакторе видно место объекта,
        // в оверлее ничего не рисуется.
        drawMediaPlaceholder(ctx, spec.type, object, spec.fileName, left, top, 1 / zoom);
      }
      ctx.restore();
      continue;
    }
    const image = assets.get(object.image);
    if (image?.complete && image.naturalWidth > 0) {
      ctx.drawImage(image, left, top, object.width, object.height);
    } else if (options.placeholders) {
      ctx.fillStyle = "#505965";
      ctx.fillRect(left, top, object.width, object.height);
      ctx.strokeStyle = "#8994a1";
      ctx.lineWidth = 1 / zoom;
      ctx.strokeRect(left, top, object.width, object.height);
    }
    ctx.restore();
  }
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
