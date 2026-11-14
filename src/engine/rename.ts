import type { RigObject } from "../types";
import { maskScript } from "./scripts";
import { isVariableIdentifier } from "./scriptNames";
import { BEHAVIOUR_META } from "./visibility";

/**
 * Переименование переменной во всех местах, где она написана.
 *
 * Переменная в этом языке не объявляется: своя переменная объекта — это имя
 * слева (`eye_target = …`), глобальная — такое же имя в `globals.rig`. Зато
 * живёт имя в нескольких местах сразу: в объявлении, в формулах, в `state.имя`
 * и снимком в настройках поведения. Поэтому «переименовать» — это замена всех
 * вхождений, а не правка одной строки: иначе вчерашняя формула молча читает
 * ноль (или, хуже, чужую переменную с тем же именем).
 *
 * Что замена **не** трогает:
 *
 * - строки и комментарии — это текст, а не код;
 * - поля после точки (`mic.speak`, `parent.x`) — вход модуля или параметр
 *   родителя; исключение одно: `state.имя`, это та же переменная в прошлом кадре;
 * - вызовы (`имя(…)`) — функция, а не переменная;
 * - имена событий (`event имя`, `on имя`, `call имя`);
 * - тела `on` тех событий, у которых в скобках объявлена **своя** переменная с
 *   этим именем: там имя означает снимок события, а не переменную объекта.
 *
 * Замена идёт с конца, чтобы позиции вхождений не поехали; строка и столбец
 * при этом не меняются вовсе — редактору не нужно двигать каретку.
 */

/** Вхождение имени в тексте: половина открытого интервала `[from, to)`. */
export interface NameSpan {
  from: number;
  to: number;
}

/** Ключевые слова, после которых имя — это имя события, а не переменной. */
const BEFORE_KEYWORDS = new Set(["event", "on", "call"]);

/**
 * Имена своих переменных: строка вида `имя = …` вне блока события.
 *
 * Тело `on { … }` не считается: присваивание там заводит переменную события, а
 * не объекта (`a = a + 1` — обычный счётчик срабатываний). Глубина скобок
 * считается по очищенному тексту, где строк и комментариев нет, — иначе `{` в
 * кавычках сдвинул бы всё ниже.
 */
export function localNames(text: string): string[] {
  const masked = maskScript(text);
  const names: string[] = [];
  let depth = 0;
  for (const line of masked.split("\n")) {
    if (depth === 0) {
      const match = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(?!=)/.exec(line);
      if (match && isVariableIdentifier(match[1])) names.push(match[1]);
    }
    for (const char of line) {
      if (char === "{") depth += 1;
      else if (char === "}") depth = Math.max(0, depth - 1);
    }
  }
  return [...new Set(names)];
}

/**
 * Объявление переменной, внутри имени которого стоит позиция: `имя = …`.
 *
 * Так редактор узнаёт, что правят именно имя переменной, а не формулу: слева от
 * `=` в начале строки вне блоков. Возвращается и место имени, чтобы замена
 * остальных вхождений не тронула объявление — его правит сам автор.
 */
export interface DeclarationName extends NameSpan {
  name: string;
  /** Начало строки объявления: по нему видно, то же это имя или уже другое. */
  line: number;
}

export function declarationAt(text: string, pos: number): DeclarationName | null {
  if (pos < 0 || pos > text.length) return null;
  const masked = maskScript(text);
  const lineStart = masked.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  const lineEnd = masked.indexOf("\n", lineStart);
  const line = masked.slice(lineStart, lineEnd === -1 ? masked.length : lineEnd);
  // Объявление — только на верхнем уровне: внутри `{ … }` живёт переменная события.
  let depth = 0;
  for (let index = 0; index < lineStart; index += 1) {
    if (masked[index] === "{") depth += 1;
    else if (masked[index] === "}") depth = Math.max(0, depth - 1);
  }
  if (depth !== 0) return null;
  const match = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(?!=)/.exec(line);
  if (!match || !isVariableIdentifier(match[1])) return null;
  const from = lineStart + match[0].indexOf(match[1]);
  const to = from + match[1].length;
  // Позиция может стоять и сразу за последним символом имени: набор с конца
  // (`eye_target|` → `eye_target_new`) — это тоже правка имени.
  if (pos < from || pos > to) return null;
  return { from, to, name: match[1], line: lineStart };
}

/** Одно изменение текста: что вырезали и что вставили на его место. */
export interface RenameEdit {
  /** Начало замены в прежнем тексте. */
  fromA: number;
  /** Конец замены в прежнем тексте (равен `fromA` у вставки). */
  toA: number;
  /** Вставленный текст. */
  insert: string;
}

