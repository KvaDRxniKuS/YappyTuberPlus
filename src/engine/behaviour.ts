import type { RigObject, Vec2 } from "../types";
import { BEHAVIOUR_META, readVisibilitySources, type VisibilitySource } from "./visibility";

/**
 * Поведение объекта — это «пресет» в духе PNGTuber: несколько ползунков,
 * которые превращаются в обычные формулы скрипта.
 *
 * Истина — сам скрипт: настройки лежат JSON-строкой в комментарии внутри
 * блока, а формулы ниже блока читаются ядром. Поэтому вкладка «Поведение» и
 * вкладка «Объект» всегда показывают одно и то же, а продвинутый автор может
 * удалить блок и писать руками.
 *
 * Блок — **добавка**, а не переопределение: он пишет каналы `<параметр>_behaviour`,
 * а параметр складывает канал с авторским кодом (`x = inherit + x_behaviour + …`).
 * Поэтому ползунки не стирают формулы, а формулы не спорят с ползунками.
 *
 * Важное правило генератора: сглаживание и пружина стоят **последними** в
 * цепочке и по умолчанию фильтруют только добавку — `follow`, покачивание и
 * подпрыгивание, без `inherit`. Так объект не «тормозит» за родителем; галочка
 * «сглаживать и наследство» возвращает прежнее ощущение, фильтруя сумму и
 * вычитая из неё `inherit`.
 */

export type VisibilityRule = "none" | "open" | "closed";

/**
 * Видимость по пресетам: объект показывается только при выбранных пресетах
 * или, наоборот, при всех, кроме них.
 *
 * `variable` и `module` — снимок настроек на момент правки: генератору нужно
 * написать формулу `preset == presets_1_summer`, а списка модулей у него нет.
 */
export interface PresetRule {
  /** Имя модуля пресетов: по нему панель находит список пресетов. */
  module: string;
  /** Переменная пресета в скрипте. */
  variable: string;
  mode: "only" | "except";
  /** Имена пресетов; в скрипте — полные константы `<модуль>_<имя>`. */
  names: string[];
}

/** Координаты, в которых физика поворота держит «тяжёлую» сторону. */
export type PhysSpace = "world" | "parent";

/** Куда доворачивать объект от речи. */
export type DragMode = "right" | "left" | "random" | "alternate";

/** Форма предела следования за мышью: эллипс или прямоугольник. */
export type FollowShape = "ellipse" | "rect";

export interface Behaviour {
  /** Сглаживание позиции: 0 — без фильтра, 1 — сильно отстаёт. */
  smooth: number;
  /** Упругость позиции: 0 — выключено, 1 — мягкая пружина. */
  spring: number;
  /**
   * Сглаживать и наследство: фильтр позиции и поворота охватывает движение
   * родителя. По умолчанию нет — блок поведения это добавка, и объект не
   * «тормозит» за родителем, пока об этом не попросят.
   */
  smoothInherit: boolean;
  /** Сглаживание поворота. */
  rotationSmooth: number;
  /** Пружина на повороте. */
  rotationSpring: number;
  /** Скаляр размера по X к базовому размеру спрайта (1 — как в инспекторе). */
  scaleX: number;
  /** Скаляр размера по Y: тем же полем удобно править высоту, не заходя в инспектор. */
  scaleY: number;
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
  /**
   * Имя модуля микрофона, чьи входы читает поведение: `mic.speak`,
   * `mic.talking`. Пусто — речевых формул нет вовсе.
   *
   * Имя хранится снимком, как у мыши и пресетов: модуль можно переименовать
   * или выбрать второй микрофон, и формулы поедут за ним. Жёсткое `mic`
   * ломалось бы, стоило пересоздать модуль — новый получил бы имя `loudness`.
   */
  voiceModule: string;
  /** Имя модуля моргания, чей вход читает видимость глаза. */
  eyeModule: string;
  /**
   * Имя вывода внутри этого модуля: `blink`, `blink_2`…
   *
   * У модуля моргания выводов может быть несколько, и «глаз» — не обязательно
   * первый. Имя хранится снимком, как имя модуля: переименование вывода в
   * настройках не оставит формулу смотреть в пустоту — панель предложит выбор.
   */
  eyeInput: string;
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
  /** Условия видимости по пресетам одежды и эмоций. */
  presets: PresetRule[];
  /**
   * Источники видимости — множители, которые редактор считает сам.
   *
   * В скрипт они не превращаются: `visible` и `opacity` уже заняты формулами, а
   * доля видимости должна умножать прозрачность, а не заменять её. Поэтому
   * список лежит в блоке настроек, а кадр правится на выходе из движка — так
   * одно и то же поведение видят и редактор, и оверлей.
   */
  visibility: VisibilitySource[];
  /**
   * Имя модуля мыши, за которой следует объект. Пусто — следование выключено.
   *
   * Имя хранится снимком, как у пресетов: генератору нужно написать
   * `mouse.x`, а списка модулей у него нет. Если модуль из пресета убрать,
   * следование надо выключить — иначе ядро ругалось бы на неизвестный вход.
   */
  followMouseModule: string;
  /** Доля пути к курсору: 1 — у края области объект уходит на весь предел. */
  followMouseStrength: number;
  /** Форма предела: эллипс или прямоугольник со своими шириной и высотой. */
  followMouseLimit: FollowShape;
  /**
   * Ширина предела, пиксели холста — **полный размер**, а не радиус.
   *
   * Объект ходит на половину: ширина 300 означает ±150 от покоя. Так подпись
   * «Ширина» совпадает с тем, что видно на сетке, и одна и та же цифра
   * означает одно и то же в обеих формах.
   */
  followMouseWidth: number;
  /** Высота предела, пиксели холста — тоже полный размер. */
  followMouseHeight: number;
  /** Мёртвая зона: доля хода курсора, в которой объект стоит на месте. */
  followMouseDead: number;
  /** Сглаживание следования, мс. 0 — без фильтра. */
  followMouseSmooth: number;
  /** Следовать по горизонтали. */
  followMouseAxisX: boolean;
  /** Следовать по вертикали. */
  followMouseAxisY: boolean;
  /** Инверсия: объект уходит от курсора, а не за ним. */
  followMouseInvert: boolean;
  /**
   * Доворот за мышью: сколько градусов даёт край области по горизонтали.
   *
   * Мышь по X — это «повернуться», по Y — «наклониться»: курсор правее центра
   * поворачивает объект вправо, ниже центра — наклоняет. Градусы ограничены
   * теми же пределами сустава, что и покачивание, поэтому поворот за мышью не
   * вылетает из разрешённого диапазона.
   */
  followMouseRotX: number;
  /** Доворот за мышью по вертикали, градусы на край области. */
  followMouseRotY: number;
  /** Сглаживание доворота, мс: 0 — мгновенно. */
  followMouseRotSmooth: number;
  /**
   * Мерцание света: форма волны, амплитуда и частота.
   *
   * Яркость пятна считается через обычный `opacity`, поэтому своя частота у
   * каждой лампы ничего не стоит, а «без мерцания» — это просто 0.
   */
  flickerStyle: "sine" | "noise";
  /** Глубина мерцания 0…1: 0 — ровный свет, 1 — гаснет до нуля. */
  flickerAmplitude: number;
  /** Частота мерцания, Гц: 1 — раз в секунду. */
  flickerSpeed: number;
}

