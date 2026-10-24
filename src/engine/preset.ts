import { childScript, rootScript } from "../data/demoPreset";
import { ensureModules } from "../modules/values";
import {
  DEFAULT_BASE, DEFAULT_OVERLAY, type BasePose, type ModuleInstance, type OverlayConfig,
  type RigObject, type RigPreset,
} from "../types";
import { isKnownModuleType, moduleDefinition } from "../modules/registry";

export function descendantIds(objects: RigObject[], id: string): Set<string> {
  const result = new Set<string>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const object of objects) {
      if (object.parentId && result.has(object.parentId) && !result.has(object.id)) {
        result.add(object.id);
        changed = true;
      }
    }
  }
  return result;
}

export function isDescendant(objects: RigObject[], id: string, possibleAncestor: string): boolean {
  let current = objects.find((object) => object.id === id)?.parentId ?? null;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    if (current === possibleAncestor) return true;
    visited.add(current);
    current = objects.find((object) => object.id === current)?.parentId ?? null;
  }
  return false;
}

export function scriptValue(script: string, parameter: string): string {
  for (const raw of script.split("\n")) {
    const line = raw.split("//")[0].trim();
    const match = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (match?.[1] === parameter) return match[2].trim();
  }
  return "";
}

export function setScriptValue(script: string, parameter: string, expression: string): string {
  let found = false;
  const lines = script.split("\n").map((raw) => {
    const match = raw.match(/^\s*([A-Za-z0-9_]+)\s*=/);
    if (match?.[1] !== parameter) return raw;
    found = true;
    return `${parameter} = ${expression}`;
  });
  if (!found) lines.push(`${parameter} = ${expression}`);
  return lines.join("\n");
}

export function makeSprite(id: string, name: string, image: string, width: number, height: number, x: number, y: number): RigObject {
  return {
    id, name, kind: "sprite", enabled: true, image, parentId: null, pivot: { x: 0.5, y: 0.5 },
    base: { ...DEFAULT_BASE, x, y }, width, height, script: rootScript(),
  };
}

export function makeGroup(id: string, name: string, x = 500, y = 300): RigObject {
  return {
    id, name, kind: "group", enabled: true, image: null, parentId: null, pivot: { x: 0.5, y: 0.5 },
    base: { ...DEFAULT_BASE, x, y }, width: 0, height: 0, script: rootScript(),
  };
}

export function uniqueId(objects: RigObject[], preferred: string): string {
  const safe = preferred.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "object";
  if (!objects.some((object) => object.id === safe)) return safe;
  let index = 2;
  while (objects.some((object) => object.id === `${safe}_${index}`)) index += 1;
  return `${safe}_${index}`;
}

const CHILD_DEFAULTS: Record<string, string> = {
  x: "inherit + follow(offset, parent).x",
  y: "inherit + follow(offset, parent).y",
  rotation: "inherit",
  sizeX: "inherit",
  sizeY: "inherit",
  skewX: "inherit",
  skewY: "inherit",
  opacity: "inherit",
  visible: "inherit",
  layer: "inherit",
};

function numericExpression(expression: string): number | null {
  if (!expression.trim()) return null;
  const value = Number(expression);
  return Number.isFinite(value) ? value : null;
}

export function setParent(object: RigObject, parentId: string | null): RigObject {
  // Changing one non-null parent for another only changes the parent namespace and offset.
  if (object.parentId !== null && parentId !== null) return { ...object, parentId };
  let script = object.script;
  for (const [parameter, childExpression] of Object.entries(CHILD_DEFAULTS)) {
    const expression = scriptValue(script, parameter);
    if (!expression) continue;
    if (parentId === null) {
      if (expression !== childExpression) continue;
      const rootValue = parameter === "visible" ? object.base.visible
        : parameter === "layer" ? object.base.layer
        : parameter === "sizeX" || parameter === "sizeY" || parameter === "opacity" ? 1 : 0;
      script = setScriptValue(script, parameter, String(rootValue));
    } else {
      const numeric = numericExpression(expression);
      const rootValue = parameter === "visible" ? object.base.visible
        : parameter === "layer" ? object.base.layer
        : parameter === "sizeX" || parameter === "sizeY" || parameter === "opacity" ? 1 : 0;
      if (numeric === rootValue) script = setScriptValue(script, parameter, childExpression);
    }
  }
  return { ...object, parentId, script };
}

