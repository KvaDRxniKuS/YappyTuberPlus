import type { InputMeta, InputTextLine, InputValues, ModuleInstance, RigPreset } from "../types";
import { DEFAULT_MODULES } from "../types";
import {
  hasModule, inputDefault, inputRange, libraryEmpty, moduleDefaults, moduleDefinition,
  type ModuleDefinition, type ModuleInputSpec,
} from "./registry";
import { VISEME_BASE, computeVisemes, normalizeVisemes, visemeInputs } from "./viseme";
import { enumInputs, enumStates, manualMode, stateIndex } from "./manual";
import { presetEntries, presetInputs, presetPreview } from "./presets";
import { channelValues, colorChannels, colorInputs } from "./color";
import { frameValue, type AudioFrame } from "./audio";
import { TEXT_HISTORY_DEFAULT, externalInputs, readExternalSource } from "./external";
import { textInputOf } from "./sources";
import type { ExternalTextLine } from "./sources";
import {
  keyboardKeys, keyLabel, mouseArea, mouseButtonLabel, mouseButtons, mouseSpaceOf, mouseValue,
  type PointerFrame,
} from "./pointer";

/** Полное имя входа: `mic.talking`. Именно так оно пишется в скрипте. */
export function inputKey(module: ModuleInstance, input: string): string {
  return `${module.name}.${input}`;
}

/**
 * Входы экземпляра. У обычных шаблонов они заданы в JSON, у визем список свой
 * у каждого экземпляра (пользователь добавляет и калибрует звуки сам).
 */
export function instanceInputs(module: ModuleInstance): ModuleInputSpec[] {
  const definition = moduleDefinition(module.type);
  if (definition.kind === "viseme") return visemeInputs(module);
  // Ручной модуль в режиме «Состояния» задаёт входы сам: номер + флаг на состояние.
  if (definition.kind === "manual" && manualMode(module) === "enum") return enumInputs(module);
  // Пресеты: номер выбранного в панели плюс флаг на каждый пресет.
  if (definition.kind === "presets") return presetInputs(module);
  // Внешний источник: входы задаёт таблица отображения, а не шаблон.
  if (definition.kind === "external") return externalInputs(module, definition.inputs);
  // Цвет: у каждого канала свои пять входов — `_r`, `_g`, `_b`, `_a`, `_level`.
  if (definition.kind === "color") return colorInputs(module);
  if (definition.kind === "keyboard") {
    return keyboardKeys(module).map((key) => ({
      name: key.name,
      label: keyLabel(key.code),
      min: 0,
      max: 1,
      step: 1,
      kind: "flag" as const,
      hint: `${keyLabel(key.code)} (${key.code}): 1, пока клавиша нажата`,
    }));
  }
  if (definition.kind === "mouse") {
    // К обычным полям мыши добавляются кнопки, которые выбрал пользователь.
    return [
      ...definition.inputs,
      ...mouseButtons(module).map((item) => ({
        name: item.name,
        label: mouseButtonLabel(item.button),
        min: 0,
        max: 1,
        step: 1,
        kind: "flag" as const,
        hint: `${mouseButtonLabel(item.button)}: 1, пока кнопка нажата`,
      })),
    ];
  }
  return definition.inputs;
}

/** Клавиатура, одиночная клавиша и мышь берут значения не из ползунков, а из хука. */
export function isPointerKind(kind: string): boolean {
  return kind === "keyboard" || kind === "key" || kind === "mouse";
}

export function moduleInputs(module: ModuleInstance): Array<{ key: string; spec: ModuleInputSpec }> {
  return instanceInputs(module).map((spec) => ({ key: inputKey(module, spec.name), spec }));
}

/** Включён ли конкретный вход: выключенные не считаются и не уходят в кадр. */
export function inputEnabled(module: ModuleInstance, input: string): boolean {
  return !module.disabledInputs?.includes(input);
}

/**
 * Имя модуля должно быть пригодно для скрипта: латиница, цифры и `_`,
 * первый символ — буква или `_`. Всё остальное превращается в `_`.
 */
