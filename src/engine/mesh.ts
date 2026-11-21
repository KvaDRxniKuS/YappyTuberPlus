import type {
  ArtMesh, BrushSpec, GridSpec, MeshSpec, MirrorSpec, ObjectFrame, RigObject, Vec2, WarpCorner,
  WarpSpec,
} from "../types";
import { WARP_CORNERS, defaultWarp } from "../render/warp";

/*
 * Артмеш и деформер.
 *
 * Артмеш отвечает на вопрос «как нарезана картинка»: точки и треугольники, по
 * которым она ложится на сцену. Деформер отвечает на вопрос «что стало с этой
 * нарезкой»: регулярная сетка `cols × rows`, узлы которой двигают инструментом
 * и позами состояний. Это две разные вещи, и путать их нельзя: ключ состояния
 * двигает деформер и не зависит от плотности артмеша (§6.1 плана).
 *
 * Всё считается в **долях зоны**: и точки артмеша, и узлы сетки. Поэтому смена
 * размера объекта и перемещение зоны ничего не ломают, а текстурная координата
 * точки артмеша — это просто её собственное положение, UV отдельно не нужны.
 *
 * Модуль чистый: ни DOM, ни ядра. Рендер и редактор берут отсюда геометрию,
 * поэтому всё, что здесь есть, проверяется тестами без браузера.
 */

/** Пределы сетки: 2×2 — это сегодняшняя деформация крайних точек. */
export const MESH_MIN = 2;
export const MESH_MAX = 32;

/**
 * Шкала густоты сетки.
 *
 * Нелинейная намеренно: линейный ползунок 2…32 отдал бы половину хода на
 * 17…32, которые нужны раз в жизни, а 3×3 и 4×4 — постоянно.
 */
export const GRID_STEPS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32] as const;

/** Кисть по умолчанию: выключена, радиус — четверть зоны, край мягкий. */
export const BRUSH_DEFAULT: BrushSpec = { on: false, radius: 0.25, hardness: 0.5 };

/** Ось симметрии по умолчанию: вертикальная через центр зоны, выключена. */
export const MIRROR_DEFAULT: MirrorSpec = { on: false, x: 0.5, y: 0.5, angle: 90 };

/** Округление до тысячных: доли зоны, больше знаков в пресете не нужно. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Размер сетки: целое, 2…32. Битое число и мусор дают `fallback`. */
export function clampGrid(value: unknown, fallback = MESH_MIN): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MESH_MAX, Math.max(MESH_MIN, Math.round(parsed)));
}

/**
 * Индекс узла: слева-вправо, сверху-вниз.
 *
 * `cols` и `rows` — число **узлов** по стороне, а не ячеек: сетка 2×2 — это
 * четыре угла и одна ячейка, ровно сегодняшняя деформация крайних точек.
 */
export function gridIndex(cols: number, i: number, j: number): number {
  return j * cols + i;
}

/** Узел по индексу: обратная операция к `gridIndex`. */
export function gridCellOf(cols: number, index: number): { i: number; j: number } {
  return { i: index % cols, j: Math.floor(index / cols) };
}

/** Четыре крайних узла сетки в порядке углов: `tl`, `tr`, `br`, `bl`. */
export function gridCorners(grid: GridSpec): number[] {
  const bottom = (grid.rows - 1) * grid.cols;
  return [0, grid.cols - 1, bottom + grid.cols - 1, bottom];
}

/** Равномерные точки прямоугольника в долях зоны: `cols` × `rows` узлов. */
export function regularPoints(
  cols: number, rows: number, left = 0, top = 0, width = 1, height = 1,
): Vec2[] {
  const points: Vec2[] = [];
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      points.push({
        x: round(left + (width * i) / (cols - 1)),
        y: round(top + (height * j) / (rows - 1)),
      });
    }
  }
  return points;
}

/** Регулярная сетка: узлы стоят на равных долях. */
export function regularGrid(cols = MESH_MIN, rows = MESH_MIN): GridSpec {
  const c = clampGrid(cols);
  const r = clampGrid(rows);
  return { cols: c, rows: r, points: regularPoints(c, r) };
}

/**
 * Треугольники регулярной сетки: по два на ячейку, обход одинаковый.
 *
 * Диагональ идёт из левого верхнего угла ячейки в правый нижний — так же, как
 * режется сегодняшняя деформация крайних точек, поэтому 2×2 мигрирует без
 * единого пикселя разницы.
 */
export function gridTriangles(cols: number, rows: number): number[] {
  const triangles: number[] = [];
  for (let j = 0; j < rows - 1; j += 1) {
    for (let i = 0; i < cols - 1; i += 1) {
      const tl = gridIndex(cols, i, j);
      const tr = gridIndex(cols, i + 1, j);
      const br = gridIndex(cols, i + 1, j + 1);
      const bl = gridIndex(cols, i, j + 1);
      triangles.push(tl, tr, br, tl, br, bl);
    }
  }
  return triangles;
}

/** Артмеш, сгенерированный сеткой: пока его не правили руками, он регулярный. */
export function artFromGrid(cols = MESH_MIN, rows = MESH_MIN): ArtMesh {
  const c = clampGrid(cols);
  const r = clampGrid(rows);
  return {
    points: regularPoints(c, r),
    triangles: gridTriangles(c, r),
    auto: { cols: c, rows: r },
  };
}

/** Пустая деформация: зона — вся картинка, нарезка и сетка регулярные. */
export function defaultMesh(): MeshSpec {
  return {
    enabled: false,
    frame: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
    art: artFromGrid(2, 2),
    deform: regularGrid(2, 2),
  };
}

/**
 * Миграция старой деформации крайних точек в сетку.
 *
 * Старый `warp` — это ровно артмеш 2×2 по углам зоны и деформер 2×2, где узлы
 * сдвинуты на те же проценты. Поэтому миграция — не «похожая картинка», а
 * побитово та же геометрия: четыре угла, две диагонали, те же смещения.
 * Параметры `warpTLx…warpBLy` продолжают двигать эти четыре узла.
 */
export function migrateWarp(warp: WarpSpec): MeshSpec {
  const frame = {
    x: numberOr(warp.frame?.x, 0),
    y: numberOr(warp.frame?.y, 0),
    width: Math.max(0.001, numberOr(warp.frame?.width, 1)),
    height: Math.max(0.001, numberOr(warp.frame?.height, 1)),
    rotation: numberOr(warp.frame?.rotation, 0),
  };
  const art = artFromGrid(2, 2);
  // Узлы идут построчно (слева-вправо, сверху-вниз), а углы — по обходу
  // `tl, tr, br, bl`: у сетки 2×2 это индексы 0, 1, 3, 2.
  const corners = [0, 1, 3, 2];
  const points = art.points.map((point, index) => {
    const position = corners.indexOf(index);
    const corner = position >= 0 ? warp.corners?.[WARP_CORNERS[position]] : undefined;
    return {
      x: round(point.x + numberOr(corner?.x, 0) / 100),
      y: round(point.y + numberOr(corner?.y, 0) / 100),
    };
  });
  return { enabled: warp.enabled === true, frame, art, deform: { cols: 2, rows: 2, points } };
}

/** Число из мусора: конечное — как есть, иначе запасное. */
function numberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Точка в допустимых пределах: сетку можно увести за зону, но не в бесконечность. */
function normalizePoint(raw: unknown): Vec2 | null {
  if (!raw || typeof raw !== "object") return null;
  const point = raw as Partial<Vec2>;
  const x = numberOr(point.x, Number.NaN);
  const y = numberOr(point.y, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: round(Math.min(4, Math.max(-3, x))), y: round(Math.min(4, Math.max(-3, y))) };
}

