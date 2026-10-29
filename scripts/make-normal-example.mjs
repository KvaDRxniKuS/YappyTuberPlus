#!/usr/bin/env node
/**
 * Тестовый кубик для карт нормалей: картинка, карта и лист-дебаг.
 *
 * Зачем генератор, а не готовые файлы «на глаз»: нормаль каждой грани должна
 * быть ровно тем вектором, который даёт поворот куба. Тогда любой перекос
 * (перевёрнутый зелёный канал, сдвиг карты, неверный знак света) видно сразу,
 * а сам пример ничего не доказывает «примерно».
 *
 * Конвенция карты — OpenGL: зелёный канал смотрит **вверх** (+Y вверх), как
 * читает рендер (`src/render/lighting.ts`: `vec2 xy = vec2(texel.x, -texel.y)`).
 * Красный — вправо, синий — на зрителя. Вне кубика — прозрачный чёрный, а
 * чёрное рендер и так считает пустым местом.
 *
 * Пишет:
 *   examples/normal-cube/cube.png          — картинка кубика;
 *   examples/normal-cube/cube-normal.png   — карта нормалей к ней;
 *   examples/normal-cube/cube-debug.png    — лист 2×2: картинка, ожидаемый свет
 *                                            сверху и слева и вид DirectX-карты.
 *
 * Запуск: node scripts/make-normal-example.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { lightDirection, shadePoint } from "./material-math.mjs";

const SIZE = 512;
const SS = 3; // сглаживание краёв: 3×3 подпикселя на пиксель
const OUT = join(process.cwd(), "examples", "normal-cube");

/* ─────────────────────────── PNG ─────────────────────────── */

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** PNG без зависимостей: 8 бит на канал, RGBA. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // фильтр «нет»
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // глубина
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ─────────────────────────── холст ─────────────────────────── */

const blank = (width, height) => ({ width, height, data: new Float64Array(width * height * 4) });

/** Пиксель с обычным наложением: цвет и альфа поверх того, что уже есть. */
function over(target, x, y, [r, g, b], alpha) {
  if (x < 0 || y < 0 || x >= target.width || y >= target.height || alpha <= 0) return;
  const i = (y * target.width + x) * 4;
  const dst = target.data;
  const a = Math.min(1, dst[i + 3] + alpha * (1 - dst[i + 3]));
  if (a <= 0) return;
  for (let c = 0; c < 3; c += 1) {
    const src = c === 0 ? r : c === 1 ? g : b;
    dst[i + c] = (src * alpha + dst[i + c] * dst[i + 3] * (1 - alpha)) / a;
  }
  dst[i + 3] = a;
}

function toPixels(canvas) {
  const out = Buffer.alloc(canvas.width * canvas.height * 4);
  for (let i = 0; i < canvas.data.length; i += 4) {
    out[i] = Math.round(Math.min(1, Math.max(0, canvas.data[i])) * 255);
    out[i + 1] = Math.round(Math.min(1, Math.max(0, canvas.data[i + 1])) * 255);
    out[i + 2] = Math.round(Math.min(1, Math.max(0, canvas.data[i + 2])) * 255);
    out[i + 3] = Math.round(Math.min(1, Math.max(0, canvas.data[i + 3])) * 255);
  }
  return out;
}

/* ─────────────────────────── куб ─────────────────────────── */

const hex = (value) => [
  parseInt(value.slice(1, 3), 16) / 255,
  parseInt(value.slice(3, 5), 16) / 255,
  parseInt(value.slice(5, 7), 16) / 255,
];

/** Поворот «изометрия»: рыскание 45°, наклон, при котором видны три грани. */
function rotate([x, y, z]) {
  const yaw = Math.PI / 4;
  // Знак важен: с положительным наклоном камера смотрит снизу и видна нижняя
  // грань, а нужен вид сверху — тогда верхняя грань светится от лампы сверху.
  const pitch = -Math.atan(1 / Math.SQRT2); // ≈ 35.264° — истинная изометрия
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // Сначала рыскание вокруг вертикали, затем наклон: камера смотрит вдоль −Z.
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const y2 = y * cp + z1 * sp;
  const z2 = -y * sp + z1 * cp;
  return [x1, y2, z2];
}

