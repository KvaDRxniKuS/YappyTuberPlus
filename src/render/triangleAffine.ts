import type {Vec2} from "../types";

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
