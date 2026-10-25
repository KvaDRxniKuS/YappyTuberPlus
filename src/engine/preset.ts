import { childScript, rootScript } from "../data/demoPreset";
import { ensureModules } from "../modules/values";
import { selectionRoots } from "./selection";
import {
  DEFAULT_BASE, DEFAULT_OVERLAY, type BasePose, type EnumState, type KeyboardKey, type MediaRepeat,
  type MediaSpec, type ModuleConfig,
  type ModuleInstance,
  type MouseButton, type ObjectKind, type OverlayConfig, type RigObject, type RigPreset, type TextSpec,
  type VisemeEntry,
} from "../types";
import { DEFAULT_MEDIA } from "../render/media";
import { DEFAULT_TEXT } from "../render/text";
import { hasModule, libraryEmpty, moduleDefaults, moduleDefinition, type ModuleField } from "../modules/registry";
import { readTemplates, sanitizeVisemeName, uniqueVisemeName } from "../modules/viseme";
import { enumConstants, sanitizeStateName, uniqueStateName } from "../modules/manual";
import { keyInputName, mouseButtons, uniqueButtonName, uniqueKeyName } from "../modules/pointer";

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

/** Медиа-объект: те же параметры позы, что у спрайта, плюс данные воспроизведения. */
export function makeMedia(
  id: string,
  name: string,
  media: Partial<MediaSpec>,
  width: number,
  height: number,
  x: number,
  y: number,
): RigObject {
  return {
    id, name, kind: "media", enabled: true, image: null, parentId: null,
    pivot: { x: 0.5, y: 0.5 }, base: { ...DEFAULT_BASE, x, y }, width, height,
    script: rootScript(), media: { ...DEFAULT_MEDIA, ...media },
  };
}

/** Текстовый объект: рамка задаёт ширину переноса и точку вращения. */
export function makeText(
  id: string,
  name: string,
  text: Partial<TextSpec>,
  width: number,
  height: number,
  x: number,
  y: number,
): RigObject {
  return {
    id, name, kind: "text", enabled: true, image: null, parentId: null,
    pivot: { x: 0.5, y: 0.5 }, base: { ...DEFAULT_BASE, x, y }, width, height,
    script: rootScript(), text: { ...DEFAULT_TEXT, ...text },
  };
}

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "jfif", "webp", "gif", "apng", "avif", "bmp"];
const VIDEO_EXTENSIONS = ["mp4", "webm", "mov", "mkv", "m4v", "avi"];
const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"];

/**
 * Чем является выбранный файл по MIME и расширению.
 *
 * `null` — «непонятно»: MIME в WebView2 приходит не для всех контейнеров
 * (например, `.mkv` может прийти пустым). В этом случае решает содержимое —
 * `sniffContainer` в `importFile.ts` смотрит сигнатуры байт, поэтому видео
 * никогда не превращается в спрайт с ошибкой декодирования.
 */
export function mediaTypeOf(file: File): MediaSpec["type"] | null {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("image/")) return "image";
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  if (VIDEO_EXTENSIONS.includes(extension)) return "video";
  if (AUDIO_EXTENSIONS.includes(extension)) return "audio";
  if (IMAGE_EXTENSIONS.includes(extension)) return "image";
  return null;
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

const MEDIA_TYPES: MediaSpec["type"][] = ["image", "video", "audio"];
const MEDIA_REPEATS: MediaRepeat[] = ["restart", "fade", "overlay", "finish"];

