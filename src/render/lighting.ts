import type { LightShape } from "../types";
import { assetUrl } from "../engine/assets";
import { alphaOf, withAlpha } from "./light";

/**
 * Объём от нормалей: проход освещения на WebGL2.
 *
 * Canvas 2D умеет рисовать пятно света, но не умеет считать, как поверхность
 * повёрнута к этому пятну — а именно из этого получается объём. Поэтому после
 * отрисовки сцены холст уходит текстурой в WebGL2, где для каждой точки
 * считается наклон поверхности из карты нормалей и добавка света.
 *
 * Проход ничего не перерисовывает заново: пятна, градиенты, маски и порядок
 * слоёв остаются за Canvas 2D, а WebGL только затемняет и подсвечивает уже
 * нарисованное там, где у объекта есть карта нормалей. Значит, свет никогда не
 * красит пустое место и не спорит с разметкой редактора — и откат без WebGL2
 * ничего не ломает, просто пропадает объём.
 */

/** Свет в координатах холста: пятно уже сведено с камерой и масштабом. */
export interface LightSample {
  /** Центр пятна в пикселях холста. */
  x: number;
  y: number;
  /** Радиус в пикселях холста. */
  radius: number;
  /** Поворот пятна, радианы. */
  rotation: number;
  shape: LightShape;
  angle: number;
  softness: number;
  colorStart: string;
  colorEnd: string;
  brightness: number;
  blend: "normal" | "add";
}

/** Объект с картой нормалей: матрица «локальные координаты → пиксели холста». */
export interface NormalSample {
  /** Матрица 3×3 по столбцам: [a, b, 0, c, d, 0, e, f, 1]. */
  matrix: number[];
  /** Рамка картинки в локальных координатах: left, top, width, height. */
  rect: [number, number, number, number];
  /** Файл карты нормалей. */
  src: string;
  /** Сила объёма 0…200 %. */
  strength: number;
}

/**
 * Что собрал проход отрисовки: светильники сцены.
 *
 * Объектов с картой нормалей здесь нет: объём считается каждому объекту сразу
 * после его отрисовки, в его собственном слое (`shadeLayer`), иначе он
 * просвечивал бы сквозь объекты выше.
 */
export interface LightingCollector {
  lights: LightSample[];
}

export function createCollector(): LightingCollector {
  return { lights: [] };
}

export function resetCollector(collector: LightingCollector): void {
  collector.lights.length = 0;
}

/** Сколько светильников уходит в шейдер: больше — лишние не считаются. */
export const MAX_LIGHTS = 8;

const NORMAL_VERTEX = `#version 300 es
in vec2 aPos;
uniform mat3 uMatrix;
uniform vec4 uRect;
uniform vec2 uViewport;
uniform vec2 uOrigin;
out vec2 vUv;
void main() {
  vUv = aPos;
  vec2 local = uRect.xy + aPos * uRect.zw;
  vec3 device = uMatrix * vec3(local, 1.0);
  // Матрица объекта считается в пикселях всего холста, а рисуем мы только его
  // рамку: начало координат переносится в угол рамки, размер равен её размеру.
  vec2 inside = device.xy - uOrigin;
  // Y не переворачивается, хотя в кадре он растёт вниз: кадровый буфер хранит
  // строки снизу вверх, а холст и его текстура — сверху вниз. Поэтому «верх
  // объекта» попадает в первую строку буфера и читается тем же vUv, что и
  // сцена. С «1.0 -» карта ложится зеркалом по вертикали: она перестаёт
  // держаться за объект и уезжает вместе с камерой.
  gl_Position = vec4(inside.x / uViewport.x * 2.0 - 1.0, inside.y / uViewport.y * 2.0 - 1.0, 0.0, 1.0);
}`;

const NORMAL_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uMap;
uniform float uStrength;
out vec4 outColor;
void main() {
  vec3 texel = texture(uMap, vUv).rgb * 2.0 - 1.0;
  // В карте нормалей +Y смотрит вверх, а на холсте Y растёт вниз.
  vec2 xy = vec2(texel.x, -texel.y) * uStrength;
  float len = length(xy);
  if (len > 1.0) { xy /= len; len = 1.0; }
  outColor = vec4(xy * 0.5 + 0.5, len, 1.0);
}`;

const VOLUME_VERTEX = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos;
  gl_Position = vec4(aPos.x * 2.0 - 1.0, 1.0 - aPos.y * 2.0, 0.0, 1.0);
}`;

