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

/** Досягаемость блика в радиусах пятна: за краем света нет, а отражение есть. */
export const SPECULAR_REACH = 1.8;

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

/** Половина ширины чистого GGX по углу: θ½ = √(√2 − 1)·α = 0.64359·roughness². */
export const LOBE_HALF_RATIO = 0.64359;
/** Пол ширины блика: доля углового тела света — 15 %. */
export const SPECULAR_BODY_FLOOR = 0.15;
/** Шаг одного пикселя холста в доле блика (сглаживание, не размытие). */
export const SPECULAR_PIXEL_FLOOR = 1;

/**
 * Доля блика: 1 в зеркальном направлении, 0.5 на полуширине, дальше спад по
 * закону GGX по углу (1/θ⁴). Ограничен максимумом по построению — ни полки, ни
 * потолка. Множитель √2 − 1 ставит знаменатель в 2 ровно на полуширине.
 */
export function specLobe(angle, halfWidth) {
  const k = ((angle * angle) / Math.max(halfWidth * halfWidth, 1e-8)) * (Math.SQRT2 - 1);
  const d = 1 + k;
  return 1 / (d * d);
}

/**
 * Полуширина лепестка: шероховатость, но не уже 15 % углового тела света и не
 * уже пикселя холста. Повторяет `specLobeWidth` из материала и шейдера.
 */
export function specLobeWidth(roughness, psi, dist) {
  const alpha = Math.max(roughness * roughness, 0.002);
  return Math.max(
    LOBE_HALF_RATIO * alpha,
    Math.max(psi * SPECULAR_BODY_FLOOR, SPECULAR_PIXEL_FLOOR / dist),
  );
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

/**
 * Насколько далеко по направлению dir лежит край формы источника: угловой
 * контур света. Бисекция идёт по той же shapeEdge — блик наследует и
 * треугольник, и сектор, и поворот. Восемь шагов — это около 1 % по краю: больше не нужно, спорит с ценой пикселя.
 */
export function outlineRay(dir, shape, halfAngle, soft) {
  let low = 0.05;
  let high = 3;
  for (let step = 0; step < 8; step += 1) {
    const mid = (low + high) / 2;
    const probe = shapeEdge([dir[0] * mid, dir[1] * mid], shape, halfAngle, soft);
    if (probe.d <= 1 && probe.cover > 0) low = mid;
    else high = mid;
  }
  return low;
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
    const body = light.body;
    const cos = Math.cos(body.rotation);
    const sin = Math.sin(body.rotation);
    // Смещение точки от центра света в системе источника — ровно то же, что
    // считает шейдер (rel, local).
    const rel = [-body.toLight[0], -body.toLight[1]];
    const inSource = [
      (cos * rel[0] + sin * rel[1]) / body.span,
      (-sin * rel[0] + cos * rel[1]) / body.span,
    ];
    const patch = shapeEdge(inSource, body.shape, body.halfAngle, body.soft);
    // Блик спадает к SPECULAR_REACH, а не обрывается краем пятна. Диффузную
    // часть это не касается: покрытие пятна уже умножено в `color`.
    const specAllowed = patch.d <= SPECULAR_REACH;
    const NdotL = dot(N, light.L);
    if (NdotL <= 0) continue;
    const H = norm([light.L[0] + V[0], light.L[1] + V[1], light.L[2] + V[2]]);
    const F = fresnel(Math.max(H[2], 0), F0);
    // Угол между полувектором и нормалью = «насколько мимо блика» лежит точка:
    // 0 в центре отражения, рост к краям. Не трассировка луча: под ортографией
    // отражённый луч на грани круче 45° уходит за спину, и блика нет вовсе.
    const NdotH = clamp(dot(N, H), 0, 1);
    const angDev = Math.acos(NdotH);
    // Угловой радиус тела источника: его отражение и есть блик. Край формы
    // берётся в направлении отклонения, поэтому у прямоугольного света пятно
    // прямоугольное, у треугольного — треугольное, поворот общий.
    const dist = Math.max(Math.hypot(rel[0], rel[1], Math.max(body.height, 1)), 1);
    // Пол в 15 % тела: у очень мягкого источника тело тоньше своего края.
    const bulk = Math.max(body.span * (1 - body.soft), body.span * 0.15);
    const dev = [H[0] - N[0] * NdotH, H[1] - N[1] * NdotH];
    const devLen = Math.hypot(dev[0], dev[1]);
    const relLen = Math.hypot(rel[0], rel[1]);
    // Под центром света отклонение нулевое, направление вырождено — берём
    // направление от центра пятна, иначе бисекция контура раздувает блик.
    const tangent = devLen > 1e-4
      ? [dev[0] / devLen, dev[1] / devLen]
      : (relLen > 1e-4 ? [rel[0] / relLen, rel[1] / relLen] : [1, 0]);
    const dirH = [
      cos * tangent[0] + sin * tangent[1],
      -sin * tangent[0] + cos * tangent[1],
    ];
    // Угловой радиус края формы света в направлении отклонения: он решает,
    // какую форму имеет блик, и поворот наследует у самого источника.
    const psi = Math.atan((bulk * outlineRay(dirH, body.shape, body.halfAngle, body.soft)) / dist);
    const lobe = specLobe(angDev, specLobeWidth(roughness, psi, dist));
    // Узкий блик чуть ярче широкого: mix(1, 2, 1 − roughness) — это 2 − roughness.
    // Экспозиция гаснет там, где отражение и так яркое (металл): см. material.ts.
    const f0Max = Math.max(F0[0], Math.max(F0[1], F0[2]));
    const exposure = 1 + (SPECULAR_EXPOSURE - 1) * clamp(1 - f0Max / SPECULAR_EXPOSURE_KNEE, 0, 1);
    const amp = (2 - roughness) * exposure;
    const reach = specAllowed ? body.core * (1 - smoothstep(1, SPECULAR_REACH, patch.d)) : 0;
    const specScale = lobe * reach * amp * NdotL * point.specular * light.specular
      * Math.max(0, light.polarity);
    const diffScale = NdotL * diffuseWeight;
    for (let c = 0; c < 3; c += 1) {
      // Диффузная часть идёт через color (в нём уже лежит покрытие пятна),
      // блик — через tint и reach: отражение от пятна не зависит.
      out[c] += light.color[c] * diffScale * point.albedo[c] + body.tint[c] * F[c] * specScale;
    }
  }

  return out.map((value) => clamp(value, 0, 8));
}
