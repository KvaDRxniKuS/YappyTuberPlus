import type { ModuleInstance } from "../types";
import { moduleInputs } from "../modules/values";
import { localNames } from "./rename";

/**
 * Список того, что можно привязать к слою состояний.
 *
 * Один список на поле параметра и на диалог замены: разъехавшись, они
 * предлагали бы разное. Порядок — от общего к частному (входы модулей,
 * глобальные переменные, свои переменные объекта), имя встречается один раз.
 *
 * Свои переменные читаются из скрипта объекта: локальная переменная живёт
 * только в нём, поэтому список у каждого объекта свой.
 */

export interface ParamItem {
  name: string;
  /** Подпись входа из паспорта: «рот открыт», «угол головы». */
  note?: string;
}

export interface ParamGroup {
  title: string;
  items: ParamItem[];
}

export interface ParamSources {
  modules: ModuleInstance[];
  /** Имена глобальных переменных: разобранный глобальный скрипт. */
  globals?: string[];
  /** Значения кадра от ядра: `signal.*`, каналы часов и прочее. */
  values?: Record<string, number>;
  /** Переменные, которые ядро отдало в кадре (`frame.globals`). */
  frameGlobals?: Record<string, number>;
  /** Скрипт объекта: из него берутся свои переменные. */
  script?: string;
}

export function paramGroups(sources: ParamSources): ParamGroup[] {
  const seen = new Set<string>();
  const take = (name: string, note?: string): ParamItem | null => {
    if (!name || seen.has(name)) return null;
    seen.add(name);
    return { name, note };
  };
  const items = (list: Array<ParamItem | null>) => (
    list.filter((item): item is ParamItem => item !== null)
  );

  const inputs = items(sources.modules.flatMap((instance) => (
    moduleInputs(instance).map((input) => take(input.key, input.spec.label))
  )));
  const globals = items([
    ...Object.keys(sources.frameGlobals ?? {}).map((name) => take(name)),
    ...(sources.globals ?? []).map((name) => take(name)),
  ]);
  const local = items(localNames(sources.script ?? "").map((name) => take(name)));
  // Всё, что ядро уже знает, но модули не объявили: `signal.*`, каналы часов.
  const rest = items(Object.keys(sources.values ?? {}).map((name) => take(name)));

  return [
    { title: "входы", items: inputs },
    { title: "глобальные", items: globals },
    { title: "свои переменные", items: local },
    { title: "значения кадра", items: rest },
  ].filter((group) => group.items.length > 0);
}