const FACES = [
  { name: "+Y", normal: [0, 1, 0], corners: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]] },
  { name: "+Z", normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { name: "+X", normal: [1, 0, 0], corners: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
  { name: "-Y", normal: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { name: "-Z", normal: [0, 0, -1], corners: [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]] },
  { name: "-X", normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
];

const SCALE = 118; // экранных пикселей на единицу ребра (ребро = 2)
const CENTER = [SIZE / 2, SIZE / 2 + 6];

/** Вершина куба в пикселях картинки: x — вправо, y — вниз. */
function project([x, y, z]) {
  const [vx, vy] = rotate([x, y, z]);
  return [CENTER[0] + vx * SCALE, CENTER[1] - vy * SCALE];
}

/** Видимые грани: нормаль после поворота смотрит на зрителя (+Z). */
const visible = FACES
  .map((face) => ({ ...face, view: rotate(face.normal) }))
  .filter((face) => face.view[2] > 0.001)
  .map((face) => ({ ...face, points: face.corners.map(project) }));

function inside(points, x, y) {
  let sign = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
    if (Math.abs(cross) < 1e-9) continue;
    const next = Math.sign(cross);
    if (sign === 0) sign = next;
    else if (sign !== next) return false;
  }
  return true;
}

/** Цвет граней: одинаковый, чтобы объём делала только карта нормалей. */
const FACE_COLOR = hex("#cdd2d8");
const EDGE_COLOR = hex("#6f7883");

/* ────────────────── картинка и карта нормалей ────────────────── */

function paint(color, normalMap) {
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const cover = new Map();
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          for (const face of visible) {
            if (!inside(face.points, px, py)) continue;
            cover.set(face, (cover.get(face) ?? 0) + 1 / (SS * SS));
            break;
          }
        }
      }
      if (!cover.size) continue;
      let total = 0;
      const normal = [0, 0, 0];
      for (const [face, part] of cover) {
        total += part;
        for (let c = 0; c < 3; c += 1) normal[c] += face.view[c] * part;
      }
      // Нормали складываются по покрытию и нормируются: на срезе ребра
      // получается честная средняя нормаль, а не цвет одной из граней.
      const length = Math.hypot(normal[0], normal[1], normal[2]) || 1;
      const unit = normal.map((value) => value / length);
      over(color, x, y, FACE_COLOR, Math.min(1, total));
      // Карта нормалей: r — вправо, g — вверх (OpenGL), b — на зрителя.
      over(normalMap, x, y, [unit[0] * 0.5 + 0.5, unit[1] * 0.5 + 0.5, unit[2] * 0.5 + 0.5], Math.min(1, total));
    }
  }
}

/** Рёбра кубика: только на картинке, карта нормалей остаётся по граням. */
function paintEdges(color) {
  for (const face of visible) {
    for (let i = 0; i < face.points.length; i += 1) {
      const [x1, y1] = face.points[i];
      const [x2, y2] = face.points[(i + 1) % face.points.length];
      const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * SS);
      for (let s = 0; s <= steps; s += 1) {
        const px = x1 + ((x2 - x1) * s) / steps;
        const py = y1 + ((y2 - y1) * s) / steps;
        const radius = 1.1;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const dist = Math.hypot(dx, dy);
            if (dist > radius + 1) continue;
            const alpha = Math.min(1, Math.max(0, radius + 0.5 - dist));
            const i2 = (Math.round(py) + dy) * color.width + Math.round(px) + dx;
            if (i2 < 0 || i2 >= color.width * color.height) continue;
            if (color.data[i2 * 4 + 3] < 0.15) continue; // не мажем фон
            over(color, Math.round(px) + dx, Math.round(py) + dy, EDGE_COLOR, alpha * 0.85);
          }
        }
      }
    }
  }
}

/* ─────────────────────── ожидаемый свет ─────────────────────── */

/**
 * Тот же расчёт, что делает шейдер объёма: наклон поверхности относительно
 * направления на свет и добавка света. Нужен, чтобы на листе-дебаге было
 * видно, что должно получиться, — тогда перевёрнутый зелёный виден глазами.
 */