/** Артмеш из пресета: мусор отбрасывается, битые треугольники не ломают сцену. */
export function normalizeArt(raw: unknown): ArtMesh | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Partial<ArtMesh>;
  if (!Array.isArray(source.points)) return undefined;
  const points: Vec2[] = [];
  for (const item of source.points) {
    const point = normalizePoint(item);
    if (!point) return undefined;
    points.push(point);
  }
  if (points.length < 3 && source.auto !== null) return undefined;
  const triangles: number[] = [];
  const seen = new Set<string>();
  const input = Array.isArray(source.triangles) ? source.triangles : [];
  for (let index = 0; index + 2 < input.length; index += 3) {
    const a = Math.round(numberOr(input[index], -1));
    const b = Math.round(numberOr(input[index + 1], -1));
    const c = Math.round(numberOr(input[index + 2], -1));
    const inside = [a, b, c].every((value) => value >= 0 && value < points.length);
    if (!inside) continue;
    if (a === b || b === c || a === c) continue;
    const key = [a, b, c].sort((left, right) => left - right).join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    if (Math.abs(triangleArea(points[a], points[b], points[c])) < 1e-6) continue;
    triangles.push(a, b, c);
  }
  if (!triangles.length && (!Array.isArray(source.triangles) || source.triangles.length > 0)) return undefined;
  const auto = source.auto && typeof source.auto === "object"
    ? { cols: clampGrid(source.auto.cols), rows: clampGrid(source.auto.rows) }
    : null;
  const outline: number[] = [];
  if (Array.isArray(source.outline)) {
    for (const item of source.outline) {
      const index = Math.round(numberOr(item, -1));
      if (index >= 0 && index < points.length) outline.push(index);
    }
  }
  // Ручные линии: только существующие пары, без повторов и петель.
  const manual: Array<[number, number]> = [];
  const manualKeys = new Set<string>();
  if (Array.isArray(source.manual)) {
    for (const item of source.manual) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const from = Math.round(numberOr(item[0], -1));
      const to = Math.round(numberOr(item[1], -1));
      if (from < 0 || to < 0 || from >= points.length || to >= points.length || from === to) continue;
      const key = edgeKey(from, to);
      if (manualKeys.has(key)) continue;
      manualKeys.add(key);
      manual.push([from, to]);
    }
  }
  return {
    points,
    triangles,
    ...(manual.length ? { manual } : {}),
    ...(outline.length >= 3 ? { outline } : {}),
    auto,
  };
}

/**
 * Сетка из пресета. Если точек не то количество, что обещает `cols × rows`,
 * сетка пересобирается регулярной: иначе редактор и рендер разойдутся в
 * индексах, и «поехала одна точка» превратится в кашу.
 */
/** Кисть из пресета: выключена, если её нет. Радиус и жёсткость — в разумных пределах. */
export function normalizeBrush(raw: unknown): BrushSpec {
  if (!raw || typeof raw !== "object") return { ...BRUSH_DEFAULT };
  const source = raw as Partial<BrushSpec>;
  return {
    on: source.on === true,
    radius: Math.min(2, Math.max(0.02, numberOr(source.radius, BRUSH_DEFAULT.radius))),
    hardness: Math.min(1, Math.max(0, numberOr(source.hardness, BRUSH_DEFAULT.hardness))),
  };
}

/** Ось симметрии из пресета: точка в долях зоны, угол в градусах. */
export function normalizeMirror(raw: unknown): MirrorSpec {
  if (!raw || typeof raw !== "object") return { ...MIRROR_DEFAULT };
  const source = raw as Partial<MirrorSpec>;
  const angle = numberOr(source.angle, MIRROR_DEFAULT.angle);
  return {
    on: source.on === true,
    x: numberOr(source.x, MIRROR_DEFAULT.x),
    y: numberOr(source.y, MIRROR_DEFAULT.y),
    // Угол держим в −180…180: ось — это прямая, лишние обороты не нужны.
    angle: ((angle % 360) + 540) % 360 - 180,
  };
}

export function normalizeGrid(raw: unknown): GridSpec | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Partial<GridSpec>;
  const cols = clampGrid(source.cols);
  const rows = clampGrid(source.rows);
  const expected = cols * rows;
  if (!Array.isArray(source.points) || source.points.length !== expected) return regularGrid(cols, rows);
  const points: Vec2[] = [];
  for (const item of source.points) {
    const point = normalizePoint(item);
    if (!point) return regularGrid(cols, rows);
    points.push(point);
  }
  return { cols, rows, points };
}

/** Деформация из пресета: галочка, зона, нарезка и сетка. */
export function normalizeMesh(raw: unknown): MeshSpec | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Partial<MeshSpec>;
  const base = defaultMesh();
  const frame = source.frame && typeof source.frame === "object" ? source.frame : base.frame;
  const mesh: MeshSpec = {
    enabled: source.enabled === true,
    frame: {
      x: numberOr(frame.x, base.frame.x),
      y: numberOr(frame.y, base.frame.y),
      width: Math.max(0.001, numberOr(frame.width, base.frame.width)),
      height: Math.max(0.001, numberOr(frame.height, base.frame.height)),
      rotation: numberOr(frame.rotation, base.frame.rotation),
    },
    art: normalizeArt(source.art) ?? base.art,
    deform: normalizeGrid(source.deform) ?? base.deform,
    brush: normalizeBrush(source.brush),
    mirror: normalizeMirror(source.mirror),
  };
  return mesh;
}

/**
 * Деформация объекта: новая сетка, а у старого пресета — миграция `warp`.
 *
 * Миграция не пишется в объект сама: пресет остаётся прежним, пока его не
 * тронули. Так старый файл можно открыть, посмотреть и закрыть, ничего не
 * изменив.
 */
export function meshOf(object: RigObject): MeshSpec | undefined {
  if (object.mesh) return normalizeMesh(object.mesh);
  if (object.warp) return migrateWarp(object.warp);
  return undefined;
}

/** Включена ли деформация сеткой. */
export function meshEnabled(object: RigObject): boolean {
  const mesh = meshOf(object);
  return mesh?.enabled === true;
}

/** Значение сетки в параметрической точке `u`, `v` (0…1) — билинейно по ячейке. */
export function sampleGrid(grid: GridSpec, u: number, v: number): Vec2 {
  const cu = Math.min(grid.cols - 1, Math.max(0, u * (grid.cols - 1)));
  const cv = Math.min(grid.rows - 1, Math.max(0, v * (grid.rows - 1)));
  const i = Math.min(grid.cols - 2, Math.floor(cu));
  const j = Math.min(grid.rows - 2, Math.floor(cv));
  const fu = cu - i;
  const fv = cv - j;
  const p00 = grid.points[gridIndex(grid.cols, i, j)];
  const p10 = grid.points[gridIndex(grid.cols, i + 1, j)];
  const p01 = grid.points[gridIndex(grid.cols, i, j + 1)];
  const p11 = grid.points[gridIndex(grid.cols, i + 1, j + 1)];
  if (!p00 || !p10 || !p01 || !p11) return { x: u, y: v };
  const top = { x: p00.x + (p10.x - p00.x) * fu, y: p00.y + (p10.y - p00.y) * fu };
  const bottom = { x: p01.x + (p11.x - p01.x) * fu, y: p01.y + (p11.y - p01.y) * fu };
  return {
    x: round(top.x + (bottom.x - top.x) * fv),
    y: round(top.y + (bottom.y - top.y) * fv),
  };
}

/**
 * Смена густоты сетки без потери формы.
 *
 * Каждый новый узел берётся из старой сетки в своей параметрической точке:
 * «что здесь было» остаётся здесь, просто подробнее. Поэтому 2×2 → 4×4 не
 * сбрасывает форму, а 4×4 → 2×2 её огрубляет, но не теряет.
 */