function finite(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Настройки медиа: неизвестные поля отбрасываются, числа держатся в границах. */
export function normalizeMedia(raw: unknown): MediaSpec {
  const source = raw && typeof raw === "object" ? raw as Partial<MediaSpec> : {};
  return {
    src: typeof source.src === "string" && source.src ? source.src : null,
    type: MEDIA_TYPES.includes(source.type as MediaSpec["type"]) ? source.type as MediaSpec["type"] : "image",
    fileName: typeof source.fileName === "string" ? source.fileName : "",
    loop: source.loop !== false,
    autoplay: source.autoplay === true,
    muted: source.muted === true,
    volume: finite(source.volume, 1, 0, 1),
    speed: finite(source.speed, 1, 0.1, 4),
    repeat: MEDIA_REPEATS.includes(source.repeat as MediaRepeat) ? source.repeat as MediaRepeat : "restart",
    fade: finite(source.fade, 0.25, 0, 10),
    voices: Math.round(finite(source.voices, 4, 1, 8)),
  };
}

/** Настройки текста: шрифт, размер и цвет всегда в пригодном виде. */
export function normalizeText(raw: unknown): TextSpec {
  const source = raw && typeof raw === "object" ? raw as Partial<TextSpec> : {};
  return {
    template: typeof source.template === "string" ? source.template : DEFAULT_TEXT.template,
    font: typeof source.font === "string" && source.font.trim() ? source.font.trim() : DEFAULT_TEXT.font,
    size: finite(source.size, DEFAULT_TEXT.size, 4, 400),
    color: typeof source.color === "string" && source.color ? source.color : DEFAULT_TEXT.color,
    align: source.align === "left" || source.align === "right" ? source.align : "center",
    bold: source.bold !== false,
    italic: source.italic === true,
    strokeColor: typeof source.strokeColor === "string" && source.strokeColor ? source.strokeColor : DEFAULT_TEXT.strokeColor,
    strokeWidth: finite(source.strokeWidth, DEFAULT_TEXT.strokeWidth, 0, 24),
    lineHeight: finite(source.lineHeight, DEFAULT_TEXT.lineHeight, 0.5, 3),
  };
}

export function normalizePreset(value: unknown): RigPreset | null {
  if (!value || typeof value !== "object") return null;
  const preset = value as Partial<RigPreset>;
  if (preset.version !== 2 || !Array.isArray(preset.objects) || !preset.canvas) return null;
  return ensureModules({
    version: 2,
    name: preset.name || "Без названия",
    canvas: { width: Number(preset.canvas.width) || 1000, height: Number(preset.canvas.height) || 600 },
    objects: preset.objects.map((object) => {
      const kind: ObjectKind = object.kind === "group" || object.kind === "media" || object.kind === "text"
        ? object.kind
        : "sprite";
      return {
        ...object,
        kind,
        enabled: object.enabled !== false,
        base: { ...DEFAULT_BASE, ...object.base },
        pivot: object.pivot || { x: 0.5, y: 0.5 },
        width: object.width || 1,
        height: object.height || 1,
        script: object.script || (object.parentId ? childScript() : rootScript()),
        // Поля медиа и текста есть только у своего вида объекта: так пресет не
        // копит мусор от смены вида и остаётся читаемым в JSON.
        media: kind === "media" ? normalizeMedia(object.media) : undefined,
        text: kind === "text" ? normalizeText(object.text) : undefined,
      };
    }),
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
    // Эталоны читаются терпимо: массив, `Float32Array`-подобный объект, строка,
    // другая длина и старое поле `template`. Выбрасывать записанный звук из-за
    // формы хранения нельзя — это данные пользователя, они не восстанавливаются.
    const templates = readTemplates(entry.templates, entry.template);
    entries.push({
      name,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim().slice(0, 12) : name,
      templates,
    });
  }
  return entries;
}

/**
 * Состояния ручного модуля (`mode: "enum"`): имя для скрипта и подпись.
 * Список живёт в настройках экземпляра, поэтому нормализуется отдельно —
 * иначе общая нормализация полей выбросила бы массив.
 */
function normalizeEnumStates(raw: unknown): EnumState[] {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(source.states) ? source.states : [];
  const states: EnumState[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const name = uniqueStateName(states, sanitizeStateName(typeof entry.name === "string" ? entry.name : ""));
    states.push({
      name,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim().slice(0, 24) : name,
    });
  }
  return states;
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

/** Дополнительные кнопки мыши: имена латиницей, без повторов по кнопке и имени. */
function normalizeMouseButtons(raw: unknown): MouseButton[] {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(source.buttons) ? source.buttons : [];
  const buttons: MouseButton[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const button = typeof entry.button === "string" ? entry.button.trim() : "";
    if (!button || buttons.some((other) => other.button === button)) continue;
    const rawName = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : button;
    buttons.push({ button, name: uniqueButtonName(buttons, rawName) });
  }
  return buttons;
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
    // Режим берём из настроек или из шаблона: у старого модуля его может не быть.
    const isEnum = definition.kind === "manual"
      && (rawConfig.mode === "enum" || Array.isArray(rawConfig.states));
    const states = isEnum ? normalizeEnumStates(item.config) : null;
    const buttons = definition.kind === "mouse" || Array.isArray(rawConfig.buttons)
      ? normalizeMouseButtons(item.config)
      : null;
    const knownInputs = states
      ? ["value", ...states.map((entry) => entry.name)]
      : visemes
      ? visemes.map((entry) => entry.name)
      : keys
        ? keys.map((key) => key.name)
        : buttons
          ? [...definition.inputs.map((spec) => spec.name), ...buttons.map((item) => item.name)]
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
        // Значения шаблона — база: без них у загруженного модуля не было бы
        // даже пустого `code`, и карточка показывала бы «undefined».
        ...moduleDefaults(definition),
        ...(unknown ? rawConfig : normalizeConfig(definition.fields, item.config)),
        ...(visemes ? { visemes } : {}),
        ...(states ? { states } : {}),
        ...(keys ? { keys } : {}),
        ...(buttons ? { buttons } : {}),
        // Код клавиши — не поле шаблона, но он обязан пережить любую загрузку.
        // Пустая строка — это осознанный «бинда нет», её тоже сохраняем.
        ...(typeof rawConfig.code === "string" ? { code: rawConfig.code.trim() } : {}),
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
    // Старые пресеты получают «по размеру холста»: это ровно то поведение,
    // которого ждёт пользователь, и оно не ломает картинку — окно просто
    // совпадает с холстом.
    followCanvas: overlay.followCanvas !== false,
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
    // Имена состояний enum — часть «контракта» скрипта: переименование
    // состояния пересоздаёт движок, иначе ядро держало бы старые константы.
    constants: enumConstants(preset.modules),
    objects: preset.objects.map(({ id, kind, parentId, script, width, height, media }) => ({
      id, kind, parentId, script, width, height,
      // Ядру нужны только стартовые значения: с чего начать и как громко.
      media: media ? { autoplay: media.autoplay, speed: media.speed, volume: media.volume } : null,
    })),
  });
}

export function baseStructure(preset: RigPreset): string {
  return JSON.stringify(baseUpdates(preset));
}

export type { BasePose };

/**
 * Куда встаёт новый объект. Один выделенный — новый становится его ребёнком
 * (спрайт «прилипает» к телу, группа — к выбранному узлу). Несколько
 * выделенных — новый становится их общим родителем: группа подхватывает всю
 * пачку. Без выделения новый объект остаётся в корне сцены.
 */
export function parentNewObject(
  objects: RigObject[],
  created: RigObject[],
  selected: string[],
): RigObject[] {
  const roots = selectionRoots(objects, selected);
  if (roots.length === 1) {
    const parent = roots[0];
    return objects.map((object) => (created.includes(object) ? setParent(object, parent) : object));
  }
  // Один новый объект на несколько выделенных — единственный случай, когда
  // «стать родителем» однозначно: два новых спрайта не могут оба быть родителем.
  if (roots.length > 1 && created.length === 1) {
    const parent = created[0].id;
    // Общий родитель выделенных: новый объект встаёт внутрь него, а не в корень,
    // иначе группа выпрыгивает из тела, в котором лежали все выбранные.
    const parents = new Set(roots.map((id) => objects.find((object) => object.id === id)?.parentId ?? null));
    const common = parents.size === 1 ? [...parents][0] : null;
    const nested = objects.map((object) => {
      if (roots.includes(object.id)) return setParent(object, parent);
      if (object.id === parent && common) return setParent(object, common);
      return object;
    });
    return nested;
  }
  return objects;
}

/** Точка, вокруг которой ставится новая группа: центр выделения, иначе центр холста. */
export function groupSpot(preset: RigPreset, selected: string[]): { x: number; y: number } {
  const picked = preset.objects.filter((object) => selected.includes(object.id));
  if (!picked.length) {
    return { x: Math.round(preset.canvas.width / 2), y: Math.round(preset.canvas.height / 2) };
  }
  return {
    x: Math.round(picked.reduce((sum, object) => sum + object.base.x, 0) / picked.length),
    y: Math.round(picked.reduce((sum, object) => sum + object.base.y, 0) / picked.length),
  };
}