export function normalizePreset(value: unknown): RigPreset | null {
  if (!value || typeof value !== "object") return null;
  const preset = value as Partial<RigPreset>;
  if (preset.version !== 2 || !Array.isArray(preset.objects) || !preset.canvas) return null;
  return ensureModules({
    version: 2,
    name: preset.name || "Без названия",
    canvas: { width: Number(preset.canvas.width) || 1000, height: Number(preset.canvas.height) || 600 },
    objects: preset.objects.map((object) => ({
      ...object,
      enabled: object.enabled !== false,
      base: { ...DEFAULT_BASE, ...object.base },
      pivot: object.pivot || { x: 0.5, y: 0.5 },
      width: object.width || 1,
      height: object.height || 1,
      script: object.script || (object.parentId ? childScript() : rootScript()),
    })),
    globals: preset.globals || "",
    runtime: {
      fpsMode: preset.runtime?.fpsMode === "display" ? "display" : "limited",
      fpsLimit: Math.min(240, Math.max(1, Math.round(preset.runtime?.fpsLimit || 60))),
    },
    overlay: normalizeOverlay(preset.overlay),
    modules: normalizeModules(preset.modules),
  });
}

/** Приводит список модулей к известным типам; чужие сохраняются как `manual`. */
export function normalizeModules(value: unknown): ModuleInstance[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const modules: ModuleInstance[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Partial<ModuleInstance>;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const type = item.type && isKnownModuleType(item.type) ? item.type : "manual";
    const config = item.config && typeof item.config === "object" ? item.config : {};
    modules.push({
      name,
      type,
      enabled: item.enabled !== false,
      source: item.source === "manual" ? "manual" : moduleDefinition(type).audio ? "live" : "manual",
      config: {
        deviceId: typeof config.deviceId === "string" ? config.deviceId : undefined,
        gain: Number.isFinite(config.gain) ? Number(config.gain) : undefined,
        threshold: Number.isFinite(config.threshold) ? Number(config.threshold) : undefined,
        processing: config.processing === true,
      },
    });
  }
  return modules;
}

const SCALE_MODES = new Set(["contain", "cover", "stretch", "pixel"]);
const BACKGROUNDS = new Set(["transparent", "color", "chroma"]);

export function normalizeOverlay(value: Partial<OverlayConfig> | undefined): OverlayConfig {
  const overlay = value || {};
  return {
    width: Math.min(7680, Math.max(120, Math.round(Number(overlay.width) || DEFAULT_OVERLAY.width))),
    height: Math.min(4320, Math.max(120, Math.round(Number(overlay.height) || DEFAULT_OVERLAY.height))),
    scaleMode: overlay.scaleMode && SCALE_MODES.has(overlay.scaleMode) ? overlay.scaleMode : DEFAULT_OVERLAY.scaleMode,
    background: overlay.background && BACKGROUNDS.has(overlay.background) ? overlay.background : DEFAULT_OVERLAY.background,
    color: typeof overlay.color === "string" ? overlay.color : DEFAULT_OVERLAY.color,
    chromaColor: typeof overlay.chromaColor === "string" ? overlay.chromaColor : DEFAULT_OVERLAY.chromaColor,
    clickThrough: overlay.clickThrough ?? DEFAULT_OVERLAY.clickThrough,
    alwaysOnTop: overlay.alwaysOnTop ?? DEFAULT_OVERLAY.alwaysOnTop,
    showGuide: overlay.showGuide ?? DEFAULT_OVERLAY.showGuide,
  };
}

export function baseUpdates(preset: RigPreset) {
  return preset.objects.map((object) => ({ id: object.id, base: object.base }));
}

export function engineStructure(preset: RigPreset): string {
  return JSON.stringify({
    canvas: preset.canvas,
    globals: preset.globals,
    objects: preset.objects.map(({ id, kind, parentId, script, width, height }) => ({ id, kind, parentId, script, width, height })),
  });
}

export function baseStructure(preset: RigPreset): string {
  return JSON.stringify(baseUpdates(preset));
}

export type { BasePose };
