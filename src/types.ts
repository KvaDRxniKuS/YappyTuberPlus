export type ParamName =
  | "x" | "y" | "rotation" | "sizeX" | "sizeY"
  | "skewX" | "skewY" | "opacity" | "visible" | "layer";

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

export interface RigObject {
  id: string;
  name: string;
  kind: "sprite" | "group";
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

export interface RigFrame {
  seq: number;
  time: number;
  dt: number;
  globals: Record<string, number>;
  objects: Record<string, ObjectFrame>;
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
}

/**
 * Реализация модуля в коде. Шаблоны из папки `modules` описывают входы и
 * настройки, а поведение выбирается по этому полю.
 */
export type ModuleKind =
  | "loudness" | "manual" | "autoblink" | "viseme" | "keyboard" | "key" | "mouse"
  /** Значения из сети: WebSocket (и позже HTTP/OSC) по таблице отображения. */
  | "external";

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
  scale?: number;
  offset?: number;
  /** Удержание импульса, мс: события вроде «пришла награда» живут один пакет. */
  holdMs?: number;
  /** Событие Twitch, из которого пришла строка: по нему включаются подписки. */
  event?: string;
  /** Условие: правило срабатывает, только если поле в сообщении совпало. */
  when?: { path: string; equals?: string; contains?: string };
  /** Значение, если поля нет или оно не число: «событие пришло» = 1. */
  fallback?: number;
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
