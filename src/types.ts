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

export type ModuleType = "loudness" | "viseme" | "manual";

/** Откуда экземпляр берёт значения: с микрофона или из ползунков. */
export type ModuleSource = "live" | "manual";

export interface ModuleConfig {
  /** Идентификатор устройства из `navigator.mediaDevices`. */
  deviceId?: string;
  /** Множитель уровня до расчёта входов. */
  gain?: number;
  /** Порог речи в дБ для `talking`. */
  threshold?: number;
  /** Обработка браузера: эхоподавление, шумоподавление, АРУ. */
  processing?: boolean;
}

/** Экземпляр модуля. Имя — префикс входов: `mic` → `mic.talking`. */
export interface ModuleInstance {
  /** Уникальное имя латиницей: буквы, цифры и `_`; точка в скрипте. */
  name: string;
  type: ModuleType;
  enabled: boolean;
  source: ModuleSource;
  config: ModuleConfig;
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
  rightEditorHeight: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  showBounds: GuideMode;
  showPivots: GuideMode;
}

export const DEFAULT_INPUTS: InputValues = { values: {}, signals: {} };

/** Набор модулей нового пресета: микрофон и ручные входы. */
export const DEFAULT_MODULES: ModuleInstance[] = [
  {
    name: "mic",
    type: "loudness",
    enabled: true,
    source: "live",
    config: { gain: 1, threshold: -43, processing: false },
  },
  {
    name: "manual",
    type: "manual",
    enabled: true,
    source: "manual",
    config: {},
  },
];

export const DEFAULT_LAYOUT: EditorLayout = {
  leftWidth: 248,
  rightWidth: 440,
  sceneHeight: 420,
  rightEditorHeight: 370,
  leftCollapsed: false,
  rightCollapsed: false,
  showBounds: "selected",
  showPivots: "selected",
};

/** Пределы раскладки: те же числа, что использует перетаскивание разделителей. */
export const LAYOUT_LIMITS = {
  leftWidth: [170, 460],
  rightWidth: [300, 760],
  sceneHeight: [200, 2400],
  rightEditorHeight: [180, 2400],
} as const;

/**
 * Приводит сохранённую раскладку к допустимой.
 *
 * Раскладка лежит в localStorage и переживает пересборку приложения, поэтому
 * любое мусорное значение (NaN, строка, ширина больше окна) раньше попадало в
 * grid-template-columns и превращало рабочую область в пустоту. Здесь всё
 * нечисловое и выходящее за пределы заменяется значением по умолчанию.
 */
export function clampLayout(raw: Partial<EditorLayout> | null | undefined): EditorLayout {
  const source = raw && typeof raw === "object" ? raw : {};
  const number = (value: unknown, key: keyof typeof LAYOUT_LIMITS) => {
    const [min, max] = LAYOUT_LIMITS[key];
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_LAYOUT[key];
    return Math.min(max, Math.max(min, Math.round(parsed)));
  };
  const guide = (value: unknown, fallback: GuideMode): GuideMode =>
    (GUIDE_MODES as readonly string[]).includes(String(value)) ? (value as GuideMode) : fallback;
  return {
    leftWidth: number(source.leftWidth, "leftWidth"),
    rightWidth: number(source.rightWidth, "rightWidth"),
    sceneHeight: number(source.sceneHeight, "sceneHeight"),
    rightEditorHeight: number(source.rightEditorHeight, "rightEditorHeight"),
    leftCollapsed: source.leftCollapsed === true,
    rightCollapsed: source.rightCollapsed === true,
    showBounds: guide(source.showBounds, DEFAULT_LAYOUT.showBounds),
    showPivots: guide(source.showPivots, DEFAULT_LAYOUT.showPivots),
  };
}

export const DEFAULT_OVERLAY: OverlayConfig = {
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
