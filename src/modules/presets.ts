import type { EnumState, ModuleInstance } from "../types";
import type { ModuleInputSpec } from "./registry";
import { moduleDefinition } from "./registry";
import { enumConstants, sanitizeStateName } from "./manual";

/**
 * Модуль «Пресеты».
 *
 * Пресет — это вариант образа: одежда, эмоция, выражение лица. Пользователь
 * перечисляет пресеты, а модуль сам делает из них рабочую систему:
 *
 * - заводит переменную (`preset` по умолчанию) — номер выбранного пресета;
 * - переводит имена пресетов в числа (`preset == summer`), чтобы в скрипте
 *   было видно слово, а не номер;
 * - пишет в глобальный скрипт события: пресет можно включить из панели или
 *   получить наградой Twitch — без единой строчки кода;
 * - отдаёт список пресетов вкладке «Поведение», где у объекта отмечают, при
 *   каких пресетах он виден.
 *
 * Имена пресетов санитизируются тем же способом, что состояния ручного модуля:
 * из «Летний» получается `letniy`. Поэтому пользователь пишет подписи
 * по-русски, а скрипт остаётся латиницей.
 */

/** Стартовый набор: его видно в панели и можно править. */
export const PRESET_BASE: EnumState[] = [
  { name: "summer", label: "Лето" },
  { name: "winter", label: "Зима" },
];

/** Имя переменной пресета по умолчанию. */
export const PRESET_VARIABLE_BASE = "preset";

/**
 * Префикс награды по умолчанию: в модуле Twitch награда «Смена образа» даёт
 * вход `redeem_смена_образа`, поэтому пресет `summer` ищется как
 * `twitch.redeem_summer` (после санитизации имени).
 */
export const PRESET_PREFIX_BASE = "redeem";

/** Список пресетов экземпляра. Битые записи отбрасываются. */
export function presetEntries(module: ModuleInstance): EnumState[] {
  const raw = module.config.presets;
  if (!Array.isArray(raw) || raw.length === 0) return PRESET_BASE.map((entry) => ({ ...entry }));
  const entries: EnumState[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Partial<EnumState>;
    if (typeof candidate.name !== "string" || !candidate.name) continue;
    entries.push({ name: candidate.name, label: typeof candidate.label === "string" && candidate.label ? candidate.label : candidate.name });
  }
  return entries.length ? entries : PRESET_BASE.map((entry) => ({ ...entry }));
}

/**
 * Имя переменной: только латиница, цифры и `_` — оно попадает в скрипт.
 *
 * Кириллицу переводим в латиницу тем же способом, что имена состояний:
 * «Образ» → `obraz`, а не пустая строка. Если после чистки ничего не осталось,
 * берём `preset`.
 */
export function presetVariable(module: ModuleInstance): string {
  const raw = typeof module.config.variable === "string" ? module.config.variable.trim() : "";
  if (!raw) return PRESET_VARIABLE_BASE;
  const clean = sanitizeStateName(raw).slice(0, 24);
  if (!clean) return PRESET_VARIABLE_BASE;
  return /^[a-z_]/.test(clean) ? clean : `p_${clean}`;
}

/** Искать пресеты среди наград: галочка в карточке модуля. */
export function presetRewardSearch(module: ModuleInstance): boolean {
  return module.config.rewardSearch === true;
}

/** Модули, в которых ищем награды: `["twitch"]` по умолчанию. */
export function presetRewardModules(module: ModuleInstance): string[] {
  const raw = module.config.rewardModules;
  if (!Array.isArray(raw)) return ["twitch"];
  return raw
    .filter((entry): entry is string => typeof entry === "string" && !!entry.trim())
    .map((entry) => entry.trim());
}

/** Префиксы наград: то, что стоит после модуля и до `_имяпресета`. */
export function presetRewardPrefixes(module: ModuleInstance): string[] {
  const raw = module.config.rewardPrefixes;
  const list = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === "string" && !!entry.trim()).map((entry) => entry.trim())
    : [];
  if (list.length === 0) return [PRESET_PREFIX_BASE];
  return list.map((entry) => entry.replace(/_+$/, ""));
}

/** Пресет, выбранный в панели для проверки образа: −1 — никакой. */
export function presetPreview(module: ModuleInstance): number {
  const raw = Number(module.config.preview);
  const count = presetEntries(module).length;
  if (!Number.isFinite(raw)) return -1;
  return Math.min(count - 1, Math.max(-1, Math.round(raw)));
}

/**
 * Входы модуля. Номер приходит из панели (кнопка «Показать»), флаги выводятся
 * из него — как у manual в режиме состояний. Настоящее значение переменной
 * живёт в ядре: его меняют события пресетов.
 */
export function presetInputs(module: ModuleInstance): ModuleInputSpec[] {
  const entries = presetEntries(module);
  return [
    {
      name: "value",
      label: "Пресет",
      min: -1,
      max: Math.max(0, entries.length - 1),
      step: 1,
      kind: "level" as const,
      hint: "номер показанного пресета: −1 — ни один",
    },
    ...entries.map((entry, index) => ({
      name: entry.name,
      label: entry.label,
      min: 0,
      max: 1,
      step: 1,
      kind: "flag" as const,
      hint: `1, пока показан пресет «${entry.label}» (номер ${index})`,
    })),
  ];
}

/** Имя входа награды: префикс плюс имя пресета через `_`. */
export function rewardInputName(prefix: string, preset: EnumState): string {
  return `${prefix}_${sanitizeStateName(preset.name)}`;
}

