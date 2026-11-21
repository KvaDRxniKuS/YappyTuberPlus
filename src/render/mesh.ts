import type { ObjectFrame, RigObject, Vec2 } from "../types";
import { applyOffsets, meshOf, meshVertices, paramOffsets, regularGrid, sampleDeform } from "../engine/mesh";
import { affineFromTriangles } from "./warp";

/*
 * Рендер сетки: картинка ложится на сцену треугольниками артмеша.
 *
 * Большая сетка — это тысячи треугольников (32×32 — 1922 ячейки, 3844
 * треугольника), а Canvas 2D умеет рисовать только аффинные треугольники по
 * одному: на каждый нужен `clip` + `drawImage`. Поэтому основной путь — WebGL2:
 * одна текстура, один индексный буфер, один вызов на объект. Canvas 2D остаётся
 * запасным путём (нет WebGL2, старая видеокарта): картинка та же, но медленно.
 *
 * Композит остаётся обычным: WebGL рисует в свой холст, а холст кладётся на
 * сцену через `drawImage`. Так сетка живёт внутри прежнего рендера — с масками,
 * светом, материалом и порядком слоёв, которые считает Canvas 2D.
 */

/** Геометрия одного объекта: UV в долях картинки и цели в координатах объекта. */
interface MeshGeometry {
  /** Куда точка картинки попадает на объекте (пиксели от левого верхнего угла картинки). */
  targets: Vec2[];
  /** Текстурная координата точки: доли картинки. */
  uv: Vec2[];
  triangles: number[];
}

/**
 * Зона: прямоугольник внутри картинки плюс поворот вокруг центра.
 *
 * Точки артмеша и сетки лежат в долях зоны, поэтому «где это на объекте»
 * считается здесь и только здесь: редактор и рендер обязаны видеть одно и то
 * же, иначе ручки уедут от картинки.
 */
export interface ZoneGeometry {
  width: number;
  height: number;
  /** Доли зоны → пиксели от левого верхнего угла картинки. */
  toObject(u: number, v: number): Vec2;
  /** Пиксели от угла картинки → доли зоны (для ручек и кликов). */
  toZone(point: Vec2): Vec2;
}

/** Зона объекта в его координатах. `width`/`height` — размер нарисованной картинки. */
export function zoneGeometry(object: RigObject, width = object.width, height = object.height): ZoneGeometry {
  const mesh = meshOf(object);
  const frame = mesh?.frame ?? { x: 0, y: 0, width: 1, height: 1, rotation: 0 };
  const zoneWidth = Math.max(0.001, width * frame.width);
  const zoneHeight = Math.max(0.001, height * frame.height);
  const centerX = width * frame.x + zoneWidth / 2;
  const centerY = height * frame.y + zoneHeight / 2;
  const angle = (frame.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    width: zoneWidth,
    height: zoneHeight,
    toObject(u: number, v: number): Vec2 {
      const localX = u * zoneWidth - zoneWidth / 2;
      const localY = v * zoneHeight - zoneHeight / 2;
      return {
        x: centerX + localX * cos - localY * sin,
        y: centerY + localX * sin + localY * cos,
      };
    },
    toZone(point: Vec2): Vec2 {
      const dx = point.x - centerX;
      const dy = point.y - centerY;
      const localX = dx * cos + dy * sin;
      const localY = -dx * sin + dy * cos;
      return { x: (localX + zoneWidth / 2) / zoneWidth, y: (localY + zoneHeight / 2) / zoneHeight };
    },
  };
}

