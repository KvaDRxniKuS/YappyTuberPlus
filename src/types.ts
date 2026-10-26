export type ParamName =
  | "x" | "y" | "rotation" | "sizeX" | "sizeY"
  | "skewX" | "skewY" | "opacity" | "visible" | "layer"
  /** Медиа: 1 — играет, 0 — пауза. */
  | "play"
  /** Медиа: множитель скорости воспроизведения. */
  | "speed"
  /** Медиа: множитель громкости 0..1. */
  | "volume"
  /**
   * Деформация: смещение угла в процентах от размера зоны (левый верхний —
   * `warpTL`, дальше по часовой). Числа те же, что в инспекторе, поэтому
   * угол можно двигать формулой и ловить событиями.
   */
  | "warpTLx" | "warpTLy" | "warpTRx" | "warpTRy"
  | "warpBRx" | "warpBRy" | "warpBLx" | "warpBLy";

export interface Vec2 { x: number; y: number }

export interface BasePose {
  x: number;
  y: number;
  rotation: number;
  sizeX: number;
  sizeY: number;
  skewX: number;
  skewY: number;
  opacity: number;
  visible: number;
  layer: number;
}

/**
 * Вид объекта сцены.
 *
 * `media` и `text` — дочерние виды спрайта: у них те же параметры позы, пивот,
 * родитель и скрипт, но вместо картинки — файл воспроизведения или текст.
 */
export type ObjectKind = "sprite" | "group" | "media" | "text" | "shape";

/** Что делать, если событие активировало звук повторно, пока он ещё играет. */
export type MediaRepeat = "restart" | "fade" | "overlay" | "finish";

/**
 * Медиа-объект: картинка (в том числе анимированная), видео или звук.
 *
 * Все настройки — базовые значения. Скрипт может менять их параметрами
 * `play`, `speed`, `volume` и командами `play()`, `pause()`, `stop()`,
 * `seek(сек)`, `rate(x)`, `volume(x)`.
 */
export interface MediaSpec {
  /** Файл как data URL: пресет остаётся одним файлом и переносится целиком. */
  src: string | null;
  /** Чем файл является на самом деле: по MIME и расширению. */
  type: "image" | "video" | "audio";
  /** Имя файла для подписи в инспекторе. */
  fileName: string;
  /** Зациклить воспроизведение. */
  loop: boolean;
  /** Запускать сразу после включения сцены. */
  autoplay: boolean;
  /** Видео без звука. */
  muted: boolean;
  /** Базовая громкость 0..1; умножается на параметр `volume`. */
  volume: number;
  /** Базовая скорость 0.1..4; умножается на параметр `speed`. */
  speed: number;
  /** Поведение при повторной активации: прервать, затушевать, наложить, доиграть. */
  repeat: MediaRepeat;
  /** Длительность затухания при `repeat: "fade"`, секунды. */
  fade: number;
  /** Сколько копий звука разрешено при `repeat: "overlay"`. */
  voices: number;
}

/** Текстовый объект: шаблон с подстановками из текстового канала модулей. */
export interface TextSpec {
  /**
   * Текст или шаблон. `{путь}` подставляет строку из текстового канала
   * (`{twitch.chat.message}`), `{twitch.chat.user}` — автора.
   *
   * Это значение по умолчанию: скрипт объекта задаёт свою строку переменной
   * `text = "…"` (база) и переопределяет её присваиванием в блоке события до
   * «Стопа». Экранирование `'{…}'` показывает ссылку текстом, не читая модуль.
   */
  template: string;
  font: string;
  size: number;
  color: string;
  align: "left" | "center" | "right";
  bold: boolean;
  italic: boolean;
  /** Обводка: ширина 0 — без обводки. */
  strokeColor: string;
  strokeWidth: number;
  /** Межстрочный интервал, множитель высоты шрифта. */
  lineHeight: number;
}

