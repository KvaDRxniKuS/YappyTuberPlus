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

/** Минимум окружения: металл без него чёрный вне пятна света. */
export const MIN_AMBIENT = 0.35;

/** Экспозиция отражения: во сколько раз блик ярче самой подсветки холста. */
export const SPECULAR_EXPOSURE = 6;
/** Колено экспозиции: F0, выше которого блик не подтягивается. */
export const SPECULAR_EXPOSURE_KNEE = 0.32;

/** Размытие края отражения при шероховатости 1 — доля радиуса источника. */
export const SPECULAR_EDGE_BLUR = 1;
/** Край отражения не уже пикселя холста: сглаживание, а не размытие. */
export const SPECULAR_PIXEL_FLOOR = 1;
/** Ослабление отражения размытием: шире изображение источника, ниже пик. */
export const SPECULAR_BLUR_DIM = 1.5;
/** Пол окклюзии: ноль AO не стирает материал до чёрного. */
export const AO_FLOOR = 0.35;

export function fresnel(VdotN, F0) {
  const k = Math.pow(1 - clamp(VdotN, 0, 1), 5);
  return [F0[0] + (1 - F0[0]) * k, F0[1] + (1 - F0[1]) * k, F0[2] + (1 - F0[2]) * k];
}

/** Отражённый луч от поверхности к зрителю: `R = 2(N·V)N − V` при `V = (0,0,1)`. */
export function reflectRay(normal) {
  const VdotN = normal[2];
  return [2 * VdotN * normal[0], 2 * VdotN * normal[1], 2 * VdotN * VdotN - 1];
}

/** Точка пересечения отражённого луча с плоскостью света — в координатах источника. */
export function reflectedLocal(local, ray, cos, sin, height, span) {
  if (!(ray[2] > 1e-4)) return null;
  const travel = height / (ray[2] * Math.max(span, 1e-3));
  return [
    local[0] + (cos * ray[0] + sin * ray[1]) * travel,
    local[1] + (-sin * ray[0] + cos * ray[1]) * travel,
  ];
}

/** Ширина размытого края отражения в координатах источника. */
export function specularEdgeBlur(roughness, span) {
  const pixel = SPECULAR_PIXEL_FLOOR / Math.max(span, 1);
  return Math.max(pixel, SPECULAR_EDGE_BLUR * clamp(roughness, 0, 1));
}

/** Маска отражения: 1 внутри силуэта источника, 0 снаружи. */
export function specularMask(dRefl, blur) {
  const width = Math.max(blur, 1e-4);
  return 1 - smoothstep(1 - width, 1 + width, dRefl);
}

/** Ослабление отражения размытием. */
export function specularDim(blur) {
  return 1 / (1 + SPECULAR_BLUR_DIM * Math.max(blur, 0));
}

/** Окклюзия непрямого света с полом. */
export function occluded(ao) {
  return AO_FLOOR + (1 - AO_FLOOR) * clamp(ao, 0, 1);
}

/** Знаковая площадь внутри треугольника: больше нуля значит «внутри». */
function triangleInside(point) {
  const a = [0, -1];
  const b = [0.866025, 0.5];
  const c = [-0.866025, 0.5];
  const cross = (u, v, q) => (v[0] - u[0]) * (q[1] - u[1]) - (v[1] - u[1]) * (q[0] - u[0]);
  return Math.min(cross(a, b, point), cross(b, c, point), cross(c, a, point));
}

/**
 * Форма источника: 0 в центре фигуры, 1 на её краю; cover — мягкая стенка.
 * Одна функция на подсветку пятна и на блик — поэтому отражение наследует
 * форму света. Local уже поделен на масштаб: радиус пятна либо тело источника.
 */
export function shapeEdge(local, shape, halfAngle, soft) {
  if (shape < 0.5) return { d: Math.hypot(local[0], local[1]), cover: 1 };
  if (shape < 1.5) return { d: Math.max(Math.abs(local[0]), Math.abs(local[1])), cover: 1 };
  if (shape < 2.5) {
    return {
      d: Math.hypot(local[0], local[1]) / 1.5,
      cover: clamp(triangleInside(local) / Math.max(soft * 0.35, 0.001), 0, 1),
    };
  }
  if (shape < 3.5) {
    const dir = Math.atan2(local[0], -local[1]);
    return {
      d: Math.hypot(local[0], local[1]),
      cover: clamp((halfAngle - Math.abs(dir)) / Math.max(soft * halfAngle, 0.001), 0, 1),
    };
  }
  return { d: Math.hypot(local[0], local[1]), cover: 1 };
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function baseReflectance(albedo, metallic, f0 = 0.04) {
  const m = clamp(metallic, 0, 1);
  const base = clamp(f0, 0, 1);
  return [
    base + (albedo[0] - base) * m,
    base + (albedo[1] - base) * m,
    base + (albedo[2] - base) * m,
  ];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v) => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};

