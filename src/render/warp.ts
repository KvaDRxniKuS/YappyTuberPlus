import type { Affine } from "./rigCanvas";
import type { ObjectFrame, ParamName, RigObject, Vec2, WarpCorner, WarpFrame, WarpSpec } from "../types";

/**
 * Деформация крайних точек.
 *
 * Идея простая: картинку (или её часть) описывает четырёхугольник, четыре угла
 * которого пользователь тянет в инспекторе, в спецрежиме сцены или формулой
 * скрипта. Рендер режет четырёхугольник по диагонали на два треугольника и
 * рисует каждый аффинным преобразованием — так получается перспектива без
 * сеток, атласов и шейдеров: никакого Live2D-редактора меша пользователю не
 * показывается.
 *
 * Почему треугольники: аффинное преобразование задаётся тремя парами точек
 * однозначно, поэтому треугольник ложится точно, а четырёхугольник — нет
 * (общего аффинного преобразования для произвольного квада не существует).
 * Два треугольника с общим ребром дают ту самую перспективу; шов по диагонали
 * прячется перекрытием в полпикселя.
 */

/** Порядок углов один на весь код: по часовой стрелке от левого верхнего. */
export const WARP_CORNERS: WarpCorner[] = ["tl", "tr", "br", "bl"];

/** Подписи углов: коротко в таблице инспектора, полностью в подсказках. */
export const WARP_CORNER_LABEL: Record<WarpCorner, string> = {
  tl: "Левый верхний",
  tr: "Правый верхний",
  br: "Правый нижний",
  bl: "Левый нижний",
};

/** Пределы деформации: смещение угла — проценты размера зоны. */
export const WARP_LIMIT = 100;

/** Пустая деформация: зона — вся картинка, углы не смещены. */
export function defaultWarp(): WarpSpec {
  return {
    enabled: false,
    frame: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    corners: {
      tl: { x: 0, y: 0 },
      tr: { x: 0, y: 0 },
      br: { x: 0, y: 0 },
      bl: { x: 0, y: 0 },
    },
  };
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Битый JSON не должен ломать сцену: приводим зону и углы к разумным числам. */
export function normalizeWarp(raw: unknown): WarpSpec | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as { enabled?: unknown; frame?: Partial<WarpFrame>; corners?: Partial<Record<WarpCorner, Partial<Vec2>>> };
  const frame = source.frame || {};
  const base = defaultWarp();
  const corner = (key: WarpCorner): Vec2 => {
    const item = source.corners?.[key];
    return {
      x: clamp(item?.x, -WARP_LIMIT, WARP_LIMIT, 0),
      y: clamp(item?.y, -WARP_LIMIT, WARP_LIMIT, 0),
    };
  };
  return {
    enabled: source.enabled === true,
    frame: {
      // Зона может вылезать за картинку: так удобно гнуть только её край.
      x: clamp(frame.x, -1, 2, base.frame.x),
      y: clamp(frame.y, -1, 2, base.frame.y),
      width: clamp(frame.width, 0.01, 4, base.frame.width),
      height: clamp(frame.height, 0.01, 4, base.frame.height),
      rotation: clamp(frame.rotation, -360, 360, 0),
    },
    corners: { tl: corner("tl"), tr: corner("tr"), br: corner("br"), bl: corner("bl") },
  };
}

/** Включена ли деформация у объекта: поле есть и галочка стоит. */
export function warpEnabled(object: RigObject): boolean {
  return object.warp?.enabled === true;
}

/** Имя параметра скрипта для угла: `tl` + `x` → `warpTLx`. */
function paramName(corner: WarpCorner, axis: "x" | "y"): ParamName {
  return `warp${corner.toUpperCase()}${axis}` as ParamName;
}

/**
 * Размеры зоны в пикселях объекта. Зона задана долями картинки, поэтому при
 * смене размера объекта она пересчитывается вместе с ним.
 */
export function warpFrameSize(object: RigObject): { width: number; height: number } {
  const spec = object.warp ?? defaultWarp();
  return { width: object.width * spec.frame.width, height: object.height * spec.frame.height };
}

/**
 * Углы зоны до деформации в координатах объекта: (0, 0) — левый верхний угол
 * рамки картинки. Поворот зоны считается вокруг её центра.
 */
