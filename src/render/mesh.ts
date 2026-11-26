import {evaluateArtMesh, compiledArtMesh, addArtOffsets, type CompiledArtMesh} from "../engine/artMeshRuntime";
import type {ArtOffsets} from "../engine/artDeformation";
import {TextureCache} from "./textureCache";
import {reportResources} from "../engine/meter";
import {enterRenderStage} from "../engine/renderProfile";
import type { ObjectFrame, RigObject, Vec2 } from "../types";
import { affineFromTriangles } from "./triangleAffine";

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
export interface MeshGeometry {
  /** Куда точка картинки попадает на объекте (пиксели от левого верхнего угла картинки). */
  targets: Vec2[];
  /** Текстурная координата точки: доли картинки. */
  uv: Vec2[];
  triangles: number[];
}

/** Only explicit authored triangle topology can produce a surface. */
export function meshGeometry(object:RigObject,_width=object.width,_height=object.height,_values?:ObjectFrame|null,keyOffsets?:Record<string,Vec2>|null):MeshGeometry|null {
  return object.artMesh ? evaluateArtMesh(compiledArtMesh(object.artMesh),addArtOffsets(object.artPose,keyOffsets)) : null;
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

/** Unified art mesh rendering: no GridSpec, zone cage or implicit geometry.
 * Caller supplies the object's transform and local-coordinate compiled mesh.
 * Empty topology intentionally draws nothing, not an undeformed fallback. */
export function drawArtMesh(
  ctx:CanvasRenderingContext2D,image:CanvasImageSource,
  mesh:CompiledArtMesh,offsets:ArtOffsets={},
):void {
  if(!mesh.triangles.length)return;
  const geometry=evaluateArtMesh(mesh,offsets);
  const source=imageSize(image);
  if(source.width<=0||source.height<=0)return;
  drawTriangles(ctx,image,source.width,source.height,geometry);
}

export function drawMeshImage(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  object: RigObject,
  width: number,
  height: number,
  values?: ObjectFrame | null,
  keyOffsets?: Record<string, Vec2> | null,
  deform?: (point: Vec2) => Vec2,
  prepared?: MeshGeometry,
): boolean {
  const endPathProfile=enterRenderStage("mesh");
  try {

  const endGeometry=enterRenderStage("mesh-geometry");
  let geometry:MeshGeometry|null|undefined;
  try { geometry=prepared ?? meshSurfaceGeometry(object,width,height,values,keyOffsets,deform); }
  finally {endGeometry?.();}
  if(!geometry) return false;
  if(geometry.triangles.length) drawTriangles(ctx,image,width,height,geometry);
  return true;
  } finally { endPathProfile?.(); }
}

/** Same evaluated surface for rendering, clipping bounds and hit testing. */
export function meshSurfaceGeometry(
  object:RigObject,width=object.width,height=object.height,values?:ObjectFrame|null,
  keyOffsets?:Record<string,Vec2>|null,deform?:(point:Vec2)=>Vec2,
):MeshGeometry|null {
  const geometry=meshGeometry(object,width,height,values,keyOffsets);
  return geometry&&deform?{...geometry,targets:geometry.targets.map(deform)}:geometry;
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
  textures: TextureCache<CanvasImageSource,{texture:WebGLTexture;url:string;width:number;height:number}>;
  position: number;
  uv: number;
  matrix: WebGLUniformLocation | null;
  sampler: WebGLUniformLocation | null;
  source: CanvasImageSource | null;
  /** Размер картинки, загруженной в текстуру: видео меняется каждый кадр. */
  size: { width: number; height: number };
  fallbackBytes: number;
}

let glState: GlState | null = null;
let glFailed = false;

function createGlState(): GlState | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width=canvas.height=1;
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
    textures: new TextureCache(entry=>gl.deleteTexture(entry.texture)),
    position: gl.getAttribLocation(program, "a_pos"),
    uv: gl.getAttribLocation(program, "a_uv"),
    matrix: gl.getUniformLocation(program, "u_matrix"),
    sampler: gl.getUniformLocation(program, "u_image"),
    source: null,
    size: { width: 0, height: 0 },
    fallbackBytes: 0,
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
  const endUpload=enterRenderStage("mesh-upload");
  try {
  const source=image as HTMLImageElement;
  const url=source.currentSrc || source.src || "";
  // Only immutable image elements are cached. Canvas/video must refresh.
  const immutable=typeof source.naturalWidth === "number";
  const cached=immutable?state.textures.get(image):undefined;
  if(cached && cached.url===url && cached.width===size.width && cached.height===size.height) {
    gl.bindTexture(gl.TEXTURE_2D,cached.texture);return true;
  }
  if(cached)state.textures.delete(image);
  const bytes=size.width*size.height*4;
  const cacheable=immutable && bytes>0 && bytes<=32*1024*1024;
  const texture=cacheable?gl.createTexture():state.texture;
  if(!texture)return false;
  gl.bindTexture(gl.TEXTURE_2D,texture);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  try {
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image as TexImageSource);
  } catch {
    if(cacheable)gl.deleteTexture(texture);
    return false;
  }
  if(cacheable)state.textures.set(image,{texture,url,width:size.width,height:size.height},bytes);
  if(!cacheable)state.fallbackBytes=bytes;
  state.source = null;
  state.size = { width: size.width || width, height: size.height || height };
  return true;
  } finally {endUpload?.();}

}