/** Геометрия объекта: артмеш, прогнанный через сетку, в пикселях объекта. */
export function meshGeometry(
  object: RigObject,
  width = object.width,
  height = object.height,
  values?: ObjectFrame | null,
  keyOffsets?: Record<string, Vec2> | null,
): MeshGeometry | null {
  const mesh = meshOf(object);
  if (!mesh || !mesh.enabled) return null;
  // Параметры скрипта и смещения ключа двигают один и тот же узел: они
  // складываются, а не спорят за него.
  const offsets: Record<string, Vec2> = {};
  for (const source of [paramOffsets(mesh, values), keyOffsets]) {
    for (const [index, offset] of Object.entries(source ?? {})) {
      const previous = offsets[index];
      offsets[index] = previous
        ? { x: previous.x + offset.x, y: previous.y + offset.y }
        : offset;
    }
  }
  const grid = applyOffsets(mesh.deform, Object.keys(offsets).length ? offsets : undefined);
  const vertices = meshVertices({ ...mesh, deform: grid });
  const zone = zoneGeometry(object, width, height);
  return {
    targets: vertices.targets.map((point) => zone.toObject(point.x, point.y)),
    // Текстурная координата — положение точки внутри картинки: зона вырезает
    // свой кусок картинки, и UV считается от её границ.
    uv: vertices.params.map((point) => {
      const source = zone.toObject(point.x, point.y);
      return { x: source.x / width, y: source.y / height };
    }),
    triangles: vertices.triangles,
  };
}

