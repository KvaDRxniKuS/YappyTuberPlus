/**
 * Математика материала на чистом JS — для генератора примеров и его тестов.
 *
 * Это та же модель, что в `src/render/material.ts` и в шейдере прохода объёма:
 * Cook-Torrance, распределение GGX, аппроксимация Шлика. Отдельный файл нужен,
 * потому что генератор примеров запускается обычным node и не умеет читать
 * TypeScript. Расхождение ловит тест `material.spec.ts`: он считает сетку точек
 * обеими реализациями и сравнивает числа.
 */

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function ggx(NdotH, roughness) {
  const alpha = Math.max(roughness * roughness, 0.002);
  const a2 = alpha * alpha;
  const d = NdotH * NdotH * (a2 - 1) + 1;
  return a2 / (Math.PI * d * d);
}

export function fresnel(VdotH, F0) {
  const k = Math.pow(1 - clamp(VdotH, 0, 1), 5);
  return [F0[0] + (1 - F0[0]) * k, F0[1] + (1 - F0[1]) * k, F0[2] + (1 - F0[2]) * k];
}

export function baseReflectance(albedo, metallic) {
  const m = clamp(metallic, 0, 1);
  return [
    0.04 + (albedo[0] - 0.04) * m,
    0.04 + (albedo[1] - 0.04) * m,
    0.04 + (albedo[2] - 0.04) * m,
  ];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v) => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};

/** Цвет точки по материалу: то же, что `shadePoint` из `src/render/material.ts`. */
export function shadePoint(point, lights, options) {
  const flat = [
    point.normal[0] * options.normalStrength,
    point.normal[1] * options.normalStrength,
    point.normal[2] + (1 - options.normalStrength),
  ];
  const N = norm(flat);
  const V = [0, 0, 1];
  const metallic = clamp(point.metallic, 0, 1);
  // Минимум — как в шейдере (`clamp(…, 0.02, 1.0)`): «зеркало» не должно
  // считаться по-разному в кадре и на листе примера.
  const roughness = clamp(point.roughness, 0.02, 1);
  const F0 = baseReflectance(point.albedo, metallic);
  const ambientLevel = clamp(point.environment.level, 0, 2);
  const ambient = point.environment.color.map((channel) => channel * ambientLevel);
  const out = [
    (point.albedo[0] * (1 - metallic) + F0[0]) * ambient[0] * point.ao + point.emissive[0],
    (point.albedo[1] * (1 - metallic) + F0[1]) * ambient[1] * point.ao + point.emissive[1],
    (point.albedo[2] * (1 - metallic) + F0[2]) * ambient[2] * point.ao + point.emissive[2],
  ];
  const diffuseWeight = (1 - metallic) * point.ao;
  for (const light of lights) {
    // Тёмный свет — это тень: в материале он гасит диффузную часть (это делает
    // шейдер), а сам ничего не добавляет.
    if (light.polarity <= 0) continue;
    const NdotL = dot(N, light.L);
    if (NdotL <= 0) continue;
    const H = norm([light.L[0] + V[0], light.L[1] + V[1], light.L[2] + V[2]]);
    const NdotH = Math.max(dot(N, H), 1e-4);
    const VdotH = Math.max(dot(V, H), 0);
    const D = ggx(NdotH, roughness);
    const F = fresnel(VdotH, F0);
    const denom = 4 * Math.max(NdotL, 1e-4) * Math.max(N[2], 1e-4);
    const specScale = (D / denom) * point.specular * Math.max(0, light.polarity);
    const diffScale = NdotL * diffuseWeight;
    for (let c = 0; c < 3; c += 1) {
      out[c] += light.color[c] * (specScale * F[c] + diffScale * point.albedo[c]);
    }
  }
  return out.map((value) => clamp(value, 0, 8));
}
