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

/**
 * Дописывает блок в конец скрипта, сохраняя пустую строку между блоками.
 *
 * Имя занятого события получает номер: два блока одного входа («рост» и «спад»)
 * иначе дали бы «событие уже объявлено» — то есть кнопка в панели «Входы»
 * ломала бы скрипт вместо того, чтобы его дописать.
 */
export function appendSnippet(script: string, snippet: string): string {
  const base = script.replace(/\s+$/, "");
  const block = renameTakenEvent(base, snippet).replace(/\s+$/, "");
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

/** Освобождает имя события: `twitch_chat` → `twitch_chat_2`, если имя занято. */
function renameTakenEvent(source: string, snippet: string): string {
  const declared = /^\s*event\s+([A-Za-z_][A-Za-z0-9_]*)/m.exec(snippet);
  if (!declared) return snippet;
  const name = declared[1];
  const taken = new Set(eventNames(source));
  if (!taken.has(name)) return snippet;
  let index = 2;
  while (taken.has(`${name}_${index}`)) index += 1;
  const fresh = `${name}_${index}`;
  // Имя события стоит в объявлении и в подписке — переименовываем оба места.
  return snippet
    .replace(new RegExp(`\\bevent\\s+${name}\\b`, "g"), `event ${fresh}`)
    .replace(new RegExp(`\\bon\\s+${name}\\b`, "g"), `on ${fresh}`);
}