/**
 * Направление на свет для точки сцены — та же формула, что в шейдере объёма.
 *
 * `toLight` — смещение от точки до центра пятна, `height` — высота света над
 * холстом. Оба числа в одних единицах (пиксели холста), и только вместе они
 * дают наклон: если нормировать смещение отдельно, высота в сотни пикселей
 * перевесит, и свет будет светить сверху для всей сцены.
 */
export function lightDirection(toLight, height) {
  return norm([toLight[0], toLight[1], Math.max(height, 1)]);
}

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
  const F0 = baseReflectance(point.albedo, metallic, point.f0 ?? 0.04);
  // Минимум окружения: у металла диффузной части нет вовсе, и без отражения
  // он чёрный вне пятна света — ровно так «половина куба» и пропадала.
  const ambientLevel = Math.max(clamp(point.environment.level, 0, 2), MIN_AMBIENT);
  const ambient = point.environment.color.map((channel) => channel * ambientLevel);
  // Окклюзия — про непрямой свет, и у неё есть пол: ноль AO не стирает материал.
  const indirect = occluded(point.ao);
  const out = [
    (point.albedo[0] * (1 - metallic) + F0[0]) * ambient[0] * indirect + point.emissive[0],
    (point.albedo[1] * (1 - metallic) + F0[1]) * ambient[1] * indirect + point.emissive[1],
    (point.albedo[2] * (1 - metallic) + F0[2]) * ambient[2] * indirect + point.emissive[2],
  ];
  // Прямой свет окклюзия не гасит.
  const diffuseWeight = 1 - metallic;
  // Отражённый луч и Шлик зависят от нормали, а не от света.
  const ray = reflectRay(N);
  const F = fresnel(Math.max(N[2], 0), F0);
  const f0Max = Math.max(F0[0], Math.max(F0[1], F0[2]));
  const exposure = 1 + (SPECULAR_EXPOSURE - 1) * clamp(1 - f0Max / SPECULAR_EXPOSURE_KNEE, 0, 1);

  for (const light of lights) {
    // Тёмный свет — тень: сам он ничего не добавляет, блика не даёт.
    if (light.polarity <= 0) continue;
    const body = light.body;
    const cos = Math.cos(body.rotation);
    const sin = Math.sin(body.rotation);
    const NdotL = dot(N, light.L);
    if (NdotL <= 0) continue;
    const rel = [-body.toLight[0], -body.toLight[1]];
    const inSource = [
      (cos * rel[0] + sin * rel[1]) / body.span,
      (-sin * rel[0] + cos * rel[1]) / body.span,
    ];
    // Блик — отражение силуэта источника: где отражённый луч попал на плоскость
    // света, там и проверяем форму. На плоской поверхности попадание равно самой
    // точке, поэтому при шероховатости 0 отражение равно силуэту лампы.
    const hit = reflectedLocal(inSource, ray, cos, sin, body.height, body.span);
    const blur = specularEdgeBlur(roughness, body.span);
    let mask = 0;
    // Яркость света в точке попадания (см. `shadePoint` в `src/render/material.ts`).
    let alphaHit = body.core;
    if (hit) {
      const reflected = shapeEdge(hit, body.shape, body.halfAngle, body.soft);
      if (reflected.cover > 0) {
        mask = specularMask(reflected.d, blur) * specularDim(blur);
        const kernel = 1 - body.soft;
        const tHit = clamp((reflected.d - kernel) / Math.max(1 - kernel, 0.001), 0, 1);
        alphaHit = body.core + ((body.edge ?? body.core) - body.core) * tHit;
      }
    }
    const specScale = mask * exposure * point.specular * light.specular * alphaHit;
    const diffScale = NdotL * diffuseWeight;
    for (let c = 0; c < 3; c += 1) {
      out[c] += light.color[c] * diffScale * point.albedo[c] + body.tint[c] * F[c] * specScale;
    }
  }

  return out.map((value) => clamp(value, 0, 8));
}
