import type { ModuleConfig, ModuleInstance, ModuleKind } from "../types";

/** Тип поля настроек: из него панель рисует контрол без ручного кода. */
export type ModuleFieldType = "number" | "flag" | "select" | "device";

export interface ModuleFieldOption {
  value: string;
  label: string;
}

export interface ModuleField {
  key: string;
  label: string;
  type: ModuleFieldType;
  min?: number;
  max?: number;
  step?: number;
  /** Подпись единиц измерения: `мс`, `дБ`, `×`. */
  suffix?: string;
  options?: ModuleFieldOption[];
  default?: number | string | boolean;
  /** Поле видно только при таких значениях других полей. */
  showWhen?: Record<string, number | string | boolean>;
  hint?: string;
}

export interface ModuleInputSpec {
  /** Имя входа без префикса: в скрипте выглядит как `<имя модуля>.<name>`. */
  name: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  /** `db` — децибелы (по умолчанию −60), остальное 0…1. */
  kind?: "level" | "db" | "flag";
  hint?: string;
}

/**
 * Описание модуля — то, что лежит в `public/modules/<id>.json`.
 *
 * `kind` выбирает реализацию в коде (`loudness`, `manual`, `autoblink`,
 * `viseme`): сам JSON ничего не считает, он описывает входы и настройки.
 */
export interface ModuleDefinition {
  id: string;
  title: string;
  description: string;
  kind: ModuleKind;
  /** Модуль умеет брать значения с микрофона. */
  audio?: boolean;
  inputs: ModuleInputSpec[];
  fields: ModuleField[];
  defaults: ModuleConfig;
}

const FALLBACK: ModuleDefinition = {
  id: "unknown",
  title: "Модуль",
  description: "Шаблон модуля не найден в папке modules.",
  kind: "manual",
  inputs: [],
  fields: [],
  defaults: {},
};

/** Порядок карточек в палитре: сначала источники сигнала, потом ручные. */
const ORDER = ["loudness", "viseme", "keyboard", "key", "mouse", "autoblink", "manual"];

const library = new Map<string, ModuleDefinition>();
const listeners = new Set<() => void>();
/** Загрузилась ли папка `modules` во время работы приложения. */
let libraryState: { ready: boolean; error: string | null } = { ready: false, error: null };

function readNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeField(raw: unknown): ModuleField | null {
  if (!raw || typeof raw !== "object") return null;
  const field = raw as Record<string, unknown>;
  const key = typeof field.key === "string" ? field.key.trim() : "";
  if (!key) return null;
  const type = field.type === "flag" || field.type === "select" || field.type === "device" ? field.type : "number";
  const options = Array.isArray(field.options)
    ? field.options
      .map((option) => {
        if (!option || typeof option !== "object") return null;
        const item = option as Record<string, unknown>;
        const value = String(item.value ?? "");
        return value ? { value, label: String(item.label ?? value) } : null;
      })
      .filter((option): option is ModuleFieldOption => option !== null)
    : undefined;
  const showWhen = field.showWhen && typeof field.showWhen === "object"
    ? Object.fromEntries(Object.entries(field.showWhen as Record<string, unknown>).map(([name, value]) => [name, value as string | number | boolean]))
    : undefined;
  return {
    key,
    label: typeof field.label === "string" ? field.label : key,
    type,
    min: readNumber(field.min),
    max: readNumber(field.max),
    step: readNumber(field.step),
    suffix: typeof field.suffix === "string" ? field.suffix : undefined,
    options,
    default: field.default as number | string | boolean | undefined,
    showWhen,
    hint: typeof field.hint === "string" ? field.hint : undefined,
  };
}

function normalizeInput(raw: unknown): ModuleInputSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return null;
  const kind = input.kind === "db" || input.kind === "flag" ? input.kind : "level";
  return {
    name,
    label: typeof input.label === "string" ? input.label : name,
    min: readNumber(input.min) ?? (kind === "db" ? -80 : 0),
    max: readNumber(input.max) ?? 1,
    step: readNumber(input.step),
    kind,
    hint: typeof input.hint === "string" ? input.hint : undefined,
  };
}

/** Проверяет и приводит один шаблон из JSON к описанию модуля. */
export function normalizeDefinition(raw: unknown): ModuleDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const id = typeof source.id === "string" ? source.id.trim().toLowerCase() : "";
  if (!id || !/^[a-z][a-z0-9_]*$/.test(id)) return null;
  const inputs = Array.isArray(source.inputs)
    ? source.inputs.map(normalizeInput).filter((input): input is ModuleInputSpec => input !== null)
    : [];
  const fields = Array.isArray(source.fields)
    ? source.fields.map(normalizeField).filter((field): field is ModuleField => field !== null)
    : [];
  const known: ModuleKind[] = ["loudness", "manual", "autoblink", "viseme", "keyboard", "key", "mouse"];
  const kind = known.includes(source.kind as ModuleKind) ? (source.kind as ModuleKind) : "manual";
  return {
    id,
    title: typeof source.title === "string" ? source.title : id,
    description: typeof source.description === "string" ? source.description : "",
    kind,
    audio: source.audio === true || kind === "loudness",
    inputs,
    fields,
    defaults: source.defaults && typeof source.defaults === "object" ? { ...(source.defaults as ModuleConfig) } : {},
  };
}

