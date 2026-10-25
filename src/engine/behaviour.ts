import type { RigObject, Vec2 } from "../types";

/**
 * Поведение объекта — это «пресет» в духе PNGTuber: несколько ползунков,
 * которые превращаются в обычные формулы скрипта.
 *
 * Истина — сам скрипт: настройки лежат JSON-строкой в комментарии внутри
 * блока, а формулы ниже блока читаются ядром. Поэтому вкладка «Поведение» и
 * вкладка «Объект» всегда показывают одно и то же, а продвинутый автор может
 * удалить блок и писать руками.
 *
 * Важное правило генератора: сглаживание и пружина стоят **последними** в
 * цепочке. Они фильтруют итоговую цель по оси — наследство родителя, `follow`,
 * покачивание и подпрыгивание вместе, — поэтому «drag» влияет и на bounce, а не
 * только на следование за родителем.
 */

export type VisibilityRule = "none" | "open" | "closed";

/** Координаты, в которых физика поворота держит «тяжёлую» сторону. */
export type PhysSpace = "world" | "parent";

export interface Behaviour {
  /** Сглаживание позиции: 0 — без фильтра, 1 — сильно отстаёт. */
  smooth: number;
  /** Упругость позиции: 0 — выключено, 1 — мягкая пружина. */
  spring: number;
  /** Сглаживание поворота. */
  rotationSmooth: number;
  /** Пружина на повороте. */
  rotationSpring: number;
  /** Сквош от речи: -1..1. Минус меняет оси местами. 0 — выключено. */
  squash: number;
  /** Скорость деформации, мс. */
  squashIn: number;
  /** Скорость возврата, мс. */
  squashOut: number;
  /** Подпрыгивание при речи, пиксели вверх. 0 — выключено. */
  bounce: number;
  /** Доворот от речи, градусы (−180..180). */
  rotationalDrag: number;
  /** Предел отклонения влево, градусы 0..180. */
  rotationalLimitLeft: number;
  /** Предел отклонения вправо, градусы 0..180. */
  rotationalLimitRight: number;
  /** `true` — покачивание шумом, `false` — плавной синусоидой. */
  wiggleRandom: boolean;
  wiggleXFreq: number;
  wiggleXAmp: number;
  wiggleYFreq: number;
  wiggleYAmp: number;
  /** Рот: `open` — виден при речи, `closed` — виден в тишине. */
  mouth: VisibilityRule;
  /** Глаз: `open` — виден при открытых глазах, `closed` — на моргании. */
  eye: VisibilityRule;
  /** Мировой поворот «тяжёлой» стороной: 0 — вниз, 90 — вправо. `null` — выкл. */
  physRotation: number | null;
  /**
   * В каких координатах считается угол физики.
   * `world` — мировая: спрайт держит заданный мировой угол и **не** едет за
   * поворотом тела (подвеска, серьга, прядь). `parent` — родительская: угол
   * задан внутри родителя, тело подхватывает спрайт, а пружина запаздывает —
   * так рука качается на плече.
   */
  physSpace: PhysSpace;
  /** Плавность мировой физики: 0 — жёстко, 1 — вязко. */
  physSmooth: number;
}

export const DEFAULT_BEHAVIOUR: Behaviour = {
  smooth: 0,
  spring: 0,
  rotationSmooth: 0,
  rotationSpring: 0,
  squash: 0,
  squashIn: 90,
  squashOut: 240,
  bounce: 0,
  rotationalDrag: 0,
  rotationalLimitLeft: 0,
  rotationalLimitRight: 0,
  wiggleRandom: false,
  wiggleXFreq: 0,
  wiggleXAmp: 0,
  wiggleYFreq: 0,
  wiggleYAmp: 0,
  mouth: "none",
  eye: "none",
  physRotation: null,
  physSpace: "world",
  physSmooth: 0.4,
};

const START = "// ── поведение: вкладка «Поведение» ──";
const END = "// ── конец поведения ──";
const META = "// @behaviour ";

