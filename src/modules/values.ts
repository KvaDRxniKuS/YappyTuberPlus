import type { InputValues, ModuleInstance, RigPreset } from "../types";
import { DEFAULT_MODULES } from "../types";
import { inputDefault, moduleDefinition, type ModuleInputSpec } from "./registry";

/** Полное имя входа: `mic.talking`. Именно так оно пишется в скрипте. */
export function inputKey(module: ModuleInstance, input: string): string {
  return `${module.name}.${input}`;
}

export function moduleInputs(module: ModuleInstance): Array<{ key: string; spec: ModuleInputSpec }> {
  return moduleDefinition(module.type).inputs.map((spec) => ({ key: inputKey(module, spec.name), spec }));
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
  }
  return problems;
}

export type ModuleAudioValues = Record<string, Record<string, number>>;

/**
 * Собирает плоский словарь входов: включённые модули, каждый вход — под своим
 * полным именем. Живой модуль берёт значения из аудио, ручной — из ползунков.
 */
export function composeValues(
  modules: ModuleInstance[],
  audio: ModuleAudioValues,
  manual: Record<string, number>,
): Record<string, number> {
  const values: Record<string, number> = {};
  for (const module of modules) {
    if (!module.enabled) continue;
    const definition = moduleDefinition(module.type);
    const live = definition.audio && module.source === "live";
    for (const spec of definition.inputs) {
      const key = inputKey(module, spec.name);
      const value = live ? audio[module.name]?.[spec.name] : manual[key];
      values[key] = Number.isFinite(value as number) ? (value as number) : inputDefault(spec);
    }
  }
  return values;
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

/** `signal.blink` до модулей был единственным способом мигнуть вручную. */
const LEGACY_SIGNAL_BLINK = "signal.blink";

export interface LegacyMigration {
  script: string;
  /** Имена модулей, которые нужны после переноса. */
  used: string[];
  changed: boolean;
}

/**
 * Переписывает старые входы (`speak`, `talking`, `viseme_a`, `signal.blink`) в
 * имена модулей (`mic.speak`, `mic.talking`, `viseme.a`, `manual.blink`).
 * Работает по границам идентификаторов, поэтому `talking_smooth` не задевает.
 */
export function migrateLegacyScript(script: string): LegacyMigration {
  const used: string[] = [];
  let changed = false;
  let result = script.replace(/signal\.blink\b/g, () => {
    changed = true;
    used.push("manual");
    return "manual.blink";
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

/** Нужен ли пресету модуль Viseme: ищем старые или новые виземы в текстах. */
export function usesVisemeInputs(scripts: string[]): boolean {
  return scripts.some((script) => /\bviseme\.[aeiou]\b|\bviseme_[aeiou]\b/.test(script));
}

/**
 * Дополняет пресет модулями: если их нет (файл из версии без модулей),
 * переносит старые входы в имена модулей. Возвращает новый пресет.
 */
export function ensureModules(preset: RigPreset): RigPreset {
  const scripts = [preset.globals, ...preset.objects.map((object) => object.script)];
  if (Array.isArray(preset.modules) && preset.modules.length > 0) {
    return { ...preset, modules: preset.modules };
  }
  const migrations = scripts.map((script) => migrateLegacyScript(script));
  const used = new Set(migrations.flatMap((migration) => migration.used));
  const modules: ModuleInstance[] = DEFAULT_MODULES.map((module) => ({ ...module, config: { ...module.config } }));
  if (used.has("viseme") || usesVisemeInputs(scripts)) {
    modules.push({ name: "viseme", type: "viseme", enabled: true, source: "manual", config: {} });
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