export function sanitizeModuleName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  if (!cleaned) return "module";
  return /^[a-z_]/.test(cleaned) ? cleaned : `m_${cleaned}`;
}

/** Подбирает свободное имя: `mic`, `mic_2`, `mic_3`… */
export function uniqueModuleName(modules: Array<{ name: string }>, base: string): string {
  const clean = sanitizeModuleName(base);
  if (!modules.some((module) => module.name === clean)) return clean;
  let index = 2;
  while (modules.some((module) => module.name === `${clean}_${index}`)) index += 1;
  return `${clean}_${index}`;
}

/** Проверка списка модулей: имена уникальны и валидны. */
export function validateModules(modules: ModuleInstance[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const module of modules) {
    if (!module.name) problems.push("У модуля нет имени");
    else if (!/^[a-z_][a-z0-9_]*$/.test(module.name)) problems.push(`Имя «${module.name}» не подходит для скрипта`);
    else if (seen.has(module.name)) problems.push(`Имя «${module.name}» повторяется`);
    seen.add(module.name);
    if (!libraryEmpty() && !hasModule(module.type)) {
      problems.push(`Шаблон «${module.type}» не найден в папке modules`);
    }
  }
  return problems;
}

export type ModuleAudioValues = Record<string, AudioFrame>;

export interface ModuleSources {
  /** Живые значения по имени модуля: `{ mic: { speak: 0.4, … } }`. */
  audio: ModuleAudioValues;
  /** Ручные значения по полному имени входа: `{ "manual.value": 0.5 }`. */
  manual: Record<string, number>;
  /** Значения по таймеру (моргание и прочие авто-модули), ключ — полный. */
  auto: Record<string, number>;
  /** Клавиатура и мышь: снимок за кадр. */
  pointer?: PointerFrame;
  /** Внешние источники: `{ bridge: { hr: 72 } }` — уже с учётом правил. */
  external?: Record<string, Record<string, number>>;
  /**
   * Время кадра в миллисекундах: нужно модулю «Цвет», у которого значение —
   * функция времени. Без него берётся системное: в тестах это делает результат
   * непредсказуемым, поэтому время всегда можно передать явно.
   */
  now?: number;
  /** Секунды с прошлого кадра: `smooth` у цвета считает по нему инерцию. */
  dt?: number;
}

/**
 * Собирает плоский словарь входов: только включённые модули и только
 * включённые входы. Выключенный вход в кадр не попадает — если скрипт его
 * читает, ядро честно скажет «неизвестное имя».
 */
