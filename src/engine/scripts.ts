import type { ScriptErrorInfo } from "../types";

/**
 * Разбор скрипта глазами редактора: ядро — единственный источник истины, но
 * подсветка не должна ждать кадра и не должна ломать сцену, поэтому проверка
 * идёт отдельным запросом `check` и молча пропускается, если ядро старее.
 */
export type ScriptCheck = (source: string) => Promise<ScriptErrorInfo | null>;

/**
 * Имена объявленных событий: `event имя(…) { … }`.
 *
 * Нужны автодополнению после `on` и `call`: в списке видны только те имена,
 * которые действительно объявлены в этой области (в скрипте объекта — плюс
 * глобальные, их добавляет вызывающий код).
 */
export function eventNames(source: string): string[] {
  const names: string[] = [];
  const pattern = /^\s*event\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  for (const match of source.matchAll(pattern)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/** Имя события из ключа входа: `twitch.chat` → `twitch_chat`. */
export function eventNameFor(inputKey: string): string {
  return inputKey.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Готовое событие для входа: объявление и обработчик с пустым телом. */
export function eventSnippet(name: string, condition: string): string {
  return `event ${name}() { ${condition} }\non ${name} {\n  \n}`;
}

/** Дописывает блок в конец скрипта, сохраняя пустую строку между блоками. */
export function appendSnippet(script: string, snippet: string): string {
  const base = script.replace(/\s+$/, "");
  const block = snippet.replace(/\s+$/, "");
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}
