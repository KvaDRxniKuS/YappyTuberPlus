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

/** Куда доворачивать объект от речи. */
export type DragMode = "right" | "left" | "random" | "alternate";

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
  /** Скорость подпрыгивания: полураспад подъёма, мс. */
  bounceSpeed: number;
  /** `true` — прыгнуть один раз и опуститься, даже если речь не кончилась. */
  bounceOnce: boolean;
  /** Как долго держится одиночный прыжок, мс (только при `bounceOnce`). */
  bounceHold: number;
  /** Угол поворота от речи, градусы 0..180. 0 — выключено. */
  dragAngle: number;
  /**
   * Длительность импульса от речи, мс. С физикой речь не давит постоянно, а
   * толкает мотор раз за всплеск: у толчка быстрый фронт (60 мс) и этот спад.
   */
  dragImpulse: number;
  /** Куда поворачивать: вправо, влево, случайно или поочерёдно. */
  dragMode: DragMode;
  /** Угол — это максимум: фактический выбирается случайно в 0..угол. */
  dragInRange: boolean;
  /** Предел отклонения от родителя влево, градусы 0..180. */
  rotationalLimitLeft: number;
  /** Предел отклонения от родителя вправо, градусы 0..180. */
  rotationalLimitRight: number;
  /** `true` — покачивание X шумом, `false` — плавной синусоидой. */
  wiggleRandom: boolean;
  /** То же для Y: у осей независимые переключатели. */
  wiggleYRandom: boolean;
  wiggleXFreq: number;
  wiggleXAmp: number;
  wiggleYFreq: number;
  wiggleYAmp: number;
  /** То же для углового покачивания — со своим переключателем. */
  wiggleRotRandom: boolean;
  wiggleRotFreq: number;
  wiggleRotAmp: number;
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
  /** Вязкость мотора физики: 0 — свободный маятник, 1 — вязкая среда. */
  physSmooth: number;
  /** Сила мотора физики: резкость (частота) пружины, 0 — мягко, 1 — резко. */
  physForce: number;
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
  bounceSpeed: 120,
  bounceOnce: false,
  bounceHold: 700,
  dragAngle: 0,
  dragImpulse: 260,
  dragMode: "right",
  dragInRange: false,
  rotationalLimitLeft: 0,
  rotationalLimitRight: 0,
  wiggleRandom: false,
  wiggleYRandom: false,
  wiggleXFreq: 0,
  wiggleXAmp: 0,
  wiggleYFreq: 0,
  wiggleYAmp: 0,
  wiggleRotRandom: false,
  wiggleRotFreq: 0,
  wiggleRotAmp: 0,
  mouth: "none",
  eye: "none",
  physRotation: null,
  physSpace: "world",
  physSmooth: 0.4,
  physForce: 0.4,
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