/** Вид контура в объекте-фигуре. */
export type ShapeItemKind = "rect" | "ellipse" | "path";

/**
 * Один контур фигуры.
 *
 * Координаты — в собственных координатах объекта: левый верхний угол его
 * рамки — (0, 0), правый нижний — (`width`, `height`). Пивот, поворот и масштаб
 * действуют на фигуру так же, как на спрайт, поэтому она ведёт себя как
 * обычный объект сцены.
 */
export interface ShapeItem {
  id: string;
  kind: ShapeItemKind;
  /** Прямоугольник и эллипс: рамка. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Перо: точки контура. */
  points: Vec2[];
  /** Перо: сглаженная кривая (Catmull-Rom) вместо ломаной. */
  smooth: boolean;
  /** Перо: замкнуть контур в кольцо. */
  closed: boolean;
}

/** Фигуры объекта `kind: "shape"`: набор контуров плюс цвет заливки и обводки. */
export interface ShapeSpec {
  items: ShapeItem[];
  fill: string;
  stroke: string;
  strokeWidth: number;
  /** Рисовать фигуру в сцене; на маску это не влияет. */
  draw: boolean;
}

/** Откуда берётся маска объекта. */
export type MaskKind = "shape" | "points" | "file";

/**
 * Маска объекта: что из него видно.
 *
 * `shape` — контуры другого объекта-фигуры (он живёт в сцене, его можно
 * двигать и анимировать скриптом); `points` — многоугольник в координатах
 * самого объекта; `file` — картинка, альфа которой решает, что видно.
 */
export interface MaskSpec {
  kind: MaskKind;
  /** Объект-фигура, чьи контуры и есть маска. */
  shapeId: string;
  /** Набор точек в координатах объекта (0…ширина, 0…высота). */
  points: Vec2[];
  /** Файл-маска в хранилище (`asset:<id>`) или обычный путь. */
  file: string | null;
  /** Показать то, что снаружи контура. */
  invert: boolean;
  /** Мягкий край контура в пикселях: 0 — резкий. */
  feather: number;
}

/** Четыре угла деформации: порядок по часовой стрелке от левого верхнего. */
export type WarpCorner = "tl" | "tr" | "br" | "bl";

/**
 * Зона деформации внутри картинки: прямоугольник в её долях плюс поворот.
 *
 * Доли, а не пиксели: при замене картинки на такую же по смыслу зона остаётся
 * на месте, а размер зоны пересчитывается вместе с размером объекта.
 */
export interface WarpFrame {
  /** Левый верхний угол зоны, доли ширины и высоты картинки (0…1). */
  x: number;
  y: number;
  /** Размер зоны, доли картинки: 1 — вся картинка. */
  width: number;
  height: number;
  /** Поворот зоны вокруг её центра, градусы. */
  rotation: number;
}

/**
 * Деформация крайних точек: картинка растягивается в четырёхугольник.
 *
 * Никаких сеток и атласов: пользователь двигает четыре угла прямоугольника,
 * а рендер рисует картинку двумя треугольниками — этого достаточно, чтобы
 * получить перспективу. `frame` задаёт, какую часть картинки гнуть: остальное
 * остаётся ровным.
 */
export interface WarpSpec {
  enabled: boolean;
  frame: WarpFrame;
  /** Смещения углов в процентах размера зоны: −100…100 по каждой оси. */
  corners: Record<WarpCorner, Vec2>;
}

export interface RigObject {
  id: string;
  name: string;
  kind: ObjectKind;
  /**
   * Доступность объекта для показа. Умножается на `visible` из скрипта:
   * глаз в структуре гасит объект, не трогая его формулы.
   */
  enabled: boolean;
  image: string | null;
  parentId: string | null;
  pivot: Vec2;
  base: BasePose;
  script: string;
  width: number;
  height: number;
  /** Настройки медиа-объекта: есть только у `kind: "media"`. */
  media?: MediaSpec;
  /** Настройки текста: есть только у `kind: "text"`. */
  text?: TextSpec;
  /** Фигуры: есть только у `kind: "shape"`. */
  shape?: ShapeSpec;
  /** Маска видимости: у любого объекта, кроме группы. */
  mask?: MaskSpec;
  /** Деформация крайних точек: есть у спрайта и медиа-картинки. */
  warp?: WarpSpec;
}