export const DEFAULT_BEHAVIOUR: Behaviour = {
  smooth: 0,
  spring: 0,
  smoothInherit: false,
  rotationSmooth: 0,
  rotationSpring: 0,
  scaleX: 1,
  scaleY: 1,
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
  voiceModule: "",
  eyeModule: "",
  eyeInput: "blink",
  physRotation: null,
  physSpace: "world",
  physSmooth: 0.4,
  physForce: 0.4,
  presets: [],
  visibility: [],
  followMouseModule: "",
  followMouseStrength: 1,
  followMouseLimit: "ellipse",
  followMouseWidth: 240,
  followMouseHeight: 240,
  followMouseDead: 0,
  followMouseSmooth: 120,
  followMouseAxisX: true,
  followMouseAxisY: true,
  followMouseInvert: false,
  followMouseRotX: 0,
  followMouseRotY: 0,
  followMouseRotSmooth: 120,
  flickerStyle: "sine",
  flickerAmplitude: 0,
  flickerSpeed: 2.5,
};

const START = "// ── поведение: вкладка «Поведение» ──";
const END = "// ── конец поведения ──";
/** Маркер блока: общий с модулем видимости, который читает его на каждом кадре. */
const META = BEHAVIOUR_META;

/** Параметры, которые переписывает блок: остальное в скрипте не трогаем. */
/**
 * Параметры, у которых есть канал поведения.
 *
 * Блок больше ничего не переопределяет: он пишет `<параметр>_behaviour`, а
 * авторская строка складывает канал со своими слагаемыми. Список задаёт и
 * генератор, и склейку с хвостом скрипта, поэтому порядок здесь — порядок
 * строк по умолчанию: сначала позиция, потом размер.
 */
const CHANNEL_PARAMS = ["x", "y", "rotation", "sizeX", "sizeY", "opacity", "visible"] as const;

type ChannelParam = (typeof CHANNEL_PARAMS)[number];

/** Имя канала в скрипте: `x` → `x_behaviour`. */
function channelName(param: ChannelParam): string {
  return `${param}_behaviour`;
}

/**
 * Параметр умножается на канал, а не складывается с ним.
 *
 * Тип значения решает оператор: позиция и поворот — добавка (`+`), размер,
 * прозрачность и видимость — множитель (`*`). Нейтраль у них тоже разная
 * (0 и 1), поэтому ядро хранит её в таблице параметров.
 */
function channelMultiplicative(param: ChannelParam): boolean {
  return param === "sizeX" || param === "sizeY" || param === "opacity" || param === "visible";
}

/** Как канал встаёт в авторскую строку. */
function channelTerm(param: ChannelParam): string {
  return `${channelMultiplicative(param) ? "*" : "+"} ${channelName(param)}`;
}