export function resizeGrid(grid: GridSpec, cols: number, rows: number): GridSpec {
  const c = clampGrid(cols);
  const r = clampGrid(rows);
  if (c === grid.cols && r === grid.rows) return grid;
  const points: Vec2[] = [];
  for (let j = 0; j < r; j += 1) {
    for (let i = 0; i < c; i += 1) {
      points.push(sampleGrid(grid, i / (c - 1), j / (r - 1)));
    }
  }
  return { cols: c, rows: r, points };
}

/** Сдвиг одного узла сетки в долях зоны. */
export function shiftNode(grid: GridSpec, index: number, dx: number, dy: number): GridSpec {
  if (index < 0 || index >= grid.points.length) return grid;
  const points = grid.points.map((point, position) => (position === index
    ? { x: round(point.x + dx), y: round(point.y + dy) }
    : point));
  return { ...grid, points };
}

/** Смещения узлов из позы ключа: индекс узла → дельта в долях зоны. */
export function applyOffsets(grid: GridSpec, offsets?: Record<string, Vec2> | null): GridSpec {
  if (!offsets) return grid;
  const points = grid.points.map((point, index) => {
    const offset = offsets[String(index)];
    if (!offset) return point;
    return { x: round(point.x + offset.x), y: round(point.y + offset.y) };
  });
  return { ...grid, points };
}

/* ── Кисть, сглаживание и симметрия ───────────────────────────────────────
 *
 * Всё это правки **авторской** сетки: они не знают ни о состояниях, ни о
 * нарезке. Точки — доли зоны, поэтому кисть получает расстояния в пикселях
 * картинки: радиус должен быть круглым на экране, а не в UV.
 */

/** Ось симметрии как прямая: точка и единичное направление в долях зоны. */
function axisLine(axis: MirrorSpec): { x: number; y: number; ux: number; uy: number } {
  const radians = (axis.angle * Math.PI) / 180;
  return { x: axis.x, y: axis.y, ux: Math.cos(radians), uy: Math.sin(radians) };
}

/** Отражение точки относительно оси симметрии (в долях зоны). */
export function mirrorAcross(point: Vec2, axis: MirrorSpec): Vec2 {
  const { x, y, ux, uy } = axisLine(axis);
  const dx = point.x - x;
  const dy = point.y - y;
  const dot = dx * ux + dy * uy;
  return { x: round(x + 2 * dot * ux - dx), y: round(y + 2 * dot * uy - dy) };
}

/** Проекция точки на ось: так узел, лежащий на оси, остаётся на ней. */
function ontoAxis(point: Vec2, axis: MirrorSpec): Vec2 {
  const { x, y, ux, uy } = axisLine(axis);
  const dot = (point.x - x) * ux + (point.y - y) * uy;
  return { x: round(x + dot * ux), y: round(y + dot * uy) };
}

/** Шаг сетки в долях зоны — по нему меряется «соседний узел». */
function gridStep(grid: GridSpec): number {
  return Math.min(1 / Math.max(1, grid.cols - 1), 1 / Math.max(1, grid.rows - 1));
}

/** Ближайший узел к точке в пределах допуска: пара для симметрии. */
function nearestNode(grid: GridSpec, point: Vec2, tolerance: number): number | null {
  let best: number | null = null;
  let distance = tolerance;
  grid.points.forEach((candidate, index) => {
    const length = Math.hypot(candidate.x - point.x, candidate.y - point.y);
    if (length <= distance) {
      distance = length;
      best = index;
    }
  });
  return best;
}

/**
 * Ось совпадает с осями сетки: вертикальная меняет столбцы, горизонтальная — строки.
 *
 * Для таких осей пара узлов известна по индексу (`j·cols + i`), и это надёжнее
 * поиска по положению: у правленой сетки сосед может оказаться ближе «своего»
 * отражения, и пара разъехалась бы.
 */
function alignedAxis(axis: MirrorSpec): "vertical" | "horizontal" | null {
  const radians = (axis.angle * Math.PI) / 180;
  if (Math.abs(Math.cos(radians)) < 1e-6) return "vertical";
  if (Math.abs(Math.sin(radians)) < 1e-6) return "horizontal";
  return null;
}

/** Узел-отражение: где та же точка на другой стороне оси. */
export function mirrorNode(grid: GridSpec, index: number, axis: MirrorSpec): number | null {
  const point = grid.points[index];
  if (!point) return null;
  const aligned = alignedAxis(axis);
  if (aligned) {
    const i = index % grid.cols;
    const j = Math.floor(index / grid.cols);
    const mate = aligned === "vertical"
      ? j * grid.cols + (grid.cols - 1 - i)
      : (grid.rows - 1 - j) * grid.cols + i;
    return mate === index ? null : mate;
  }
  const mate = nearestNode(grid, mirrorAcross(point, axis), gridStep(grid) * 0.75);
  return mate === index ? null : mate;
}

/**
 * Сдвиг узла вместе с его отражением: так работает симметрия при перетаскивании.
 *
 * Отражение получает **отражённый** сдвиг, иначе пара разъехалась бы: у
 * вертикальной оси `dx` меняет знак, у горизонтальной — `dy`.
 */
export function moveNodeMirrored(
  grid: GridSpec,
  index: number,
  dx: number,
  dy: number,
  axis: MirrorSpec,
): GridSpec {
  const mate = mirrorNode(grid, index, axis);
  // Отражённый вектор — это отражение конца сдвинутого отрезка, а не самого
  // вектора: у косой оси разница видна.
  const point = grid.points[index];
  let mirrored = grid;
  if (mate !== null && point) {
    const movedPoint = { x: point.x + dx, y: point.y + dy };
    const matePoint = grid.points[mate];
    if (matePoint) {
      const target = mirrorAcross(movedPoint, axis);
      mirrored = shiftNode(grid, mate, target.x - matePoint.x, target.y - matePoint.y);
    }
  }
  return shiftNode(mirrored, index, dx, dy);
}

/**
 * Симметризация сетки: пары узлов встают зеркально, узлы на оси — на ось.
 *
 * Форма при этом меняется наполовину хода каждой пары — это и есть «сделать
 * симметрично», а не «отразить одну сторону на другую».
 */
export function symmetrizeGrid(grid: GridSpec, axis: MirrorSpec): GridSpec {
  const points = grid.points.map((point) => ({ ...point }));
  const done = new Set<number>();
  const tolerance = gridStep(grid) * 0.75;
  grid.points.forEach((point, index) => {
    if (done.has(index)) return;
    done.add(index);
    const mate = mirrorNode(grid, index, axis);
    if (mate === null) {
      // Пары нет: если узел стоит на оси (с точностью до шага) — ставим ровно
      // на неё, иначе оставляем как есть.
      if (Math.hypot(mirrorAcross(point, axis).x - point.x, mirrorAcross(point, axis).y - point.y) <= tolerance) {
        points[index] = ontoAxis(point, axis);
      }
      return;
    }
    done.add(mate);
    // Середина пары — половина хода каждой стороны: сетка становится
    // симметричной, но форма не «переезжает» целиком на одну сторону.
    const other = grid.points[mate];
    if (!other) return;
    const mirrored = mirrorAcross(other, axis);
    const middle = { x: round((point.x + mirrored.x) / 2), y: round((point.y + mirrored.y) / 2) };
    points[index] = middle;
    points[mate] = mirrorAcross(middle, axis);
  });
  return { ...grid, points };
}

/**
 * Веса кисти по узлам: 1 в центре, 0 на краю, между ними — плавное затухание.
 *
 * `hardness` — доля радиуса, где вес ещё единица. Косинус выбран за нулевую
 * производную на краю: сетка не получает ступеньки там, где мазок кончается.
 */