export function warpFrameQuad(object: RigObject): Vec2[] {
  const spec = object.warp ?? defaultWarp();
  const { width, height } = warpFrameSize(object);
  const centerX = object.width * spec.frame.x + width / 2;
  const centerY = object.height * spec.frame.y + height / 2;
  const angle = (spec.frame.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const x = (sx * width) / 2;
    const y = (sy * height) / 2;
    return { x: centerX + x * cos - y * sin, y: centerY + x * sin + y * cos };
  });
}

/**
 * Смещения углов в процентах зоны.
 *
 * Параметр скрипта **добавляется** к настройке из инспектора. Иначе нельзя:
 * ядро отдаёт значение каждого параметра в каждом кадре, поэтому «прочитать
 * `warpTLx`» всегда даёт число — и статическая настройка молча перестала бы
 * работать, как только ядро узнало про эти параметры. Сложение же читается
 * естественно: «инспектор задаёт форму, скрипт её раскачивает».
 */
export function warpOffsets(object: RigObject, values?: ObjectFrame | null): Record<WarpCorner, Vec2> {
  const spec = object.warp ?? defaultWarp();
  const read = (corner: WarpCorner, axis: "x" | "y"): number => {
    const live = values?.[paramName(corner, axis)];
    const base = spec.corners[corner][axis];
    return Number.isFinite(live as number) ? base + (live as number) : base;
  };
  return {
    tl: { x: read("tl", "x"), y: read("tl", "y") },
    tr: { x: read("tr", "x"), y: read("tr", "y") },
    br: { x: read("br", "x"), y: read("br", "y") },
    bl: { x: read("bl", "x"), y: read("bl", "y") },
  };
}

/** Итоговый четырёхугольник картинки в координатах объекта. */
export function warpQuad(object: RigObject, values?: ObjectFrame | null): Vec2[] {
  const base = warpFrameQuad(object);
  const offsets = warpOffsets(object, values);
  const { width, height } = warpFrameSize(object);
  return base.map((point, index) => {
    const offset = offsets[WARP_CORNERS[index]];
    return {
      x: point.x + (offset.x * width) / 100,
      y: point.y + (offset.y * height) / 100,
    };
  });
}

/** Есть ли что деформировать: включено и хотя бы один угол сдвинут. */
export function warpMoved(object: RigObject, values?: ObjectFrame | null): boolean {
  if (!warpEnabled(object)) return false;
  const offsets = warpOffsets(object, values);
  return WARP_CORNERS.some((corner) => offsets[corner].x !== 0 || offsets[corner].y !== 0);
}