function lit(color, normalMap, lightFrom, flipGreen) {
  const out = blank(SIZE, SIZE);
  // Высота как «авто» в редакторе: половина радиуса пятна. Смещение до света
  // считается от каждой точки, поэтому лист показывает настоящий наклон.
  const light = { x: lightFrom[0], y: lightFrom[1], radius: 900, height: 450 };
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const i = (y * SIZE + x) * 4;
      const alpha = normalMap.data[i + 3];
      const base = [color.data[i], color.data[i + 1], color.data[i + 2]];
      out.data[i] = base[0];
      out.data[i + 1] = base[1];
      out.data[i + 2] = base[2];
      out.data[i + 3] = color.data[i + 3];
      if (alpha <= 0.01) continue;
      // Карта → вектор нормали (y вверх), затем разворот в координаты холста.
      let nx = normalMap.data[i] * 2 - 1;
      const ny = (normalMap.data[i + 1] * 2 - 1) * (flipGreen ? -1 : 1);
      const nz = normalMap.data[i + 2] * 2 - 1;
      const xy = [nx, -ny];
      let len = Math.hypot(xy[0], xy[1]);
      if (len > 1) { xy[0] /= len; xy[1] /= len; len = 1; }
      // Чёрное и прозрачное — «здесь пусто»: объёма нет (правило рендера).
      const level = Math.max(normalMap.data[i], normalMap.data[i + 1], normalMap.data[i + 2]);
      const smooth = (a, b, t) => {
        const k = Math.min(1, Math.max(0, (t - a) / (b - a)));
        return k * k * (3 - 2 * k);
      };
      const cover = smooth(0.08, 0.25, level) * smooth(0.02, 0.5, alpha);
      const volume = len * cover * 2;
      const n = [xy[0], xy[1], Math.sqrt(Math.max(1 - (xy[0] ** 2 + xy[1] ** 2), 0.05))];
      // Та же формула, что в шейдере: смещение до света и высота в пикселях.
      const l = lightDirection([light.x - x, light.y - y], light.height);
      const delta = n[0] * l[0] + n[1] * l[1] + n[2] * l[2] - l[2];
      const scale = 1 + Math.min(2, Math.max(-0.9, delta)) * volume;
      out.data[i] = Math.min(1, Math.max(0, base[0] * Math.max(0, scale)));
      out.data[i + 1] = Math.min(1, Math.max(0, base[1] * Math.max(0, scale)));
      out.data[i + 2] = Math.min(1, Math.max(0, base[2] * Math.max(0, scale)));
      void nx; void nz;
    }
  }
  return out;
}

/* ───────────────────────── подписи ───────────────────────── */

const FONT = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x1f],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  " ": [0, 0, 0, 0, 0, 0, 0],
  1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  3: [0x1e, 0x01, 0x01, 0x0e, 0x01, 0x01, 0x1e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x0e, 0x10, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
};

function text(canvas, x, y, value, scale, [r, g, b]) {
  let cursor = x;
  for (const char of value.toUpperCase()) {
    const glyph = FONT[char] ?? FONT[" "];
    for (let row = 0; row < 7; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        if (!(glyph[row] & (1 << (4 - col)))) continue;
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            over(canvas, cursor + col * scale + sx, y + row * scale + sy, [r, g, b], 1);
          }
        }
      }
    }
    cursor += 6 * scale;
  }
}

function bar(canvas, x, y, width, height, rgb, alpha) {
  for (let dy = 0; dy < height; dy += 1) {
    for (let dx = 0; dx < width; dx += 1) over(canvas, x + dx, y + dy, rgb, alpha);
  }
}

function arrow(canvas, x, y, dx, dy) {
  const steps = 46;
  for (let s = 0; s <= steps; s += 1) {
    bar(canvas, Math.round(x + (dx * s) / steps) - 1, Math.round(y + (dy * s) / steps) - 1, 3, 3, [1, 0.85, 0.3], 1);
  }
  const [hx, hy] = [x + dx, y + dy];
  // Усики стрелки растут от острия назад: иначе стрелка читается наоборот.
  const angle = Math.atan2(-dy, -dx);
  for (const side of [-0.5, 0.5]) {
    for (let s = 0; s < 22; s += 1) {
      bar(
        canvas,
        Math.round(hx + Math.cos(angle + side) * s) - 1,
        Math.round(hy + Math.sin(angle + side) * s) - 1,
        3, 3, [1, 0.85, 0.3], 1,
      );
    }
  }
}