export function brushWeights(points: readonly Vec2[], center: Vec2, radius: number, hardness: number): number[] {
  const inner = Math.max(0, Math.min(1, hardness)) * radius;
  return points.map((point) => {
    const distance = Math.hypot(point.x - center.x, point.y - center.y);
    if (distance >= radius) return 0;
    if (distance <= inner) return 1;
    const t = (distance - inner) / Math.max(1e-6, radius - inner);
    return 0.5 + 0.5 * Math.cos(Math.PI * t);
  });
}

/** Мазок: узлы едут на `delta`, умноженную на свой вес. Один проход по сетке. */
export function brushGrid(grid: GridSpec, weights: readonly number[], dx: number, dy: number): GridSpec {
  if (!dx && !dy) return grid;
  const points = grid.points.map((point, index) => {
    const weight = weights[index] ?? 0;
    if (weight <= 0) return point;
    return { x: round(point.x + dx * weight), y: round(point.y + dy * weight) };
  });
  return { ...grid, points };
}

/**
 * Сглаживание сетки: каждый внутренний узел тянется к середине соседей.
 *
 * Крайние узлы не двигаются — иначе сетка «сжималась» бы с каждым нажатием.
 * `strength` — доля хода к середине: 1 — сразу среднее, 0.35 — мягко.
 */
export function smoothGrid(grid: GridSpec, strength = 0.35): GridSpec {
  const { cols, rows } = grid;
  if (cols < 3 && rows < 3) return grid;
  const points = grid.points.map((point, index) => {
    const i = index % cols;
    const j = Math.floor(index / cols);
    if (i === 0 || j === 0 || i === cols - 1 || j === rows - 1) return point;
    const neighbours = [
      grid.points[gridIndex(cols, i - 1, j)],
      grid.points[gridIndex(cols, i + 1, j)],
      grid.points[gridIndex(cols, i, j - 1)],
      grid.points[gridIndex(cols, i, j + 1)],
    ].filter(Boolean) as Vec2[];
    if (!neighbours.length) return point;
    const middle = neighbours.reduce(
      (sum, item) => ({ x: sum.x + item.x / neighbours.length, y: sum.y + item.y / neighbours.length }),
      { x: 0, y: 0 },
    );
    return {
      x: round(point.x + (middle.x - point.x) * Math.max(0, Math.min(1, strength))),
      y: round(point.y + (middle.y - point.y) * Math.max(0, Math.min(1, strength))),
    };
  });
  return { ...grid, points };
}

/** Сетка снова регулярная: форма сбрасывается, густота остаётся. */
export function resetGrid(grid: GridSpec): GridSpec {
  return regularGrid(grid.cols, grid.rows);
}

/** Нарезка снова регулярная: густота автосетки сохраняется. */
export function resetArt(art: ArtMesh): ArtMesh {
  return artFromGrid(art.auto?.cols ?? MESH_MIN, art.auto?.rows ?? MESH_MIN);
}

/** Сдвинута ли сетка относительно регулярной. */
export function gridMoved(grid: GridSpec): boolean {
  const regular = regularGrid(grid.cols, grid.rows);
  return grid.points.some((point, index) => {
    const other = regular.points[index];
    return Math.abs(point.x - other.x) > 1e-6 || Math.abs(point.y - other.y) > 1e-6;
  });
}

/** Сдвинута ли картинка: сетка не регулярна или нарезка не 2×2. */
export function meshMoved(mesh: MeshSpec): boolean {
  return gridMoved(mesh.deform);
}

/**
 * Параметры `warpTLx…warpBLy` как смещения четырёх крайних узлов сетки.
 *
 * Старые параметры остаются в силе: они двигают те же углы, что и раньше, и в
 * тех же процентах зоны. Возвращаются смещения по индексам узлов — ровно в том
 * виде, в каком их принимает `applyOffsets`.
 */
export function paramOffsets(mesh: MeshSpec, values?: ObjectFrame | null): Record<string, Vec2> | undefined {
  if (!values) return undefined;
  const corners = gridCorners(mesh.deform);
  const result: Record<string, Vec2> = {};
  let touched = false;
  WARP_CORNERS.forEach((corner: WarpCorner, index) => {
    const px = values[`warp${corner.toUpperCase()}x` as keyof ObjectFrame];
    const py = values[`warp${corner.toUpperCase()}y` as keyof ObjectFrame];
    const dx = Number.isFinite(px as number) ? (px as number) / 100 : 0;
    const dy = Number.isFinite(py as number) ? (py as number) / 100 : 0;
    if (dx === 0 && dy === 0) return;
    result[String(corners[index])] = { x: round(dx), y: round(dy) };
    touched = true;
  });
  return touched ? result : undefined;
}

/** Вершины для рендера: где точка нарезки сидит в текстуре и куда она уехала. */
export interface MeshVertices {
  /** Положение точки в долях зоны: оно же текстурная координата внутри зоны. */
  params: Vec2[];
  /** Куда эта точка уехала после деформера (доли зоны). */
  targets: Vec2[];
  triangles: number[];
}

/** Вершины сетки: нарезка, прогнанная через деформер (и смещения ключа). */
export function meshVertices(mesh: MeshSpec, offsets?: Record<string, Vec2> | null): MeshVertices {
  const grid = applyOffsets(mesh.deform, offsets);
  return {
    params: mesh.art.points,
    targets: mesh.art.points.map((point) => sampleGrid(grid, point.x, point.y)),
    triangles: mesh.art.triangles,
  };
}

/**
 * Покрывает ли нарезка ровно зону: тогда рендер дорисовывает картинку вокруг
 * зоны обычным путём, как делала старая деформация крайних точек.
 */
export function meshIsZoneQuad(mesh: MeshSpec): boolean {
  const { art } = mesh;
  if (art.points.length !== 4 || art.triangles.length !== 6) return false;
  const expected = regularPoints(2, 2);
  return art.points.every((point, index) => Math.abs(point.x - expected[index].x) < 1e-6
    && Math.abs(point.y - expected[index].y) < 1e-6);
}

/* ── Артмеш: ручная триангуляция ──────────────────────────────────────────
 *
 * Редактор артмеша правит треугольники руками: разрезать ребро, перевернуть
 * диагональ, добавить и удалить треугольник. Все операции возвращают новый
 * артмеш или `null`, если правка невозможна, — редактору не нужно проверять
 * геометрию второй раз.
 */

/** Ключ ребра: порядок концов не важен. */
export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Рёбра артмеша: ключ ребра → треугольники, которые на нём стоят. */
export function edgeMap(art: ArtMesh): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (let index = 0; index < art.triangles.length; index += 3) {
    const triangle = index / 3;
    const [a, b, c] = [art.triangles[index], art.triangles[index + 1], art.triangles[index + 2]];
    for (const [first, second] of [[a, b], [b, c], [c, a]]) {
      const key = edgeKey(first, second);
      const list = map.get(key);
      if (list) list.push(triangle);
      else map.set(key, [triangle]);
    }
  }
  return map;
}

/** Следующий по обходу треугольника индекс: для сохранения направления. */
function nextInTriangle(triangle: number[], value: number): number {
  const position = triangle.indexOf(value);
  return triangle[(position + 1) % 3];
}

/**
 * Разрезать ребро: в его середину встаёт новая точка, треугольники по обе
 * стороны ребра делятся на два. Направление обхода сохраняется, иначе площадь
 * ставшего треугольника поменяла бы знак.
 */