/**
 * Отрисовка треугольников через WebGL2.
 *
 * Холст под сетку не на весь экран: он обрезан по рамке объекта на сцене.
 * Иначе каждый объект с сеткой стирал и склеивал бы весь кадр — на пяти
 * спрайтах в OBS это заметно.
 */
/** Diagnostic only: WebGL2 may itself be software-backed by the browser. */
export function meshRenderBackend():string {
  if(glFailed) return "Canvas 2D — резервный рендер мешей";
  if(!glState) return "меши не отрисовывались";
  const gl=glState.gl,debug=gl.getExtension("WEBGL_debug_renderer_info");
  const renderer=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
  return `WebGL2 · ${String(renderer)}`;
}

/** Bounded high-water storage: avoid resize thrashing between mesh objects. */
export function meshBufferSize(current:number,required:number,limit:number):number {
  return Math.min(limit,Math.max(current,Math.ceil(required/64)*64));
}

function drawWithWebgl(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number,
  geometry: MeshGeometry,
): boolean {
  if (typeof document === "undefined" || glFailed) return false;
  if (!glState) glState = createGlState();
  if (!glState) {
    console.warn("WebGL2 недоступен: деформированные меши рисуются через медленный Canvas 2D. Проверьте аппаратное ускорение OBS/браузера.");
    glFailed = true;
    return false;
  }
  const state = glState;
  const { gl, canvas } = state;
  const endSurface=enterRenderStage("mesh-surface");
  let left:number,top:number,boxWidth:number,boxHeight:number;
  try {
  const transform = ctx.getTransform();
  left = Infinity;
  top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  // Bounds need scalars, not a fresh transformed Vec2 for every mesh vertex.
  for (const point of geometry.targets) {
    const x=transform.a*point.x+transform.c*point.y+transform.e;
    const y=transform.b*point.x+transform.d*point.y+transform.f;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (!Number.isFinite(left) || right - left < 1e-3 || bottom - top < 1e-3) return true;
  // Один пиксель запаса: сглаживание по краю треугольника не должно обрезаться.
  left = Math.max(0, Math.floor(left) - 1);
  top = Math.max(0, Math.floor(top) - 1);
  right = Math.min(canvasSize(ctx).width, Math.ceil(right) + 1);
  bottom = Math.min(canvasSize(ctx).height, Math.ceil(bottom) + 1);
  if(right<=left || bottom<=top)return true;
  boxWidth = Math.max(1, Math.ceil(right - left));
  boxHeight = Math.max(1, Math.ceil(bottom - top));
  const nextWidth=meshBufferSize(canvas.width,boxWidth,ctx.canvas.width);
  const nextHeight=meshBufferSize(canvas.height,boxHeight,ctx.canvas.height);
  // Resize only the changed axis: assigning either dimension resets storage.
  if(canvas.width!==nextWidth)canvas.width=nextWidth;
  if(canvas.height!==nextHeight)canvas.height=nextHeight;
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  } finally {endSurface?.();}
  const transform=ctx.getTransform();
  gl.activeTexture(gl.TEXTURE0);
  if (!uploadTexture(state, image, width, height)) return false;

  const endSubmit=enterRenderStage("mesh-submit");
  try {
  const matrix = meshMatrix(transform, { left, top, width: canvas.width, height: canvas.height });
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
  gl.uniform1i(state.sampler, 0);
  gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
  } finally {endSubmit?.();}
  reportResources(state,{textures:state.textures.size+1,textureBytes:state.textures.bytes+state.fallbackBytes,
    offscreenCanvases:1,offscreenCanvasBytes:canvas.width*canvas.height*4});
  const endComposite=enterRenderStage("mesh-composite");
  try {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Matrix/viewport use full storage; copy only the active top-left crop.
  ctx.drawImage(canvas, 0, 0, boxWidth, boxHeight, left, top, boxWidth, boxHeight);
  ctx.restore();
  } finally {endComposite?.();}
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
