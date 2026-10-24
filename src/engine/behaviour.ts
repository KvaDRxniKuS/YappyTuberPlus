import type { RigObject, Vec2 } from "../types";

/**
 * Поведение объекта — это «пресет» в духе PNGTuber: несколько ползунков,
 * которые превращаются в обычные формулы скрипта.
 *
 * Истина — сам скрипт: настройки лежат JSON-строкой в комментарии внутри
 * блока, а формулы ниже блока читаются ядром. Поэтому вкладка «Поведение» и
 * вкладка «Объект» всегда показывают одно и то же, а продвинутый автор может
 * удалить блок и писать руками.
 */

export type VisibilityRule = "none" | "open" | "closed";

export interface Behaviour {
  /** Сглаживание позиции: 0 — следует за родителем сразу, 1 — сильно отстаёт. */
  smooth: number;
  /** Упругость позиции: 0 — выключено, 1 — мягкая пружина. */
  spring: number;
  /** Сглаживание наследуемого поворота. */
  rotationSmooth: number;
  /** Пружина на наследуемом повороте. */
  rotationSpring: number;
  /** Сила сквоша от речи: 0 — выключено. */
  squash: number;
  /** Скорость деформации, мс. */
  squashIn: number;
  /** Скорость возврата, мс. */
  squashOut: number;
  /** Подпружиненный доворот от речи, градусы (±180). */
  rotationalDrag: number;
  /** Предел собственного отклонения угла, градусы. 0 — без предела. */
  rotationalLimit: number;
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
  rotationalDrag: 0,
  rotationalLimit: 0,
  wiggleXFreq: 0,
  wiggleXAmp: 0,
  wiggleYFreq: 0,
  wiggleYAmp: 0,
  mouth: "none",
  eye: "none",
  physRotation: null,
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

/** Стабильный seed шума: у каждого объекта своё покачивание. */
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
    && behaviour.squash === 0 && behaviour.rotationalDrag === 0
    && behaviour.wiggleXAmp === 0 && behaviour.wiggleYAmp === 0
    && behaviour.mouth === "none" && behaviour.eye === "none"
    && behaviour.physRotation === null;
}

/** Настройки из скрипта: JSON-строка комментария. */
export function readBehaviour(script: string): Behaviour {
  for (const line of script.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(META)) continue;
    try {
      const raw: unknown = JSON.parse(trimmed.slice(META.length));
      if (!raw || typeof raw !== "object") break;
      const parsed = { ...DEFAULT_BEHAVIOUR, ...(raw as Partial<Behaviour>) };
      return { ...parsed, physRotation: typeof parsed.physRotation === "number" ? parsed.physRotation : null };
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

  const position = behaviour.smooth > 0 || behaviour.spring > 0;
  const wiggleX = behaviour.wiggleXAmp > 0 && behaviour.wiggleXFreq > 0;
  const wiggleY = behaviour.wiggleYAmp > 0 && behaviour.wiggleYFreq > 0;

  const axis = (name: "x" | "y", wiggleAmp: number, wiggleFreq: number): string => {
    let expression = hasParent ? `inherit + follow(offset, parent).${name}` : "0";
    if (behaviour.smooth > 0) expression = `smooth(${expression}, ${num(behaviour.smooth * 260)})`;
    if (behaviour.spring > 0) {
      const { frequency, damping } = springParams(behaviour.spring);
      expression = `spring(${expression}, ${num(frequency)}, ${num(damping)})`;
    }
    if (wiggleAmp > 0 && wiggleFreq > 0) {
      expression = `${expression} + noise(${seed + (name === "x" ? 0 : 1)}, ${num(wiggleFreq)}) * ${num(wiggleAmp)}`;
    }
    return expression;
  };

  if (position || wiggleX) body.push(`x = ${axis("x", behaviour.wiggleXAmp, behaviour.wiggleXFreq)}`);
  if (position || wiggleY) body.push(`y = ${axis("y", behaviour.wiggleYAmp, behaviour.wiggleYFreq)}`);

  const drag = behaviour.rotationalDrag !== 0;
  const limit = behaviour.rotationalLimit > 0;
  const physical = behaviour.physRotation !== null && heavyAngle(object.pivot) !== null;
  if (behaviour.rotationSmooth > 0 || behaviour.rotationSpring > 0 || drag || physical) {
    let expression: string;
    const { frequency, damping } = springParams(behaviour.physSmooth);
    if (physical) {
      // Мировая ориентация: тяжёлая сторона смотрит в угол physRotation.
      const heavy = heavyAngle(object.pivot)!;
      const target = behaviour.physRotation! - heavy - object.base.rotation;
      expression = `spring(${num(target)}, ${num(frequency)}, ${num(damping)})`;
    } else {
      expression = hasParent ? "inherit" : "0";
      if (behaviour.rotationSmooth > 0) expression = `smooth(${expression}, ${num(behaviour.rotationSmooth * 260)})`;
      if (behaviour.rotationSpring > 0) {
        const spring = springParams(behaviour.rotationSpring);
        expression = `spring(${expression}, ${num(spring.frequency)}, ${num(spring.damping)})`;
      }
    }
    if (drag) {
      const push = `spring(mic.speak * ${num(behaviour.rotationalDrag)}, 2.4, 0.35)`;
      expression = `${expression} + ${limit ? `limit(${push}, ${num(-behaviour.rotationalLimit)}, ${num(behaviour.rotationalLimit)})` : push}`;
    }
    body.push(`rotation = ${expression}`);
  }

  if (behaviour.squash > 0) {
    // Отдельной переменной в скрипте объекта быть не может (имя слева — это
    // параметр), поэтому прошлое значение сквоша берём из `state.sizeY`:
    // sizeY = inherit * (1 + s), значит s_prev = state.sizeY - inherit.
    const target = `mic.speak * ${num(behaviour.squash)}`;
    const past = `(state.sizeY - ${scale})`;
    body.push(
      `sizeY = ${scale} * (1 + smooth(${target}, ${target} > ${past} ? ${num(behaviour.squashIn)} : ${num(behaviour.squashOut)}))`,
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
