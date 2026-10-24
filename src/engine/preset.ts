import { childScript, rootScript } from "../data/demoPreset";
import { ensureModules } from "../modules/values";
import {
  DEFAULT_BASE, DEFAULT_OVERLAY, type BasePose, type KeyboardKey, type ModuleConfig, type ModuleInstance,
  type OverlayConfig, type RigObject, type RigPreset, type VisemeEntry,
} from "../types";
import { hasModule, libraryEmpty, moduleDefinition, type ModuleField } from "../modules/registry";
import { VISEME_BANDS, sanitizeVisemeName, uniqueVisemeName } from "../modules/viseme";
import { keyInputName, uniqueKeyName } from "../modules/pointer";

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

/** Приводит настройки экземпляра к полям шаблона: типы и границы. */
function normalizeConfig(fields: ModuleField[], raw: unknown): Record<string, number | string | boolean | undefined> {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const config: Record<string, number | string | boolean | undefined> = {};
  for (const field of fields) {
    const value = source[field.key] ?? field.default;
    if (field.type === "flag") {
      config[field.key] = value === true;
      continue;
    }
    if (field.type === "number") {
      const parsed = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(parsed)) { config[field.key] = field.default; continue; }
      const min = field.min ?? -Infinity;
      const max = field.max ?? Infinity;
      config[field.key] = Math.min(max, Math.max(min, parsed));
      continue;
    }
    // select/device: строка; пустое значение означает «по умолчанию».
    config[field.key] = typeof value === "string" && value ? value : field.default;
  }
  // Поля, которых нет в шаблоне, но которые были сохранены раньше, не теряем:
  // так ручные настройки не пропадают при правке JSON.
  for (const [key, value] of Object.entries(source)) {
    if (key in config) continue;
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") config[key] = value;
  }
  return config;
}

/**
 * Виземы экземпляра: имена латиницей, эталоны — векторы нужной длины.
 * Вариантов записи у одной виземы может быть сколько угодно; битые отбрасываем.
 */
function normalizeVisemesConfig(raw: unknown): VisemeEntry[] {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(source.visemes) ? source.visemes : [];
  const entries: VisemeEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const name = uniqueVisemeName(entries, sanitizeVisemeName(typeof entry.name === "string" ? entry.name : ""));
    const templates = (Array.isArray(entry.templates) ? entry.templates : [])
      .filter((template): template is unknown[] => Array.isArray(template) && template.length === VISEME_BANDS)
      .map((template) => template.map((value) => (Number.isFinite(Number(value)) ? Number(value) : 0)));
    entries.push({
      name,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim().slice(0, 12) : name,
      templates,
    });
  }
  return entries;
}

/** Клавиши клавиатурного модуля: код клавиши и уникальное имя входа. */
function normalizeKeyboardKeys(raw: unknown): KeyboardKey[] {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(source.keys) ? source.keys : [];
  const keys: KeyboardKey[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const code = typeof entry.code === "string" ? entry.code.trim() : "";
    if (!code || keys.some((key) => key.code === code)) continue;
    const rawName = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : keyInputName(code);
    keys.push({ code, name: uniqueKeyName(keys, rawName) });
  }
  return keys;
}

/** Приводит список модулей к известным шаблонам; неизвестные остаются как есть. */
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
    // Тип не подменяем: неизвестный шаблон показывается как «шаблон не найден»,
    // а не превращается молча в Manual с единственным входом `manual.value`.
    // Пока папка modules не прочитана, проверять нечего — тип сохраняется как есть.
    const rawType = typeof item.type === "string" ? item.type : "";
    const type = !rawType ? "manual" : rawType;
    const definition = moduleDefinition(type);
    // Шаблон ещё не прочитан (или его нет): настройки не трогаем вовсе. Иначе
    // нормализация по пустому набору полей выбросила бы виземы и калибровки —
    // ровно то, что случилось с настройками `manual` до этого.
    const unknown = libraryEmpty() || !hasModule(type);
    const rawConfig = item.config && typeof item.config === "object" ? { ...(item.config as ModuleConfig) } : {};
    const visemes = definition.kind === "viseme" || Array.isArray(rawConfig.visemes)
      ? normalizeVisemesConfig(item.config)
      : null;
    const keys = definition.kind === "keyboard" || Array.isArray(rawConfig.keys)
      ? normalizeKeyboardKeys(item.config)
      : null;
    const knownInputs = visemes
      ? visemes.map((entry) => entry.name)
      : keys
        ? keys.map((key) => key.name)
        : definition.inputs.map((spec) => spec.name);
    const disabled = Array.isArray(item.disabledInputs)
      ? item.disabledInputs.filter((input): input is string => typeof input === "string" && knownInputs.includes(input))
      : [];
    modules.push({
      name,
      type,
      enabled: item.enabled !== false,
      // Пока шаблон неизвестен, источник не переключаем: иначе микрофонный
      // модуль после перезагрузки молча становится «Ползунком».
      source: item.source === "manual" || (!unknown && !definition.audio) ? "manual" : "live",
      config: {
        ...(unknown ? rawConfig : normalizeConfig(definition.fields, item.config)),
        ...(visemes ? { visemes } : {}),
        ...(keys ? { keys } : {}),
        // Код клавиши — не поле шаблона, но он обязан пережить любую загрузку.
        ...(typeof rawConfig.code === "string" && rawConfig.code.trim() ? { code: rawConfig.code.trim() } : {}),
      },
      ...(disabled.length > 0 ? { disabledInputs: disabled } : {}),
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