/* ─────────────────────────── сборка ─────────────────────────── */

mkdirSync(OUT, { recursive: true });

const color = blank(SIZE, SIZE);
const normalMap = blank(SIZE, SIZE);
paint(color, normalMap);
paintEdges(color);

writeFileSync(join(OUT, "cube.png"), encodePng(SIZE, SIZE, toPixels(color)));
writeFileSync(join(OUT, "cube-normal.png"), encodePng(SIZE, SIZE, toPixels(normalMap)));

/*
 * Карты материала. У кубика поверхности ровные, поэтому каналы задаются по
 * граням: верх — глянцевый металл, левая — матовая, правая — пластик. Так на
 * одном объекте видно сразу все три поведения и легко заметить, что канал
 * читается не оттуда.
 */
function paintMaterialMaps(orm, emissive) {
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const face = visibleFaceAt(x, y);
      if (!face) continue;
      const name = face.name;
      // ORM: R — окклюзия, G — шероховатость, B — металл (glTF, Unreal, Godot).
      const spec = name === "+Y"
        ? { roughness: 0.18, metallic: 1, ao: 1 }
        : name === "+Z"
          ? { roughness: 0.75, metallic: 0, ao: 1 }
          : { roughness: 0.35, metallic: 0, ao: 0.85 };
      over(orm, x, y, [spec.ao, spec.roughness, spec.metallic], 1);
      // Свечение: только верхняя грань, слабо — чтобы правило «свечение не
      // зависит от светов» было видно в темноте.
      const glow = name === "+Y" ? 0.35 : 0;
      over(emissive, x, y, [glow, glow * 0.6, glow * 1.2 > 1 ? 1 : glow * 1.2], glow > 0 ? 1 : 0);
    }
  }
}

/** Какая грань накрывает пиксель: та же геометрия, что у картинки. */
function visibleFaceAt(x, y) {
  let best = null;
  for (const face of visible) {
    if (!inside(face.points, x + 0.5, y + 0.5)) continue;
    if (!best || face.view[2] > best.view[2]) best = face;
  }
  return best;
}

const panels = [
  { caption: "1 COLOR", image: color },
  { caption: "2 LIGHT TOP", image: lit(color, normalMap, [SIZE / 2, -1400], false) },
  { caption: "3 LIGHT LEFT", image: lit(color, normalMap, [-1400, SIZE / 2], false) },
  // Так выглядит DirectX-карта: зелёный смотрит вниз. Свет сверху путает верх и низ.
  { caption: "4 GREEN FLIPPED", image: lit(color, normalMap, [SIZE / 2, -1400], true) },
];

const GAP = 24;
const width = SIZE * 2 + GAP * 3;
const height = SIZE * 2 + GAP * 3;
const sheet = blank(width, height);
bar(sheet, 0, 0, width, height, [0.09, 0.1, 0.12], 1);

panels.forEach((panel, index) => {
  const x = GAP + (index % 2) * (SIZE + GAP);
  const y = GAP + Math.floor(index / 2) * (SIZE + GAP);
  for (let dy = 0; dy < SIZE; dy += 1) {
    for (let dx = 0; dx < SIZE; dx += 1) {
      const s = (dy * SIZE + dx) * 4;
      over(sheet, x + dx, y + dy, [panel.image.data[s], panel.image.data[s + 1], panel.image.data[s + 2]], panel.image.data[s + 3]);
    }
  }
  bar(sheet, x, y, SIZE, 26, [0.09, 0.1, 0.12], 0.82);
  text(sheet, x + 8, y + 7, panel.caption, 2, [0.92, 0.93, 0.95]);
  if (index === 1 || index === 3) arrow(sheet, x + 26, y + 74, 0, 60);
  if (index === 2) arrow(sheet, x + 26, y + 74, 60, 0);
});

writeFileSync(join(OUT, "cube-debug.png"), encodePng(width, height, toPixels(sheet)));