export function composeValues(modules: ModuleInstance[], sources: ModuleSources): Record<string, number> {
  const values: Record<string, number> = {};
  for (const module of modules) {
    if (!module.enabled) continue;
    const definition = moduleDefinition(module.type);
    const specs = instanceInputs(module);

    if (definition.kind === "keyboard") {
      const sample = sources.pointer?.keys;
      for (const key of keyboardKeys(module)) {
        if (!inputEnabled(module, key.name)) continue;
        values[inputKey(module, key.name)] = sample?.[key.code]?.down ?? 0;
      }
      continue;
    }

    if (definition.kind === "key") {
      const code = typeof module.config.code === "string" ? module.config.code : "";
      const sample = code ? sources.pointer?.keys[code] : undefined;
      for (const spec of specs) {
        if (!inputEnabled(module, spec.name)) continue;
        const value = spec.name === "hold" ? sample?.hold : spec.name === "hits" ? sample?.hits : sample?.down;
        values[inputKey(module, spec.name)] = Number.isFinite(value as number) ? (value as number) : 0;
      }
      continue;
    }

    if (definition.kind === "mouse") {
      const mouse = sources.pointer?.mouse;
      // Область чтения — свойство экземпляра: один модуль смотрит на весь
      // монитор, другой на окно приложения, третий на сцену. Пиксели экрана
      // одни и те же, меняется только начало отсчёта.
      const space = mouseSpaceOf(module.config);
      const monitorIndex = Number(module.config.monitor ?? 0);
      const area = mouseArea(space, Number.isFinite(monitorIndex) ? monitorIndex : 0, sources.pointer?.screen);
      // Инверсия Y — тоже свойство экземпляра: у одного модуля курсор «как в 2D»,
      // у другого «как в 3D», и оба живут в одном пресете.
      const invertY = module.config.invertY === true;
      for (const spec of specs) {
        if (!inputEnabled(module, spec.name)) continue;
        let value = mouseValue(mouse, spec.name, area);
        if (invertY && spec.name === "y") value = 1 - value;
        else if (invertY && spec.name === "dy") value = -value;
        values[inputKey(module, spec.name)] = Number.isFinite(value) ? value : 0;
      }
      continue;
    }

    if (definition.kind === "external") {
      // Источник отдаёт только то, что реально пришло: не пришло — ноль,
      // чтобы скрипт не читал залипшее прошлое значение.
      const sample = sources.external?.[module.name];
      for (const spec of specs) {
        if (!inputEnabled(module, spec.name)) continue;
        const value = sample?.[spec.name];
        values[inputKey(module, spec.name)] = Number.isFinite(value as number)
          ? (value as number)
          : fallbackValue(module, definition, spec);
      }
      continue;
    }

    if (definition.kind === "viseme") {
      const frame = sources.audio[module.name];
      const computed = module.source === "live"
        ? computeVisemes(module, frame?.bands, frame?.db ?? -80)
        : null;
      const local: Record<string, number> = {};
      for (const spec of specs) {
        if (!inputEnabled(module, spec.name)) continue;
        const key = inputKey(module, spec.name);
        const manual = sources.manual[key];
        local[key] = computed ? computed[spec.name] ?? 0 : Number.isFinite(manual as number) ? (manual as number) : 0;
      }
      const final = module.config.normalize === true ? normalizeVisemes(local) : local;
      Object.assign(values, final);
      continue;
    }

    // Пресеты: номер берётся из панели модуля (кнопка «Показать»), флаги
    // выводятся из него. Настоящий пресет живёт в переменной ядра и меняется
    // событиями — поэтому здесь только предпросмотр.
    if (definition.kind === "presets") {
      const index = presetPreview(module);
      for (const spec of specs) {
        if (!inputEnabled(module, spec.name)) continue;
        if (spec.name === "value") {
          values[inputKey(module, spec.name)] = index;
          continue;
        }
        const position = presetEntries(module).findIndex((entry) => entry.name === spec.name);
        values[inputKey(module, spec.name)] = position === index ? 1 : 0;
      }
      continue;
    }

    // Состояния: хранится одно число (номер выбранного), флаги выводятся из
    // него. Так панель не может показать два выбранных состояния сразу.
    if (definition.kind === "manual" && manualMode(module) === "enum") {
      const index = stateIndex(module, sources.manual[inputKey(module, "value")]);
      for (const spec of specs) {
        if (!inputEnabled(module, spec.name)) continue;
        if (spec.name === "value") values[inputKey(module, spec.name)] = index;
      }
      enumStates(module).forEach((state, position) => {
        if (!inputEnabled(module, state.name)) return;
        values[inputKey(module, state.name)] = position === index ? 1 : 0;
      });
      continue;
    }

    for (const spec of specs) {
      if (!inputEnabled(module, spec.name)) continue;
      const key = inputKey(module, spec.name);
      let value: number | undefined;
      if (definition.kind === "loudness" && module.source === "live") value = frameValue(sources.audio[module.name], spec.name);
      else if (definition.kind === "autoblink") value = sources.auto[key];
      else value = sources.manual[key];
      values[key] = Number.isFinite(value as number) ? (value as number) : fallbackValue(module, definition, spec);
    }
  }
  // Цвет считается последним: режим «Реакция» ведёт яркость входом другого
  // модуля, а тот может стоять в списке ниже — тогда его значения уже собраны.
  const now = Number.isFinite(sources.now) ? sources.now as number : Date.now();
  const dt = Number.isFinite(sources.dt) ? Math.max(0, sources.dt as number) : 1 / 30;
  for (const module of modules) {
    if (!module.enabled) continue;
    if (moduleDefinition(module.type).kind !== "color") continue;
    for (const channel of colorChannels(module)) {
      const react = channel.react;
      const level = react ? (values[`${react.module}.${react.input}`] ?? 0) : 1;
      const numbers = channelValues(module.name, channel, now / 1000, dt, level);
      for (const part of ["r", "g", "b", "a", "level"] as const) {
        const key = inputKey(module, `${channel.name}_${part}`);
        if (!inputEnabled(module, `${channel.name}_${part}`)) continue;
        values[key] = numbers[part];
      }
    }
  }
  return values;
}

