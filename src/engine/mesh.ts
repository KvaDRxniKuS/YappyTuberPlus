import type {
  ArtMesh, GridSpec, MeshSpec, ObjectFrame, RigObject, Vec2, WarpCorner, WarpSpec,
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
  if (points.length < 3) return undefined;
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
  if (!triangles.length) return undefined;
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
  return outline.length >= 3 ? { points, triangles, outline, auto } : { points, triangles, auto };
}

/**
 * Сетка из пресета. Если точек не то количество, что обещает `cols × rows`,
 * сетка пересобирается регулярной: иначе редактор и рендер разойдутся в
 * индексах, и «поехала одна точка» превратится в кашу.
 */
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
  if (index < 0 || index >= art.points.length || art.points.length <= 3) return art;
  const points = art.points.filter((_, position) => position !== index);
  const triangles: number[] = [];
  for (let at = 0; at < art.triangles.length; at += 3) {
    const triangle = [art.triangles[at], art.triangles[at + 1], art.triangles[at + 2]];
    if (triangle.includes(index)) continue;
    triangles.push(...triangle.map((value) => (value > index ? value - 1 : value)));
  }
  if (triangles.length < 3) return art;
  const outline = art.outline
    ?.filter((value) => value !== index)
    .map((value) => (value > index ? value - 1 : value));
  return {
    points,
    triangles,
    ...(outline && outline.length >= 3 ? { outline } : {}),
    auto: null,
  };
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
  const triangles = earClip(clipped);
  if (triangles.length < 3) return null;
  return {
    points: clipped,
    triangles,
    outline: clipped.map((_, index) => index),
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