export interface RuntimeConfig {
  fpsMode: "limited" | "display";
  fpsLimit: number;
}

export type OverlayScaleMode = "contain" | "cover" | "stretch" | "pixel";
export type OverlayBackground = "transparent" | "color" | "chroma";

export interface OverlayConfig {
  /**
   * Размер окна оверлея берётся из холста пресета. Ширина и высота ниже —
   * значения на случай ручного размера (`followCanvas: false`); при
   * `followCanvas` они всё равно пересчитываются из холста.
   */
  followCanvas: boolean;
  width: number;
  height: number;
  scaleMode: OverlayScaleMode;
  background: OverlayBackground;
  color: string;
  chromaColor: string;
  clickThrough: boolean;
  alwaysOnTop: boolean;
  showGuide: boolean;
}

export interface RigPreset {
  version: 2;
  name: string;
  canvas: { width: number; height: number };
  objects: RigObject[];
  globals: string;
  runtime: RuntimeConfig;
  overlay: OverlayConfig;
  /** Экземпляры модулей: именно они поставляют входы вида `<имя>.<вход>`. */
  modules: ModuleInstance[];
}

export type ObjectFrame = Record<ParamName, number>;

/** Место ошибки скрипта: строка и столбец с единицы, длина подчёркивания. */
export interface ScriptErrorInfo {
  line: number;
  column: number;
  length: number;
  message: string;
}

/**
 * Второе место той же ошибки: та же декларация видна и там.
 *
 * Конфликт имён всегда про две строки — свою и чужую. Свой скрипт редактор
 * подчёркивает, а на чужой показывает дорогу: `globals` или id объекта.
 */
export interface ScriptIssueLink {
  /** `globals` — глобальный скрипт, иначе id объекта. */
  scope: string;
  line: number;
}

/** Ошибка скрипта со вторым местом: `scriptIssues` из ответа `check`. */
export interface ScriptIssueInfo extends ScriptErrorInfo {
  related?: ScriptIssueLink | null;
  /** Спорное имя события или переменной: по нему ищутся все вхождения. */
  name?: string;
}

/** Команда воспроизведения, которую ядро отдало медиа-объекту. */
export interface MediaCue {
  /** Растёт на каждую команду: по нему видно, что команда новая. */
  cue: number;
  /** `none` — команд не было. */
  action: "none" | "play" | "resume" | "pause" | "stop" | "seek";
  /** Секунды для `seek`, иначе 0. */
  arg: number;
}

export interface RigFrame {
  seq: number;
  time: number;
  dt: number;
  globals: Record<string, number>;
  objects: Record<string, ObjectFrame>;
  /**
   * Команды медиа-объектам по id. Поля может не быть, если ядро старое —
   * тогда медиа просто живёт по параметрам `play`, `speed`, `volume`.
   */
  media?: Record<string, MediaCue>;
  /**
   * Текст объекта: база из скрипта (`text = "…"`) и переопределение из
   * событий. Если ключа нет, редактор подставляет шаблон из инспектора.
   */
  texts?: Record<string, string>;
  order: string[];
  diagnostics: string[];
}

/**
 * Значения входов, которые получает ядро.
 *
 * `values` — плоский словарь `<имя модуля>.<вход>`, например `mic.talking`.
 * Ядро не знает имён заранее: набор целиком определяется модулями.
 * `signals` — свободный канал `signal.<имя>` для плагинов и ручных сигналов.
 */