/** Строка по умолчанию, если её в скрипте нет. */
function channelLine(param: ChannelParam, hasParent: boolean): string {
  const channel = channelName(param);
  if (!hasParent) return `${param} = ${channel}`;
  return channelMultiplicative(param)
    ? `${param} = inherit * ${channel}`
    : `${param} = inherit + ${channel}`;
}

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
    && behaviour.scaleX === 1 && behaviour.scaleY === 1
    && behaviour.squash === 0 && behaviour.bounce === 0
    && behaviour.dragAngle === 0
    && behaviour.rotationalLimitLeft === 0 && behaviour.rotationalLimitRight === 0
    && behaviour.wiggleXAmp === 0 && behaviour.wiggleYAmp === 0
    && behaviour.wiggleRotAmp === 0
    && behaviour.mouth === "none" && behaviour.eye === "none"
    && behaviour.voiceModule === "" && behaviour.eyeModule === "" && behaviour.eyeInput === "blink"
    && behaviour.physRotation === null && behaviour.physSpace === "world"
    && behaviour.followMouseModule === ""
    && behaviour.visibility.length === 0
    && behaviour.followMouseRotX === 0 && behaviour.followMouseRotY === 0
    && behaviour.flickerAmplitude === 0;
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
      merged.scaleX = clampNumber(merged.scaleX, 0.05, 5, 1);
      merged.scaleY = clampNumber(merged.scaleY, 0.05, 5, 1);
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
      // Следование за мышью: без имени модуля оно выключено, числа — в своих
      // границах. Битое имя (пробелы, кириллица) отбрасываем: оно станет
      // текстом скрипта.
      merged.followMouseModule = typeof source.followMouseModule === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(source.followMouseModule.trim())
        ? source.followMouseModule.trim()
        : "";
      // Форма: старые `box`/`circle` читаются как `rect`/`ellipse`.
      merged.followMouseLimit = source.followMouseLimit === "rect" || source.followMouseLimit === "box"
        ? "rect"
        : "ellipse";
      merged.followMouseStrength = clampNumber(merged.followMouseStrength, 0, 1, 1);
      // Размер предела. Старые поля (`radius`, `rangeX/Y`) переезжают в ширину
      // и высоту **тем же числом**: смысл стал «полный размер», а не «полуось»,
      // поэтому ход у готовых объектов станет вдвое меньше — это осознанное
      // решение, а не ошибка чтения.
      const legacySize = (own: unknown, radius: unknown, range: unknown, fallback: number): number => {
        if (typeof own === "number") return clampNumber(own, 2, 8000, fallback);
        if (typeof radius === "number") return clampNumber(radius, 2, 8000, fallback);
        if (typeof range === "number") return clampNumber(range, 2, 8000, fallback);
        return fallback;
      };
      merged.followMouseWidth = legacySize(source.followMouseWidth, source.followMouseRadius, source.followMouseRangeX, 240);
      merged.followMouseHeight = legacySize(source.followMouseHeight, source.followMouseRadius, source.followMouseRangeY, 240);
      merged.followMouseDead = clampNumber(merged.followMouseDead, 0, 0.9, 0);
      merged.followMouseSmooth = clampNumber(merged.followMouseSmooth, 0, 2000, 120);
      merged.followMouseAxisX = source.followMouseAxisX !== false;
      merged.followMouseAxisY = source.followMouseAxisY !== false;
      merged.followMouseInvert = merged.followMouseInvert === true;
      merged.followMouseRotX = clampNumber(merged.followMouseRotX, -180, 180, 0);
      merged.followMouseRotY = clampNumber(merged.followMouseRotY, -180, 180, 0);
      merged.followMouseRotSmooth = clampNumber(merged.followMouseRotSmooth, 0, 2000, 120);
      merged.flickerStyle = merged.flickerStyle === "noise" ? "noise" : "sine";
      merged.flickerAmplitude = clampNumber(merged.flickerAmplitude, 0, 1, 0);
      merged.flickerSpeed = clampNumber(merged.flickerSpeed, 0.05, 30, 2.5);
      // Имена модулей речи и моргания: та же проверка, что у мыши. Битое имя
      // стало бы текстом скрипта, поэтому оно превращается в пустое — тогда
      // речевые формулы просто не пишутся.
      const moduleName = (value: unknown): string => (
        typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim()) ? value.trim() : ""
      );
      merged.voiceModule = moduleName(source.voiceModule);
      merged.eyeModule = moduleName(source.eyeModule);
      // Пресеты: битые записи (старые пресеты, ручная правка JSON) отбрасываем,
      // иначе генератор написал бы в скрипт бессмысленное условие.
      merged.presets = Array.isArray(source.presets)
        ? (source.presets as PresetRule[]).filter((rule) => (
          !!rule && typeof rule.module === "string" && typeof rule.variable === "string"
          && (rule.mode === "only" || rule.mode === "except") && Array.isArray(rule.names)
        )).map((rule) => ({
          module: rule.module,
          variable: rule.variable,
          mode: rule.mode,
          names: rule.names.filter((name) => typeof name === "string" && !!name),
        }))
        : [];
      // Источники видимости: те же правила, что и у панели. Битые записи
      // отбрасываются, иначе объект гас бы от пустого множителя.
      merged.visibility = readVisibilitySources(source.visibility);
      /**
       * В блок уходят только известные ключи и в порядке `DEFAULT_BEHAVIOUR`.
       *
       * Иначе старые поля (`followMouseRadius`, `rotationalDrag`) оставались бы
       * в JSON навсегда: `merge` их сохраняет, а панель уже не знает. Блок —
       * это паспорт настроек, и он должен читаться без сюрпризов.
       */
      const known = { ...DEFAULT_BEHAVIOUR } as Behaviour;
      const writable = known as unknown as Record<string, unknown>;
      for (const key of Object.keys(known) as Array<keyof Behaviour>) {
        writable[key] = merged[key];
      }
      return known;
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

  /**
   * Речь и моргание — только через модуль.
   *
   * Вкладка «Поведение» показывает поля речи, лишь когда в пресете есть
   * микрофон, и запоминает его имя. Здесь это имя превращается во вход
   * (`mic.speak`, `voice_2.speak`). Нет модуля — нет и формул: иначе ядро
   * получило бы ссылку на несуществующий вход, а объект — «поведение»,
   * которое ничего не делает. Настройки при этом никуда не деваются: они
   * лежат в JSON-блоке и оживают, когда модуль вернут.
   */
  const voice = behaviour.voiceModule.trim();
  const eye = behaviour.eyeModule.trim();
  // Какой вывод модуля моргания считать «глазом»: имя входа, а не догадка.
  const eyeInput = behaviour.eyeInput.trim() || "blink";
  const speak = voice ? `${voice}.speak` : null;
  const talking = voice ? `(${voice}.talking > 0 or ${voice}.speak > 0.05)` : null;

  /**
   * Покачивание одной оси. «Случайно» не подменяет синусоиду шумом: шум с
   * аргументом `f` меняет значение раз в 1/f секунды, поэтому качается он
   * примерно вчетверо медленнее заказанной частоты и заметно слабее по
   * амплитуде. Вместо этого частота остаётся ровно той, что задана, а
   * случайность живёт в плавном дрейфе фазы и амплитуды — движение не
   * повторяется, ритм и размах соответствуют числам в панели.
   */
  const wobble = (localSeed: number, amplitude: number, frequency: number, random: boolean): string | null => {
    if (amplitude <= 0 || frequency <= 0) return null;
    const phase = ((localSeed % 100) / 100) * 2 * Math.PI;
    const angle = random
      ? `time * 2 * pi * ${num(frequency)} + ${num(phase)} + noise(${localSeed + 11}, 0.35) * 2.6`
      : `time * 2 * pi * ${num(frequency)} + ${num(phase)}`;
    const gain = random ? ` * (0.72 + 0.28 * abs(noise(${localSeed + 23}, 0.45)))` : "";
    return `sin(${angle}) * ${num(amplitude)}${gain}`;
  };

  const wiggle = (axis: "x" | "y", amplitude: number, frequency: number): string | null => {
    const localSeed = seed + (axis === "x" ? 0 : 1);
    const random = axis === "y" ? behaviour.wiggleYRandom : behaviour.wiggleRandom;
    return wobble(localSeed, amplitude, frequency, random);
  };

  const position = behaviour.smooth > 0 || behaviour.spring > 0;
  const bounce = behaviour.bounce > 0;
  const wiggleX = wiggle("x", behaviour.wiggleXAmp, behaviour.wiggleXFreq);
  const wiggleY = wiggle("y", behaviour.wiggleYAmp, behaviour.wiggleYFreq);

  // Фильтр ставится ПОСЛЕ сборки цели: так drag/пружина гасят и наследство
  // родителя, и покачивание, и подпрыгивание — реакцию объекта в абсолюте.
  /**
   * Фильтр добавки.
   *
   * По умолчанию сглаживается только реакция объекта: наследство родителя идёт
   * как есть, иначе объект «тормозит» за родителем, хотя его об этом не
   * просили — а поведение теперь добавка, а не переопределение.
   *
   * Галочка «сглаживать и наследство» возвращает прежнее ощущение: фильтруется
   * сумма, но канал остаётся добавкой — из отфильтрованной суммы вычитается
   * `inherit`, и `x = inherit + x_behaviour` даёт ровно отфильтрованный итог.
   */
  const filtered = (delta: string): string => {
    if (!position) return delta;
    const apply = (input: string): string => {
      let result = input;
      if (behaviour.smooth > 0) result = `smooth(${result}, ${num(behaviour.smooth * 260)})`;
      if (behaviour.spring > 0) {
        const { frequency, damping } = springParams(behaviour.spring);
        result = `spring(${result}, ${num(frequency)}, ${num(damping)})`;
      }
      return result;
    };
    if (!behaviour.smoothInherit || !hasParent) return apply(delta);
    return `(${apply(`(${delta}) + inherit`)} - inherit)`;
  };

  /**
   * Следование за мышью.
   *
   * Входы модуля — доли 0…1 внутри выбранной области, поэтому середина
   * области означает «стоять на месте»: смещение считается от 0.5 и
   * нормируется в −1…1. Дальше его ограничивает форма:
   *
   * - **эллипс** — делим смещение на полуоси, получаем «насколько вышли за
   *   край», и при выходе укорачиваем вектор до единичной окружности в этих
   *   координатах. Объект обходит эллипс целиком, а не квадрат с углами;
   * - **прямоугольник** — свой предел по каждой оси, тогда можно разрешить
   *   движение только вбок.
   *
   * Ширина и высота — **полный размер** области, поэтому полуось — половина.
   * Одна и та же цифра означает одно и то же в обеих формах.
   *
   * «Мёртвая зона» вырезает середину хода: объект стоит, пока курсор рядом с
   * центром области, и только потом начинает тянуться. Без неё мелкое дрожание
   * мыши дёргало бы спрайт постоянно.
   */
  // Пределы сустава: они ограничивают и покачивание, и доворот за мышью.
  const limitLeft = Math.max(0, behaviour.rotationalLimitLeft);
  const limitRight = Math.max(0, behaviour.rotationalLimitRight);
  const limits = limitLeft > 0 || limitRight > 0;

  const followModule = behaviour.followMouseModule.trim();
  const followRotX = Math.min(180, Math.max(-180, behaviour.followMouseRotX));
  const followRotY = Math.min(180, Math.max(-180, behaviour.followMouseRotY));
  const followRotate = followModule !== "" && (followRotX !== 0 || followRotY !== 0);
  const followOn = followModule !== ""
    && ((behaviour.followMouseStrength > 0
      && (behaviour.followMouseAxisX || behaviour.followMouseAxisY)) || followRotate);
  const follow = (() => {
    if (!followOn) return null;
    const strength = Math.min(1, Math.max(0, behaviour.followMouseStrength));
    const dead = Math.min(0.9, Math.max(0, behaviour.followMouseDead));
    const ellipse = behaviour.followMouseLimit !== "rect";
    // Полуоси: ширина и высота — полный размер области.
    const halfW = Math.max(1, behaviour.followMouseWidth / 2);
    const halfH = Math.max(1, behaviour.followMouseHeight / 2);
    /** Ход одной оси: −1…1, с мёртвой зоной и инверсией. */
    const travel = (axis: "x" | "y"): string => {
      const raw = `${followModule}.${axis}`;
      const signed = behaviour.followMouseInvert ? `(-${raw})` : raw;
      if (dead <= 0) return signed;
      // После вырезания середины остаток растягивается на весь ход: иначе
      // край области так и не давал бы полного смещения.
      return `sign(${signed}) * max(abs(${signed}) - ${num(dead)}, 0) / ${num(1 - dead)}`;
    };
    let x = behaviour.followMouseAxisX ? `${travel("x")} * ${num(halfW)} * ${num(strength)}` : "0";
    let y = behaviour.followMouseAxisY ? `${travel("y")} * ${num(halfH)} * ${num(strength)}` : "0";
    if (ellipse) {
      // Эллипс: смещение делится на полуоси, длина полученного вектора
      // показывает, насколько вышли за край. Дальше он укорачивается до
      // единицы — объект обходит эллипс, а не прямоугольник с углами.
      // Делители защищены от нуля, поэтому выключенная ось ничего не ломает.
      const nx = `((${x}) / ${num(halfW)})`;
      const ny = `((${y}) / ${num(halfH)})`;
      const length = `sqrt((${nx}) * (${nx}) + (${ny}) * (${ny}))`;
      const scale = `min(1, 1 / max(${length}, 0.0001))`;
      x = `(${x}) * ${scale}`;
      y = `(${y}) * ${scale}`;
    } else {
      x = `limit(${x}, ${num(-halfW)}, ${num(halfW)})`;
      y = `limit(${y}, ${num(-halfH)}, ${num(halfH)})`;
    }
    const ms = Math.min(2000, Math.max(0, behaviour.followMouseSmooth));
    const wrap = (expression: string) => (ms > 0 ? `smooth(${expression}, ${num(ms)})` : expression);

    /**
     * Доворот за мышью.
     *
     * Горизонталь и вертикаль складываются: курсор справа-снизу и поворачивает
     * вправо, и наклоняет. Сглаживание своё — поворот обычно вязче позиции,
     * иначе голова дёргается на каждом движении мыши. Пределы сустава
     * действуют на доворот так же, как на покачивание: доворот входит в общее
     * отклонение, а `limit` ниже держит его внутри сустава.
     */
    let rotation: string | null = null;
    if (followRotate) {
      const parts = [
        followRotX !== 0 ? `${travel("x")} * ${num(followRotX)}` : null,
        followRotY !== 0 ? `${travel("y")} * ${num(followRotY)}` : null,
      ].filter(Boolean) as string[];
      const rotMs = Math.min(2000, Math.max(0, behaviour.followMouseRotSmooth));
      let expression = parts.join(" + ");
      if (rotMs > 0) expression = `smooth(${expression}, ${num(rotMs)})`;
      // Свой `limit` тут не нужен: пределы сустава ставятся ниже на всё
      // отклонение от покоя, вместе с покачиванием и доворотом от речи.
      rotation = expression;
    }

    return {
      x: behaviour.followMouseStrength > 0 && behaviour.followMouseAxisX ? wrap(x) : null,
      y: behaviour.followMouseStrength > 0 && behaviour.followMouseAxisY ? wrap(y) : null,
      rotation,
    };
  })();

  const target = (axis: "x" | "y") => {
    // Наследство в добавку не входит: его складывает авторская строка
    // (`x = inherit + x_behaviour`), поэтому канал можно править, не боясь
    // стереть чужой код.
    const parts: string[] = [];
    if (hasParent) parts.push(`follow(offset, parent).${axis}`);
    const extra = follow ? follow[axis] : null;
    if (extra) parts.push(`(${extra})`);
    // Пусто — значит добавки нет: «0 + sin(…)» только мешало бы читать строку.
    return parts.join(" + ");
  };

  if (position || wiggleX || follow?.x) {
    const parts = [target("x"), wiggleX].filter(Boolean).join(" + ") || "0";
    body.push(`x_behaviour = ${filtered(parts)}`);
  }
  if (position || wiggleY || bounce || follow?.y) {
    const parts = [target("y")].filter((part, index) => index > 0 || part.length > 0);
    if (bounce && speak) {
      // Скорость подъёма задаётся отдельно от фильтра позиции, поэтому
      // «резкий прыжок при вязком следовании» — рабочая комбинация.
      const rise = `smooth(${speak}, ${num(behaviour.bounceSpeed)})`;
      // Один прыжок — это импульс: быстрый фронт минус медленный спад. Разница
      // гаснет, даже если речь не кончилась, а в тишине оба слагаемых уходят в
      // ноль, и следующий всплеск речи снова даёт прыжок.
      const shape = behaviour.bounceOnce
        ? `max(${rise} - smooth(${speak}, ${num(Math.max(behaviour.bounceHold, behaviour.bounceSpeed))}), 0)`
        : rise;
      const hop = `${shape} * ${num(behaviour.bounce)}`;
      // Если внешнего фильтра нет, подпрыгивание сглаживает собственная пружина:
      // иначе объект дёргался бы мгновенно.
      parts.push(`- ${position ? hop : `spring(${hop}, 2.2, 0.55)`}`);
    }
    if (wiggleY) parts.push(`+ ${wiggleY}`);
    body.push(`y_behaviour = ${filtered(parts.join(" ").trim() || "0")}`);
  }

  // Доворот от речи без микрофона не на что опереть: поля нет — формулы нет.
  const drag = behaviour.dragAngle > 0 && speak !== null;
  const rotFilter = behaviour.rotationSmooth > 0 || behaviour.rotationSpring > 0;
  const heavy = heavyAngle(object.pivot);
  const physical = behaviour.physRotation !== null && heavy !== null;

  // Угловое покачивание — такой же генератор, как у позиции, но со своим
  // переключателем случайности: хвосту нужен шум, а маятнику — синусоида.
  const wiggleRot = wobble(seed + 2, behaviour.wiggleRotAmp, behaviour.wiggleRotFreq, behaviour.wiggleRotRandom);

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
  const dragPush = `${speak} * ${dragAmount}`;
  const followTurn = follow?.rotation ?? null;
  const deviation = [drag ? dragPush : null, wiggleRot, followTurn].filter(Boolean) as string[];

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

  /**
   * Фильтр поворота как добавки.
   *
   * Предел сустава ставится на отклонение от родителя, а сглаживание по
   * умолчанию не трогает наследство: объект не «тормозит» за родителем, пока
   * об этом не попросили. Галочка «сглаживать и наследство» фильтрует сумму и
   * возвращает разницу, поэтому канал остаётся добавкой.
   */
  const rotateDelta = (dev: string): string => {
    if (!rotFilter) return dev;
    if (!behaviour.smoothInherit || !hasParent) return rotateFilter(dev);
    return `(${rotateFilter(`(${dev}) + inherit`)} - inherit)`;
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
      const kick = `max(smooth(${speak}, 60) - smooth(${speak}, ${num(behaviour.dragImpulse)}), 0)`;
      // Импульс не должен быть сильнее сустава: при почти нулевом затухании
      // толчок больше допуска залипает на упоре и дребезжит между сторонами.
      // Ноль с одной стороны — честный запрет: толкаем только в разрешённую.
      const room = [limitLeft, limitRight].filter((value) => value > 0);
      const reach = limits ? Math.min(behaviour.dragAngle, Math.min(...room)) : behaviour.dragAngle;
      const impulse = drag ? `${kick} * ${num(reach)} * ${dragDirection()}` : null;
      const push = [impulse, wiggleRot].filter(Boolean).join(" + ");
      // Доворот за мышью входит в цель мотора: пружина тянется к нему и не
      // спорит с ней, а предел ниже ограничивает уже полное отклонение.
      const aimTarget = [push, followTurn].filter(Boolean).join(" + ");
      const inner = `spring(${rest}${aimTarget ? ` + ${aimTarget}` : ""}, ${num(frequency)}, ${num(damping)})`;
      // С физикой работает только сглаживание — как трение после мотора.
      // «Пружина поворота» тут не участвует: второй пружинный контур подряд
      // гасит первый. Предел — на отклонение от родителя.
      // «Сглаживание поворота» с физикой работает как трение: мотор тянет,
      // но движение выходит вязким. smooth не перелетает цель, поэтому предел,
      // посчитанный выше, остаётся честным.
      const damped = behaviour.rotationSmooth > 0
        ? `smooth(${inner}, ${num(behaviour.rotationSmooth * 260)})`
        : inner;
      const absolute = limits
        ? `${rest} + limit(${damped} - (${rest}), ${num(-limitLeft)}, ${num(limitRight)})`
        : damped;
      // Абсолютный угол превращается в добавку: авторская строка сама
      // прибавит наследство.
      expression = `${absolute} - (${rest})`;
    } else if (deviation.length) {
      let dev = deviation.join(" + ");
      // Без поворотного фильтра у доворота своя пружина: он не должен
      // появляться мгновенно.
      if (!rotFilter && drag) dev = `spring(${dev}, 2.4, 0.35)`;
      const delta = rotateDelta(dev);
      // Предел — на отклонение от родителя: сумма с его углом не ограничена.
      expression = limits ? `limit(${delta}, ${num(-limitLeft)}, ${num(limitRight)})` : delta;
    } else {
      // Отклонения нет — остаётся только «провис» наследства, и лишь если его
      // попросили галочкой: иначе добавка честно равна нулю.
      expression = hasParent && behaviour.smoothInherit
        ? `${rotateFilter("inherit")} - inherit`
        : "0";
    }
    if (expression !== "0") body.push(`rotation_behaviour = ${expression}`);
  }

  /**
   * Размер — множитель, а не слагаемое: нейтраль 1, и авторская строка
   * выглядит как `sizeX = inherit * sizeX_behaviour`. Поэтому «Масштаб» из
   * инспектора и сквош живут в одном канале и не спорят с ручной формулой.
   */
  const factorX = num(behaviour.scaleX);
  const factorY = num(behaviour.scaleY);

  // Абсолютная база нужна только для прошлого сквоша: `state.sizeY` — итоговый
  // размер (наследство родителя × множитель канала), а база — тот же размер без
  // сквоша. Разность в пикселях и была прошлым сквошем; менять на долю нельзя —
  // сравнение с `abs(значение) * база` потеряло бы размерность.
  const absoluteBase = (value: number): string => {
    if (!hasParent) return num(value);
    return value === 1 ? "inherit" : `inherit * ${num(value)}`;
  };
  const baseY = absoluteBase(behaviour.scaleY);

  if (behaviour.squash !== 0 && speak) {
    // Сквош бывает отрицательным, и тогда «рост» цели означает уменьшение.
    const value = `${speak} * ${num(behaviour.squash)}`;
    const past = `abs(state.sizeY - (${baseY}))`;
    const timing = `abs(${value}) * (${baseY}) > ${past} ? ${num(behaviour.squashIn)} : ${num(behaviour.squashOut)}`;
    // Объём держим вокруг новой базы: растянулись по Y — сжались по X.
    // Множители: `2·scaleX − sizeY_behaviour·(scaleX/scaleY)`, что при равных
    // масштабах даёт ровно `2 − sizeY_behaviour`.
    const ratio = behaviour.scaleX / behaviour.scaleY;
    const ratioTerm = Math.abs(ratio - 1) < 1e-9 ? "" : ` * ${num(ratio)}`;
    body.push(
      `sizeY_behaviour = ${factorY} * (1 + smooth(${value}, ${timing}))`,
      `sizeX_behaviour = 2 * ${factorX} - sizeY_behaviour${ratioTerm}`,
    );
  } else {
    if (behaviour.scaleX !== 1) body.push(`sizeX_behaviour = ${factorX}`);
    if (behaviour.scaleY !== 1) body.push(`sizeY_behaviour = ${factorY}`);
  }

  const rules: string[] = [];
  if (talking && behaviour.mouth === "open") rules.push(`${talking} ? 1 : 0`);
  if (talking && behaviour.mouth === "closed") rules.push(`${talking} ? 0 : 1`);
  if (eye && behaviour.eye === "open") rules.push(`1 - ${eye}.${eyeInput}`);
  if (eye && behaviour.eye === "closed") rules.push(`${eye}.${eyeInput}`);
  // Пресеты: «виден только при» и «виден при всех, кроме». Пустой список —
  // это «без ограничения», поэтому условие не пишется вовсе: иначе объект
  // исчез бы у всех, кто просто добавил пресеты.
  for (const presets of behaviour.presets) {
    if (!presets.names.length) continue;
    const terms = presets.names.map((name) => `${presets.variable} == ${presets.module}_${name}`);
    const condition = terms.join(" or ");
    rules.push(presets.mode === "only" ? `(${condition} ? 1 : 0)` : `(${condition} ? 0 : 1)`);
  }
  // Видимость — тоже множитель: канал равен 1, когда объект виден, и авторская
  // строка — `visible = visible_behaviour`.
  if (rules.length) body.push(`visible_behaviour = ${rules.map((rule) => `(${rule})`).join(" * ")}`);

  // Мерцание: волна 0…1, вычтенная из полной яркости. Синус — ровное «дыхание»
  // лампы, шум — неровное, как у свечи или костра.
  const flicker = Math.min(1, Math.max(0, behaviour.flickerAmplitude));
  if (flicker > 0) {
    const speed = Math.min(30, Math.max(0.05, behaviour.flickerSpeed));
    const wave = behaviour.flickerStyle === "noise"
      ? `noise(${num(seedOf(object.id))}, ${num(speed)})`
      // Период синуса — 1 / скорость: 2π превращает герцы в радианы.
      : `sin(time * ${num(2 * Math.PI * speed)})`;
    // Прозрачность — множитель: полная яркость равна единице, и канал
    // можно умножить на любую авторскую формулу.
    body.push(`opacity_behaviour = 1 - ${num(flicker)} * (0.5 - 0.5 * ${wave})`);
  }

  // Источник можно выбрать до включения правила. Сохраняем метаданные, иначе
  // контролируемый селектор после перерисовки вернулся бы к первому модулю.
  if (!body.length && !voice && !eye && !behaviour.visibility.length) return "";
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
 * Следит, чтобы в авторских строках стояло слагаемое канала.
 *
 * Блок поведения пишет `<параметр>_behaviour`, а параметр складывает канал со
 * своим кодом. Значит, редактору нельзя «вырезать» присваивания, как раньше:
 * надо вставить терм в существующую строку, не трогая остального, а если
 * строки нет — добавить её. Сброс поведения терм убирает, но строку оставляет:
 * `x = inherit` — это ровно то же поведение, что и по умолчанию.
 *
 * Строки внутри блоков событий не трогаем: `{}` считается глубиной.
 */