const VOLUME_FRAGMENT = `#version 300 es
precision highp float;
#define MAX_LIGHTS ${MAX_LIGHTS}
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uNormals;
uniform vec2 uCanvas;
uniform vec2 uOrigin;
uniform vec2 uSize;
uniform int uCount;
uniform vec4 uColor0[MAX_LIGHTS];
uniform vec4 uColor1[MAX_LIGHTS];
uniform vec4 uGeom[MAX_LIGHTS];
uniform vec4 uShape[MAX_LIGHTS];
out vec4 outColor;

// Знаковая площадь внутри треугольника: > 0 значит «внутри».
float triangleInside(vec2 p) {
  vec2 a = vec2(0.0, -1.0);
  vec2 b = vec2(0.866025, 0.5);
  vec2 c = vec2(-0.866025, 0.5);
  float d1 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  float d2 = (c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x);
  float d3 = (a.x - c.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x);
  return min(d1, min(d2, d3));
}

void main() {
  vec4 scene = texture(uScene, vUv);
  vec4 nrm = texture(uNormals, vUv);
  // Покрытие × сила: без карты нормалей объёма нет.
  float volume = nrm.a * nrm.b * 2.0;
  if (uCount == 0 || volume <= 0.001) { outColor = scene; return; }

  // Пиксели всего холста: vUv считается внутри рамки объекта.
  vec2 p = uOrigin + vUv * uSize;
  vec2 nxy = nrm.rg * 2.0 - 1.0;
  vec3 n = vec3(nxy, max(sqrt(max(1.0 - dot(nxy, nxy), 0.0)), 0.05));
  float accum = 0.0;

  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uCount) break;
    vec4 color0 = uColor0[i];
    vec4 color1 = uColor1[i];
    vec2 center = uGeom[i].xy;
    float radius = max(uGeom[i].z, 1.0);
    float rot = uGeom[i].w;
    float shape = uShape[i].x;
    float halfAngle = max(radians(uShape[i].y) * 0.5, 0.001);
    float soft = clamp(uShape[i].z, 0.0, 0.999);
    float polarity = uShape[i].w;

    vec2 rel = p - center;
    float c = cos(rot);
    float s = sin(rot);
    vec2 local = vec2(c * rel.x + s * rel.y, -s * rel.x + c * rel.y) / radius;

    float d;
    float cover = 1.0;
    if (shape < 0.5) {
      d = length(local);
    } else if (shape < 1.5) {
      d = max(abs(local.x), abs(local.y));
    } else if (shape < 2.5) {
      d = length(local) / 1.5;
      cover = clamp(triangleInside(local) / max(soft * 0.35, 0.001), 0.0, 1.0);
    } else if (shape < 3.5) {
      d = length(local);
      float dir = atan(local.x, -local.y);
      cover = clamp((halfAngle - abs(dir)) / max(soft * halfAngle, 0.001), 0.0, 1.0);
    } else {
      d = length(rel) / max(length(uCanvas), 1.0);
    }
    if (d > 1.0 || cover <= 0.0) continue;

    float kernel = 1.0 - soft;
    float t = clamp((d - kernel) / max(1.0 - kernel, 0.001), 0.0, 1.0);
    float a = mix(color0.a, color1.a, t) * cover;
    if (a <= 0.0005) continue;

    // Направление на свет в плоскости экрана плюс «в глаз»: наклон поверхности
    // относительно этого направления и даёт объём.
    vec2 toLight = center - p;
    float dist = length(toLight);
    vec2 flatDir = dist > 0.001 ? toLight / dist : vec2(0.0);
    vec3 lightDir = normalize(vec3(flatDir * 0.85, 1.0));
    float delta = dot(n, lightDir) - lightDir.z;
    accum += delta * a * polarity;
  }

  if (abs(accum) <= 0.0005) { outColor = scene; return; }
  // Больше единицы — не выбеливать: предел объема держим мягким.
  float scale = 1.0 + clamp(accum, -0.9, 2.0) * volume;
  outColor = vec4(clamp(scene.rgb * max(scale, 0.0), 0.0, 1.0), scene.a);
}`;