export interface InputValues {
  values: Record<string, number>;
  signals: Record<string, number>;
  /**
   * Текстовый канал входов: `<модуль>.<вход>` → последние строки.
   *
   * Числовые формулы текста не видят, поэтому чат едет отдельной картой.
   * Свежие строки идут **последними**: в скрипте `twitch.chat.message()` —
   * последнее сообщение, `(-1)` — предыдущее.
   */
  texts?: Record<string, { lines: InputTextLine[] }>;
  /**
   * Паспорт входа: подпись, границы, шаг и вид. Скрипт читает их как
   * `twitch.reward.max`, `twitch.reward.label`.
   */
  meta?: Record<string, InputMeta>;
  /**
   * Отметки активности входа: когда что-то случилось.
   *
   * Возраст считается от текущего момента и приходит из редактора: часы
   * фронтенда и ядра не связаны. По ним считаются `count(с)`, `sum(с)` и
   * `avg(с)`; вес нужен `sum` — награда за 500 бит тяжелее сообщения чата.
   */
  marks?: Record<string, InputMark[]>;
}

/** Одна отметка активности: возраст в миллисекундах и вес события. */
export interface InputMark {
  ageMs: number;
  weight?: number;
}

/** Строка текстового канала: сообщение и его автор. */
export interface InputTextLine {
  text: string;
  author?: string;
}

/** Границы и подпись входа — то, что раньше знал только редактор. */
export interface InputMeta {
  label: string;
  min: number;
  max: number;
  step: number;
  kind: string;
}

/**
 * Реализация модуля в коде. Шаблоны из папки `modules` описывают входы и
 * настройки, а поведение выбирается по этому полю.
 */
export type ModuleKind =
  | "loudness" | "manual" | "autoblink" | "viseme" | "keyboard" | "key" | "mouse"
  /** Значения из сети: WebSocket (и позже HTTP/OSC) по таблице отображения. */
  | "external"
  /** Пресеты одежды и эмоций: список, переменная и события из наград. */
  | "presets";

/**
 * Транспорт внешнего источника.
 *
 * `ws` живёт в окне и работает и в браузере, и в приложении. `http`, `sse` и
 * `osc` выполняет Rust: только так запросы идут мимо CORS, а UDP вообще доступен
 * лишь из нативного слоя.
 */
export type ExternalSourceTransport = "ws" | "http" | "sse" | "osc" | "twitch";

/** Правило отображения: поле JSON → вход модуля. */
export interface ExternalSourceRule {
  /** Имя входа: в скрипте это `<модуль>.<input>`. */
  input: string;
  /** Путь в сообщении: `$.value`, `$.data.bpm`, `$.items[0].n`. */
  path: string;
  label?: string;
  kind?: "level" | "db" | "flag";
  min?: number;
  max?: number;
  /** Шаг изменения значения; пусто — по виду входа (`flag` → 1, иначе 0.01). */
  step?: number;
  /**
   * Длительность значения: сколько миллисекунд вход помнит пришедшее число,
   * потом ноль.
   *
   * Пакет источника — это мгновение: «пришла награда» приходит один раз и только
   * в нём есть стоимость. Без удержания вход либо мигнул бы на один кадр, либо
   * залип на последнем числе до следующего пакета.
   */
  holdMs?: number;
  /** Событие Twitch, из которого пришла строка: по нему включаются подписки. */
  event?: string;
  /** Условие: правило срабатывает, только если поле в сообщении совпало. */
  when?: { path: string; equals?: string; contains?: string; ignoreCase?: boolean };
  /** Значение, если поля нет или оно не число: «событие пришло» = 1. */
  fallback?: number;
  /** Счётчик: каждый подходящий пакет увеличивает значение на 1. */
  count?: boolean;
}

/**
 * Текст из источника (чат). В формулы он не попадает — там только числа, —
 * поэтому отображается в панели «Входы» и в журнале.
 */