/**
 * Значение, пока не пришло настоящее: у ручного и авто-модуля — нижняя граница
 * из настроек (моргание начинается «открытыми глазами»), у остальных — тишина.
 */
function fallbackValue(module: ModuleInstance, definition: ModuleDefinition, spec: ModuleInputSpec): number {
  if (definition.kind === "manual" || definition.kind === "autoblink") return inputRange(module, spec).min;
  return inputDefault(spec);
}

/**
 * Паспорта входов: подпись, границы, шаг и вид.
 *
 * Панель знала их всегда, а скрипт — нет. Теперь `twitch.reward.max` и
 * `manual.value.label` читаются прямо в формуле: доля от предела считается без
 * второй копии числа в скрипте.
 */
export function inputMeta(modules: ModuleInstance[]): Record<string, InputMeta> {
  const meta: Record<string, InputMeta> = {};
  for (const module of modules) {
    for (const spec of instanceInputs(module)) {
      const range = inputRange(module, spec);
      meta[inputKey(module, spec.name)] = {
        label: spec.label || spec.name,
        min: range.min,
        max: range.max,
        step: range.step,
        kind: spec.kind ?? "level",
      };
    }
  }
  return meta;
}

/**
 * Вход, к которому относится текст источника.
 *
 * По умолчанию — строка-счётчик (у Twitch это `chat`), иначе первый вход
 * таблицы отображения. Имя можно задать и руками: оно попадает в скрипт как
 * `twitch.chat.message`.
 */
export function textInputName(module: ModuleInstance): string | null {
  if (moduleDefinition(module.type).kind !== "external") return null;
  // Имя входа текста знает сам источник: чат и отметки активности должны
  // попадать в один и тот же `<модуль>.<вход>`.
  return textInputOf(readExternalSource(module.config as Record<string, unknown>));
}

/**
 * Текстовый канал для ядра: `<модуль>.<вход>` → последние строки.
 *
 * В ядро строки уходят **от старых к свежим**: так `message()` — последнее
 * сообщение, `message(-1)` — предыдущее. Журнал источника держит свежие
 * первыми (их первыми видно в панели), поэтому здесь порядок разворачивается.
 */
export function inputTexts(
  modules: ModuleInstance[],
  lines?: Record<string, ExternalTextLine[]>,
): Record<string, { lines: InputTextLine[] }> {
  const texts: Record<string, { lines: InputTextLine[] }> = {};
  for (const module of modules) {
    const input = textInputName(module);
    if (!input) continue;
    const source = readExternalSource(module.config as Record<string, unknown>);
    const limit = source.text?.history ?? TEXT_HISTORY_DEFAULT;
    const list = lines?.[module.name] ?? [];
    if (list.length === 0) continue;
    texts[`${module.name}.${input}`] = {
      lines: list.slice(0, limit).reverse().map((line) => ({ text: line.text, author: line.author })),
    };
  }
  return texts;
}

export function inputsPayload(values: Record<string, number>, signals: Record<string, number> = {}): InputValues {
  return { values, signals };
}

/** Старые имена входов и их новые имена в системе модулей. */
const LEGACY_ALIASES: Record<string, string> = {
  speak: "mic.speak",
  loudness: "mic.loudness",
  db: "mic.db",
  talking: "mic.talking",
  viseme_a: "viseme.a",
  viseme_e: "viseme.e",
  viseme_i: "viseme.i",
  viseme_o: "viseme.o",
  viseme_u: "viseme.u",
};