export function splitEdge(art: ArtMesh, a: number, b: number): ArtMesh | null {
  if (a === b || a < 0 || b < 0 || a >= art.points.length || b >= art.points.length) return null;
  const key = edgeKey(a, b);
  const owners = edgeMap(art).get(key) ?? [];
  if (!owners.length) return null;
  const start = art.points[a];
  const end = art.points[b];
  const points = [...art.points, { x: round((start.x + end.x) / 2), y: round((start.y + end.y) / 2) }];
  const middle = points.length - 1;
  const triangles: number[] = [];
  for (let index = 0; index < art.triangles.length; index += 3) {
    const triangle = [art.triangles[index], art.triangles[index + 1], art.triangles[index + 2]];
    if (!owners.includes(index / 3)) {
      triangles.push(...triangle);
      continue;
    }
    // Порядок «a → b» задаёт, с какой стороны встаёт новая точка.
    const forward = nextInTriangle(triangle, a) === b;
    const [from, to] = forward ? [a, b] : [b, a];
    const third = triangle.find((value) => value !== a && value !== b)!;
    triangles.push(from, middle, third, middle, to, third);
  }
  return { points, triangles, ...(art.outline ? { outline: art.outline } : {}), auto: null };
}

/** Площадь треугольника со знаком: по ней проверяются вырожденность и обход. */
export function triangleArea(a: Vec2, b: Vec2, c: Vec2): number {
  return ((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
}

/**
 * Перевернуть диагональ у двух соседних треугольников.
 *
 * Работает только на выпуклом четырёхугольнике: иначе новый треугольник лёг бы
 * поверх соседей. Проверка — знаки площадей четырёх получившихся углов.
 */
export function flipDiagonal(art: ArtMesh, a: number, b: number): ArtMesh | null {
  const owners = edgeMap(art).get(edgeKey(a, b)) ?? [];
  if (owners.length !== 2) return null;
  const [first, second] = owners.map((index) => [
    art.triangles[index * 3], art.triangles[index * 3 + 1], art.triangles[index * 3 + 2],
  ]);
  const c = first.find((value) => value !== a && value !== b);
  const d = second.find((value) => value !== a && value !== b);
  if (c === undefined || d === undefined) return null;
  const points = art.points;
  const quad = [a, c, b, d].map((index) => points[index]);
  const cross = (o: Vec2, p: Vec2, q: Vec2) => triangleArea(o, p, q);
  const signs = [
    cross(quad[0], quad[1], quad[2]),
    cross(quad[1], quad[2], quad[3]),
    cross(quad[2], quad[3], quad[0]),
    cross(quad[3], quad[0], quad[1]),
  ];
  if (signs.some((value) => Math.abs(value) < 1e-9)) return null;
  const positive = signs.every((value) => value > 0);
  const negative = signs.every((value) => value < 0);
  if (!positive && !negative) return null;
  const forward = nextInTriangle(first, a) === b;
  const replacement = forward ? [c, d, a, d, c, b] : [d, c, b, c, d, a];
  const triangles = [...art.triangles];
  const positions = [...owners].sort((left, right) => left - right);
  triangles.splice(positions[1] * 3, 3, ...replacement.slice(3));
  triangles.splice(positions[0] * 3, 3, ...replacement.slice(0, 3));
  return { ...art, triangles, auto: null };
}

/** Есть ли такой треугольник (порядок вершин и обход не важны). */
export function hasTriangle(art: ArtMesh, a: number, b: number, c: number): boolean {
  const key = [a, b, c].sort((left, right) => left - right).join(":");
  for (let index = 0; index < art.triangles.length; index += 3) {
    const other = [art.triangles[index], art.triangles[index + 1], art.triangles[index + 2]]
      .sort((left, right) => left - right).join(":");
    if (other === key) return true;
  }
  return false;
}

/** Добавить треугольник: только невырожденный, только новый, индексы в диапазоне. */
export function addTriangle(art: ArtMesh, a: number, b: number, c: number): ArtMesh | null {
  const limit = art.points.length;
  if ([a, b, c].some((value) => value < 0 || value >= limit)) return null;
  if (a === b || b === c || a === c) return null;
  if (Math.abs(triangleArea(art.points[a], art.points[b], art.points[c])) < 1e-6) return null;
  if (hasTriangle(art, a, b, c)) return null;
  return { ...art, triangles: [...art.triangles, a, b, c], auto: null };
}

/** Удалить треугольник по номеру. Последний треугольник удалить нельзя. */
export function deleteTriangle(art: ArtMesh, index: number): ArtMesh {
  const count = art.triangles.length / 3;
  if (index < 0 || index >= count || count <= 1) return art;
  const triangles = [...art.triangles];
  triangles.splice(index * 3, 3);
  return { ...art, triangles, auto: null };
}

/** Удалить точку: вместе с ней уходят все её треугольники, индексы сдвигаются. */
export function deleteArtPoint(art: ArtMesh, index: number): ArtMesh {
  if (index < 0 || index >= art.points.length) return art;
  const points = art.points.filter((_, position) => position !== index);
  const triangles: number[] = [];
  for (let at = 0; at < art.triangles.length; at += 3) {
    const triangle = [art.triangles[at], art.triangles[at + 1], art.triangles[at + 2]];
    if (triangle.includes(index)) continue;
    triangles.push(...triangle.map((value) => (value > index ? value - 1 : value)));
  }
  const outline = art.outline
    ?.filter((value) => value !== index)
    .map((value) => (value > index ? value - 1 : value));
  // Ручные линии уходят вместе с точкой, остальные переезжают по индексам.
  const manual = (art.manual ?? [])
    .filter(([from, to]) => from !== index && to !== index)
    .map(([from, to]) => [from > index ? from - 1 : from, to > index ? to - 1 : to] as [number, number]);
  return {
    points,
    triangles,
    ...(manual.length ? { manual } : {}),
    ...(outline && outline.length >= 3 ? { outline } : {}),
    auto: null,
  };
}

/* ── Линии нарезки: ручные и автоматические ───────────────────────────────
 *
 * Триангуляция — это точки и линии. Линии бывают двух видов:
 *
 * - **ручные** (`art.manual`) — их провёл человек инструментом «Линия».
 *   Автосетка такую линию перерезать не может;
 * - **автоматические** — всё остальное, что дают треугольники. После каждой
 *   ручной линии они пересчитываются: треугольники, которые она резала,
 *   заменяются новыми по обе стороны от неё.
 *
 * Видимая часть картинки — объединение треугольников, поэтому точки и линии
 * меняют не только форму, но и покрытие: удалённая точка уносит с собой свои
 * треугольники, удалённая внутренняя линия переворачивается на другую
 * диагональ (или оставляет дырку, если четырёхугольник невыпуклый).
 */

/** Параметры пересечения двух отрезков: `t` по первому, `u` по второму. */
function segmentParams(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): { t: number; u: number } | null {
  const rx = p2.x - p1.x;
  const ry = p2.y - p1.y;
  const sx = q2.x - q1.x;
  const sy = q2.y - q1.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((q1.x - p1.x) * sy - (q1.y - p1.y) * sx) / denom;
  const u = ((q1.x - p1.x) * ry - (q1.y - p1.y) * rx) / denom;
  return { t, u };
}

/** Отрезки пересекаются внутри друг друга: общие концы пересечением не считаются. */
function crossesInterior(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): boolean {
  const hit = segmentParams(p1, p2, q1, q2);
  if (!hit) return false;
  return hit.t > 1e-7 && hit.t < 1 - 1e-7 && hit.u > 1e-7 && hit.u < 1 - 1e-7;
}

/** Точка внутри треугольника: барицентрические координаты с допуском. */
function triangleHolds(points: Vec2[], tri: readonly number[], point: Vec2, eps = 1e-9): boolean {
  const a = points[tri[0]];
  const b = points[tri[1]];
  const c = points[tri[2]];
  const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
  if (Math.abs(area) < 1e-12) return false;
  const s1 = ((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)) / area;
  const s2 = ((c.x - b.x) * (point.y - b.y) - (c.y - b.y) * (point.x - b.x)) / area;
  const s3 = ((a.x - c.x) * (point.y - c.y) - (a.y - c.y) * (point.x - c.x)) / area;
  return s1 >= -eps && s2 >= -eps && s3 >= -eps;
}

/** Рёбра нарезки двумя списками: ручные и автоматические. */
export function artLines(art: ArtMesh): { manual: Array<[number, number]>; auto: Array<[number, number]> } {
  const manual: Array<[number, number]> = [];
  const seen = new Set<string>();
  for (const [from, to] of art.manual ?? []) {
    if (from === to) continue;
    if (from < 0 || to < 0 || from >= art.points.length || to >= art.points.length) continue;
    const key = edgeKey(from, to);
    if (seen.has(key)) continue;
    seen.add(key);
    manual.push([from, to]);
  }
  const auto: Array<[number, number]> = [];
  for (let index = 0; index < art.triangles.length; index += 3) {
    const tri = [art.triangles[index], art.triangles[index + 1], art.triangles[index + 2]];
    for (const [from, to] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
      const key = edgeKey(from, to);
      if (seen.has(key)) continue;
      seen.add(key);
      auto.push([from, to]);
    }
  }
  return { manual, auto };
}

/** Ближайшая линия к точке — по экранным координатам точек нарезки. */
export function nearestArtLine(
  points: readonly Vec2[],
  art: ArtMesh,
  at: Vec2,
  limit = Number.POSITIVE_INFINITY,
): { a: number; b: number; manual: boolean; distance: number } | null {
  const lines = artLines(art);
  let best: { a: number; b: number; manual: boolean; distance: number } | null = null;
  const check = (pairs: Array<[number, number]>, manual: boolean) => {
    for (const [a, b] of pairs) {
      const start = points[a];
      const end = points[b];
      if (!start || !end) continue;
      const distance = pointSegmentDistance(at, start, end);
      if (distance > limit) continue;
      if (best && distance >= best.distance) continue;
      best = { a, b, manual, distance };
    }
  };
  // Ручные линии ближе к «главным»: при равном расстоянии выбирается ручная.
  check(lines.manual, true);
  check(lines.auto, false);
  return best;
}

/** Расстояние от точки до отрезка: для попадания мышью. */
export function pointSegmentDistance(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length2 = dx * dx + dy * dy;
  if (length2 < 1e-12) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.min(1, Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length2));
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

/** Линия становится ручной: автосетка её больше не тронет. */
function markManual(art: ArtMesh, a: number, b: number): ArtMesh {
  const key = edgeKey(a, b);
  const manual = (art.manual ?? []).filter(([from, to]) => edgeKey(from, to) !== key);
  return { ...art, manual: [...manual, [a, b]], auto: null };
}

/**
 * Новая точка нарезки.
 *
 * Как и базовая, она сразу участвует в триангуляции: попала внутрь
 * треугольника — он делится на три, попала на линию — делятся оба
 * треугольника по её сторонам. Линии к ближайшим вершинам получаются
 * автоматическими: ручных здесь нет. Вне покрытия точка не появляется —
 * иначе она была бы невидимой и ничего не гнула.
 */
export function addArtPoint(art: ArtMesh, point: Vec2): ArtMesh | null {
  if (art.points.length >= 1024) return null;
  const at = { x: round(point.x), y: round(point.y) };
  if (art.points.some((existing) => Math.hypot(existing.x - at.x, existing.y - at.y) < 1e-3)) return null;

  // 1. Внутри треугольника — три новых треугольника.
  for (let index = 0; index < art.triangles.length; index += 3) {
    const tri = [art.triangles[index], art.triangles[index + 1], art.triangles[index + 2]];
    if (!triangleHolds(art.points, tri, at, -1e-7)) continue;
    const points = [...art.points, at];
    const next = points.length - 1;
    const triangles = [...art.triangles];
    triangles.splice(
      index, 3,
      tri[0], tri[1], next,
      tri[1], tri[2], next,
      tri[2], tri[0], next,
    );
    return { ...art, points, triangles, auto: null };
  }

  // 2. На линии — делим её: треугольники по обе стороны распадаются на два.
  const { manual, auto } = artLines(art);
  let best: { a: number; b: number; distance: number } | null = null;
  for (const [a, b] of [...manual, ...auto]) {
    const distance = pointSegmentDistance(at, art.points[a], art.points[b]);
    if (distance > 1e-3) continue;
    if (best && distance >= best.distance) continue;
    best = { a, b, distance };
  }
  if (!best) {
    // Outside the current coverage (including a deleted patch): connect only
    // visible boundary edges. Existing triangles and manual lines are barriers.
    const points = [...art.points, at];
    const next = art.points.length;
    const triangles = [...art.triangles];
    const edges = [...artLines(art).auto, ...artLines(art).manual];
    const visible = (id: number) => !edges.some(([a, b]) =>
      a !== id && b !== id && crossesInterior(at, points[id], points[a], points[b]));
    const covered = (point: Vec2) => {
      for (let i = 0; i < art.triangles.length; i += 3) {
        if (triangleHolds(points, art.triangles.slice(i, i + 3), point)) return true;
      }
      return false;
    };
    const boundary = [...edgeMap(art)].filter(([, owners]) => owners.length === 1)
      .map(([key]) => key.split(":").map(Number) as [number, number]);
    // With no faces left, the first three non-collinear points seed a face.
    if (!art.triangles.length) {
      for (let a = 0; a < next; a += 1) for (let b = a + 1; b < next; b += 1) {
        if (Math.abs(triangleArea(points[a], points[b], at)) > 1e-6) {
          boundary.push([a, b]);
          a = next;
          break;
        }
      }
    }
    for (const [a, b] of boundary) {
      if (!visible(a) || !visible(b)) continue;
      if (Math.abs(triangleArea(points[a], points[b], at)) < 1e-6) continue;
      const center = { x: (points[a].x + points[b].x + at.x) / 3, y: (points[a].y + points[b].y + at.y) / 3 };
      if (covered(center)) continue;
      triangles.push(a, b, next);
    }
    return { ...art, points, triangles, auto: null };
  }
  const { a, b } = best;
  const points = [...art.points, at];
  const next = points.length - 1;
  const triangles: number[] = [];
  const key = edgeKey(a, b);
  for (let index = 0; index < art.triangles.length; index += 3) {
    const tri = [art.triangles[index], art.triangles[index + 1], art.triangles[index + 2]];
    const has = tri.includes(a) && tri.includes(b);
    if (!has) {
      triangles.push(...tri);
      continue;
    }
    const forward = nextInTriangle(tri, a) === b;
    const [from, to] = forward ? [a, b] : [b, a];
    const third = tri.find((value) => value !== a && value !== b)!;
    triangles.push(from, next, third, next, to, third);
  }
  // Разрезанная ручная линия остаётся ручной — уже двумя половинами.
  const manualNext: Array<[number, number]> = [];
  let split = false;
  for (const [from, to] of art.manual ?? []) {
    if (edgeKey(from, to) !== key) {
      manualNext.push([from, to]);
      continue;
    }
    split = true;
  }
  if (split) manualNext.push([a, next], [next, b]);
  return {
    points,
    triangles,
    ...(manualNext.length ? { manual: manualNext } : {}),
    ...(art.outline ? { outline: art.outline } : {}),
    auto: null,
  };
}

/**
 * Ручная линия между двумя точками.
 *
 * Линия проходит по сетке и режет автоматические линии, которые встают на её
 * пути: треугольники под ней заменяются новыми по обе стороны. Ручную линию
 * перерезать нельзя — попытка вернуть `null`. Если на отрезке лежит вершина,
 * линия делится на части через неё: узел внутри ребра сломал бы триангуляцию.
 */
export function addArtLine(art: ArtMesh, a: number, b: number): ArtMesh | null {
  if (a === b) return null;
  if (a < 0 || b < 0 || a >= art.points.length || b >= art.points.length) return null;
  const start = art.points[a];
  const end = art.points[b];
  const { manual } = artLines(art);
  for (const [from, to] of manual) {
    if (edgeKey(from, to) === edgeKey(a, b)) return null;
    if (crossesInterior(start, end, art.points[from], art.points[to])) return null;
  }
  // Вершины ровно на отрезке делят его на части.
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length2 = dx * dx + dy * dy;
  if (length2 < 1e-12) return null;
  const between: Array<{ index: number; t: number }> = [];
  art.points.forEach((point, index) => {
    if (index === a || index === b) return;
    const t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / length2;
    if (t <= 1e-6 || t >= 1 - 1e-6) return;
    if (Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t)) > 1e-6) return;
    between.push({ index, t });
  });
  between.sort((left, right) => left.t - right.t);
  const chain = [a, ...between.map((item) => item.index), b];
  let current = art;
  for (let step = 0; step + 1 < chain.length; step += 1) {
    const next = cutArtLine(current, chain[step], chain[step + 1]);
    if (!next) return null;
    current = next;
  }
  return current;
}