export interface ExternalTextConfig {
  path: string;
  /** Поле с именем автора: показывается рядом с текстом. */
  authorPath?: string;
  /**
   * Вход, к которому относится текст: `chat` у Twitch. По нему скрипт
   * читает `twitch.chat.message`, поэтому имя должно совпадать с входом.
   */
  input?: string;
  /** Сколько последних строк держать: столько видно в панели и в скрипте. */
  history?: number;
  /**
   * Срок хранения строки в секундах: старая строка пропадает, даже если новых
   * сообщений нет. `0` — не ограничивать по времени, только по количеству.
   */
  retainSeconds?: number;
  /** Показывать автора рядом с текстом в панели «Входы». */
  showAuthor?: boolean;
}

/** Внешний источник в настройках экземпляра (`config.source`). */
export interface ExternalSourceConfig {
  transport: ExternalSourceTransport;
  /** Адрес: `ws://127.0.0.1:17801/inputs`, `wss://…`. */
  url: string;
  /** Сообщение сразу после подключения (JSON-строка): подписка или авторизация. */
  subscribe?: string;
  mapping: ExternalSourceRule[];
  /** Переподключаться при обрыве; по умолчанию да. */
  reconnect?: boolean;
  /** Пауза между опросами для `http`, мс (100…600000). */
  intervalMs?: number;
  /** Twitch: Client ID приложения. Не секрет, поэтому живёт в пресете. */
  clientId?: string;
  /** Twitch: логин канала, за событиями которого следим. */
  channel?: string;
  /** Откуда брать текст для показа в панели (чат, награды). */
  text?: ExternalTextConfig;
}

/** Идентификатор шаблона модуля: `loudness`, `autoblink`, `manual`, `viseme`… */
export type ModuleType = string;

/** Откуда экземпляр берёт значения: с микрофона или из ползунков. */
export type ModuleSource = "live" | "manual";

/**
 * Настройки экземпляра. Ключи задаёт шаблон модуля (`fields` в JSON),
 * поэтому набор открытый.
 */
/** Клавиша в клавиатурном модуле: код и имя входа. */
export interface KeyboardKey {
  /** `event.code`: `Space`, `KeyA`, `ShiftLeft`. Не зависит от раскладки. */
  code: string;
  /** Имя входа: `keyboard.space`. */
  name: string;
}

/** Дополнительная кнопка мыши: `back`, `forward`, `button7` и имя входа. */
export interface MouseButton {
  /** Кнопка мыши: `back` (Mouse 4), `forward` (Mouse 5), `button7`… */
  button: string;
  /** Имя входа: `cursor.back`. */
  name: string;
}

/** Одна визема экземпляра: имя в скрипте, подпись и эталонный спектр. */
export interface VisemeEntry {
  /** Имя входа: `viseme.a`, `viseme.o_umlaut`. Только латиница. */
  name: string;
  /** Как показывать в панели: `ö`, `a`. */
  label: string;
  /** Эталонные спектры (варианты произношения): 32 числа, единичная длина. */
  templates: number[][];
}

/**
 * Состояние ручного модуля в режиме `enum`: имя для скрипта и подпись для
 * панели. Номер состояния — это и есть значение входа `manual.value`.
 */
export interface EnumState {
  /** Имя входа: `mode.idle`, `mode.walk`. Только латиница, цифры и `_`. */
  name: string;
  /** Как показывать в панели: «Покой», «Идёт». */
  label: string;
}