function bindChannels(text: string, channels: readonly ChannelParam[], hasParent: boolean): string {
  const lines = text.split("\n");
  const done = new Set<ChannelParam>();
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (depth === 0) {
      for (const param of CHANNEL_PARAMS) {
        const match = new RegExp(`^(\\s*)${param}\\s*=\\s*(.*)$`).exec(line);
        if (!match) continue;
        const channel = channelName(param);
        let rhs = stripTerm(match[2], param);
        if (channels.includes(param)) rhs = insertTerm(rhs, channelTerm(param), channel);
        lines[index] = rhs === match[2] ? line : `${match[1]}${param} = ${rhs}`;
        done.add(param);
        break;
      }
    }
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (depth < 0) depth = 0;
  }
  const missing = channels.filter((param) => !done.has(param));
  if (missing.length) {
    const extra = missing.map((param) => channelLine(param, hasParent)).join("\n");
    const body = lines.join("\n").replace(/\s+$/, "");
    return body ? `${body}\n${extra}` : extra;
  }
  return lines.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
}

/** Убирает из правой части терм канала — только если он там есть. */
function stripTerm(rhs: string, param: ChannelParam): string {
  const channel = channelName(param);
  const trimmed = rhs.trim();
  // Строка была создана нами и состояла только из канала: возвращаем нейтраль.
  if (trimmed === channel) return channelMultiplicative(param) ? "1" : "0";
  return rhs.replace(new RegExp(`\\s*[+*]\\s*${channel}\\b`), "");
}