/**
 * Одна ручная линия без вершин на отрезке.
 *
 * Классический приём: пока какая-нибудь линия сетки пересекает отрезок, она
 * переворачивается на другую диагональ своей пары треугольников. Пересечения
 * исчезают, и отрезок становится линией триангуляции — тогда он и объявляется
 * ручным. Площадь при перевороте не меняется, поэтому покрытие остаётся.
 *
 * Ручные линии при этом не переворачиваются: конфликт отсеян в `addArtLine`,
 * а здесь на всякий случай проверяется ещё раз.
 */
function cutArtLine(art: ArtMesh, a: number, b: number): ArtMesh | null {
  const key = edgeKey(a, b);
  if ((edgeMap(art).get(key) ?? []).length) return markManual(art, a, b);
  const manualKeys = new Set((art.manual ?? []).map(([from, to]) => edgeKey(from, to)));
  let current = art;
  const limit = art.triangles.length * 4 + 32;
  const visited = new Set<string>();
  for (let guard = 0; guard < limit; guard += 1) {
    const crossing = crossingLines(current, a, b);
    if (!crossing.length) break;
    const candidates = crossing
      .filter(([from, to]) => !manualKeys.has(edgeKey(from, to)))
      .map(([from, to]) => flipDiagonal(current, from, to))
      .filter((next): next is ArtMesh => !!next)
      .filter((next) => !visited.has(next.triangles.join(",")))
      .sort((x, y) => crossingLines(x, a, b).length - crossingLines(y, a, b).length);
    if (!candidates.length) return null;
    visited.add(current.triangles.join(","));
    current = candidates[0];
  }
  if (!(edgeMap(current).get(key) ?? []).length) return null;
  return markManual(current, a, b);
}