export interface ModuleConfig {
  /** Идентификатор устройства из `navigator.mediaDevices`. */
  deviceId?: string;
  /** Множитель уровня до расчёта входов. */
  gain?: number;
  /** Порог речи в дБ для `talking`. */
  threshold?: number;
  /** Обработка браузера: эхоподавление, шумоподавление, АРУ. */
  processing?: boolean;
  /** Виземы экземпляра: список входов задаётся настройками, а не шаблоном. */
  visemes?: VisemeEntry[];
  /** Клавиши клавиатурного модуля: тоже список экземпляра. */
  keys?: KeyboardKey[];
  /** Код клавиши у модуля «одна клавиша»: `Space`, `KeyA`. Пусто — бинда нет. */
  code?: string;
  /** Дополнительные кнопки мыши: список экземпляра. */
  buttons?: MouseButton[];
  /** Состояния ручного модуля в режиме `enum`: список экземпляра. */
  states?: EnumState[];
  /** Настройки внешнего источника (модуль `external`). */
  source?: ExternalSourceConfig;
  /** Нормализовать сумму визем к 1. */
  normalize?: boolean;
  /** Порог слышимости для визем, дБ. */
  gate?: number;
  [key: string]:
    | number | string | boolean
    | string[]
    | VisemeEntry[] | KeyboardKey[] | MouseButton[] | EnumState[]
    | ExternalSourceConfig
    | undefined;
}

/** Экземпляр модуля. Имя — префикс входов: `mic` → `mic.talking`. */
export interface ModuleInstance {
  /** Уникальное имя латиницей: буквы, цифры и `_`; точка в скрипте. */
  name: string;
  type: ModuleType;
  enabled: boolean;
  source: ModuleSource;
  config: ModuleConfig;
  /**
   * Выключенные входы. Такой вход не считается и не уходит в кадр вовсе:
   * ядро сообщит «неизвестное имя», если скрипт его всё-таки читает.
   */
  disabledInputs?: string[];
}

/** Геометрические подсказки в сцене: выключены, только выделенное или всё. */
export type GuideMode = "off" | "selected" | "all";

export const GUIDE_MODES: GuideMode[] = ["off", "selected", "all"];

export const GUIDE_LABEL: Record<GuideMode, string> = {
  off: "выкл",
  selected: "только выделенные",
  all: "все",
};

export function nextGuideMode(mode: GuideMode): GuideMode {
  return GUIDE_MODES[(GUIDE_MODES.indexOf(mode) + 1) % GUIDE_MODES.length];
}

export interface EditorLayout {
  leftWidth: number;
  rightWidth: number;
  sceneHeight: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  showBounds: GuideMode;
  showPivots: GuideMode;
}

export const DEFAULT_INPUTS: InputValues = { values: {}, signals: {} };

/** Набор модулей нового пресета: микрофон и ручные входы. */
/** Стартовый набор нового пресета: микрофон, авто-моргание и ручной вход. */
export const DEFAULT_MODULES: ModuleInstance[] = [
  {
    name: "mic",
    type: "loudness",
    enabled: true,
    source: "live",
    config: { gain: 1, threshold: -43, processing: false },
  },
  {
    name: "auto",
    type: "autoblink",
    enabled: true,
    source: "manual",
    config: { period: 4200, hold: 140, jitter: 35, min: 0, max: 1 },
  },
  {
    name: "manual",
    type: "manual",
    enabled: true,
    source: "manual",
    config: { mode: "number", min: 0, max: 1, step: 0.01 },
  },
];

export const DEFAULT_LAYOUT: EditorLayout = {
  leftWidth: 248,
  rightWidth: 440,
  sceneHeight: 420,
  leftCollapsed: false,
  rightCollapsed: false,
  showBounds: "selected",
  showPivots: "selected",
};

export const DEFAULT_OVERLAY: OverlayConfig = {
  // По умолчанию окно оверлея совпадает с холстом: риг виден 1:1 и не нужно
  // подбирать размеры руками, а изменение размера холста тянет окно за собой.
  followCanvas: true,
  width: 900,
  height: 620,
  scaleMode: "contain",
  background: "transparent",
  color: "#17191d",
  chromaColor: "#00ff00",
  clickThrough: false,
  alwaysOnTop: true,
  showGuide: false,
};

export const DEFAULT_BASE: BasePose = {
  x: 500, y: 300, rotation: 0,
  sizeX: 1, sizeY: 1, skewX: 0, skewY: 0,
  opacity: 1, visible: 1, layer: 0,
};