/** Параметры, которые переписывает блок: остальное в скрипте не трогаем. */
const MANAGED = ["x", "y", "rotation", "sizeX", "sizeY", "visible"] as const;

function num(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** Стабильный seed: у каждого объекта своё покачивание и своя фаза. */
function seedOf(id: string): number {
  let hash = 7;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) % 9973;
  return hash + 11;
}

/** Частота и затухание пружины по «силе» 0..1: больше сила — мягче и качается дольше. */
function springParams(strength: number): { frequency: number; damping: number } {
  return {
    frequency: 4.5 - 3.8 * Math.min(1, Math.max(0, strength)),
    damping: 0.85 - 0.6 * Math.min(1, Math.max(0, strength)),
  };
}

/**
 * Угол «тяжёлой» стороны в той же системе, что и физика: 0 — вниз, 90 — вправо.
 * Считается по пивоту: длинная часть спрайта — противоположная пивоту.
 */
export function heavyAngle(pivot: Vec2): number | null {
  const hx = 0.5 - pivot.x;
  const hy = 0.5 - pivot.y;
  if (Math.hypot(hx, hy) < 0.03) return null;
  return (Math.atan2(hx, hy) * 180) / Math.PI;
}

/** Ничего не настроено — блок не нужен, скрипт остаётся как есть. */
export function isDefault(behaviour: Behaviour): boolean {
  return behaviour.smooth === 0 && behaviour.spring === 0
    && behaviour.rotationSmooth === 0 && behaviour.rotationSpring === 0
    && behaviour.squash === 0 && behaviour.bounce === 0
    && behaviour.rotationalDrag === 0
    && behaviour.rotationalLimitLeft === 0 && behaviour.rotationalLimitRight === 0
    && behaviour.wiggleXAmp === 0 && behaviour.wiggleYAmp === 0
    && behaviour.mouth === "none" && behaviour.eye === "none"
    && behaviour.physRotation === null && behaviour.physSpace === "world";
}

/** Настройки из скрипта: JSON-строка комментария. */
export function readBehaviour(script: string): Behaviour {
  for (const line of script.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(META)) continue;
    try {
      const raw: unknown = JSON.parse(trimmed.slice(META.length));
      if (!raw || typeof raw !== "object") break;
      const source = raw as Record<string, unknown>;
      const merged: Behaviour = { ...DEFAULT_BEHAVIOUR, ...(source as Partial<Behaviour>) };
      // Старый общий предел (±N) переносим в два односторонних.
      if (typeof source.rotationalLimit === "number"
        && source.rotationalLimitLeft === undefined && source.rotationalLimitRight === undefined) {
        const magnitude = Math.abs(source.rotationalLimit);
        merged.rotationalLimitLeft = magnitude;
        merged.rotationalLimitRight = magnitude;
      }
      merged.physRotation = typeof merged.physRotation === "number" ? merged.physRotation : null;
      merged.physSpace = merged.physSpace === "parent" ? "parent" : "world";
      merged.wiggleRandom = merged.wiggleRandom === true;
      return merged;
    } catch {
      break;
    }
  }
  return { ...DEFAULT_BEHAVIOUR };
}