/** Линии сетки, которые пересекают отрезок внутри (концы не считаются). */
function crossingLines(art: ArtMesh, a: number, b: number): Array<[number, number]> {
  const start = art.points[a];
  const end = art.points[b];
  const seen = new Set<string>();
  const result: Array<[number, number]> = [];
  for (let index = 0; index < art.triangles.length; index += 3) {
    const tri = [art.triangles[index], art.triangles[index + 1], art.triangles[index + 2]];
    for (const [from, to] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
      if (from === a || from === b || to === a || to === b) continue;
      const key = edgeKey(from, to);
      if (seen.has(key)) continue;
      if (!crossesInterior(start, end, art.points[from], art.points[to])) continue;
      seen.add(key);
      result.push([from, to]);
    }
  }
  return result;
}

/**
 * Удалить линию.
 *
 * Внутренняя линия не оставляет дырку: её треугольники схлопываются в
 * четырёхугольник и делятся заново по другой диагонали — картинка остаётся
 * покрытой, а линии, которую удалили, больше нет. Крайняя линия (один
 * треугольник) и невыпуклый четырёхугольник убирают покрытие: на их месте
 * дырка, и это видно на спрайте.
 */
export function removeArtLine(art: ArtMesh, a: number, b: number): ArtMesh {
  const key = edgeKey(a, b);
  const owners = edgeMap(art).get(key) ?? [];
  if (!owners.length) return art;
  const manual = (art.manual ?? []).filter(([from, to]) => edgeKey(from, to) !== key);
  const base: ArtMesh = { ...art, manual };
  if (owners.length === 2) {
    const first = [art.triangles[owners[0] * 3], art.triangles[owners[0] * 3 + 1], art.triangles[owners[0] * 3 + 2]];
    const second = [art.triangles[owners[1] * 3], art.triangles[owners[1] * 3 + 1], art.triangles[owners[1] * 3 + 2]];
    const left = first.find((value) => value !== a && value !== b);
    const right = second.find((value) => value !== a && value !== b);
    const busy = left !== undefined && right !== undefined
      && manual.some(([from, to]) => edgeKey(from, to) === edgeKey(left, right));
    if (!busy) {
      const flipped = flipDiagonal(base, a, b);
      if (flipped) return flipped;
    }
  }
  const drop = new Set(owners);
  const triangles: number[] = [];
  for (let index = 0; index < art.triangles.length; index += 3) {
    if (drop.has(index / 3)) continue;
    triangles.push(art.triangles[index], art.triangles[index + 1], art.triangles[index + 2]);
  }
  return { ...base, triangles, auto: null };
}

/**
 * Автотриангуляция контура «отрезанием уха».
 *
 * Нужна и для ручного меша, и для проверки: контур из перо-объекта или из
 * маски-точек должен стать треугольниками без дыр. Работает на простом
 * многоугольнике; направление обхода определяется по площади.
 */