/** Состояние набора имени: от какого имени к какому и на какой строке. */
export interface RenameTyping {
  from: string;
  to: string;
  line: number;
}

/** Что сделать с правкой, задевшей имя переменной. */
export interface RenamePlan {
  /** Имя в тексте до правки — его и заменяем в остальных местах. */
  current: string;
  /** Новое имя; может быть недописанным. */
  next: string;
  /** От какого имени считается вся последовательность (для чужих скриптов). */
  from: string;
  /** Начало строки объявления. */
  line: number;
  /** Замены остальных вхождений. Пусто — менять нечего (имя ещё не выбрано). */
  changes: Array<NameSpan & { insert: string }>;
  /** Состояние для следующей буквы. */
  pending: RenameTyping;
}

/**
 * Правка объявления → план переименования.
 *
 * «Поменять имя переменной» здесь значит править левую часть присваивания, но
 * имя набирается по буквам: `eye_target` стирают и печатают `gaze`, и это
 * десяток отдельных изменений. Поэтому план помнит начало последовательности
 * (`pending`): первое изменение, которое стёрло или заменило часть имени,
 * запускает переименование, а следующие буквы его продолжают.
 *
 * Набор **нового** объявления с нуля (`newname = 1`) не запускает ничего:
 * имя ещё не выбрано, и совпадения в чужих формулах трогать нельзя.
 */
export function planRename(
  before: string,
  after: string,
  edit: RenameEdit,
  pending: RenameTyping | null,
): RenamePlan | null {
  const target = declarationAt(before, edit.fromA);
  if (!target) return null;
  const same = pending !== null && pending.line === target.line;
  if (!same && edit.toA <= edit.fromA) return null;
  const from = same && pending ? pending.from : target.name;
  const next = before.slice(target.from, edit.fromA) + edit.insert + before.slice(edit.toA, target.to);
  const state: RenameTyping = { from, to: next, line: target.line };
  if (!isVariableIdentifier(next) || next === target.name) {
    return { current: target.name, next, from, line: target.line, changes: [], pending: state };
  }
  const changes = renameSpans(after, target.name).map((span) => ({ ...span, insert: next }));
  return { current: target.name, next, from, line: target.line, changes, pending: state };
}

/**
 * Тела событий, где имя занято переменной самого события.
 *
 * `event speak (loud = mic.loudness ; 5000) { … }` + `on speak { … }`: внутри
 * тела `loud` — снимок значения на момент срабатывания. Переименование
 * переменной объекта не должно его переписывать: это другая переменная.
 */
