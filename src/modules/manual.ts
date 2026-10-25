import type { EnumState, ModuleInstance } from "../types";
import type { ModuleInputSpec } from "./registry";

/**
 * Ручной модуль в режиме «Состояния» (enum).
 *
 * Значение входа `manual.value` — номер выбранного состояния (0, 1, 2…), поэтому
 * сравнение в скрипте работает обычными операторами, а состояние читается по
 * номеру или по имени: фронтенд добавляет имена состояний в константы ядра
 * (`constants`), и `manual.value == walk` выглядит как человеческая запись.
 *
 * Кроме номера у модуля есть по входу-флагу на каждое состояние
 * (`manual.walk` = 1, пока выбрано это состояние): флаги дают точные события
 * `on manual.walk.down { … }` — по номеру такое не выразить, потому что
 * «сменилось на walk» и «стало числом 1» — разные вещи.
 */

/** Стартовый набор состояний нового модуля: его можно править и удалять. */
export const ENUM_STATES_BASE: EnumState[] = [
  { name: "idle", label: "Покой" },
  { name: "walk", label: "Идёт" },
  { name: "run", label: "Бежит" },
];

/** Имя состояния: только латиница, цифры и `_` — оно попадает в скрипт. */
export function stateNameAllowed(raw: string): boolean {
  return /^[a-z0-9_]*$/.test(raw);
}

/** Кириллица в латиницу: подпись «Идёт» должна дать пригодное имя `idet`. */
const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** Имя состояния из любой подписи: `Идёт` → `idet`, `ö` → `o`. */
export function sanitizeStateName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/ö/g, "o")
    .replace(/ä/g, "a")
    .replace(/ü/g, "u")
    .replace(/ß/g, "ss")
    .replace(/[а-яё]/g, (letter) => CYRILLIC[letter] ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) return "state";
  return /^[a-z_]/.test(cleaned) ? cleaned : `s_${cleaned}`;
}

/** Свободное имя в списке состояний: `walk`, `walk_2`, `walk_3`… */
export function uniqueStateName(entries: EnumState[], base: string): string {
  const clean = sanitizeStateName(base);
  if (!entries.some((entry) => entry.name === clean)) return clean;
  let index = 2;
  while (entries.some((entry) => entry.name === `${clean}_${index}`)) index += 1;
  return `${clean}_${index}`;
}

/** Режим модуля: `flag`, `number` или `enum`. */
export function manualMode(module: ModuleInstance): "flag" | "number" | "enum" {
  const mode = module.config.mode;
  return mode === "flag" || mode === "enum" ? mode : "number";
}

/** Список состояний экземпляра. Битые записи отбрасываются. */
export function enumStates(module: ModuleInstance): EnumState[] {
  const raw = module.config.states;
  if (!Array.isArray(raw) || raw.length === 0) return ENUM_STATES_BASE.map((entry) => ({ ...entry }));
  return raw;
}

/** Номер выбранного состояния: значение входа приводится к целому 0…N−1. */
export function stateIndex(module: ModuleInstance, value: number | undefined): number {
  const states = enumStates(module);
  const raw = Number.isFinite(value as number) ? Math.round(value as number) : 0;
  return Math.min(states.length - 1, Math.max(0, raw));
}

/** Входы модуля в режиме «Состояния»: номер выбранного + флаг на состояние. */
export function enumInputs(module: ModuleInstance): ModuleInputSpec[] {
  const states = enumStates(module);
  return [
    {
      name: "value",
      label: "Состояние",
      min: 0,
      max: Math.max(1, states.length - 1),
      step: 1,
      kind: "level" as const,
      hint: "номер выбранного состояния: 0, 1, 2…; в скрипте `manual.value == walk`",
    },
    ...states.map((state, index) => ({
      name: state.name,
      label: state.label,
      min: 0,
      max: 1,
      step: 1,
      kind: "flag" as const,
      hint: `1, пока выбрано состояние «${state.label}» (номер ${index})`,
    })),
  ];
}

/**
 * Константы для ядра: имена состояний как числа.
 *
 * В скрипте это делает сравнение читаемым: `manual.value == walk`. Кроме
 * короткого имени есть полное `<модуль>_<состояние>` — два модуля со
 * состоянием «walk» не конфликтуют. Короткое имя достаётся первому модулю,
 * который его объявил: предсказуемо и без диагностики на ровном месте.
 */
export function enumConstants(modules: ModuleInstance[]): Record<string, number> {
  const constants: Record<string, number> = {};
  for (const module of modules) {
    if (!module.enabled) continue;
    if (module.type !== "manual" || manualMode(module) !== "enum") continue;
    enumStates(module).forEach((state, index) => {
      const long = `${module.name}_${state.name}`;
      if (!(long in constants)) constants[long] = index;
      if (!(state.name in constants)) constants[state.name] = index;
    });
  }
  return constants;
}