/** Текст блока для текущих настроек и геометрии объекта. */
export function behaviourBlock(behaviour: Behaviour, object: RigObject): string {
  const hasParent = Boolean(object.parentId);
  const seed = seedOf(object.id);
  const scale = hasParent ? "inherit" : "1";
  const body: string[] = [];

  const wiggle = (axis: "x" | "y", amplitude: number, frequency: number): string | null => {
    if (amplitude <= 0 || frequency <= 0) return null;
    const localSeed = seed + (axis === "x" ? 0 : 1);
    if (behaviour.wiggleRandom) return `noise(${localSeed}, ${num(frequency)}) * ${num(amplitude)}`;
    const phase = ((localSeed % 100) / 100) * 2 * Math.PI;
    return `sin(time * 2 * pi * ${num(frequency)} + ${num(phase)}) * ${num(amplitude)}`;
  };

  const position = behaviour.smooth > 0 || behaviour.spring > 0;
  const bounce = behaviour.bounce > 0;
  const wiggleX = wiggle("x", behaviour.wiggleXAmp, behaviour.wiggleXFreq);
  const wiggleY = wiggle("y", behaviour.wiggleYAmp, behaviour.wiggleYFreq);

  // Фильтр ставится ПОСЛЕ сборки цели: так drag/пружина гасят и наследство
  // родителя, и покачивание, и подпрыгивание — реакцию объекта в абсолюте.
  const filtered = (expression: string): string => {
    let result = expression;
    if (behaviour.smooth > 0) result = `smooth(${result}, ${num(behaviour.smooth * 260)})`;
    if (behaviour.spring > 0) {
      const { frequency, damping } = springParams(behaviour.spring);
      result = `spring(${result}, ${num(frequency)}, ${num(damping)})`;
    }
    return result;
  };

  const target = (axis: "x" | "y") => (hasParent ? `inherit + follow(offset, parent).${axis}` : "0");

  if (position || wiggleX) {
    const parts = [target("x"), wiggleX].filter(Boolean).join(" + ");
    body.push(`x = ${filtered(parts)}`);
  }
  if (position || wiggleY || bounce) {
    const parts = [target("y")];
    if (bounce) {
      const hop = `mic.speak * ${num(behaviour.bounce)}`;
      // Если внешнего фильтра нет, подпрыгивание сглаживает собственная пружина:
      // иначе объект дёргался бы мгновенно.
      parts.push(`- ${position ? hop : `spring(${hop}, 2.2, 0.55)`}`);
    }
    if (wiggleY) parts.push(`+ ${wiggleY}`);
    body.push(`y = ${filtered(parts.join(" "))}`);
  }

  const drag = behaviour.rotationalDrag !== 0;
  const limitLeft = Math.max(0, behaviour.rotationalLimitLeft);
  const limitRight = Math.max(0, behaviour.rotationalLimitRight);
  const rotFilter = behaviour.rotationSmooth > 0 || behaviour.rotationSpring > 0;
  const heavy = heavyAngle(object.pivot);
  const physical = behaviour.physRotation !== null && heavy !== null;

  // Фильтр поворота — отдельная функция: он ставится и на наследуемый угол,
  // и на собственный доворот. Две независимые цепочки (у каждой свой узел
  // состояния) дают честный предел: он ограничивает именно отклонение.
  const rotateFilter = (expression: string): string => {
    let result = expression;
    if (behaviour.rotationSmooth > 0) result = `smooth(${result}, ${num(behaviour.rotationSmooth * 260)})`;
    if (behaviour.rotationSpring > 0) {
      const { frequency, damping } = springParams(behaviour.rotationSpring);
      result = `spring(${result}, ${num(frequency)}, ${num(damping)})`;
    }
    return result;
  };

  if (physical || rotFilter || drag) {
    let expression: string;
    if (physical) {
      // Тяжёлая сторона смотрит в угол physRotation. В `world` угол мировой:
      // поворот родителя в цель не входит, поэтому спрайт его игнорирует и
      // висит в мире. В `parent` добавляется `inherit` — тело подхватывает
      // спрайт, а пружина запаздывает и даёт качок. Пивот обязателен: он задаёт
      // плечо, вокруг которого считается «тяжесть».
      const aim = behaviour.physRotation! - heavy! - object.base.rotation;
      const { frequency, damping } = springParams(behaviour.physSmooth);
      const target = behaviour.physSpace === "parent" && hasParent
        ? `inherit ${aim < 0 ? "-" : "+"} ${num(Math.abs(aim))}`
        : num(aim);
      expression = `spring(${target}, ${num(frequency)}, ${num(damping)})`;
    } else {
      const base = hasParent ? "inherit" : "0";
      expression = rotFilter ? rotateFilter(base) : base;
    }
    if (drag) {
      const push = `mic.speak * ${num(behaviour.rotationalDrag)}`;
      let shaped = (!physical && rotFilter) ? rotateFilter(push) : `spring(${push}, 2.4, 0.35)`;
      if (limitLeft > 0 || limitRight > 0) shaped = `limit(${shaped}, ${num(-limitLeft)}, ${num(limitRight)})`;
      expression = `${expression} + ${shaped}`;
    }
    body.push(`rotation = ${expression}`);
  }

  if (behaviour.squash !== 0) {
    // Отдельной переменной в скрипте объекта быть не может (имя слева — это
    // параметр), поэтому прошлое значение сквоша берём из `state.sizeY`:
    // sizeY = inherit * (1 + s), значит s_prev = state.sizeY - inherit.
    // Сравниваем модули: сквош бывает отрицательным, и тогда «рост» цели
    // означает уменьшение sizeY.
    const value = `mic.speak * ${num(behaviour.squash)}`;
    const past = `abs(state.sizeY - ${scale})`;
    body.push(
      `sizeY = ${scale} * (1 + smooth(${value}, abs(${value}) > ${past} ? ${num(behaviour.squashIn)} : ${num(behaviour.squashOut)}))`,
      `sizeX = ${scale} * 2 - sizeY`,
    );
  }

  const rules: string[] = [];
  const talking = "(mic.talking > 0 or mic.speak > 0.05)";
  if (behaviour.mouth === "open") rules.push(`${talking} ? 1 : 0`);
  if (behaviour.mouth === "closed") rules.push(`${talking} ? 0 : 1`);
  if (behaviour.eye === "open") rules.push("1 - auto.blink");
  if (behaviour.eye === "closed") rules.push("auto.blink");
  if (rules.length) body.push(`visible = ${rules.map((rule) => `(${rule})`).join(" * ")}`);

  if (!body.length) return "";
  return [
    START,
    `${META}${JSON.stringify(behaviour)}`,
    ...body,
    END,
  ].join("\n");
}

