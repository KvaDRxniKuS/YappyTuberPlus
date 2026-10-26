import type { ScriptIssueInfo } from "../types";

/**
 * Что нужно проверке кроме самого текста.
 *
 * Конфликт имён виден только «сбоку»: имя события занимают в другой области, а
 * параметр объекта живёт вне текста. Поэтому ядру отдают соседей, а оно отвечает
 * местами ошибок — обоими.
 */
export interface ScriptScope {
  /** `globals` — глобальный скрипт, иначе id объекта. */
  scope?: string;
  /** Текст глобального скрипта: по нему видно занятые имена событий. */
  globals: string;
  /** Скрипты объектов: глобальное имя не должно повторяться и в них. */
  objects: Array<{ id: string; script: string }>;
}

/**
 * Разбор скрипта глазами редактора: ядро — единственный источник истины, но
 * подсветка не должна ждать кадра и не должна ломать сцену, поэтому проверка
 * идёт отдельным запросом `check` и молча пропускается, если ядро старее.
 *
 * Ответ — все места сразу: конфликт имён всегда про две строки.
 */
export type ScriptCheck = (source: string, scope?: ScriptScope) => Promise<ScriptIssueInfo[]>;

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
  const block = freeEventName(base, snippet).replace(/\s+$/, "");
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

/**
 * Все вхождения имени целым словом.
 *
 * Имя события живёт в трёх местах — объявление `event`, подписка `on`, вызов
 * `call`, — и при конфликте важно видеть их все: спор идёт не о строке, а об
 * имени. Границы слова проверяются вручную: `\b` в JavaScript считает словом
 * `[A-Za-z0-9_]`, а кириллица в именах не участвует, но точка в `<вход>.up`
 * ломала бы поиск в другом направлении.
 */
export function nameSpans(source: string, name: string): ErrorSpan[] {
  if (!name) return [];
  const spans: ErrorSpan[] = [];
  const word = /[A-Za-z0-9_]/;
  let from = source.indexOf(name);
  while (from !== -1) {
    const before = from > 0 ? source[from - 1] : "";
    const after = source[from + name.length] ?? "";
    // Точка с любой стороны — это путь входа (`mouse.left`), а не имя: события
    // и переменные пишутся отдельным словом, поэтому такие совпадения не наши.
    const startsWord = before === "" || (!word.test(before) && before !== ".");
    const endsWord = after === "" || (!word.test(after) && after !== ".");
    if (startsWord && endsWord) spans.push({ from, to: from + name.length, related: true });
    from = source.indexOf(name, from + 1);
  }
  return spans;
}

/** Место ошибки в смещениях текста: `related` — вторая декларация. */
export interface ErrorSpan {
  from: number;
  to: number;
  related: boolean;
}

/**
 * Ошибки → места в тексте.
 *
 * Своя строка подчёркивается точно (столбец и длина из ядра). Второе
 * объявление известно только строкой, поэтому подчёркивается целиком — и только
 * если оно в этом же тексте: чужой скрипт здесь не показать.
 */
export function issueSpans(
  source: string,
  issues: ScriptIssueInfo[],
  ownScope: string,
): ErrorSpan[] {
  // Начало каждой строки: смещения считаются по тексту, без CodeMirror.
  const starts: number[] = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  const lineStart = (number: number) => starts[Math.min(Math.max(number, 1), starts.length) - 1];
  const lineEnd = (number: number) => {
    const index = Math.min(Math.max(number, 1), starts.length) - 1;
    return index + 1 < starts.length ? starts[index + 1] - 1 : source.length;
  };
  const spans: ErrorSpan[] = [];
  for (const issue of issues) {
    const from = Math.min(lineStart(issue.line) + Math.max(issue.column - 1, 0), lineEnd(issue.line));
    const to = Math.min(from + Math.max(issue.length, 1), lineEnd(issue.line));
    if (to > from) spans.push({ from, to, related: false });
    const related = issue.related;
    if (!related || related.scope !== ownScope) continue;
    const otherFrom = lineStart(related.line);
    const otherTo = lineEnd(related.line);
    if (otherTo > otherFrom) spans.push({ from: otherFrom, to: otherTo, related: true });
  }
  return spans;
}

/**
 * Куда ведёт клик по ошибке: второе объявление в **другом** скрипте.
 *
 * Если вторая строка в этом же тексте, она уже подчёркнута — переходить некуда.
 * Возвращается первое такое место: остальные видны в сообщении как «ещё N».
 */
export function issueTarget(
  issues: ScriptIssueInfo[],
  ownScope: string,
): { scope: string; line: number; name?: string } | null {
  for (const issue of issues) {
    if (issue.related && issue.related.scope !== ownScope) {
      return { scope: issue.related.scope, line: issue.related.line, name: issue.name };
    }
  }
  return null;
}

/**
 * Имя, о котором спорит проверка: первое найденное.
 *
 * Нужно и без перехода: обе декларации могут лежать в одном скрипте, и тогда
 * полезно видеть все вхождения имени — от объявления до вызовов.
 */
export function issueName(issues: ScriptIssueInfo[]): string | null {
  for (const issue of issues) {
    if (issue.name) return issue.name;
  }
  return null;
}

/** Как называется область в сообщении: `globals.rig` или `<id>.rig`. */
export function scopeTitle(scope: string): string {
  return scope === "globals" ? "globals.rig" : `${scope}.rig`;
}

/** Сообщение под редактором: первое место и сколько ещё таких же. */
export function describeIssues(issues: ScriptIssueInfo[]): string {
  if (issues.length === 0) return "";
  const more = issues.length > 1 ? ` · ещё ${issues.length - 1}` : "";
  return `${issues[0].message}${more}`;
}

/** Освобождает имя события: `twitch_chat` → `twitch_chat_2`, если имя занято. */
export function freeEventName(source: string, snippet: string): string {
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