/** Точка внутри четырёхугольника: для кликов, рамок и лассо. */
export function pointInQuad(point: Vec2, quad: Vec2[]): boolean {
  let inside = false;
  for (let index = 0, previous = quad.length - 1; index < quad.length; previous = index, index += 1) {
    const a = quad[index];
    const b = quad[previous];
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-9) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * Аффинное преобразование по трём парам точек: источник → приёмник.
 *
 * Возвращает коэффициенты canvas-матрицы `setTransform(a, b, c, d, e, f)`.
 */
export function affineFromTriangles(source: Vec2[], target: Vec2[]): { a: number; b: number; c: number; d: number; e: number; f: number } | null {
  const [s0, s1, s2] = source;
  const [d0, d1, d2] = target;
  const det = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
  if (Math.abs(det) < 1e-9) return null;
  const m11 = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / det;
  const m12 = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / det;
  const m21 = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / det;
  const m22 = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / det;
  return {
    a: m11,
    b: m21,
    c: m12,
    d: m22,
    e: d0.x - m11 * s0.x - m12 * s0.y,
    f: d0.y - m21 * s0.x - m22 * s0.y,
  };
}

/** Треугольник чуть больше исходного: так шов по диагонали не просвечивает. */
function expandTriangle(points: Vec2[], by: number): Vec2[] {
  const cx = (points[0].x + points[1].x + points[2].x) / 3;
  const cy = (points[0].y + points[1].y + points[2].y) / 3;
  return points.map((point) => {
    const dx = point.x - cx;
    const dy = point.y - cy;
    const length = Math.hypot(dx, dy) || 1;
    return { x: point.x + (dx / length) * by, y: point.y + (dy / length) * by };
  });
}

function tracePath(ctx: CanvasRenderingContext2D, points: Vec2[]): void {
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.closePath();
}

/**
 * Рисует картинку с деформацией. Координаты — содержимое объекта: (0, 0) это
 * его левый верхний угол, `width`/`height` — размер картинки.
 *
 * Сначала картинка рисуется как есть, но с вырезанной зоной, потом зона
 * рисуется двумя треугольниками. Иначе под деформацией просвечивал бы
 * исходный, ровный кусок картинки.
 */
export function drawWarpedImage(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  object: RigObject,
  width: number,
  height: number,
  values?: ObjectFrame | null,
): void {
  const zone = warpFrameQuad(object);
  const quad = warpQuad(object, values);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  zone.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
  ctx.closePath();
  ctx.clip("evenodd");
  ctx.drawImage(image, 0, 0, width, height);
  ctx.restore();

  for (const triangle of [[0, 1, 2], [0, 2, 3]]) {
    const source = triangle.map((index) => zone[index]);
    const target = triangle.map((index) => quad[index]);
    const matrix = affineFromTriangles(source, target);
    if (!matrix) continue;
    ctx.save();
    tracePath(ctx, expandTriangle(target, 0.5));
    ctx.clip();
    ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    ctx.drawImage(image, 0, 0, width, height);
    ctx.restore();
  }
}

/**
 * Рамка зоны для спецрежима сцены: четыре угла и середина каждой стороны.
 * Ручки нужны, чтобы менять размер прямоугольника, не трогая углы деформации.
 */
export function warpFrameHandles(object: RigObject): { name: string; point: Vec2 }[] {
  const quad = warpFrameQuad(object);
  const middle = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return [
    { name: "tl", point: quad[0] },
    { name: "top", point: middle(quad[0], quad[1]) },
    { name: "tr", point: quad[1] },
    { name: "right", point: middle(quad[1], quad[2]) },
    { name: "br", point: quad[2] },
    { name: "bottom", point: middle(quad[2], quad[3]) },
    { name: "bl", point: quad[3] },
    { name: "left", point: middle(quad[3], quad[0]) },
  ];
}

/** Углы деформации — отдельные ручки: они и есть «крайние точки». */
export function warpCornerHandles(object: RigObject, values?: ObjectFrame | null): { corner: WarpCorner; point: Vec2 }[] {
  const quad = warpQuad(object, values);
  return WARP_CORNERS.map((corner, index) => ({ corner, point: quad[index] }));
}

/**
 * Перетаскивание ручки зоны. `handle` — как в `warpFrameHandles`: `tl`, `top`,
 * `tr`, `right`, `br`, `bottom`, `bl`, `left`.
 *
 * Якорь (противоположный угол или сторона) остаётся на месте, поэтому зона
 * «растёт» от того края, который пользователь не тронул. Считаем в локальных
 * осях зоны: при повороте ручки всё равно ходят вдоль её сторон.
 */
export function resizeWarpFrame(
  spec: WarpSpec,
  handle: string,
  object: RigObject,
  dx: number,
  dy: number,
): WarpSpec {
  const angle = (spec.frame.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Экранное смещение → оси зоны.
  const localX = dx * cos + dy * sin;
  const localY = -dx * sin + dy * cos;
  const halfWidth = (object.width * spec.frame.width) / 2;
  const halfHeight = (object.height * spec.frame.height) / 2;
  const centerX = object.width * spec.frame.x + halfWidth;
  const centerY = object.height * spec.frame.y + halfHeight;

  let nextWidth = halfWidth;
  let nextHeight = halfHeight;
  if (handle === "tl") { nextWidth = halfWidth - localX / 2; nextHeight = halfHeight - localY / 2; }
  else if (handle === "tr") { nextWidth = halfWidth + localX / 2; nextHeight = halfHeight - localY / 2; }
  else if (handle === "br") { nextWidth = halfWidth + localX / 2; nextHeight = halfHeight + localY / 2; }
  else if (handle === "bl") { nextWidth = halfWidth - localX / 2; nextHeight = halfHeight + localY / 2; }
  else if (handle === "left") nextWidth = halfWidth - localX / 2;
  else if (handle === "right") nextWidth = halfWidth + localX / 2;
  else if (handle === "top") nextHeight = halfHeight - localY / 2;
  else if (handle === "bottom") nextHeight = halfHeight + localY / 2;
  nextWidth = Math.max(0.5, nextWidth);
  nextHeight = Math.max(0.5, nextHeight);

  // Якорь в локальных осях зоны: у углов — противоположный угол, у сторон —
  // середина противоположной стороны.
  const anchorLocal = (() => {
    switch (handle) {
      case "tl": return { x: halfWidth, y: halfHeight };
      case "tr": return { x: -halfWidth, y: halfHeight };
      case "br": return { x: -halfWidth, y: -halfHeight };
      case "bl": return { x: halfWidth, y: -halfHeight };
      case "left": return { x: halfWidth, y: 0 };
      case "right": return { x: -halfWidth, y: 0 };
      case "top": return { x: 0, y: halfHeight };
      case "bottom": return { x: 0, y: -halfHeight };
      default: return null;
    }
  })();
  if (!anchorLocal) return spec;
  const anchorX = centerX + anchorLocal.x * cos - anchorLocal.y * sin;
  const anchorY = centerY + anchorLocal.x * sin + anchorLocal.y * cos;
  // Новый центр — от якоря в сторону, противоположную ручке.
  const offsetLocal = (() => {
    switch (handle) {
      case "tl": return { x: -nextWidth, y: -nextHeight };
      case "tr": return { x: nextWidth, y: -nextHeight };
      case "br": return { x: nextWidth, y: nextHeight };
      case "bl": return { x: -nextWidth, y: nextHeight };
      case "left": return { x: -nextWidth, y: 0 };
      case "right": return { x: nextWidth, y: 0 };
      case "top": return { x: 0, y: -nextHeight };
      case "bottom": return { x: 0, y: nextHeight };
      default: return { x: 0, y: 0 };
    }
  })();
  const nextCenterX = anchorX + offsetLocal.x * cos - offsetLocal.y * sin;
  const nextCenterY = anchorY + offsetLocal.x * sin + offsetLocal.y * cos;
  return {
    ...spec,
    frame: {
      ...spec.frame,
      x: (nextCenterX - nextWidth) / object.width,
      y: (nextCenterY - nextHeight) / object.height,
      width: (nextWidth * 2) / object.width,
      height: (nextHeight * 2) / object.height,
    },
  };
}

/** Сдвиг всей зоны: перетаскивание за середину. */
export function moveWarpFrame(spec: WarpSpec, object: RigObject, dx: number, dy: number): WarpSpec {
  return {
    ...spec,
    frame: {
      ...spec.frame,
      x: spec.frame.x + dx / object.width,
      y: spec.frame.y + dy / object.height,
    },
  };
}

/** Поворот зоны вокруг её центра, градусы. */
export function rotateWarpFrame(spec: WarpSpec, degrees: number): WarpSpec {
  const rotation = ((spec.frame.rotation + degrees) % 360 + 360) % 360;
  return { ...spec, frame: { ...spec.frame, rotation: rotation > 180 ? rotation - 360 : rotation } };
}

/** Перетаскивание угла деформации: смещение в процентах размера зоны. */
export function moveWarpCorner(spec: WarpSpec, corner: WarpCorner, object: RigObject, dx: number, dy: number): WarpSpec {
  const { width, height } = warpFrameSize({ ...object, warp: spec } as RigObject);
  const unitX = width > 0 ? (dx / width) * 100 : 0;
  const unitY = height > 0 ? (dy / height) * 100 : 0;
  const current = spec.corners[corner];
  const clampValue = (value: number) => Math.min(WARP_LIMIT, Math.max(-WARP_LIMIT, value));
  return {
    ...spec,
    corners: {
      ...spec.corners,
      [corner]: { x: clampValue(current.x + unitX), y: clampValue(current.y + unitY) },
    },
  };
}

/**
 * Ручки деформации в координатах сцены: зона, её стороны, углы картинки и
 * поворот. Живёт здесь, а не в `Scene.tsx`, чтобы геометрию можно было
 * проверить тестом без браузера.
 */
export function warpHandlesAt(
  object: RigObject,
  values: ObjectFrame | null | undefined,
  left: number,
  top: number,
  matrix: Affine,
  zoom: number,
) {
  const spec = object.warp ?? defaultWarp();
  const at = (point: Vec2) => ({
    x: matrix.a * (left + point.x) + matrix.c * (top + point.y) + matrix.e,
    y: matrix.b * (left + point.x) + matrix.d * (top + point.y) + matrix.f,
  });
  const zoneLocal = warpFrameQuad({ ...object, warp: spec });
  const zone = zoneLocal.map(at);
  const center = at({
    x: zoneLocal.reduce((sum, point) => sum + point.x, 0) / 4,
    y: zoneLocal.reduce((sum, point) => sum + point.y, 0) / 4,
  });
  // Ручка поворота стоит над серединой верхней стороны в осях зоны.
  const middle = { x: (zoneLocal[0].x + zoneLocal[1].x) / 2, y: (zoneLocal[0].y + zoneLocal[1].y) / 2 };
  const angle = (spec.frame.rotation * Math.PI) / 180;
  // Смещение в экранных пикселях делим на зум, а не на масштаб объекта:
  // иначе у мелкого спрайта ручка прилипала бы к рамке.
  const lift = 18 / (zoom || 1);
  const rotation = at({ x: middle.x + Math.sin(angle) * lift, y: middle.y - Math.cos(angle) * lift });
  return {
    spec,
    zone,
    center,
    rotation,
    frameHandles: warpFrameHandles({ ...object, warp: spec }).map((handle) => ({ ...handle, point: at(handle.point) })),
    corners: warpCornerHandles({ ...object, warp: spec }, values).map((handle) => ({ ...handle, point: at(handle.point) })),
  };
}

/** Что схватила мышь в спецрежиме: ручку зоны, угол картинки, поворот или тело. */
export type WarpGrab =
  | { kind: "corner"; corner: WarpCorner }
  | { kind: "handle"; handle: string }
  | { kind: "rotation"; center: Vec2; angle: number }
  | { kind: "move" }
  | null;

/**
 * Какие ручки ловит инструмент.
 *
 * Деформация и зона — два разных инструмента, поэтому и захват у них разный:
 * в «Углах» нельзя случайно утащить рамку, а в «Зоне» — угол картинки. Раньше
 * оба жили в одном режиме, прямоугольники пересекались, и приходилось
 * прицеливаться, чтобы не задеть чужую ручку.
 */
export type WarpGrabMode = "all" | "frame" | "corners";

/**
 * Поиск ручки под курсором. Сначала углы картинки (они важнее), потом
 * поворот, потом стороны зоны, и только затем — тело зоны.
 */
export function warpGrabAt(
  object: RigObject,
  values: ObjectFrame | null | undefined,
  left: number,
  top: number,
  matrix: Affine,
  zoom: number,
  point: Vec2,
  mode: WarpGrabMode = "all",
): WarpGrab {
  const handles = warpHandlesAt(object, values, left, top, matrix, zoom);
  const near = (target: Vec2, radius: number) => Math.hypot(target.x - point.x, target.y - point.y) <= radius;
  const cornerRadius = 9 / (zoom || 1);
  if (mode !== "frame") {
    for (const handle of handles.corners) {
      if (near(handle.point, cornerRadius)) return { kind: "corner", corner: handle.corner };
    }
  }
  if (mode === "corners") {
    // Инструмент углов ничего другого не трогает: иначе на мелком спрайте
    // ручка угла «побеждала» бы рамку, и зону нельзя было сдвинуть.
    return null;
  }
  if (near(handles.rotation, cornerRadius)) {
    return {
      kind: "rotation",
      center: handles.center,
      angle: Math.atan2(point.y - handles.center.y, point.x - handles.center.x),
    };
  }
  for (const handle of handles.frameHandles) {
    if (near(handle.point, 7 / (zoom || 1))) return { kind: "handle", handle: handle.name };
  }
  if (pointInQuad(point, handles.zone)) return { kind: "move" };
  return null;
}
