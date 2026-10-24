import type { ScriptErrorInfo } from "../types";

/**
 * Разбор скрипта глазами редактора: ядро — единственный источник истины, но
 * подсветка не должна ждать кадра и не должна ломать сцену, поэтому проверка
 * идёт отдельным запросом `check` и молча пропускается, если ядро старее.
 */
export type ScriptCheck = (source: string) => Promise<ScriptErrorInfo | null>;

/** Имена событий из `trigger имя = …`: их предлагает автодополнение после `on `. */
export function namedTriggers(globals: string): string[] {
  const names: string[] = [];
  const pattern = /^\s*trigger\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/gm;
  for (const match of globals.matchAll(pattern)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/** Дописывает блок в конец скрипта, сохраняя пустую строку между блоками. */
export function appendSnippet(script: string, snippet: string): string {
  const base = script.replace(/\s+$/, "");
  const block = snippet.replace(/\s+$/, "");
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

/** Подпись блока события для вставки: тело пустое, его пишет автор сцены. */
export function eventSnippet(condition: string): string {
  return `on ${condition} {\n  \n}`;
}