/** Границы блока в скрипте или `null`, если блока нет. */
function blockRange(script: string): { start: number; end: number } | null {
  const lines = script.split("\n");
  const startLine = lines.findIndex((line) => line.trim() === START);
  if (startLine < 0) return null;
  const endLine = lines.findIndex((line, index) => index > startLine && line.trim() === END);
  if (endLine < 0) return null;
  let start = 0;
  for (let index = 0; index < startLine; index += 1) start += lines[index].length + 1;
  let end = start;
  for (let index = startLine; index <= endLine; index += 1) end += lines[index].length + 1;
  return { start, end: end - 1 };
}

/**
 * Убирает из «хвоста» присваивания тем параметрам, которые пишет блок.
 * Строки внутри блоков событий и комментарии не трогаем.
 */
function stripManaged(text: string, params: readonly string[]): string {
  const kept: string[] = [];
  let depth = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const assignment = /^(x|y|rotation|sizeX|sizeY|visible)\s*=/.exec(trimmed);
    if (depth === 0 && assignment && params.includes(assignment[1])) {
      continue;
    }
    kept.push(line);
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (depth < 0) depth = 0;
  }
  return kept.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
}

export interface BehaviourWrite {
  script: string;
  /** Параметры, которые теперь задаёт блок: их присваивания убраны из хвоста. */
  params: string[];
}

/**
 * Переписывает блок поведения в скрипте, сохраняя авторский код под ним.
 * Настройки по умолчанию блок удаляют.
 */
export function writeBehaviour(script: string, behaviour: Behaviour, object: RigObject): BehaviourWrite {
  const range = blockRange(script);
  const tail = range ? script.slice(0, range.start) + script.slice(range.end) : script;
  const block = behaviourBlock(behaviour, object);
  const params = block
    ? MANAGED.filter((param) => new RegExp(`^\\s*(?:${param})\\s*=`, "m").test(block))
    : [];
  const rest = stripManaged(tail, params);
  const body = [block, rest].filter(Boolean).join("\n\n");
  return { script: body ? `${body}\n` : "", params: [...params] };
}
