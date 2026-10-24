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

export interface RigPreset {
  version: 2;
  name: string;
  canvas: { width: number; height: number };
  objects: RigObject[];
  globals: string;
  runtime: RuntimeConfig;
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

export interface InputValues {
  speak: number;
  loudness: number;
  db: number;
  talking: number;
  viseme_a: number;
  viseme_e: number;
  viseme_i: number;
  viseme_o: number;
  viseme_u: number;
  signals: Record<string, number>;
}

export interface EditorLayout {
  leftWidth: number;
  rightWidth: number;
  sceneHeight: number;
  rightEditorHeight: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

export const DEFAULT_INPUTS: InputValues = {
  speak: 0, loudness: 0, db: -60, talking: 0,
  viseme_a: 0, viseme_e: 0, viseme_i: 0, viseme_o: 0, viseme_u: 0,
  signals: {},
};

export const DEFAULT_LAYOUT: EditorLayout = {
  leftWidth: 248,
  rightWidth: 440,
  sceneHeight: 420,
  rightEditorHeight: 370,
  leftCollapsed: false,
  rightCollapsed: false,
};

export const DEFAULT_BASE: BasePose = {
  x: 500, y: 300, rotation: 0,
  sizeX: 1, sizeY: 1, skewX: 0, skewY: 0,
  opacity: 1, visible: 1, layer: 0,
};