const orm = blank(SIZE, SIZE);
const emissive = blank(SIZE, SIZE);
paintMaterialMaps(orm, emissive);
writeFileSync(join(OUT, "cube-orm.png"), encodePng(SIZE, SIZE, toPixels(orm)));
writeFileSync(join(OUT, "cube-emissive.png"), encodePng(SIZE, SIZE, toPixels(emissive)));

/*
 * Лист материалов: один и тот же кубик под одним и тем же светом, меняется
 * только материал. Считается той же функцией, что и в редакторе, поэтому лист
 * — эталон, а не иллюстрация.
 */
/*
 * Свет над кубиком — настоящая геометрия, а не подставленное направление:
 * пятно лежит выше-правее центра, его высота равна половине радиуса (так
 * работает «авто» в редакторе). Направление на свет, наклон и блик считаются из
 * этих же чисел на каждый пиксель, поэтому лист показывает ровно тот расчёт,
 * что делает рендер, — включая блик, который переезжает по граням.
 *
 * Лист, где нормаль подставлена плоская, блик показать не может в принципе:
 * отражение точечного источника лежит под самим источником, а не в центре
 * картинки. Именно поэтому здесь читается карта нормалей.
 */
const LIGHT_AT = [SIZE / 2 + 150, SIZE / 2 - 210];
const LIGHT_RADIUS = 520;
const LIGHT_HEIGHT = LIGHT_RADIUS / 2;
const LIGHT_COLOR = [1, 0.96, 0.9];

/** Нормаль пикселя из карты — тот же пересчёт в координаты холста, что в рендере. */
function normalAt(map, x, y) {
  const i = (y * SIZE + x) * 4;
  if (map[i + 3] <= 0.01) return null;
  const nx = map[i] * 2 - 1;
  // В карте +Y смотрит вверх, на холсте Y растёт вниз — как в `lighting.ts`.
  const xy = [nx, -(map[i + 1] * 2 - 1)];
  let len = Math.hypot(xy[0], xy[1]);
  if (len > 1) {
    xy[0] /= len;
    xy[1] /= len;
    len = 1;
  }
  return [xy[0], xy[1], Math.sqrt(Math.max(1 - len * len, 0.05))];
}

/** Один свет в одной точке: то, что шейдер собирает из `uGeom` и `uShape`. */
function lightAt(toLight) {
  return {
    L: lightDirection(toLight, LIGHT_HEIGHT),
    color: LIGHT_COLOR,
    polarity: 1,
    specular: 1,
    body: {
      toLight,
      height: LIGHT_HEIGHT,
      span: LIGHT_RADIUS,
      shape: 0,
      halfAngle: (120 * Math.PI) / 180 / 2,
      soft: 0.6,
      rotation: 0,
      core: 1,
      tint: LIGHT_COLOR,
    },
  };
}

function shadeSheet(name, material) {
  const out = blank(SIZE, SIZE);
  const albedoMap = color.data;
  const ormMap = orm.data;
  const glowMap = emissive.data;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const i = (y * SIZE + x) * 4;
      const alpha = albedoMap[i + 3];
      if (alpha <= 0.01) continue;
      const normal = normalAt(normalMap.data, x, y) ?? [0, 0, 1];
      const point = {
        albedo: [albedoMap[i], albedoMap[i + 1], albedoMap[i + 2]],
        normal,
        roughness: ormMap[i] || 0.5,
        metallic: ormMap[i + 1] || 0,
        ao: ormMap[i + 2] || 1,
        // Свечение берём из карты только там, где панель про свечение:
        // иначе верхняя грань светилась бы во всех четырёх панелях.
        emissive: material.emissive ? material.emissive : [0, 0, 0],
        emissiveMap: [glowMap[i], glowMap[i + 1], glowMap[i + 2]],
        specular: 1,
        // Отражение диэлектрика: 4 % — «обычный» IOR 1.5, как у пластика.
        f0: material.f0 ?? 0.04,
        environment: { color: [0.55, 0.6, 0.7], level: 0.45 },
        ...material,
      };
      const rgb = shadePoint(point, [lightAt([LIGHT_AT[0] - x, LIGHT_AT[1] - y])], {
        normalStrength: 1, material: true,
      });
      out.data[i] = Math.min(1, rgb[0]);
      out.data[i + 1] = Math.min(1, rgb[1]);
      out.data[i + 2] = Math.min(1, rgb[2]);
      out.data[i + 3] = alpha;
      void name;
    }
  }
  return out;
}