export function earClip(points: Vec2[]): number[] {
  const count = points.length;
  if (count < 3) return [];
  const indices = points.map((_, index) => index);
  const area = indices.reduce((sum, index) => {
    const next = (index + 1) % count;
    return sum + points[index].x * points[next].y - points[next].x * points[index].y;
  }, 0);
  if (area < 0) indices.reverse();
  const triangles: number[] = [];
  let guard = 0;
  while (indices.length > 3 && guard < count * count) {
    guard += 1;
    let clipped = false;
    for (let at = 0; at < indices.length; at += 1) {
      const previous = indices[(at + indices.length - 1) % indices.length];
      const current = indices[at];
      const next = indices[(at + 1) % indices.length];
      const a = points[previous];
      const b = points[current];
      const c = points[next];
      if (triangleArea(a, b, c) <= 1e-9) continue;
      const inside = indices.some((index) => {
        if (index === previous || index === current || index === next) return false;
        const point = points[index];
        const s1 = triangleArea(a, b, point);
        const s2 = triangleArea(b, c, point);
        const s3 = triangleArea(c, a, point);
        return s1 >= 0 && s2 >= 0 && s3 >= 0;
      });
      if (inside) continue;
      triangles.push(previous, current, next);
      indices.splice(at, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (indices.length === 3) triangles.push(indices[0], indices[1], indices[2]);
  return triangles;
}

/** Артмеш по контуру: точки контура и автотриангуляция. */
export function artFromOutline(points: Vec2[]): ArtMesh | null {
  const clipped = points.map((point) => ({ x: round(point.x), y: round(point.y) }));
  // Площадь контура: три точки на одной прямой контуром не считаются, иначе
  // нарезка получила бы вырожденный треугольник и «нулевую» картинку.
  const area = clipped.reduce((sum, point, index) => {
    const next = clipped[(index + 1) % Math.max(1, clipped.length)];
    return next ? sum + point.x * next.y - next.x * point.y : sum;
  }, 0);
  if (Math.abs(area) < 1e-6) return null;
  const triangles = earClip(clipped);
  if (triangles.length < 3) return null;
  return {
    points: clipped,
    triangles,
    outline: clipped.map((_, index) => index),
    auto: null,
  };
}

/**
 * Добавить к нарезке ещё один контур: точки и треугольники дописываются.
 *
 * Так второй контур (Shift при замыкании) не стирает первый: картинка может
 * состоять из нескольких кусков, и нарезать их по одному — обычное дело.
 */
export function mergeArt(art: ArtMesh, extra: ArtMesh): ArtMesh {
  const offset = art.points.length;
  return {
    points: [...art.points, ...extra.points],
    triangles: [...art.triangles, ...extra.triangles.map((index) => index + offset)],
    auto: null,
  };
}

/** Суммарная площадь нарезки: по ней видно дыры и наложения. */
export function artArea(art: ArtMesh): number {
  let total = 0;
  for (let index = 0; index < art.triangles.length; index += 3) {
    total += Math.abs(triangleArea(
      art.points[art.triangles[index]],
      art.points[art.triangles[index + 1]],
      art.points[art.triangles[index + 2]],
    ));
  }
  return round(total);
}

/**
 * Проверка нарезки: список ошибок для панели «Предупреждения».
 *
 * Проверяется то, что действительно ломает рендер: индексы, вырожденные и
 * повторные треугольники, площадь. Пересечения треугольников не ищутся —
 * редактор их не создаёт, а полная проверка стоит как весь кадр.
 */
export function validateArt(art: ArtMesh): string[] {
  const errors: string[] = [];
  if (art.points.length < 3) errors.push("в нарезке меньше трёх точек");
  if (art.triangles.length < 3) errors.push("в нарезке нет треугольников");
  if (art.points.length > 1024) errors.push("в нарезке больше 1024 точек");
  if (art.triangles.length / 3 > 4096) errors.push("в нарезке больше 4096 треугольников");
  const seen = new Set<string>();
  for (let index = 0; index < art.triangles.length; index += 3) {
    const [a, b, c] = [art.triangles[index], art.triangles[index + 1], art.triangles[index + 2]];
    if ([a, b, c].some((value) => value < 0 || value >= art.points.length)) {
      errors.push(`треугольник ${index / 3 + 1}: индекс вне точек`);
      continue;
    }
    if (a === b || b === c || a === c) {
      errors.push(`треугольник ${index / 3 + 1}: повторная вершина`);
      continue;
    }
    if (Math.abs(triangleArea(art.points[a], art.points[b], art.points[c])) < 1e-6) {
      errors.push(`треугольник ${index / 3 + 1}: нулевая площадь`);
    }
    const key = [a, b, c].sort((left, right) => left - right).join(":");
    if (seen.has(key)) errors.push(`треугольник ${index / 3 + 1}: повторяет другой`);
    seen.add(key);
  }
  return errors;
}

/** Отражение точки относительно оси: точка + угол в градусах. */
export function mirrorPoint(point: Vec2, axis: { x: number; y: number; angle: number }): Vec2 {
  const angle = (axis.angle * Math.PI) / 180;
  const dx = point.x - axis.x;
  const dy = point.y - axis.y;
  const projection = dx * Math.cos(angle) + dy * Math.sin(angle);
  const mirrored = {
    x: 2 * projection * Math.cos(angle) - dx,
    y: 2 * projection * Math.sin(angle) - dy,
  };
  return { x: round(axis.x + mirrored.x), y: round(axis.y + mirrored.y) };
}

/** Ось симметрии по умолчанию: вертикальная через центр картинки. */
export function defaultAxis(): { x: number; y: number; angle: number } {
  return { x: 0.5, y: 0.5, angle: 90 };
}

/** Пустая деформация старого формата — чтобы редактор мог её показать. */
export function legacyWarp(): WarpSpec {
  return defaultWarp();
}

/* ── Правки сетки и нарезки: то, что делает сцена ─────────────────────────
 *
 * Всё это — чистые функции над `MeshSpec`: редактор сцены только считает
 * смещение и вызывает нужную. Поэтому каждое действие проверяется тестом, а не
 * мышью: «разрезать ребро» — это `splitArtEdge`, а не сорок строк в обработчике
 * указателя.
 */

/** Деформация с включённой галочкой: первая правка включает её сама. */
export function withMesh(mesh: MeshSpec, patch: Partial<MeshSpec> = {}): MeshSpec {
  return { ...mesh, ...patch, enabled: true };
}

/** Сдвиг узла сетки в долях зоны. */
export function moveNode(mesh: MeshSpec, index: number, du: number, dv: number): MeshSpec {
  return withMesh(mesh, { deform: shiftNode(mesh.deform, index, du, dv) });
}

/** Сдвиг точки нарезки: сама нарезка правится, сетка не трогается. */
export function moveArtPoint(mesh: MeshSpec, index: number, du: number, dv: number): MeshSpec {
  if (index < 0 || index >= mesh.art.points.length) return mesh;
  const points = mesh.art.points.map((point, position) => (position === index
    ? { x: round(point.x + du), y: round(point.y + dv) }
    : point));
  return withMesh(mesh, { art: { ...mesh.art, points, auto: null } });
}

/** Разрезать ребро нарезки: между двумя точками появляется третья. */
export function splitArtEdge(mesh: MeshSpec, a: number, b: number): MeshSpec | null {
  const art = splitEdge(mesh.art, a, b);
  return art ? withMesh(mesh, { art }) : null;
}

/** Перевернуть диагональ между двумя треугольниками. */
export function flipArtEdge(mesh: MeshSpec, a: number, b: number): MeshSpec | null {
  const art = flipDiagonal(mesh.art, a, b);
  return art ? withMesh(mesh, { art }) : null;
}

/** Удалить треугольник по номеру. */
export function removeArtTriangle(mesh: MeshSpec, index: number): MeshSpec {
  const art = deleteTriangle(mesh.art, index);
  return art === mesh.art ? mesh : withMesh(mesh, { art });
}

/** Удалить точку нарезки вместе с её треугольниками. */
export function removeArtPoint(mesh: MeshSpec, index: number): MeshSpec {
  const art = deleteArtPoint(mesh.art, index);
  return art === mesh.art ? mesh : withMesh(mesh, { art });
}

/**
 * Разбить треугольник точкой: одна точка и три треугольника вместо одного.
 *
 * Это и есть «добавить треугольник» руками: точку некуда поставить, пока она
 * не внутри треугольника, а вставлять её в ребро умеет `splitArtEdge`.
 */
export function splitArtTriangle(mesh: MeshSpec, index: number, at: Vec2): MeshSpec | null {
  if (index < 0 || index * 3 + 2 >= mesh.art.triangles.length) return null;
  const [a, b, c] = [
    mesh.art.triangles[index * 3],
    mesh.art.triangles[index * 3 + 1],
    mesh.art.triangles[index * 3 + 2],
  ];
  const points = [...mesh.art.points, { x: round(at.x), y: round(at.y) }];
  const middle = points.length - 1;
  if (Math.abs(triangleArea(points[a], points[b], points[middle])) < 1e-9
    || Math.abs(triangleArea(points[b], points[c], points[middle])) < 1e-9
    || Math.abs(triangleArea(points[c], points[a], points[middle])) < 1e-9) {
    return null;
  }
  const triangles = [...mesh.art.triangles];
  triangles.splice(index * 3, 3, a, b, middle, b, c, middle, c, a, middle);
  return withMesh(mesh, { art: { points, triangles, auto: null } });
}