export interface LegacyMigration {
  script: string;
  /** Имена модулей, которые нужны после переноса. */
  used: string[];
  changed: boolean;
}

/**
 * Переписывает старые имена входов (`speak`, `talking`, `viseme_a`,
 * `signal.blink`, `manual.blink`) в имена модулей. Работает по границам
 * идентификаторов, поэтому `talking_smooth` не задевает.
 */
export function migrateLegacyScript(script: string): LegacyMigration {
  const used: string[] = [];
  let changed = false;
  // Моргание раньше жило в движке (`signal.blink`) и в ручном модуле
  // (`manual.blink`); теперь за него отвечает модуль AutoBlink.
  let result = script.replace(/\b(?:signal|manual)\.blink\b/g, () => {
    changed = true;
    used.push("auto");
    return "auto.blink";
  });
  result = result.replace(
    /(^|[^\w.$])(speak|loudness|db|talking|viseme_[aeiou])(?![\w.])/g,
    (match, prefix: string, name: string) => {
      const replacement = LEGACY_ALIASES[name];
      if (!replacement) return match;
      changed = true;
      used.push(replacement.split(".")[0]);
      return `${prefix}${replacement}`;
    },
  );
  return { script: result, used: [...new Set(used)], changed };
}

/**
 * Нужен ли пресету модуль Viseme: ищем обращения к виземам в текстах.
 *
 * Имена визем задаёт пользователь (`o_umlaut`, `v_2`), поэтому смотрим на любое
 * имя после `viseme.`, а не только на пятёрку базовых звуков.
 */
export function usesVisemeInputs(scripts: string[]): boolean {
  return scripts.some((script) => /\bviseme\.[a-z0-9_]+\b|\bviseme_[a-z0-9_]+\b/i.test(script));
}

/** Копия модулей по умолчанию с независимыми настройками. */
export function defaultModules(): ModuleInstance[] {
  return DEFAULT_MODULES.map((module) => ({
    ...module,
    config: { ...module.config },
    disabledInputs: module.disabledInputs ? [...module.disabledInputs] : undefined,
  }));
}

/**
 * Дополняет пресет модулями и переписывает устаревшие имена входов.
 *
 * Работает и с полным списком модулей: старые имена (`speak`, `manual.blink`)
 * в скриптах всё равно встречаются после переноса пресета, а модуль нужного
 * типа может отсутствовать в списке.
 */
export function ensureModules(preset: RigPreset): RigPreset {
  const scripts = [preset.globals, ...preset.objects.map((object) => object.script)];
  const migrations = scripts.map((script) => migrateLegacyScript(script));
  const used = new Set(migrations.flatMap((migration) => migration.used));
  const modules: ModuleInstance[] = (Array.isArray(preset.modules) && preset.modules.length > 0
    ? preset.modules
    : defaultModules()).map((module) => ({ ...module, config: { ...module.config } }));
  if ((used.has("viseme") || usesVisemeInputs(scripts)) && !modules.some((module) => module.type === "viseme")) {
    modules.push({
      name: "viseme",
      type: "viseme",
      enabled: true,
      source: "manual",
      config: { ...moduleDefaults(moduleDefinition("viseme")), visemes: VISEME_BASE.map((entry) => ({ ...entry, templates: [] })) },
    });
  }
  if (used.has("auto") && !modules.some((module) => module.type === "autoblink")) {
    modules.push({ name: "auto", type: "autoblink", enabled: true, source: "manual", config: { ...DEFAULT_MODULES[1].config } });
  }
  let index = 0;
  const migrate = (script: string) => migrations[index++]?.script ?? script;
  const globals = migrate(preset.globals);
  return {
    ...preset,
    globals,
    modules,
    objects: preset.objects.map((object) => ({ ...object, script: migrate(object.script) })),
  };
}
