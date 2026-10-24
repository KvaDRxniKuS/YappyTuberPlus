/**
 * Generates the demo mouth sprites in the same flat style as the rest of the
 * starter rig (dark outline #2b2834, cream #f8f8f2, pink #e18291).
 *
 *   node scripts/generate-demo-sprites.mjs
 *
 * The build does not need this script: the produced PNG files are committed.
 * It exists so the art stays reproducible and easy to tweak.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const OUTLINE = [0x2b, 0x28, 0x34];
const CREAM = [0xf8, 0xf8, 0xf2];
const PINK = [0xe1, 0x82, 0x91];

const WIDTH = 140;
const HEIGHT = 70;
const SCALE = 4;

/** RGBA float canvas with supersampled coverage. */
function canvas(width, height) {
  return { width, height, data: new Float32Array(width * height * 4) };
}

function blend(target, x, y, color, alpha) {
  if (alpha <= 0) return;
  const index = (y * target.width + x) * 4;
  const a = Math.min(1, alpha);
  const dstA = target.data[index + 3];
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    const dst = target.data[index + channel];
    target.data[index + channel] = (color[channel] * a + dst * dstA * (1 - a)) / outA;
  }
  target.data[index + 3] = outA;
}

/** Fills every supersampled pixel whose center is inside `test`. */
function fill(target, test, color, clip = null) {
  for (let y = 0; y < target.height; y += 1) {
    for (let x = 0; x < target.width; x += 1) {
      const px = (x + 0.5) / SCALE;
      const py = (y + 0.5) / SCALE;
      if (!test(px, py)) continue;
      if (clip && !clip(px, py)) continue;
      blend(target, x, y, color, 1);
    }
  }
}

const roundedRect = (cx, cy, width, height, radius) => (x, y) => {
  const dx = Math.abs(x - cx) - (width / 2 - radius);
  const dy = Math.abs(y - cy) - (height / 2 - radius);
  if (dx <= 0 && dy <= 0) return true;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) <= radius;
};

const ellipse = (cx, cy, rx, ry) => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

/** Distance from a point to a quadratic Bezier curve, sampled densely. */
function bezierStroke(p0, p1, p2, thickness) {
  const samples = 160;
  const points = [];
  for (let index = 0; index <= samples; index += 1) {
    const t = index / samples;
    const mt = 1 - t;
    points.push([
      mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0],
      mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1],
    ]);
  }
  const radius = thickness / 2;
  return (x, y) => {
    for (let index = 0; index < points.length - 1; index += 1) {
      const [x1, y1] = points[index];
      const [x2, y2] = points[index + 1];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
      const nx = x1 + dx * t;
      const ny = y1 + dy * t;
      if ((x - nx) ** 2 + (y - ny) ** 2 <= radius * radius) return true;
    }
    return false;
  };
}

function downsample(source) {
  const out = Buffer.alloc(WIDTH * HEIGHT * 4);
  const factor = SCALE;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const index = ((y * factor + sy) * source.width + x * factor + sx) * 4;
          const alpha = source.data[index + 3];
          r += source.data[index] * alpha;
          g += source.data[index + 1] * alpha;
          b += source.data[index + 2] * alpha;
          a += alpha;
        }
      }
      const outIndex = (y * WIDTH + x) * 4;
      const samples = factor * factor;
      if (a > 0) {
        out[outIndex] = Math.round(r / a);
        out[outIndex + 1] = Math.round(g / a);
        out[outIndex + 2] = Math.round(b / a);
      }
      out[outIndex + 3] = Math.round((a / samples) * 255);
    }
  }
  return out;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
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

function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Closed mouth: a single soft smile line, same weight as the head outline. */
function closedMouth() {
  const surface = canvas(WIDTH * SCALE, HEIGHT * SCALE);
  const smile = bezierStroke([46, 30], [70, 48], [94, 30], 7.5);
  fill(surface, smile, OUTLINE);
  return encodePng(downsample(surface), WIDTH, HEIGHT);
}

/** Open mouth: dark cavity, cream teeth strip, pink tongue, clipped inside. */
function openMouth() {
  const surface = canvas(WIDTH * SCALE, HEIGHT * SCALE);
  const cavity = roundedRect(70, 36, 78, 52, 25);
  fill(surface, cavity, OUTLINE);
  fill(surface, roundedRect(70, 25, 50, 11, 5.5), CREAM, cavity);
  fill(surface, ellipse(70, 50, 24, 14), PINK, cavity);
  return encodePng(downsample(surface), WIDTH, HEIGHT);
}

const target = join(process.cwd(), "public", "assets", "demo");
writeFileSync(join(target, "mouth_closed.png"), closedMouth());
writeFileSync(join(target, "mouth_open.png"), openMouth());
console.log("demo sprites → public/assets/demo/mouth_closed.png, mouth_open.png");