/** Число из пресета с зажимом в границы: битый JSON не должен ломать формулу. */
function clampNumber(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * Частота и затухание пружины по «силе» 0..1. Сила — это резкость мотора:
 * больше сила — выше частота (тянет резче) и меньше затухание (качается
 * дольше). Гасит разгулявшуюся пружину сглаживание — оно стоит перед ней в
 * цепочке, поэтому «резко дёрнуть и мягко отпустить» — рабочая комбинация.
 */
function springParams(strength: number): { frequency: number; damping: number } {
  const force = Math.min(1, Math.max(0, strength));
  return {
    frequency: 1.8 + 6.2 * force,
    damping: 0.8 - 0.55 * force,
  };
}

/**
 * Параметры мотора физики: сила — резкость (частота), плавность — вязкость
 * (затухание). При плавности 0 мотор звонкий и почти не тормозит (0.02), при 1
 * это вязкая среда (0.70): толчок гаснет за пару качков. Частота при силе 0 —
 * 1.8 Гц, при 1 — 8 Гц.
 */
function physSpringParams(force: number, smoothness: number): { frequency: number; damping: number } {
  const strength = Math.min(1, Math.max(0, force));
  const viscosity = Math.min(1, Math.max(0, smoothness));
  return {
    frequency: 1.8 + 6.2 * strength,
    damping: 0.02 + 0.68 * viscosity,
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
    && behaviour.dragAngle === 0
    && behaviour.rotationalLimitLeft === 0 && behaviour.rotationalLimitRight === 0
    && behaviour.wiggleXAmp === 0 && behaviour.wiggleYAmp === 0
    && behaviour.wiggleRotAmp === 0
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
      // Старое знаковое поле `rotationalDrag` в настройки не попадает: его
      // переводим в угол + направление, иначе оно вернулось бы в JSON.
      const { rotationalDrag: legacyDrag, ...rest } = source as Record<string, unknown>;
      const merged: Behaviour = { ...DEFAULT_BEHAVIOUR, ...(rest as Partial<Behaviour>) };
      // Старый общий предел (±N) переносим в два односторонних.
      if (typeof source.rotationalLimit === "number"
        && source.rotationalLimitLeft === undefined && source.rotationalLimitRight === undefined) {
        const magnitude = Math.abs(source.rotationalLimit);
        merged.rotationalLimitLeft = magnitude;
        merged.rotationalLimitRight = magnitude;
      }
      // Старый доворот был знаковым: минус — влево, плюс — вправо.
      if (typeof legacyDrag === "number" && legacyDrag !== 0 && source.dragAngle === undefined) {
        merged.dragAngle = Math.min(180, Math.abs(legacyDrag));
        merged.dragMode = legacyDrag < 0 ? "left" : "right";
      }
      merged.physRotation = typeof merged.physRotation === "number" ? merged.physRotation : null;
      merged.physSpace = merged.physSpace === "parent" ? "parent" : "world";
      merged.dragMode = (["right", "left", "random", "alternate"] as const)
        .includes(merged.dragMode) ? merged.dragMode : "right";
      merged.dragAngle = clampNumber(merged.dragAngle, 0, 180, 0);
      merged.bounceSpeed = clampNumber(merged.bounceSpeed, 10, 2000, 120);
      merged.bounceHold = clampNumber(merged.bounceHold, 60, 5000, 700);
      merged.wiggleRotFreq = clampNumber(merged.wiggleRotFreq, 0, 20, 0);
      merged.wiggleRotAmp = clampNumber(merged.wiggleRotAmp, 0, 180, 0);
      merged.wiggleRandom = merged.wiggleRandom === true;
      // Раньше переключатель был один на обе оси: старый пресет получает тот же
      // режим для Y, новый — синусоиду по умолчанию.
      merged.wiggleYRandom = source.wiggleYRandom === undefined
        ? merged.wiggleRandom
        : merged.wiggleYRandom === true;
      merged.wiggleRotRandom = merged.wiggleRotRandom === true;
      merged.dragImpulse = clampNumber(merged.dragImpulse, 40, 2000, 260);
      merged.physForce = clampNumber(merged.physForce, 0, 1, 0.4);
      merged.physSmooth = clampNumber(merged.physSmooth, 0, 1, 0.4);
      merged.bounceOnce = merged.bounceOnce === true;
      merged.dragInRange = merged.dragInRange === true;
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
    const random = axis === "y" ? behaviour.wiggleYRandom : behaviour.wiggleRandom;
    if (random) return `noise(${localSeed}, ${num(frequency)}) * ${num(amplitude)}`;
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
      // Скорость подъёма задаётся отдельно от фильтра позиции, поэтому
      // «резкий прыжок при вязком следовании» — рабочая комбинация.
      const rise = `smooth(mic.speak, ${num(behaviour.bounceSpeed)})`;
      // Один прыжок — это импульс: быстрый фронт минус медленный спад. Разница
      // гаснет, даже если речь не кончилась, а в тишине оба слагаемых уходят в
      // ноль, и следующий всплеск речи снова даёт прыжок.
      const shape = behaviour.bounceOnce
        ? `max(${rise} - smooth(mic.speak, ${num(Math.max(behaviour.bounceHold, behaviour.bounceSpeed))}), 0)`
        : rise;
      const hop = `${shape} * ${num(behaviour.bounce)}`;
      // Если внешнего фильтра нет, подпрыгивание сглаживает собственная пружина:
      // иначе объект дёргался бы мгновенно.
      parts.push(`- ${position ? hop : `spring(${hop}, 2.2, 0.55)`}`);
    }
    if (wiggleY) parts.push(`+ ${wiggleY}`);
    body.push(`y = ${filtered(parts.join(" "))}`);
  }

  const limitLeft = Math.max(0, behaviour.rotationalLimitLeft);
  const limitRight = Math.max(0, behaviour.rotationalLimitRight);
  const limits = limitLeft > 0 || limitRight > 0;
  const drag = behaviour.dragAngle > 0;
  const rotFilter = behaviour.rotationSmooth > 0 || behaviour.rotationSpring > 0;
  const heavy = heavyAngle(object.pivot);
  const physical = behaviour.physRotation !== null && heavy !== null;

  // Угловое покачивание — такой же генератор, как у позиции, но со своим
  // переключателем случайности: хвосту нужен шум, а маятнику — синусоида.
  const wiggleRot = ((): string | null => {
    if (behaviour.wiggleRotAmp <= 0 || behaviour.wiggleRotFreq <= 0) return null;
    const localSeed = seed + 2;
    if (behaviour.wiggleRotRandom) {
      return `noise(${localSeed}, ${num(behaviour.wiggleRotFreq)}) * ${num(behaviour.wiggleRotAmp)}`;
    }
    const phase = ((localSeed % 100) / 100) * 2 * Math.PI;
    return `sin(time * 2 * pi * ${num(behaviour.wiggleRotFreq)} + ${num(phase)}) * ${num(behaviour.wiggleRotAmp)}`;
  })();

  // Доворот от речи: угол 0..180 и отдельное направление. «Случайно» — сторона
  // выбирается заново примерно раз в 0.7 с, «поочерёдно» — жёсткое
  // перекидывание раз в 1.2 с, «в диапазоне» — угол это максимум, а фактический
  // берётся случайно из 0..угол на ту же «фразу». Куски постоянны внутри фразы:
  // случайное число на кадр дёргало бы объект вместо плавного качания.
  const phrase = `floor(time * 1.5)`;
  const dragDirection = (): string => {
    // Ноль с одной стороны — честный запрет: в эту сторону доворота нет вовсе,
    // поэтому «случайно» и «поочерёдно» не бьются о закрытый упор.
    if (limitLeft === 0 && limitRight > 0) return "1";
    if (limitRight === 0 && limitLeft > 0) return "-1";
    if (behaviour.dragMode === "left") return "-1";
    if (behaviour.dragMode === "random") return `sign(rnd(${phrase} + ${seed + 3}, -1, 1))`;
    if (behaviour.dragMode === "alternate") return `sign(cos(time * ${num(5.236)}))`;
    return "1";
  };
  const dragAmount = `${
    behaviour.dragInRange
      ? `rnd(${phrase} + ${seed + 4}, 0, ${num(behaviour.dragAngle)})`
      : num(behaviour.dragAngle)
  } * ${dragDirection()}`;
  const dragPush = `mic.speak * ${dragAmount}`;
  const deviation = [drag ? dragPush : null, wiggleRot].filter(Boolean) as string[];

  // Фильтр поворота — отдельная функция: он ставится и на наследуемый угол,
  // и на собственное отклонение. Две независимые цепочки (у каждой свой узел
  // состояния) дают честный предел: `limit` ограничивает именно отклонение от
  // родителя, а не сумму с его углом.
  const rotateFilter = (expression: string): string => {
    let result = expression;
    if (behaviour.rotationSmooth > 0) result = `smooth(${result}, ${num(behaviour.rotationSmooth * 260)})`;
    if (behaviour.rotationSpring > 0) {
      const { frequency, damping } = springParams(behaviour.rotationSpring);
      result = `spring(${result}, ${num(frequency)}, ${num(damping)})`;
    }
    return result;
  };

  if (physical || rotFilter || deviation.length) {
    let expression: string;
    if (physical) {
      // «Физика» — это мотор с почти нулевым затуханием: пружина тянет
      // «тяжёлую» сторону к углу physRotation, но качается вокруг покоя сама.
      // Речь не давит на угол постоянно, а толкает импульсом — тело получает
      // удар и дальше болтается по инерции, пока его не остановит сглаживание
      // поворота (или предел). Пивот задаёт плечо.
      const aim = behaviour.physRotation! - heavy! - object.base.rotation;
      // Мотор физики: «плавность» задаёт и частоту, и затухание. Высокая
      // плавность — вязко (движение останавливается, едва речь кончилась),
      // низкая — свободный звонкий маятник.
      const { frequency, damping } = physSpringParams(behaviour.physForce, behaviour.physSmooth);
      const parentSpace = behaviour.physSpace === "parent" && hasParent;
      // Положение покоя. Родительская система: угол задан внутри тела, поэтому
      // к нему прибавляется поворот родителя. Мировая: спрайт держит угол в
      // мире и **противостоит** повороту тела — `− inherit` как раз и держит
      // сумму «родитель + объект» постоянной.
      const rest = !hasParent
        ? num(aim)
        : parentSpace
          ? `inherit ${aim < 0 ? "-" : "+"} ${num(Math.abs(aim))}`
          : `${num(aim)} - inherit`;
      // Импульс: быстрый фронт минус медленный спад. Постоянного давления нет,
      // поэтому мотор всё время возвращает объект к покою, а толчок задаёт
      // качание — то, ради чего физика и включается.
      const kick = `max(smooth(mic.speak, 60) - smooth(mic.speak, ${num(behaviour.dragImpulse)}), 0)`;
      // Импульс не должен быть сильнее сустава: при почти нулевом затухании
      // толчок больше допуска залипает на упоре и дребезжит между сторонами.
      // Ноль с одной стороны — честный запрет: толкаем только в разрешённую.
      const room = [limitLeft, limitRight].filter((value) => value > 0);
      const reach = limits ? Math.min(behaviour.dragAngle, Math.min(...room)) : behaviour.dragAngle;
      const impulse = drag ? `${kick} * ${num(reach)} * ${dragDirection()}` : null;
      const push = [impulse, wiggleRot].filter(Boolean).join(" + ");
      const inner = `spring(${rest}${push ? ` + ${push}` : ""}, ${num(frequency)}, ${num(damping)})`;
      // С физикой работает только сглаживание — как трение после мотора.
      // «Пружина поворота» тут не участвует: второй пружинный контур подряд
      // гасит первый. Предел — на отклонение от родителя.
      // «Сглаживание поворота» с физикой работает как трение: мотор тянет,
      // но движение выходит вязким. smooth не перелетает цель, поэтому предел,
      // посчитанный выше, остаётся честным.
      const filtered = behaviour.rotationSmooth > 0
        ? `smooth(${inner}, ${num(behaviour.rotationSmooth * 260)})`
        : inner;
      expression = limits
        ? `${rest} + limit(${filtered} - (${rest}), ${num(-limitLeft)}, ${num(limitRight)})`
        : filtered;
    } else if (deviation.length) {
      const rest = hasParent ? "inherit" : "0";
      let dev = deviation.join(" + ");
      // Без поворотного фильтра у доворота своя пружина: он не должен
      // появляться мгновенно.
      if (!rotFilter && drag) dev = `spring(${dev}, 2.4, 0.35)`;
      // Предел ставится на отклонение от родителя, а фильтр — на итоговый угол:
      // сглаживание и пружина поворота действуют на реакцию объекта целиком.
      const filtered = rotateFilter(`${rest} + ${dev}`);
      expression = limits
        ? `${rest} + limit(${filtered} - (${rest}), ${num(-limitLeft)}, ${num(limitRight)})`
        : filtered;
    } else {
      expression = rotateFilter(hasParent ? "inherit" : "0");
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