/**
 * Вставляет терм канала в правую часть: сразу за `inherit`, если он есть
 * (так строка читается как «наследство плюс поведение плюс моё»), иначе в конец.
 * Уже стоящий терм не дублируется.
 */
function insertTerm(rhs: string, term: string, channel: string): string {
  if (new RegExp(`\\b${channel}\\b`).test(rhs)) return rhs;
  const inherit = /\binherit\b/.exec(rhs);
  if (inherit) {
    const at = inherit.index + inherit[0].length;
    return `${rhs.slice(0, at)} ${term}${rhs.slice(at)}`;
  }
  return `${rhs.trimEnd()} ${term}`;
}

/**
 * Покачивание включает само себя: задали амплитуду — частота становится 1 Гц,
 * задали частоту — амплитуда берёт значение по умолчанию. Обнулить можно любым
 * из двух полей. Правка идёт через `patch`, поэтому «обнулить» не включает
 * обратно.
 */
export function coupleWiggle(behaviour: Behaviour, patch: Partial<Behaviour>): void {
  const couple = (
    amplitudeKey: "wiggleXAmp" | "wiggleYAmp" | "wiggleRotAmp",
    frequencyKey: "wiggleXFreq" | "wiggleYFreq" | "wiggleRotFreq",
    defaultAmplitude: number,
  ) => {
    if (patch[amplitudeKey] !== undefined && behaviour[amplitudeKey] > 0 && behaviour[frequencyKey] === 0) {
      behaviour[frequencyKey] = 1;
    }
    if (patch[frequencyKey] !== undefined && behaviour[frequencyKey] > 0 && behaviour[amplitudeKey] === 0) {
      behaviour[amplitudeKey] = defaultAmplitude;
    }
  };
  couple("wiggleXAmp", "wiggleXFreq", 8);
  couple("wiggleYAmp", "wiggleYFreq", 8);
  couple("wiggleRotAmp", "wiggleRotFreq", 10);
}

