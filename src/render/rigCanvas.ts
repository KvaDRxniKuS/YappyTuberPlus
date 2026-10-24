import type { ObjectFrame, RigFrame, RigObject, RigPreset } from "../types";
import { NEUTRAL_PARAMS } from "../engine/frame";

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

  /** Starts decoding any image that is not in the cache yet. */
  sync(objects: RigObject[]): void {
    for (const object of objects) {
      const source = object.image;
      if (!source || this.images.has(source)) continue;
      const image = new Image();
      image.decoding = "async";
      image.onload = () => { this.emit(); };
      image.onerror = () => { this.emit(); };
      image.src = source;
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
 * translate(base + dynamic) · rotate · skew · scale, computed with plain
 * arithmetic: no DOMMatrix allocation in the per-sprite hot path.
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
  return multiplyAffine(multiplyAffine(multiplyAffine(translate, rotate), skew), scale);
}

/** Sprites in draw order: computed `layer` first, then preset order. */
export function orderedSprites(preset: RigPreset, frame: RigFrame | null): RigObject[] {
  const sprites = preset.objects.filter((object) => object.kind === "sprite");
  if (!frame) return [...sprites].sort((a, b) => a.base.layer - b.base.layer);
  const positions = new Map(frame.order.map((id, index) => [id, index]));
  return [...sprites].sort((a, b) => (positions.get(a.id) ?? 9999) - (positions.get(b.id) ?? 9999));
}

export interface DrawRigOptions {
  /** Draw a wireframe box for sprites whose image has not decoded yet. */
  placeholders?: boolean;
  /** Line width scale for placeholders (editor zoom). */
  lineScale?: number;
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
  for (const object of orderedSprites(preset, frame)) {
    const values = frame?.objects[object.id] || staticValues(object);
    if (values.visible === 0) continue;
    const opacity = Math.min(1, Math.max(0, object.base.opacity * values.opacity));
    if (opacity === 0 || values.sizeX === 0 || values.sizeY === 0) continue;
    const matrix = objectMatrix(object, values);
    const image = assets.get(object.image);
    const left = -object.pivot.x * object.width;
    const top = -object.pivot.y * object.height;
    ctx.save();
    ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    ctx.globalAlpha = opacity;
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