interface Programs {
  gl: WebGL2RenderingContext;
  normal: WebGLProgram;
  volume: WebGLProgram;
  quad: WebGLBuffer;
  normalFramebuffer: WebGLFramebuffer;
  normalTexture: WebGLTexture;
  /** Размер буфера нормалей: пересоздаём только при смене размера холста. */
  width: number;
  height: number;
}

let state: Programs | null = null;
let failed = false;

/** Есть ли WebGL2 и собрались ли шейдеры: решается один раз. */
export function lightingAvailable(): boolean {
  if (failed) return false;
  if (state) return true;
  return init();
}

/** Принудительный отказ: среда без WebGL2 или ошибка шейдера — не повод падать. */
function giveUp(reason: unknown): null {
  failed = true;
  state = null;
  // Один раз в консоль: в обычной работе это не сообщение, а диагностика.
  console.warn("Объём от карт нормалей выключен:", reason);
  return null;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log || "shader");
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  if (!vs || !fs) throw new Error("shader");
  const program = gl.createProgram();
  if (!program) throw new Error("program");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  // Атрибут один и всегда в нулевой точке — так проще связывать.
  gl.bindAttribLocation(program, 0, "aPos");
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(log || "link");
  }
  return program;
}

function init(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      failIfMajorPerformanceCaveat: false,
    });
    if (!gl) {
      giveUp("нет WebGL2");
      return false;
    }
    const normal = link(gl, NORMAL_VERTEX, NORMAL_FRAGMENT);
    const volume = link(gl, VOLUME_VERTEX, VOLUME_FRAGMENT);
    const quad = gl.createBuffer();
    const normalTexture = gl.createTexture();
    const normalFramebuffer = gl.createFramebuffer();
    if (!quad || !normalTexture || !normalFramebuffer) throw new Error("buffers");
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    state = { gl, normal, volume, quad, normalFramebuffer, normalTexture, width: 0, height: 0 };
    return true;
  } catch (reason) {
    giveUp(reason);
    return false;
  }
}

/** Карта нормалей: картинка или видео, уже декодированные браузером. */
interface TextureSource {
  image: HTMLImageElement | HTMLVideoElement;
  /** Видео и анимация дают новый кадр каждый раз — такую карту льём заново. */
  live: boolean;
}

const sources = new Map<string, TextureSource | null>();