/** Входы модуля-источника наград: у внешнего источника они лежат в правилах. */
function sourceInputs(module: ModuleInstance): string[] {
  const mapping = module.config.source?.mapping;
  if (Array.isArray(mapping) && mapping.length) {
    return mapping
      .map((rule) => (typeof rule?.input === "string" ? rule.input : ""))
      .filter(Boolean);
  }
  return moduleDefinition(module.type).inputs.map((input) => input.name);
}

/**
 * Где нашлась награда для пресета. Пусто — награды нет, и модуль об этом
 * честно скажет в карточке, а не сломает пресет молча.
 */
export function presetRewardInput(
  module: ModuleInstance,
  modules: ModuleInstance[],
  preset: EnumState,
): { key: string; found: boolean }[] {
  const wanted = presetRewardModules(module);
  const prefixes = presetRewardPrefixes(module);
  const result: { key: string; found: boolean }[] = [];
  for (const source of modules) {
    if (source.name === module.name) continue;
    if (!wanted.includes(source.name)) continue;
    const inputs = sourceInputs(source);
    for (const prefix of prefixes) {
      const input = rewardInputName(prefix, preset);
      if (inputs.includes(input)) result.push({ key: `${source.name}.${input}`, found: true });
      else result.push({ key: `${source.name}.${input}`, found: false });
    }
  }
  return result;
}

/**
 * События модуля для глобального скрипта.
 *
 * `preset` присваивается только внутри `on`, поэтому ядро держит значение
 * между кадрами (персистентная переменная) — пресет не сбрасывается сам.
 */
export function presetEvents(module: ModuleInstance, modules: ModuleInstance[]): string[] {
  const variable = presetVariable(module);
  const lines: string[] = [`on start { ${variable} = -1 }`];
  presetEntries(module).forEach((preset, index) => {
    // Кнопка в панели модуля: удобно примерить образ, не искупая награду.
    lines.push(`on ${module.name}.${preset.name}.up { ${variable} = ${index} }`);
    if (!presetRewardSearch(module)) return;
    for (const reward of presetRewardInput(module, modules, preset)) {
      if (!reward.found) continue;
      lines.push(`on ${reward.key}.up { ${variable} = ${index} }`);
    }
  });
  return lines;
}

/** Глобальный скрипт целиком: авторский текст плюс управляемые блоки пресетов. */
export function presetGlobals(modules: ModuleInstance[], globals: string): string {
  const blocks: string[] = [];
  for (const module of modules) {
    if (!module.enabled) continue;
    if (moduleDefinition(module.type).kind !== "presets") continue;
    const events = presetEvents(module, modules);
    blocks.push([
      `# ── пресеты: ${module.name} (модуль, вкладка «Модули») ──`,
      ...events,
      "# ── конец пресетов ──",
    ].join("\n"));
  }
  if (!blocks.length) return globals;
  return [globals.trim(), ...blocks].filter(Boolean).join("\n\n");
}

/**
 * Числа для ядра: имя пресета читается в скрипте как число.
 *
 * Короткое имя достаётся первому модулю, который его объявил (как у состояний
 * manual); полное `<модуль>_<пресет>` есть всегда — по нему и строится код
 * поведения, чтобы два модуля пресетов не путались.
 */
export function presetConstants(modules: ModuleInstance[]): Record<string, number> {
  const constants: Record<string, number> = {};
  for (const module of modules) {
    if (!module.enabled) continue;
    if (moduleDefinition(module.type).kind !== "presets") continue;
    presetEntries(module).forEach((preset, index) => {
      const long = `${module.name}_${preset.name}`;
      if (!(long in constants)) constants[long] = index;
      if (!(preset.name in constants)) constants[preset.name] = index;
    });
  }
  return constants;
}

/** Все константы скрипта: состояния manual и пресеты. */
export function moduleConstants(modules: ModuleInstance[]): Record<string, number> {
  return { ...enumConstants(modules), ...presetConstants(modules) };
}

/** Что не так с настройками: показывается в карточке модуля. */
export function presetIssues(module: ModuleInstance, modules: ModuleInstance[]): string[] {
  const issues: string[] = [];
  const variable = presetVariable(module);
  for (const other of modules) {
    if (other.name === module.name || !other.enabled) continue;
    if (moduleDefinition(other.type).kind !== "presets") continue;
    if (presetVariable(other) === variable) {
      issues.push(`Переменная «${variable}» уже занята модулем «${other.name}»: пресеты будут перебивать друг друга.`);
    }
  }
  if (!presetRewardSearch(module)) return issues;
  const known = new Set(modules.map((entry) => entry.name));
  for (const name of presetRewardModules(module)) {
    if (!known.has(name)) issues.push(`Модуль «${name}» не найден в списке модулей.`);
  }
  for (const preset of presetEntries(module)) {
    const rewards = presetRewardInput(module, modules, preset);
    if (rewards.length === 0) continue;
    if (rewards.some((reward) => reward.found)) continue;
    issues.push(`Награда «${preset.label}» не найдена: ожидался вход ${rewards.map((reward) => reward.key).join(" или ")}.`);
  }
  return issues;
}

/** Все включённые модули пресетов: их список показывает вкладка «Поведение». */
export function presetModules(modules: ModuleInstance[]): ModuleInstance[] {
  return modules.filter((module) => module.enabled && moduleDefinition(module.type).kind === "presets");
}