function eventShadowRanges(masked: string, name: string): NameSpan[] {
  /** До какого места идёт блок, открытый на позиции `open`. */
  const blockEnd = (open: number): number => {
    let depth = 0;
    for (let index = open; index < masked.length; index += 1) {
      if (masked[index] === "{") depth += 1;
      else if (masked[index] === "}") {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    return masked.length;
  };
  const shadows = new Map<string, Set<string>>();
  const ranges: NameSpan[] = [];
  for (const match of masked.matchAll(/^[ \t]*event[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(([^)\n]*)\)[ \t]*\{/gm)) {
    // До `;` — переменные события, после — пауза в миллисекундах.
    const vars = new Set<string>();
    for (const item of match[2].split(";")[0].split(",")) {
      const param = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)/.exec(item)?.[1];
      if (param) vars.add(param);
    }
    shadows.set(match[1], vars);
    if (!vars.has(name)) continue;
    // Внутри самого объявления имя — это параметр события (и его условие):
    // переименование переменной объекта туда не лезет.
    const open = match.index + match[0].length - 1;
    const paren = match.index + match[0].indexOf("(");
    ranges.push({ from: paren, to: blockEnd(open) });
  }
  for (const match of masked.matchAll(/^[ \t]*on[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\{/gm)) {
    if (!shadows.get(match[1])?.has(name)) continue;
    const open = match.index + match[0].length - 1;
    ranges.push({ from: open, to: blockEnd(open) });
  }
  return ranges;
}

/**
 * Вхождения имени, которые можно переименовать.
 *
 * Текст очищается до кода (`maskScript`), поэтому комментарии и строки
 * отсеиваются сами: в очищенном тексте их символов просто нет, а позиции
 * остаются прежними — разметка совпадает с настоящим текстом.
 */
export function renameSpans(text: string, name: string): NameSpan[] {
  if (!isVariableIdentifier(name)) return [];
  const masked = maskScript(text);
  const shadowed = eventShadowRanges(masked, name);
  const spans: NameSpan[] = [];
  const pattern = new RegExp(`\\b${name}\\b`, "g");
  for (let match = pattern.exec(masked); match; match = pattern.exec(masked)) {
    const from = match.index;
    const to = from + name.length;
    if (shadowed.some((range) => from >= range.from && to <= range.to)) continue;
    // Поле после точки — не переменная. Исключение — `state.имя`: прошлый кадр
    // той же переменной (ядро ищет её среди своих, потом среди глобальных).
    if (masked[from - 1] === "." && !/(?:^|[^A-Za-z0-9_])state\.$/.test(masked.slice(0, from))) continue;
    // Вызов функции: `min(…)` — не присваивание и не переменная.
    if (/^[ \t]*\(/.test(masked.slice(to, to + 8))) continue;
    // `event имя`, `on имя`, `call имя` — имена событий.
    const before = /([A-Za-z_][A-Za-z0-9_]*)[ \t]*$/.exec(masked.slice(0, from))?.[1];
    if (before && BEFORE_KEYWORDS.has(before)) continue;
    spans.push({ from, to });
  }
  return spans;
}

/** Переименование в одном скрипте: сколько вхождений заменено — в ответе. */
export function renameInScript(text: string, from: string, to: string): { text: string; count: number } {
  if (from === to || !isVariableIdentifier(to)) return { text, count: 0 };
  const spans = renameSpans(text, from);
  if (spans.length === 0) return { text, count: 0 };
  let out = text;
  for (const span of [...spans].reverse()) out = out.slice(0, span.from) + to + out.slice(span.to);
  return { text: out, count: spans.length };
}

/**
 * Ссылки в настройках поведения: источник видимости вида `state.имя`.
 *
 * Имя там хранится **снимком**: блок — это JSON в комментарии, и скрипт его не
 * читает. Поэтому замена по тексту скрипта до него не достаёт, а настройка
 * после переименования читала бы ноль. Патчим только строку блока и только
 * `state`-источники: имена модулей и пресетов переименование переменной не
 * касается.
 */
export function renameBehaviourChange(
  script: string,
  from: string,
  to: string,
): NameSpan & { insert: string } | null {
  if (from === to || !isVariableIdentifier(to)) return null;
  const start = script.indexOf(BEHAVIOUR_META);
  if (start < 0) return null;
  const lineStart = script.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = script.indexOf("\n", start);
  const end = lineEnd === -1 ? script.length : lineEnd;
  const line = script.slice(lineStart, end);
  const trimmed = line.trimStart();
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed.slice(BEHAVIOUR_META.length));
  } catch {
    // Битая строка блока — не повод ломать скрипт: её правит панель.
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  if (!Array.isArray(source.visibility)) return null;
  let touched = false;
  const visibility = source.visibility.map((item) => {
    if (!item || typeof item !== "object") return item;
    const entry = item as Record<string, unknown>;
    if (entry.kind !== "state" || entry.name !== from) return item;
    touched = true;
    return { ...entry, name: to };
  });
  if (!touched) return null;
  const indent = line.slice(0, line.length - trimmed.length);
  return {
    from: lineStart,
    to: end,
    insert: `${indent}${BEHAVIOUR_META}${JSON.stringify({ ...source, visibility })}`,
  };
}

/** Та же замена, но текстом: ею правится скрипт целиком (не редактором). */
export function renameBehaviour(script: string, from: string, to: string): string {
  const change = renameBehaviourChange(script, from, to);
  if (!change) return script;
  return script.slice(0, change.from) + change.insert + script.slice(change.to);
}

/** Что вышло из переименования глобальной переменной в объектах. */
export interface RenameReport {
  /** Сколько объектов изменилось. */
  objects: number;
  /** Кого не тронули: там объявлена своя переменная с тем же именем. */
  skipped: string[];
}

/**
 * Глобальная переменная переименована — обновляем все скрипты объектов.
 *
 * Объект, у которого объявлена **своя** переменная с тем же именем, пропускается
 * целиком: внутри него это имя означает своё, и переименование глобальной к ней
 * отношения не имеет. Такие объекты возвращаются в отчёте, чтобы карточка могла
 * сказать, кого не тронули, а не молчать.
 */
export function renameGlobalInObjects(
  objects: RigObject[],
  from: string,
  to: string,
): { objects: RigObject[]; report: RenameReport } {
  const report: RenameReport = { objects: 0, skipped: [] };
  if (from === to || !isVariableIdentifier(to)) return { objects, report };
  const next = objects.map((object) => {
    const script = object.script ?? "";
    if (localNames(script).includes(from)) {
      report.skipped.push(object.id);
      return object;
    }
    const renamed = renameInScript(script, from, to);
    const withBehaviour = renameBehaviour(renamed.text, from, to);
    if (renamed.count === 0 && withBehaviour === renamed.text) return object;
    report.objects += 1;
    return { ...object, script: withBehaviour };
  });
  return { objects: next, report };
}