function sourceOf(src: string, animate: boolean): TextureSource | null {
  const key = `${animate ? "a" : "s"}:${src}`;
  if (sources.has(key)) return sources.get(key) ?? null;
  const url = assetUrl(src);
  if (!url) return null;
  const video = animate && /\.(mp4|webm|mov|mkv|m4v)(\?|#|$)/i.test(src);
  if (video) {
    const element = document.createElement("video");
    element.src = url;
    element.muted = true;
    element.loop = true;
    element.playsInline = true;
    element.autoplay = true;
    void element.play().catch(() => undefined);
    sources.set(key, { image: element, live: true });
    return sources.get(key) ?? null;
  }
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  image.onerror = () => sources.set(key, null);
  // Анимированная картинка тоже живая: браузер обновляет её кадр сам.
  sources.set(key, { image, live: animate });
  return sources.get(key) ?? null;
}

/** Сбрасывает кеш карт: пресет сменился, файлов может не стать. */
export function clearNormalSources(): void {
  for (const entry of sources.values()) {
    if (entry && entry.image instanceof HTMLVideoElement) {
      entry.image.pause();
      entry.image.removeAttribute("src");
    }
  }
  sources.clear();
  mapTextures.clear();
}

function ready(texture: TextureSource): boolean {
  const element = texture.image;
  if (element instanceof HTMLVideoElement) return element.readyState >= 2 && element.videoWidth > 0;
  return element.complete && element.naturalWidth > 0;
}

/** Яркость цвета: светлое пятно подсвечивает, тёмное затеняет. */
function polarity(color: string): number {
  const match = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (!match) return 1;
  const [r, g, b] = match[1].split(",").map((part) => Number(part.trim()));
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (!Number.isFinite(luma)) return 1;
  return luma >= 0.5 ? 1 : -1;
}

const SHAPE_ID: Record<LightShape, number> = {
  circle: 0, rect: 1, triangle: 2, sector: 3, screen: 4,
};

function colorParts(value: string): [number, number, number, number] {
  const alpha = alphaOf(value, 1);
  const match = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
  if (!match) {
    // hex: разбираем сами, чтобы не зависеть от разметки цветов в DOM.
    const hex = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
    if (!hex) return [1, 1, 1, alpha];
    const hexColor = withAlpha(`#${hex[1].slice(0, 6)}`, alpha);
    return colorParts(hexColor);
  }
  const parts = match[1].split(",").map((part) => Number(part.trim()));
  return [
    Math.min(1, Math.max(0, (parts[0] ?? 255) / 255)),
    Math.min(1, Math.max(0, (parts[1] ?? 255) / 255)),
    Math.min(1, Math.max(0, (parts[2] ?? 255) / 255)),
    alpha,
  ];
}

function ensureSize(target: Programs, width: number, height: number): void {
  if (target.width === width && target.height === height) return;
  const { gl } = target;
  target.width = width;
  target.height = height;
  gl.bindTexture(gl.TEXTURE_2D, target.normalTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.normalFramebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.normalTexture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/** Рамка работы в пикселях холста: объём считается только внутри неё. */
export interface ShadeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Копия рамки слоя: в WebGL уходит только она, а не весь холст. */
let scratch: HTMLCanvasElement | null = null;

function scratchOf(source: HTMLCanvasElement, box: ShadeBox): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  if (!scratch) scratch = document.createElement("canvas");
  if (scratch.width !== box.width) scratch.width = box.width;
  if (scratch.height !== box.height) scratch.height = box.height;
  const ctx = scratch.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, box.width, box.height);
  ctx.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  return scratch;
}

/**
 * Объём одного объекта: его слой → текстура → WebGL2 → обратно в тот же слой.
 *
 * Объём считается **по объекту**, а не по готовой сцене. Причина в слоях:
 * общий буфер нормалей на весь холст закрашивал пиксели, которые уже заняты
 * объектами выше, и объём нижнего объекта просвечивал сквозь них. Здесь слой
 * содержит только сам объект, поэтому объём принадлежит ему: всё, что нарисуют
 * после, его перекрывает, а прозрачные пиксели ничего не подсвечивают.
 *
 * Работа ограничена рамкой объекта (`box`), поэтому цена кадра зависит от
 * размера объекта, а не от размера холста.
 *
 * Возвращает `true`, если объём посчитан. Любая неготовность (нет WebGL2, карта
 * ещё грузится, шейдер не собрался) — это `false`, и слой остаётся ровно таким,
 * каким его нарисовал Canvas 2D.
 */
export function shadeLayer(
  layer: HTMLCanvasElement,
  sample: NormalSample,
  lights: LightSample[],
  box: ShadeBox,
): boolean {
  if (!lights.length) return false;
  if (!(sample.strength > 0) || !sample.src) return false;
  if (box.width < 2 || box.height < 2) return false;
  if (!lightingAvailable() || !state) return false;
  const texture = sourceOf(sample.src, true);
  if (!texture || !ready(texture)) return false;
  const source = scratchOf(layer, box);
  if (!source) return false;
  const gl = state.gl;
  const width = box.width;
  const height = box.height;

  try {
    // Буферы держим размером холста: рамка объекта гуляет с камерой, и
    // пересоздавать текстуры на каждый её сдвиг незачем. Меняется только
    // вьюпорт — в него и пишем, из него и читаем.
    if (gl.canvas.width !== layer.width || gl.canvas.height !== layer.height) {
      gl.canvas.width = layer.width;
      gl.canvas.height = layer.height;
    }
    ensureSize(state, layer.width, layer.height);

    // 1. Карта нормалей объекта в его рамке.
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.normalFramebuffer);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.useProgram(state.normal);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(gl.getUniformLocation(state.normal, "uViewport"), width, height);
    gl.uniform2f(gl.getUniformLocation(state.normal, "uOrigin"), box.x, box.y);
    gl.uniformMatrix3fv(gl.getUniformLocation(state.normal, "uMatrix"), false, new Float32Array(sample.matrix));
    gl.uniform4f(gl.getUniformLocation(state.normal, "uRect"), sample.rect[0], sample.rect[1], sample.rect[2], sample.rect[3]);
    gl.uniform1f(gl.getUniformLocation(state.normal, "uStrength"), Math.min(2, Math.max(0, sample.strength / 100)));
    gl.uniform1i(gl.getUniformLocation(state.normal, "uMap"), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, createMapTexture(gl, `${sample.src}|${texture.live}`, texture));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 2. Слой объекта: текстура, обратно — с объёмом от светильников сцены.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(state.volume);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneTexture(gl, source));
    gl.uniform1i(gl.getUniformLocation(state.volume, "uScene"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, state.normalTexture);
    gl.uniform1i(gl.getUniformLocation(state.volume, "uNormals"), 1);
    // Размер всего холста нужен только форме «весь экран»: её радиус — диагональ.
    gl.uniform2f(gl.getUniformLocation(state.volume, "uCanvas"), layer.width, layer.height);
    gl.uniform2f(gl.getUniformLocation(state.volume, "uOrigin"), box.x, box.y);
    gl.uniform2f(gl.getUniformLocation(state.volume, "uSize"), width, height);

    const used = lights.slice(0, MAX_LIGHTS);
    const color0 = new Float32Array(MAX_LIGHTS * 4);
    const color1 = new Float32Array(MAX_LIGHTS * 4);
    const geom = new Float32Array(MAX_LIGHTS * 4);
    const shape = new Float32Array(MAX_LIGHTS * 4);
    used.forEach((light, index) => {
      const start = colorParts(light.colorStart);
      const end = colorParts(light.colorEnd);
      const level = Math.min(2, Math.max(0, light.brightness / 100));
      color0.set([start[0], start[1], start[2], start[3] * level], index * 4);
      color1.set([end[0], end[1], end[2], end[3] * level], index * 4);
      geom.set([light.x, light.y, Math.max(1, light.radius), light.rotation], index * 4);
      shape.set([
        SHAPE_ID[light.shape] ?? 0,
        light.angle,
        Math.min(1, Math.max(0, light.softness / 100)),
        polarity(light.colorStart),
      ], index * 4);
    });
    gl.uniform1i(gl.getUniformLocation(state.volume, "uCount"), used.length);
    gl.uniform4fv(gl.getUniformLocation(state.volume, "uColor0"), color0);
    gl.uniform4fv(gl.getUniformLocation(state.volume, "uColor1"), color1);
    gl.uniform4fv(gl.getUniformLocation(state.volume, "uGeom"), geom);
    gl.uniform4fv(gl.getUniformLocation(state.volume, "uShape"), shape);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 3. Обратно в слой: рамка заменяется целиком, «copy» внутри отсечения.
    const context = layer.getContext("2d");
    if (!context) return false;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.beginPath();
    context.rect(box.x, box.y, width, height);
    context.clip();
    context.globalAlpha = 1;
    context.globalCompositeOperation = "copy";
    context.drawImage(gl.canvas, 0, 0, width, height, box.x, box.y, width, height);
    context.restore();
    disposeSceneTexture(gl);
    return true;
  } catch (reason) {
    console.warn("Объём от карты нормалей пропущен:", reason);
    return false;
  }
}