/*
 * Лист «форма источника — форма блика». Плоская пластина смотрит ровно на
 * камеру, поэтому отражение на ней лежит строго под источником, а его контур
 * повторяет контур света: круг даёт круглое пятно, прямоугольник — квадратное,
 * треугольник — треугольное. Это и есть то, что раньше выглядело «полосой»:
 * блик был обрезан краем пятна и не имел пика под источником.
 */
const PLATE = 240;
const LIGHT_PLATE_COLOR = [0.9, 0.86, 0.78];
const PLATE_LIGHT = { x: PLATE / 2 - 46, y: PLATE / 2 - 26, span: 78, height: 260, cover: 0.85 };
// Подписи без цифр «9» и «0»: в растровом шрифте генератора их нет.
const SHAPES = [
  { caption: "CIRCLE", shape: 0 },
  { caption: "RECT", shape: 1 },
  { caption: "TRIANGLE", shape: 2 },
];

/**
 * Пластина под одним светом данной формы. Второй проход рисует контур
 * полуширины блика — там, где его яркость упала вдвое от пика: именно этот
 * контур и повторяет форму источника (его угловое тело входит в ширину
 * лепестка через `outlineRay`), а не силуэт лампы.
 */
/** Свет пластины: один и тот же во обоих проходах — и для цвета, и для поля. */
function plateLight(shape, toLight, length) {
  return {
    // Пятно света заведомо больше пластины, поэтому покрытие пятна равно
    // константе: `color` — это цвет света уже с покрытием, как и требует
    // контракт shadePoint (в шейдере за это отвечает `a`).
    L: toLight.concat(PLATE_LIGHT.height).map((value) => value / length),
    color: LIGHT_PLATE_COLOR.map((value) => value * PLATE_LIGHT.cover),
    polarity: 1,
    specular: 1,
    body: {
      toLight,
      height: PLATE_LIGHT.height,
      span: PLATE_LIGHT.span,
      shape,
      halfAngle: (120 * Math.PI) / 180 / 2,
      soft: 0.35,
      rotation: 0,
      core: 0.85,
      tint: [1, 0.96, 0.9],
    },
  };
}

function plateSheet(shape) {
  const out = blank(PLATE, PLATE);
  const platePoint = {
    albedo: [0.5, 0.5, 0.52],
    normal: [0, 0, 1],
    // Один и тот же материал на всех трёх панелях: отличается только форма
    // света — иначе сравнивать было бы нечего. Глянец выбран заведомо
    // гладким, чтобы ширина блика шла от углового тела источника.
    roughness: 0.05,
    metallic: 0,
    ao: 1,
    emissive: [0, 0, 0],
    specular: 1,
    f0: 0.04,
    environment: { color: [0, 0, 0], level: 0 },
  };
  const glintField = new Float64Array(PLATE * PLATE);
  let glintMax = 0;
  for (let y = 0; y < PLATE; y += 1) {
    for (let x = 0; x < PLATE; x += 1) {
      const inset = 18;
      const inside = x >= inset && y >= inset && x < PLATE - inset && y < PLATE - inset;
      if (!inside) continue;
      const toLight = [PLATE_LIGHT.x - x, PLATE_LIGHT.y - y];
      const length = Math.hypot(toLight[0], toLight[1], PLATE_LIGHT.height);
      const light = plateLight(shape, toLight, length);
      // «Только блик»: нулевой альбедо и без окружения — всё, что останется в
      // канале, и есть отражение источника.
      const only = shadePoint({ ...platePoint, albedo: [0, 0, 0] }, [light], { normalStrength: 1, material: true });
      const value = Math.max(only[0], only[1], only[2]);
      glintField[y * PLATE + x] = value;
      if (value > glintMax) glintMax = value;
    }
  }
  const half = glintMax * 0.5;
  for (let y = 0; y < PLATE; y += 1) {
    for (let x = 0; x < PLATE; x += 1) {
      const inset = 18;
      const inside = x >= inset && y >= inset && x < PLATE - inset && y < PLATE - inset;
      if (!inside) continue;
      const toLight = [PLATE_LIGHT.x - x, PLATE_LIGHT.y - y];
      const length = Math.hypot(toLight[0], toLight[1], PLATE_LIGHT.height);
      const light = plateLight(shape, toLight, length);
      const rgb = shadePoint(platePoint, [light], { normalStrength: 1, material: true });
      const i = (y * PLATE + x) * 4;
      // Контур полуширины: пиксель, чей блик вдвое меньше пикового, и сосед
      // вдоль X или Y уже за этой границей.
      const here = glintField[y * PLATE + x];
      const left = x > 0 ? glintField[y * PLATE + x - 1] : 0;
      const up = y > 0 ? glintField[(y - 1) * PLATE + x] : 0;
      const crossed = (here - half) * (left - half) < 0 || (here - half) * (up - half) < 0;
      const tone = crossed ? [0.95, 0.55, 0.28] : [Math.min(1, rgb[0]), Math.min(1, rgb[1]), Math.min(1, rgb[2])];
      out.data[i] = tone[0];
      out.data[i + 1] = tone[1];
      out.data[i + 2] = tone[2];
      out.data[i + 3] = 1;
    }
  }
  return out;
}