function sortDefinitions(list: ModuleDefinition[]): ModuleDefinition[] {
  const rank = (definition: ModuleDefinition) => {
    const index = ORDER.indexOf(definition.id);
    return index === -1 ? ORDER.length : index;
  };
  return [...list].sort((left, right) => rank(left) - rank(right) || left.title.localeCompare(right.title));
}

function commit(list: ModuleDefinition[]) {
  const next = sortDefinitions(list);
  library.clear();
  for (const definition of next) library.set(definition.id, definition);
  for (const listener of listeners) listener();
}

/**
 * Добавляет шаблоны в библиотеку вручную. Нужно тестам: в браузере шаблоны
 * читаются из папки `modules`, а в обычном Node-окружении fetch нет.
 */
export function registerDefinitions(list: ModuleDefinition[]): void {
  commit([...library.values(), ...list]);
}

/**
 * Дочитывает папку `public/modules` во время работы приложения: так новый
 * JSON-шаблон подхватывается в dev-режиме без пересборки, а после сборки
 * шаблоны просто лежат рядом с приложением.
 */
let pending: Promise<ModuleDefinition[]> | null = null;

export async function refreshLibrary(): Promise<ModuleDefinition[]> {
  // Панель и App подписываются одновременно: второй вызов ждёт первый.
  if (pending) return pending;
  pending = loadLibrary();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}

async function loadLibrary(): Promise<ModuleDefinition[]> {
  try {
    const indexResponse = await fetch("/modules/index.json", { cache: "no-cache" });
    if (!indexResponse.ok) {
      libraryState = { ready: true, error: `Папка modules не найдена (${indexResponse.status})` };
      for (const listener of listeners) listener();
      return moduleLibrary();
    }
    const index = await indexResponse.json() as { modules?: unknown };
    const ids = Array.isArray(index.modules) ? index.modules.map((id) => String(id).trim().toLowerCase()).filter(Boolean) : [];
    if (ids.length === 0) return moduleLibrary();
    const loaded: ModuleDefinition[] = [];
    for (const id of ids) {
      try {
        const response = await fetch(`/modules/${id}.json`, { cache: "no-cache" });
        if (!response.ok) continue;
        const definition = normalizeDefinition(await response.json());
        if (definition) loaded.push(definition);
      } catch { /* один битый файл не должен ломать библиотеку */ }
    }
    libraryState = loaded.length > 0
      ? { ready: true, error: null }
      : { ready: true, error: "В папке modules нет готовых шаблонов" };
    if (loaded.length > 0) commit(loaded);
  } catch (reason) {
    libraryState = { ready: true, error: `Библиотека модулей не загрузилась: ${reason instanceof Error ? reason.message : String(reason)}` };
  }
  for (const listener of listeners) listener();
  return moduleLibrary();
}

/** Готовность библиотеки и её ошибка: панель модулей показывает это как есть. */
export function libraryStatus(): { ready: boolean; error: string | null } {
  return libraryState;
}

export function moduleLibrary(): ModuleDefinition[] {
  return [...library.values()];
}

/** Список шаблонов пуст: приложение ещё не прочитало папку `modules`. */
export function libraryEmpty(): boolean {
  return library.size === 0;
}

/** Подписка на обновление библиотеки: панель модулей перерисуется сама. */
export function onLibraryChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Описание по идентификатору. Для неизвестного шаблона возвращается пустое
 * описание: модуль остаётся в пресете, но без входов и настроек.
 */
export function moduleDefinition(id: string): ModuleDefinition {
  return library.get(id) || { ...FALLBACK, id };
}

export function hasModule(id: string): boolean {
  return library.has(id);
}

/** Значение по умолчанию для входа: у децибел это тишина, у остальных ноль. */
export function inputDefault(spec: ModuleInputSpec): number {
  return spec.kind === "db" ? -60 : 0;
}

/** Настройки нового экземпляра: поля шаблона + его `defaults`. */
export function moduleDefaults(definition: ModuleDefinition): ModuleConfig {
  const config: ModuleConfig = {};
  for (const field of definition.fields) {
    if (field.default !== undefined) config[field.key] = field.default;
  }
  const merged: ModuleConfig = { ...config, ...definition.defaults };
  // Списки (состояния enum, виземы, клавиши, кнопки) копируем: иначе два
  // экземпляра одного шаблона делили бы один массив и правка одного меняла
  // бы другой.
  for (const [key, value] of Object.entries(merged)) {
    if (!Array.isArray(value)) continue;
    merged[key] = value.map((item) => (item && typeof item === "object" ? { ...item } : item)) as ModuleConfig[string];
  }
  return merged;
}

/** Поле видно, если совпали все условия `showWhen`. */
export function fieldVisible(field: ModuleField, config: ModuleConfig): boolean {
  if (!field.showWhen) return true;
  return Object.entries(field.showWhen).every(([key, value]) => config[key] === value);
}

/** Границы входа: у ручных и авто-модулей они берутся из настроек экземпляра. */
export function inputRange(module: ModuleInstance, spec: ModuleInputSpec): { min: number; max: number; step: number } {
  const config = module.config;
  const configurable = moduleDefinition(module.type).kind === "manual" || moduleDefinition(module.type).kind === "autoblink";
  if (configurable) {
    const min = readNumber(config.min) ?? spec.min;
    const max = readNumber(config.max) ?? spec.max;
    const step = readNumber(config.step) ?? spec.step ?? 0.01;
    return { min: Math.min(min, max), max: Math.max(min, max), step };
  }
  return { min: spec.min, max: spec.max, step: spec.step ?? 0.01 };
}