/** Четырёхугольник вокруг всей нарисованной картинки: для рамок, кликов и тени. */
export function meshQuad(object: RigObject, values?: ObjectFrame | null): Vec2[] {
  const geometry = meshGeometry(object, object.width, object.height, values);
  const width = object.width;
  const height = object.height;
  if (!geometry) {
    return [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
  }
  let left = 0;
  let top = 0;
  let right = width;
  let bottom = height;
  for (const point of geometry.targets) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
}

/** Углы зоны на объекте: по ним вырезается «дыра» под сеткой. */
function zoneQuad(zone: ZoneGeometry): Vec2[] {
  return [
    zone.toObject(0, 0), zone.toObject(1, 0), zone.toObject(1, 1), zone.toObject(0, 1),
  ];
}

/**
 * Нарисовать картинку сеткой. Возвращает `false`, если деформации нет и
 * вызывающий должен рисовать как обычно.
 */
export function drawMeshImage(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  object: RigObject,
  width: number,
  height: number,
  values?: ObjectFrame | null,
  keyOffsets?: Record<string, Vec2> | null,
  deform?: (point: Vec2) => Vec2,
): boolean {
  const mesh = meshOf(object);
  if (!mesh || !mesh.enabled) return false;
  let geometry = meshGeometry(object, width, height, values, keyOffsets);
  if (!geometry) return false;
  if (geometry.triangles.length < 3) return true;
  const grid = applyOffsets(mesh.deform, mergeGridOffsets(paramOffsets(mesh,values),keyOffsets));
  const rest = grid.rest ?? regularGrid(grid.cols,grid.rows).points;
  const strained = grid.points.some((p,i) => Math.hypot(p.x-rest[i].x,p.y-rest[i].y) > 1e-7);
  if (strained) {
    // Tessellate the SOURCE surface, then sample its deformer. Subdividing
    // already deformed triangles would miss interior controls and stretch the
    // texture differently whenever an art vertex moved.
    const source = meshGeometry({ ...object, mesh: { ...mesh, deform: regularGrid(2,2) } },width,height)!;
    const zone = zoneGeometry(object,width,height);
    const levels = Math.max(3,Math.ceil(Math.log2(Math.max(grid.cols,grid.rows)-1)));
    geometry = deformGeometry(source,(p) => {
      const uv = zone.toZone(p);
      const target = sampleDeform(grid,uv.x,uv.y);
      const point = zone.toObject(target.x,target.y);
      return deform ? deform(point) : point;
    },levels);
  } else if (deform) geometry = deformGeometry(geometry, deform);
  drawTriangles(ctx, image, width, height, geometry);
  return true;
}

/** Картинка целиком, но с вырезанной зоной: под сетку она не попадает. */
function mergeGridOffsets(...sources: Array<Record<string, Vec2> | null | undefined>): Record<string, Vec2> {
  const result: Record<string,Vec2> = {};
  for (const source of sources) for (const [id,delta] of Object.entries(source ?? {})) {
    const previous = result[id] ?? {x:0,y:0};
    result[id] = {x:previous.x+delta.x,y:previous.y+delta.y};
  }
  return result;
}

/** Subdivide only covered triangles before a non-affine parent deformation.
 * UVs stay fixed; no control grid is changed and holes remain holes. */
export function deformGeometry(geometry: MeshGeometry, deform: (point: Vec2) => Vec2, levels = 3): MeshGeometry {
  let result = geometry;
  for (let level = 0; level < levels && result.triangles.length < 24000; level += 1) {
    const targets = [...result.targets];
    const uv = [...result.uv];
    const triangles: number[] = [];
    const midpoints = new Map<string, number>();
    const midpoint = (a: number, b: number) => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const previous = midpoints.get(key);
      if (previous !== undefined) return previous;
      const index = targets.length;
      targets.push({ x: (targets[a].x + targets[b].x) / 2, y: (targets[a].y + targets[b].y) / 2 });
      uv.push({ x: (uv[a].x + uv[b].x) / 2, y: (uv[a].y + uv[b].y) / 2 });
      midpoints.set(key, index);
      return index;
    };
    for (let i = 0; i < result.triangles.length; i += 3) {
      const [a, b, c] = result.triangles.slice(i, i + 3);
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      triangles.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    result = { targets, uv, triangles };
  }
  return { ...result, targets: result.targets.map(deform) };
}

/* ── Треугольники ───────────────────────────────────────────────────────── */

function traceTriangle(ctx: CanvasRenderingContext2D, points: Vec2[]): void {
  ctx.beginPath();
  points.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
  ctx.closePath();
}

/** Треугольник, чуть раздутый от центра: шов между соседями не просвечивает. */
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

function drawTriangles(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number,
  geometry: MeshGeometry,
): void {
  if (drawWithWebgl(ctx, image, width, height, geometry)) return;
  drawWithCanvas(ctx, image, width, height, geometry);
}

/**
 * Запасной путь на Canvas 2D: каждый треугольник рисуется аффинным
 * преобразованием. Медленно, зато картинка та же — и без WebGL2 всё работает.
 */
function drawWithCanvas(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number,
  geometry: MeshGeometry,
): void {
  for (let index = 0; index < geometry.triangles.length; index += 3) {
    const ids = [geometry.triangles[index], geometry.triangles[index + 1], geometry.triangles[index + 2]];
    const source = ids.map((id) => ({ x: geometry.uv[id].x * width, y: geometry.uv[id].y * height }));
    const target = ids.map((id) => geometry.targets[id]);
    const matrix = affineFromTriangles(source, target);
    if (!matrix) continue;
    ctx.save();
    traceTriangle(ctx, expandTriangle(target, 0.35));
    ctx.clip();
    ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    ctx.drawImage(image, 0, 0, width, height);
    ctx.restore();
  }
}

/* ── WebGL2 ─────────────────────────────────────────────────────────────── */

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
uniform mat3 u_matrix;
out vec2 v_uv;
void main() {
  vec3 pos = u_matrix * vec3(a_pos, 1.0);
  gl_Position = vec4(pos.xy, 0.0, 1.0);
  v_uv = a_uv;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_image;
out vec4 outColor;
void main() {
  // Текстура загружена с предумноженной альфой: так композит на сцену
  // совпадает с обычным drawImage, включая мягкие края.
  outColor = texture(u_image, v_uv);
}`;

interface GlState {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  buffer: WebGLBuffer;
  indices: WebGLBuffer;
  texture: WebGLTexture;
  position: number;
  uv: number;
  matrix: WebGLUniformLocation | null;
  sampler: WebGLUniformLocation | null;
  source: CanvasImageSource | null;
  /** Размер картинки, загруженной в текстуру: видео меняется каждый кадр. */
  size: { width: number; height: number };
}

let glState: GlState | null = null;
let glFailed = false;

function createGlState(): GlState | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    depth: false,
    stencil: false,
    // Буфер читается сразу после отрисовки: без этого он может опустеть.
    preserveDrawingBuffer: true,
  });
  if (!gl) return null;
  const compile = (type: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  const buffer = gl.createBuffer();
  const indices = gl.createBuffer();
  const texture = gl.createTexture();
  if (!buffer || !indices || !texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);
  return {
    canvas,
    gl,
    program,
    buffer,
    indices,
    texture,
    position: gl.getAttribLocation(program, "a_pos"),
    uv: gl.getAttribLocation(program, "a_uv"),
    matrix: gl.getUniformLocation(program, "u_matrix"),
    sampler: gl.getUniformLocation(program, "u_image"),
    source: null,
    size: { width: 0, height: 0 },
  };
}

function imageSize(image: CanvasImageSource): { width: number; height: number } {
  const source = image as { videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };
  if (source.videoWidth && source.videoHeight) {
    return { width: source.videoWidth, height: source.videoHeight };
  }
  if (source.naturalWidth && source.naturalHeight) {
    return { width: source.naturalWidth, height: source.naturalHeight };
  }
  return { width: source.width ?? 0, height: source.height ?? 0 };
}

function uploadTexture(state: GlState, image: CanvasImageSource, width: number, height: number): boolean {
  const { gl } = state;
  const size = imageSize(image);
  const same = state.source === image && state.size.width === size.width && state.size.height === size.height;
  // Видео меняется каждый кадр — его текстуру приходится обновлять.
  const isVideo = (image as HTMLVideoElement).readyState !== undefined;
  if (same && !isVideo) return true;
  gl.bindTexture(gl.TEXTURE_2D, state.texture);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image as TexImageSource);
  } catch {
    return false;
  }
  state.source = image;
  state.size = { width: size.width || width, height: size.height || height };
  return true;
}

/**
 * Отрисовка треугольников через WebGL2.
 *
 * Холст под сетку не на весь экран: он обрезан по рамке объекта на сцене.
 * Иначе каждый объект с сеткой стирал и склеивал бы весь кадр — на пяти
 * спрайтах в OBS это заметно.
 */
function drawWithWebgl(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number,
  geometry: MeshGeometry,
): boolean {
  if (glFailed) return false;
  if (!glState) glState = createGlState();
  if (!glState) {
    glFailed = true;
    return false;
  }
  const state = glState;
  const { gl, canvas } = state;
  const transform = ctx.getTransform();
  const toCanvas = (point: Vec2): Vec2 => ({
    x: transform.a * point.x + transform.c * point.y + transform.e,
    y: transform.b * point.x + transform.d * point.y + transform.f,
  });
  const corners = geometry.targets.map(toCanvas);
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const point of corners) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  if (!Number.isFinite(left) || right - left < 1e-3 || bottom - top < 1e-3) return true;
  // Один пиксель запаса: сглаживание по краю треугольника не должно обрезаться.
  left = Math.max(0, Math.floor(left) - 1);
  top = Math.max(0, Math.floor(top) - 1);
  right = Math.min(canvasSize(ctx).width, Math.ceil(right) + 1);
  bottom = Math.min(canvasSize(ctx).height, Math.ceil(bottom) + 1);
  const boxWidth = Math.max(1, Math.ceil(right - left));
  const boxHeight = Math.max(1, Math.ceil(bottom - top));
  if (canvas.width !== boxWidth || canvas.height !== boxHeight) {
    canvas.width = boxWidth;
    canvas.height = boxHeight;
  }
  gl.viewport(0, 0, boxWidth, boxHeight);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (!uploadTexture(state, image, width, height)) return false;

  const matrix = meshMatrix(transform, { left, top, width: boxWidth, height: boxHeight });
  const positions = new Float32Array(geometry.targets.length * 2);
  const uvs = new Float32Array(geometry.targets.length * 2);
  geometry.targets.forEach((point, index) => {
    positions[index * 2] = point.x;
    positions[index * 2 + 1] = point.y;
    uvs[index * 2] = geometry.uv[index].x;
    uvs[index * 2 + 1] = geometry.uv[index].y;
  });
  const count = geometry.triangles.length;
  const indices = new Uint16Array(count);
  // 32×32 — это 1024 узла: в 16-битный индекс помещается с запасом.
  if (geometry.targets.length > 65535) return false;
  for (let index = 0; index < count; index += 1) indices[index] = geometry.triangles[index];

  gl.useProgram(state.program);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.buffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions.byteLength + uvs.byteLength, gl.DYNAMIC_DRAW);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
  gl.bufferSubData(gl.ARRAY_BUFFER, positions.byteLength, uvs);
  gl.enableVertexAttribArray(state.position);
  gl.vertexAttribPointer(state.position, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(state.uv);
  gl.vertexAttribPointer(state.uv, 2, gl.FLOAT, false, 0, positions.byteLength);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, state.indices);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);
  gl.uniformMatrix3fv(state.matrix, false, matrix);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state.texture);
  gl.uniform1i(state.sampler, 0);
  gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(canvas, left, top);
  ctx.restore();
  return true;
}

/**
 * Матрица «пиксели объекта → координаты WebGL» для холста сетки.
 *
 * Верх кадра должен попасть **наверх** холста: у WebGL ось Y смотрит вверх,
 * поэтому верхняя граница прямоугольника — это `+1`, а не `−1`. Знак здесь один
 * на весь рендер, и перепутать его значит перевернуть картинку целиком.
 *
 * У текстурных координат та же договорённость, что и в Canvas 2D: `v = 0` — верх
 * картинки, поэтому UV вершин остаются как есть.
 */
export function meshMatrix(
  transform: { a: number; b: number; c: number; d: number; e: number; f: number },
  box: { left: number; top: number; width: number; height: number },
): Float32Array {
  const sx = 2 / Math.max(1, box.width);
  const sy = 2 / Math.max(1, box.height);
  // Колонки по три: mat3 в GLSL заполняется по столбцам.
  return new Float32Array([
    transform.a * sx, -transform.b * sy, 0,
    transform.c * sx, -transform.d * sy, 0,
    (transform.e - box.left) * sx - 1, 1 - (transform.f - box.top) * sy, 1,
  ]);
}

/** Размер холста в пикселях: у канвы это буфер, а не CSS-размер. */
function canvasSize(ctx: CanvasRenderingContext2D): { width: number; height: number } {
  return { width: ctx.canvas.width, height: ctx.canvas.height };
}

/* ── Ручки и попадания: то, чем живёт спецрежим сцены ─────────────────────
 *
 * Точки отдаются в тех же координатах, что и старая деформация: пиксели от
 * левого верхнего угла картинки. Сцена переводит их в экранные через матрицу
 * объекта, поэтому ручки стоят там, где нарисована картинка, — с учётом
 * поворота, масштаба и пивота.
 */

/** Вершины нарезки после деформации: пиксели от угла картинки. */
export function artPointPoints(
  object: RigObject,
  values?: ObjectFrame | null,
  width = object.width,
  height = object.height,
): Vec2[] {
  const geometry = meshGeometry(object, width, height, values);
  return geometry ? geometry.targets : [];
}

/** Узлы сетки после смещений: пиксели от угла картинки. */
export function meshNodePoints(
  object: RigObject,
  values?: ObjectFrame | null,
  width = object.width,
  height = object.height,
  keyOffsets?: Record<string, Vec2> | null,
): Vec2[] {
  const mesh = meshOf(object);
  if (!mesh) return [];
  const offsets: Record<string, Vec2> = {};
  for (const source of [paramOffsets(mesh, values), keyOffsets]) {
    for (const [index, offset] of Object.entries(source ?? {})) {
      const previous = offsets[index];
      offsets[index] = previous
        ? { x: previous.x + offset.x, y: previous.y + offset.y }
        : offset;
    }
  }
  const grid = applyOffsets(mesh.deform, Object.keys(offsets).length ? offsets : undefined);
  const zone = zoneGeometry(object, width, height);
  return grid.points.map((point) => zone.toObject(point.x, point.y));
}

/** Ближайшая точка в радиусе: индекс или `null`. */
export function nearestPoint(points: Vec2[], point: Vec2, radius: number): number | null {
  let best: number | null = null;
  let distance = radius;
  points.forEach((candidate, index) => {
    const length = Math.hypot(candidate.x - point.x, candidate.y - point.y);
    if (length <= distance) {
      distance = length;
      best = index;
    }
  });
  return best;
}

/** Расстояние от точки до отрезка: по нему ловится ребро нарезки. */
function distanceToSegment(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-9) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

/** Ребро нарезки под курсором: ближайшее в радиусе. */
export function artEdgeHit(
  object: RigObject,
  point: Vec2,
  radius: number,
  values?: ObjectFrame | null,
): { a: number; b: number } | null {
  const points = artPointPoints(object, values);
  if (!points.length) return null;
  const edges = edgePairs(object);
  let best: { a: number; b: number } | null = null;
  let distance = radius;
  for (const [a, b] of edges) {
    const length = distanceToSegment(point, points[a], points[b]);
    if (length <= distance) {
      distance = length;
      best = { a, b };
    }
  }
  return best;
}

/** Рёбра нарезки без повторов: пары индексов. */
export function edgePairs(object: RigObject): [number, number][] {
  const mesh = meshOf(object);
  if (!mesh) return [];
  const seen = new Set<string>();
  const pairs: [number, number][] = [];
  for (let index = 0; index < mesh.art.triangles.length; index += 3) {
    const ids = [mesh.art.triangles[index], mesh.art.triangles[index + 1], mesh.art.triangles[index + 2]];
    for (let at = 0; at < 3; at += 1) {
      const a = ids[at];
      const b = ids[(at + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([a, b]);
    }
  }
  return pairs;
}

/** Треугольник нарезки под курсором. */
export function artTriangleHit(
  object: RigObject,
  point: Vec2,
  values?: ObjectFrame | null,
): number | null {
  const mesh = meshOf(object);
  const points = artPointPoints(object, values);
  if (!mesh || !points.length) return null;
  for (let index = 0; index < mesh.art.triangles.length; index += 3) {
    const a = points[mesh.art.triangles[index]];
    const b = points[mesh.art.triangles[index + 1]];
    const c = points[mesh.art.triangles[index + 2]];
    const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (Math.abs(area) < 1e-9) continue;
    const s1 = ((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)) / area;
    const s2 = ((c.x - b.x) * (point.y - b.y) - (c.y - b.y) * (point.x - b.x)) / area;
    const s3 = ((a.x - c.x) * (point.y - c.y) - (a.y - c.y) * (point.x - c.x)) / area;
    if (s1 >= 0 && s2 >= 0 && s3 >= 0) return index / 3;
  }
  return null;
}

/** Смещение в пикселях объекта → доли зоны (с учётом поворота зоны). */
export function zoneDelta(
  object: RigObject,
  from: Vec2,
  to: Vec2,
  width = object.width,
  height = object.height,
): Vec2 {
  const zone = zoneGeometry(object, width, height);
  const start = zone.toZone(from);
  const end = zone.toZone(to);
  return { x: end.x - start.x, y: end.y - start.y };
}

/** Пиксели объекта → доли зоны: куда ставить новую точку нарезки. */
export function zonePoint(
  object: RigObject,
  point: Vec2,
  width = object.width,
  height = object.height,
): Vec2 {
  return zoneGeometry(object, width, height).toZone(point);
}

/** Углы зоны на объекте для оверлея. */
export function zoneOutline(
  object: RigObject,
  width = object.width,
  height = object.height,
): Vec2[] {
  return zoneQuad(zoneGeometry(object, width, height));
}