function textureSettings(gl: WebGL2RenderingContext): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

/** Текстуры карт нормалей: у каждого файла своя, статичная заливается раз. */
interface MapTexture {
  texture: WebGLTexture;
  live: boolean;
  uploaded: boolean;
}

const mapTextures = new Map<string, MapTexture>();

function createMapTexture(gl: WebGL2RenderingContext, key: string, source: TextureSource): WebGLTexture {
  let entry = mapTextures.get(key);
  if (!entry) {
    const texture = gl.createTexture();
    if (!texture) throw new Error("texture");
    entry = { texture, live: source.live, uploaded: false };
    mapTextures.set(key, entry);
  }
  gl.bindTexture(gl.TEXTURE_2D, entry.texture);
  // Статичную карту заливаем один раз, живую — каждый кадр: видео и
  // анимация дают новый кадр сами.
  if (!entry.uploaded || entry.live) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source.image);
    textureSettings(gl);
    entry.uploaded = true;
  }
  return entry.texture;
}

let sceneTextureCache: WebGLTexture | null = null;

function sceneTexture(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement): WebGLTexture {
  if (!sceneTextureCache) sceneTextureCache = gl.createTexture();
  const texture = sceneTextureCache!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  textureSettings(gl);
  return texture;
}

function disposeSceneTexture(gl: WebGL2RenderingContext): void {
  gl.activeTexture(gl.TEXTURE0);
}
