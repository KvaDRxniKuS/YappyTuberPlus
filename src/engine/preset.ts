import { childScript, rootScript } from "../data/demoPreset";
import { DEFAULT_BASE, type BasePose, type RigObject, type RigPreset } from "../types";

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
    id, name, kind: "sprite", image, parentId: null, pivot: { x: 0.5, y: 0.5 },
    base: { ...DEFAULT_BASE, x, y }, width, height, script: rootScript(),
  };
}

export function makeGroup(id: string, name: string, x = 500, y = 300): RigObject {
  return {
    id, name, kind: "group", image: null, parentId: null, pivot: { x: 0.5, y: 0.5 },
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
  return {
    version: 2,
    name: preset.name || "Без названия",
    canvas: { width: Number(preset.canvas.width) || 1000, height: Number(preset.canvas.height) || 600 },
    objects: preset.objects.map((object) => ({
      ...object,
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