{
  const gap = 24;
  const sheetWidth = PLATE * SHAPES.length + gap * (SHAPES.length + 1);
  const sheetHeight = PLATE + gap * 2 + 26;
  const sheet = blank(sheetWidth, sheetHeight);
  bar(sheet, 0, 0, sheetWidth, sheetHeight, [0.09, 0.1, 0.12], 1);
  SHAPES.forEach((panel, index) => {
    const image = plateSheet(panel.shape);
    const x = gap + index * (PLATE + gap);
    const y = gap;
    for (let dy = 0; dy < PLATE; dy += 1) {
      for (let dx = 0; dx < PLATE; dx += 1) {
        const source = (dy * PLATE + dx) * 4;
        over(
          sheet, x + dx, y + dy,
          [image.data[source], image.data[source + 1], image.data[source + 2]],
          image.data[source + 3],
        );
      }
    }
    bar(sheet, x, y, PLATE, 26, [0.09, 0.1, 0.12], 0.82);
    text(sheet, x + 8, y + 7, panel.caption, 2, [0.92, 0.93, 0.95]);
  });
  writeFileSync(join(OUT, "specular-shapes.png"), encodePng(sheetWidth, sheetHeight, toPixels(sheet)));
}

const materials = [
  { caption: "5 MATTE", material: { roughness: 0.9, metallic: 0 } },
  { caption: "6 PLASTIC", material: { roughness: 0.3, metallic: 0 } },
  { caption: "7 METAL", material: { roughness: 0.18, metallic: 1 } },
  {
    caption: "8 NEON",
    material: { roughness: 0.5, metallic: 0, emissive: [0.1, 0.55, 0.9] },
  },
];

const sheet2 = blank(width, height);
bar(sheet2, 0, 0, width, height, [0.09, 0.1, 0.12], 1);
materials.forEach((panel, index) => {
  const x = GAP + (index % 2) * (SIZE + GAP);
  const y = GAP + Math.floor(index / 2) * (SIZE + GAP);
  const image = shadeSheet(panel.caption, panel.material);
  for (let dy = 0; dy < SIZE; dy += 1) {
    for (let dx = 0; dx < SIZE; dx += 1) {
      const s = (dy * SIZE + dx) * 4;
      over(sheet2, x + dx, y + dy, [image.data[s], image.data[s + 1], image.data[s + 2]], image.data[s + 3]);
    }
  }
  bar(sheet2, x, y, SIZE, 26, [0.09, 0.1, 0.12], 0.82);
  text(sheet2, x + 8, y + 7, panel.caption, 2, [0.92, 0.93, 0.95]);
});
writeFileSync(join(OUT, "cube-materials.png"), encodePng(width, height, toPixels(sheet2)));

const normals = visible.map((face) => `${face.name}: [${face.view.map((v) => v.toFixed(3)).join(", ")}]`);
console.log("visible faces:\n  " + normals.join("\n  "));
console.log(`written: ${OUT}`);