/**
 * Один и тот же патч поведения для нескольких объектов. Значения по умолчанию
 * для показа берутся у основного, но каждому объекту пишется только тронутое
 * поле — остальные его настройки сохраняются. Ключ результата — id объекта.
 */
export function writeBehaviourFor(
  targets: RigObject[],
  primary: RigObject,
  patch: Partial<Behaviour>,
): Record<string, string> {
  const shown = readBehaviour(primary.script);
  const scripts: Record<string, string> = {};
  for (const target of targets) {
    const current = target.id === primary.id ? shown : readBehaviour(target.script);
    const merged: Behaviour = { ...current, ...patch };
    coupleWiggle(merged, patch);
    scripts[target.id] = writeBehaviour(target.script, merged, target).script;
  }
  return scripts;
}

/** Сброс поведения у всего выделения: блок из каждого скрипта удаляется. */
export function resetBehaviourFor(targets: RigObject[]): Record<string, string> {
  const scripts: Record<string, string> = {};
  for (const target of targets) {
    scripts[target.id] = writeBehaviour(target.script, DEFAULT_BEHAVIOUR, target).script;
  }
  return scripts;
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
  // Какие каналы блок действительно пишет — по его собственному тексту. Канал,
  // который выключили, должен исчезнуть и из авторской строки.
  const channels = block
    ? CHANNEL_PARAMS.filter((param) => new RegExp(`^\\s*${channelName(param)}\\s*=`, "m").test(block))
    : [];
  const rest = bindChannels(tail, channels, Boolean(object.parentId));
  const body = [block, rest].filter(Boolean).join("\n\n");
  return { script: body ? `${body}\n` : "", params: [...channels] };
}
