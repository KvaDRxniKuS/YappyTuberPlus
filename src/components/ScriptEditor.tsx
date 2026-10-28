import { useEffect, useRef, useState, type DragEvent, type PointerEvent } from "react";
import { ChevronRight } from "lucide-react";
import { basicSetup } from "codemirror";
import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, showTooltip, type DecorationSet } from "@codemirror/view";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { autocompletion, snippet, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";
import type { ScriptIssueInfo } from "../types";
import {
  describeIssues, eventNames, freeEventName, issueName, issueSpans, issueTarget, nameSpans,
  scopeTitle, type ErrorSpan, type ScriptCheck, type ScriptScope,
} from "../engine/scripts";
import {
  FUNCTION_NAMES, INPUT_FIELDS, SIGNATURES, hintAt, signatureAt, signatureLine, signatureOf,
} from "../engine/signatures";
import { useFavorites } from "../hooks/useFavorites";

const language = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^\/\/.*/)) return "comment";
    // Строка — значение: `text = "привет"`.
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";
    // Ключевые слова событий: объявление, подписка, вызов и длительность.
    if (stream.match(/^(?:event|on|call|in|and|or|not|inherit|parent|offset)\b/)) return "keyword";
    if (stream.match(/^(?:time|dt|canvasWidth|canvasHeight|width|height|pi|e|signal|start|text)\b/)) return "variableName.special";
    // Поля входа: направления уровня и активность за окно.
    if (stream.match(/^\.(?:up|down|change|count|sum|avg|min|max|step|label|kind)\b/)) return "typeName";
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const word = stream.current();
      if (word === "state") return "variableName.special";
      if (/^\s*\(/.test(stream.string.slice(stream.pos))) return "function";
      return "variableName";
    }
    if (stream.match(/^[+\-*/%^<>=?:!]+/)) return "operator";
    if (stream.match(/^[{},]/)) return "punctuation";
    stream.next();
    return null;
  },
});

const highlight = HighlightStyle.define([
  { tag: tags.comment, color: "#737b86", fontStyle: "italic" },
  { tag: tags.number, color: "#d7b989" },
  { tag: tags.string, color: "#b6cf9a" },
  { tag: tags.keyword, color: "#91b9d5" },
  { tag: tags.function(tags.variableName), color: "#91d4c3" },
  { tag: tags.special(tags.variableName), color: "#c2a9df" },
  { tag: tags.typeName, color: "#d8a4bd" },
  { tag: tags.operator, color: "#a7adb7" },
  { tag: tags.propertyName, color: "#d8dce2" },
  { tag: tags.punctuation, color: "#8a929c" },
]);

const PARAMETERS = [
  "x", "y", "rotation", "sizeX", "sizeY", "skewX", "skewY", "opacity", "visible", "layer",
  // Маска: 1 — режет по контуру, 0 — объект целиком (см. «Маска» в инспекторе).
  "mask",
  // Деформация: углы в процентах размера зоны (см. «Деформация» в инспекторе).
  "warpTLx", "warpTLy", "warpTRx", "warpTRy", "warpBRx", "warpBRy", "warpBLx", "warpBLy",
  // Материал: три канала заменяют инспектор (−1 — «не задано»), свечение
  // прибавляется (см. «Материал» в инспекторе).
  "roughness", "metallic", "ao", "emissive", "ior",
];
// `text` — строковый параметр текстового объекта: база в скрипте объекта
// (`text = "привет"`), переопределение — в блоке события. Отдельно от чисел,
// потому что кадр отдаёт его строкой, а не числом.
const TEXT_PARAMETER = "text";
// Входы приходят из модулей и подставляются в автодополнение динамически.
const INPUTS = ["time", "dt", "signal", "parent", "inherit", "offset", "width", "height", "canvasWidth", "canvasHeight", "state"];
// Порядок групп в списке функций под редактором.
const GROUPS: Array<{ id: "math" | "vector" | "physics" | "random" | "compare" | "media" | "text"; title: string }> = [
  { id: "math", title: "математика" },
  { id: "vector", title: "векторы" },
  { id: "physics", title: "физика" },
  { id: "random", title: "случайность" },
  { id: "compare", title: "сравнения" },
  { id: "media", title: "медиа" },
  { id: "text", title: "текст" },
];

/**
 * MIME перетаскиваемого блока. Свой тип нужен, чтобы редактор не путал блок из
 * шпаргалки с файлом, который бросили на окно (файл — это импорт объекта).
 */
const SNIPPET_MIME = "application/x-yappy-snippet";

/**
 * Готовые блоки событий для шпаргалки: скелет, тело пишет автор.
 *
 * Перетаскиваются в скрипт мышкой и вставляются кликом — так событие не надо
 * вспоминать по памяти, а `on start {}` не превращается в пустой блок.
 */
const EVENT_BLOCKS: Array<{ code: string; note: string }> = [
  { code: "on start {\n  \n}", note: "первый кадр после запуска и после «Стоп»" },
  {
    code: "event click() { mouse.left.up }\non click {\n  \n}",
    note: "нажатие: сигнал вырос; тело пишет автор",
  },
  {
    code: "event speak (loud = mic.loudness ; 5000) { mic.talking > 0.2 in 500 }\n"
      + "on speak {\n  mouth.open = loud > 0.5\n}",
    note: "переменные события и пауза: loud — снимок на момент срабатывания",
  },
  {
    code: "event silence() { !(mic.talking > 0.2) in 600 }\non silence {\n  \n}",
    note: "тишина дольше 0,6 с: отрицание вместо relax",
  },
  {
    code: "event burst() { mouse.left.count(5) > 10 }\non burst {\n  \n}",
    note: "активность любого входа: сколько событий за 5 секунд",
  },
  {
    code: "event reward() { twitch.reward.sum(10) >= 80 }\non reward {\n  \n}",
    note: "вес событий: сумма бит наград за 10 секунд",
  },
  {
    code: "on start {\n  call click(0.9)\n}",
    note: "call — обработчик сразу, пауза cd не мешает",
  },
];

/** Заготовка объявления события: имя и условие подставляет автор. */
const EVENT_DECLARATION = "event имя(переменные ; пауза) { условие }\non имя {\n  \n}\n";

/** Перетаскивание блока: кладём и свой MIME, и обычный текст — на всякий случай. */
function startBlockDrag(event: DragEvent, code: string): void {
  event.dataTransfer.setData(SNIPPET_MIME, code);
  event.dataTransfer.setData("text/plain", code);
  event.dataTransfer.effectAllowed = "copy";
}

/**
 * Бросок блока в редактор. CodeMirror отдаёт координаты, поэтому блок встаёт
 * ровно туда, где отпустили мышь, а не в конец скрипта.
 */
const dropSnippet = EditorView.domEventHandlers({
  dragover(event) {
    const transfer = event.dataTransfer;
    if (!transfer || !Array.from(transfer.types).includes(SNIPPET_MIME)) return false;
    event.preventDefault();
    transfer.dropEffect = "copy";
    return true;
  },
  drop(event, editor) {
    const transfer = event.dataTransfer;
    if (!transfer) return false;
    const raw = transfer.getData(SNIPPET_MIME);
    if (!raw) return false;
    event.preventDefault();
    const snippet = freeEventName(editor.state.doc.toString(), raw);
    const at = editor.posAtCoords({ x: event.clientX, y: event.clientY })
      ?? editor.state.selection.main.head;
    // Блок встаёт отдельной строкой: в середине строки код сломался бы.
    const line = editor.state.doc.lineAt(at);
    const insert = (line.text.trim() ? "\n" : "") + snippet;
    editor.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length } });
    editor.focus();
    return true;
  },
});

/** Высота открытой шпаргалки: запоминается, чтобы окно не прыгало между сессиями. */
const HELP_HEIGHT_KEY = "yappytuberplus.cheatsheet.height.v1";

/**
 * Подчёркивание мест ошибки.
 *
 * Конфликт имён — это всегда две декларации, поэтому подсветка не одна:
 * `related` отмечает вторую (чужую) строку другим цветом. Если она в другом
 * скрипте, здесь подчёркивать нечего — о ней скажет сообщение под редактором.
 */
const errorEffect = StateEffect.define<ErrorSpan[] | null>();

const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(errorEffect)) continue;
      next = effect.value
        ? Decoration.set(
          effect.value.map((range) => Decoration.mark({
            class: range.related ? "cm-script-related" : "cm-script-error",
          }).range(range.from, range.to)),
          // Порядок важен для CodeMirror: диапазоны идут по тексту.
          true,
        )
        : Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Текст подсказки в самом редакторе.
 *
 * Раньше подсказка жила строкой под редактором и отъедала высоту; теперь она
 * всплывает у курсора и не мешает читать скрипт.
 */
const hintEffect = StateEffect.define<string>();

const hintField = StateField.define<string>({
  create: () => "",
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(hintEffect)) return effect.value;
    }
    return value;
  },
});

/**
 * Строка, к которой вернулись по клику на ошибку в другом скрипте.
 *
 * Подсветка временная: она отвечает на вопрос «куда я попал», а не ругается.
 * Красится не строка, а **все вхождения имени**: спор идёт об имени, и видеть
 * надо объявление, подписку и вызовы сразу.
 */
const revealEffect = StateEffect.define<ErrorSpan[] | null>();

const revealField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(revealEffect)) continue;
      next = effect.value
        ? Decoration.set(
          effect.value.map((span) => Decoration.mark({ class: "cm-script-reveal" }).range(span.from, span.to)),
          true,
        )
        : Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Все вхождения спорного имени — пока ошибка не исправлена.
 *
 * Отличается от `reveal` намеренно: переход горит пару секунд, а имя остаётся
 * подсвеченным, пока конфликт есть. Так видно, где ещё используется имя, из-за
 * которого скрипт не собирается.
 */
const nameEffect = StateEffect.define<ErrorSpan[] | null>();

const nameField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(nameEffect)) continue;
      next = effect.value
        ? Decoration.set(
          effect.value.map((span) => Decoration.mark({ class: "cm-script-name" }).range(span.from, span.to)),
          true,
        )
        : Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const hintTooltip = showTooltip.compute([hintField], (state) => {
  const text = state.field(hintField);
  if (!text) return null;
  return {
    pos: state.selection.main.head,
    above: true,
    arrow: false,
    create: () => {
      const dom = document.createElement("div");
      dom.className = "cm-script-hint";
      dom.textContent = text;
      return { dom };
    },
  };
});

interface ScriptEditorProps {
  value: string;
  objectIds: string[];
  globals: string[];
  /** Полные имена входов модулей: `mic.talking`, `auto.blink`, `manual.value`. */
  moduleInputs?: string[];
  /** Подписи входов для подсказки события: `twitch.chat` → «Сообщений». */
  moduleInputLabels?: Record<string, string>;
  /** Объявленные события: глобальные плюс локальные события этого скрипта. */
  events?: string[];
  /** Константы модулей: состояния enum (`walk`, `mode_walk`). */
  constants?: string[];
  /**
   * Что проверять: чей это скрипт и как устроены соседние области.
   *
   * Без соседей ядро не увидит конфликт имён — а он всегда про две строки:
   * «объявлено глобально» и «глобальное имя заняли в объекте».
   */
  checkScope?: ScriptScope;
  /**
   * Куда перейти внутри этого текста: строка и номер попытки.
   *
   * Номер нужен, чтобы повторный клик по той же ошибке снова подсветил строку:
   * одинаковые значения пропсов не вызывают эффект.
   */
  reveal?: { line: number; nonce: number; name?: string };
  /** Клик по ошибке в другом скрипте: переключить область и встать на строку. */
  onOpenIssue?: (scope: string, line: number, name?: string) => void;
  onCheck?: ScriptCheck;
  onApply: (value: string) => void;
}

export function ScriptEditor({
  value, objectIds, globals, moduleInputs = [], moduleInputLabels = {}, events = [],
  constants = [], checkScope, reveal, onOpenIssue, onCheck, onApply,
}: ScriptEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const applyRef = useRef(onApply);
  const checkRef = useRef(onCheck);
  const runCheckRef = useRef<(source: string) => void>(() => {});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completionData = useRef({ objectIds, globals, moduleInputs, events, constants });
  const hintData = useRef({ moduleInputs, moduleInputLabels, events });
  hintData.current = { moduleInputs, moduleInputLabels, events };
  // Соседние области читаются в момент проверки: правка глобального скрипта
  // должна снимать ошибку в скрипте объекта без пересоздания редактора.
  const checkData = useRef<ScriptScope>(checkScope ?? { globals: "", objects: [] });
  checkData.current = checkScope ?? { globals: "", objects: [] };
  const [issues, setIssues] = useState<ScriptIssueInfo[]>([]);
  // Шпаргалка и список функций свёрнуты: редактор важнее, подсказки — по клику.
  const [helpOpen, setHelpOpen] = useState(false);
  // Высота шпаргалки: её тянут за верхний край и запоминают между сессиями.
  const [helpHeight, setHelpHeight] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(HELP_HEIGHT_KEY));
      return Number.isFinite(stored) && stored >= 90 ? stored : 190;
    } catch {
      return 190;
    }
  });
  const helpHeightRef = useRef(helpHeight);
  helpHeightRef.current = helpHeight;
  const helpDrag = useRef<{ y: number; height: number } | null>(null);
  const { favorites, toggle: toggleFavorite } = useFavorites();
  // Старые закладки могли указывать на удалённую функцию — показываем только живые.
  const pinned = favorites.filter((name) => SIGNATURES[name] !== undefined);
  applyRef.current = onApply;
  checkRef.current = onCheck;
  completionData.current = { objectIds, globals, moduleInputs, events, constants };

  useEffect(() => {
    if (!host.current) return;
    const applyNow = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (view.current) applyRef.current(view.current.state.doc.toString());
    };
    const readHint = (state: EditorState) => {
      const source = state.doc.toString();
      const position = state.selection.main.head;
      // Место события важнее вызова функции: подсказка объясняет форму
      // `event имя() { условие }`, `on имя` и оператор `in`.
      const inputs = hintData.current.moduleInputs.map((key) => ({
        key,
        label: hintData.current.moduleInputLabels[key],
      }));
      const events = [...new Set([...hintData.current.events, ...eventNames(source)])];
      const text = hintAt(source, position, { inputs, events })
        ?? signatureLine(signatureAt(source, position));
      if (state.field(hintField) === text) return;
      // Dispatch внутри updateListener дал бы рекурсию, поэтому кадр позже.
      requestAnimationFrame(() => {
        const current = view.current;
        if (!current || current.state.field(hintField) === text) return;
        current.dispatch({ effects: hintEffect.of(text) });
      });
    };
    // Проверка идёт отдельно от применения: ошибка подсвечивается, но текст
    // продолжает автосохраняться — сцену это не останавливает.
    const runCheck = (source: string) => {
      const editor = view.current;
      const check = checkRef.current;
      if (!editor || !check) return;
      const scope = checkData.current;
      void check(source, scope).then((next) => {
        const current = view.current;
        if (!current || current.state.doc.toString() !== source) return;
        const text = current.state.doc.toString();
        const spans = issueSpans(text, next, scope.scope ?? "globals");
        const name = issueName(next);
        const occurrences = name ? nameSpans(text, name) : [];
        setIssues(next);
        current.dispatch({
          effects: [
            errorEffect.of(spans.length > 0 ? spans : null),
            nameEffect.of(occurrences.length > 0 ? occurrences : null),
          ],
        });
      }).catch(() => { /* ядро без `check` — просто без подсветки */ });
    };
    runCheckRef.current = runCheck;
    const scheduleCheck = (source: string) => {
      if (checkTimer.current) clearTimeout(checkTimer.current);
      checkTimer.current = setTimeout(() => runCheck(source), 320);
    };

    /** Объявленные события: из пропсов плюс уже написанные в этом тексте. */
    const declaredEvents = (state: EditorState) =>
      [...new Set([...completionData.current.events, ...eventNames(state.doc.toString())])];

    const completion = (context: CompletionContext): CompletionResult | null => {
      const word = context.matchBefore(/[A-Za-z0-9_.]*/);
      if (!word || (word.from === word.to && !context.explicit)) return null;
      const {
        objectIds: ids, globals: globalNames, moduleInputs: inputNames,
        constants: constantNames,
      } = completionData.current;
      const line = context.state.doc.lineAt(context.pos);
      const prefix = context.state.sliceDoc(line.from, context.pos);

      // `on …`: только `start` и объявленные события — путей к входам нет.
      if (/^\s*on\s+[\w]*$/.test(prefix)) {
        return {
          from: word.from,
          validFor: /^[A-Za-z0-9_]*$/,
          options: [
            {
              label: "start",
              detail: "первый кадр после запуска",
              type: "keyword",
              apply: snippet("start {\n\t\${}\n}"),
            },
            ...declaredEvents(context.state).map((name) => ({
              label: name,
              detail: "своё событие (event)",
              type: "variable",
              apply: snippet(`${name} {\n\t\${}\n}`),
            })),
          ],
        };
      }
      // `call …`: те же имена, но обработчик запускается сразу.
      if (/(?:^|[^\w.])call\s+[\w]*$/.test(prefix)) {
        return {
          from: word.from,
          validFor: /^[A-Za-z0-9_]*$/,
          options: declaredEvents(context.state).map((name) => ({
            label: name,
            detail: "вызвать обработчик сразу",
            type: "function",
            apply: `${name}()`,
          })),
        };
      }
      // `event …`: готовый скелет — форма и обработчик рядом.
      if (/^\s*event\s+[\w]*$/.test(prefix)) {
        return {
          from: word.from,
          validFor: /^[A-Za-z0-9_]*$/,
          options: [
            {
              label: "click",
              detail: "нажатие: mouse.left.up",
              type: "keyword",
              apply: snippet("click() { mouse.left.up }\n\non click {\n\t\${}\n}"),
            },
            {
              label: "speak",
              detail: "речь дольше 0,5 с: in 500",
              type: "keyword",
              apply: snippet("speak() { mic.talking > 0.2 in 500 }\n\non speak {\n\t\${}\n}"),
            },
            {
              label: "chat",
              detail: "активность чата за 5 с",
              type: "keyword",
              apply: snippet("chat() { twitch.chat.count(5) > 10 }\n\non chat {\n\t\${}\n}"),
            },
          ],
        };
      }
      // `in …`: время условия в миллисекундах или секундах.
      if (/(?:^|[^\w.])in\s+$/.test(prefix)) {
        return {
          from: context.pos,
          options: ["100", "250", "500", "1000", "0.5s", "1s"].map((value) => ({
            label: value,
            detail: "мс; суффикс s — секунды",
            type: "constant",
          })),
        };
      }
      // `<вход>.` — направления уровня и активность за окно.
      const inputField = /(?:^|[^\w.])([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)\.(\w*)$/.exec(prefix);
      if (inputField && inputNames.includes(inputField[1])) {
        const start = context.pos - inputField[2].length;
        return {
          from: start,
          validFor: /^\w*$/,
          options: INPUT_FIELDS.map((entry) => ({
            label: entry.field,
            detail: entry.note,
            type: "property",
            apply: entry.field.includes("(") ? snippet(entry.field.replace("(", "(\${}")) : entry.field,
          })),
        };
      }
      // `state.` — прошлый кадр: подсказываем переменные и параметры объекта.
      const stateMember = /(?:^|[^\w.])state\.(\w*)$/.exec(prefix);
      if (stateMember) {
        const start = context.pos - stateMember[1].length;
        return {
          from: start,
          validFor: /^\w*$/,
          options: [...new Set([...globalNames, ...PARAMETERS])].map((label) => ({
            label,
            type: PARAMETERS.includes(label) ? "property" : "variable",
            detail: "значение прошлого кадра",
          })),
        };
      }
      // `объект.` — параметры чужого объекта: `head.rotation = …`.
      const member = /(?:^|[^\w.])([A-Za-z_][A-Za-z0-9_]*)\.(\w*)$/.exec(prefix);
      if (member && ids.includes(member[1])) {
        const start = context.pos - member[2].length;
        return {
          from: start,
          validFor: /^\w*$/,
          options: [...PARAMETERS, TEXT_PARAMETER].map((label) => ({
            label,
            type: "property",
            detail: label === TEXT_PARAMETER ? `текст объекта ${member[1]}` : `параметр ${member[1]}`,
          })),
        };
      }
      const localEvents = declaredEvents(context.state);
      const options = [...new Set([
        ...ids, ...globalNames, ...PARAMETERS, TEXT_PARAMETER, ...INPUTS, ...inputNames,
        ...localEvents, ...constantNames, ...FUNCTION_NAMES,
      ])].map((label) => {
        if (SIGNATURES[label]) {
          return {
            label,
            type: "function",
            detail: signatureOf(label),
            info: SIGNATURES[label].summary,
            apply: `${label}()`,
          };
        }
        const detail = PARAMETERS.includes(label)
          ? "параметр объекта"
          : inputNames.includes(label)
            ? "вход модуля"
            : ids.includes(label)
              ? "объект"
              : globalNames.includes(label)
                ? "глобальная переменная"
                : localEvents.includes(label)
                  ? "своё событие"
                  : constantNames.includes(label)
                    ? "состояние модуля"
                    : "встроенное";
        return { label, type: PARAMETERS.includes(label) ? "property" : "variable", detail };
      });
      return { from: word.from, options, validFor: /^[A-Za-z0-9_.]*$/ };
    };
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        language,
        syntaxHighlighting(highlight),
        errorField,
        hintField,
        hintTooltip,
        autocompletion({ override: [completion], activateOnTyping: true }),
        dropSnippet,
        Prec.highest(keymap.of([{ key: "Mod-s", run: () => { applyNow(); return true; } }])),
        EditorView.updateListener.of((update) => {
          if (update.docChanged || update.selectionSet) readHint(update.state);
          if (!update.docChanged) return;
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(applyNow, 420);
          scheduleCheck(update.state.doc.toString());
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "14.5px", backgroundColor: "transparent" },
          ".cm-scroller": { fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace", lineHeight: "1.65" },
          ".cm-gutters": { backgroundColor: "#1b1e23", color: "#5f6670", border: "none" },
          ".cm-activeLine": { backgroundColor: "#ffffff05" },
          ".cm-activeLineGutter": { backgroundColor: "#ffffff06", color: "#aab1bb" },
          ".cm-content": { caretColor: "#8ad8c6", padding: "10px 0" },
          ".cm-line": { padding: "0 14px 0 10px" },
          "&.cm-focused": { outline: "none" },
          ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "#6eb8a834 !important" },
          ".cm-cursor": { borderLeftColor: "#8ad8c6" },
          ".cm-script-error": { textDecoration: "underline wavy #e08b8b" },
          ".cm-script-related": { textDecoration: "underline wavy #d3ad6a" },
          ".cm-script-reveal": { backgroundColor: "#8ad8c622", outline: "1px solid #8ad8c655" },
          ".cm-script-name": { backgroundColor: "#d8a4bd1f", borderRadius: "2px" },
          ".cm-script-hint": {
            padding: "3px 8px",
            background: "#232b31",
            border: "1px solid #36434c",
            borderRadius: "4px",
            color: "#9fd3c6",
            fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
            fontSize: "11.5px",
            whiteSpace: "nowrap",
            boxShadow: "0 6px 18px #0006",
          },
          ".cm-tooltip": { backgroundColor: "#24282f", border: "1px solid #363c45", color: "#d9dde2" },
          ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "#35414a", color: "#f0f4f7" },
          ".cm-completionDetail": { color: "#7f8b96", fontStyle: "normal", marginLeft: "8px" },
          ".cm-completionInfo": { backgroundColor: "#24282f", border: "1px solid #363c45", padding: "6px 8px", maxWidth: "260px" },
        }),
      ],
    });
    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;
    readHint(state);
    runCheck(value);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (checkTimer.current) clearTimeout(checkTimer.current);
      editor.destroy();
      view.current = null;
    };
    // The parent keys this component by object/global tab; resizing never recreates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    const cursor = Math.min(editor.state.selection.main.anchor, value.length);
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value }, selection: { anchor: cursor } });
    runCheckRef.current(value);
  }, [value]);

  /**
   * Переход к строке: клик по ошибке в другом скрипте.
   *
   * Зависимость — только `nonce`: объект ошибки пересоздаётся на каждый рендер,
   * а подсветить надо ровно один раз на клик, даже если строка та же.
   */
  const revealNonce = reveal?.nonce;
  useEffect(() => {
    const editor = view.current;
    const line = reveal?.line;
    if (!editor || !line) return;
    const target = editor.state.doc.line(Math.min(Math.max(line, 1), editor.state.doc.lines));
    // Имя важнее строки: подсвечиваем все его вхождения, а строку только
    // показываем — по ней ставится каретка и прокрутка.
    const name = reveal?.name ?? "";
    const spans = nameSpans(editor.state.doc.toString(), name);
    editor.dispatch({
      selection: { anchor: target.from },
      effects: [
        EditorView.scrollIntoView(target.from, { y: "center" }),
        revealEffect.of(spans.length > 0
          ? spans
          : [{ from: target.from, to: target.to, related: true }]),
      ],
    });
    editor.focus();
    const timer = window.setTimeout(() => {
      view.current?.dispatch({ effects: revealEffect.of(null) });
    }, 1600);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealNonce]);

  /**
   * Вставка готового блока (клик по шпаргалке — то же, что бросок мышью).
   *
   * Блок встаёт отдельной строкой, а каретка — в пустую строку внутри `{ … }`:
   * сразу видно, где писать тело.
   */
  const insertSnippet = (raw: string) => {
    const editor = view.current;
    if (!editor) return;
    // Второй блок того же события получит `_2`: иначе ядро ответит «уже объявлено».
    const code = freeEventName(editor.state.doc.toString(), raw);
    const range = editor.state.selection.main;
    const line = editor.state.doc.lineAt(range.from);
    const text = (line.text.trim() ? "\n" : "") + code;
    const body = text.indexOf("\n  \n");
    const anchor = range.from + (body >= 0 ? body + 3 : text.length);
    editor.dispatch({
      changes: { from: range.from, to: range.to, insert: text },
      selection: { anchor },
    });
    editor.focus();
  };

  /** Тянуть за верхний край шпаргалки: предел считается от окна, а не по числу. */
  const startHelpResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    helpDrag.current = { y: event.clientY, height: helpHeightRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveHelpResize = (event: PointerEvent<HTMLDivElement>) => {
    const state = helpDrag.current;
    if (!state) return;
    const limit = Math.max(160, window.innerHeight * 0.6);
    setHelpHeight(Math.min(limit, Math.max(90, state.height - (event.clientY - state.y))));
  };

  const endHelpResize = () => {
    if (!helpDrag.current) return;
    helpDrag.current = null;
    try {
      localStorage.setItem(HELP_HEIGHT_KEY, String(Math.round(helpHeightRef.current)));
    } catch {
      // Приватный режим: высота просто не запомнится.
    }
  };

  // Клик по функции вставляет её в позицию курсора и ставит каретку в скобки:
  // подсказка ниже сразу показывает ожидаемые аргументы.
  const insert = (name: string) => {
    const editor = view.current;
    if (!editor) return;
    const text = `${name}()`;
    editor.dispatch({
      changes: { from: editor.state.selection.main.from, to: editor.state.selection.main.to, insert: text },
      selection: { anchor: editor.state.selection.main.from + text.length - 1 },
    });
    editor.focus();
  };

  // Второе объявление может быть в другом скрипте: тогда в тексте его не
  // подчеркнуть, зато можно туда перейти — область и строка известны.
  const ownScope = checkScope?.scope ?? "globals";
  const jump = issueTarget(issues, ownScope);
  const jumpTitle = jump ? scopeTitle(jump.scope) : "";

  return (
    <>
      <div className="code-editor" ref={host} />
      {issues.length > 0 && (
        <div className="script-error-line" title={describeIssues(issues)}>
          <span className="script-error-text">{describeIssues(issues)}</span>
          {jump && (
            <button
              type="button"
              className="script-error-jump"
              title={`Показать второе объявление: ${jumpTitle}, строка ${jump.line}. Область переключится, имя подсветится во всех местах`}
              onClick={() => onOpenIssue?.(jump.scope, jump.line, jump.name)}
            >
              <ChevronRight size={11} /> {jumpTitle}:{jump.line}
            </button>
          )}
        </div>
      )}
      {pinned.length > 0 && (
        <div className="favorite-commands">
          <span className="favorite-title" title="Избранные команды: клик вставляет вызов">★ Избранные</span>
          {pinned.map((name) => (
            <code key={name} title={SIGNATURES[name].summary} onClick={() => insert(name)}>
              {signatureOf(name)}
            </code>
          ))}
        </div>
      )}
      <div className={`editor-help ${helpOpen ? "open" : ""}`}>
        <button
          className="editor-help-toggle"
          onClick={() => setHelpOpen(!helpOpen)}
          aria-expanded={helpOpen}
          title={helpOpen ? "Скрыть шпаргалку и список функций" : "Показать шпаргалку и список функций"}
        >
          <ChevronRight size={12} />
          <span>Шпаргалка и функции</span>
          <small>{GROUPS.map((group) => group.title).join(" · ")}</small>
        </button>
        {helpOpen && (
          <div className="editor-help-body" style={{ height: helpHeight }}>
            <div
              className="editor-help-resize"
              title="Тяните, чтобы изменить высоту шпаргалки"
              onPointerDown={startHelpResize}
              onPointerMove={moveHelpResize}
              onPointerUp={endHelpResize}
              onPointerCancel={endHelpResize}
            />
            <div className="help-events">
              <span className="help-events-title">События · перетащите в скрипт или кликните</span>
              <div className="help-event-list">
                {EVENT_BLOCKS.map((block) => (
                  <button
                    key={block.code}
                    className="help-event"
                    draggable
                    title={`${block.note}. Перетащите в скрипт или кликните — блок встанет на месте курсора`}
                    onDragStart={(event) => startBlockDrag(event, block.code)}
                    onClick={() => insertSnippet(block.code)}
                  >
                    <code>{block.code.split("\n")[0].trim()}</code>
                    <small>{block.note}</small>
                  </button>
                ))}
                <button
                  className="help-event"
                  draggable
                  title="Объявление события: условие в фигурных скобках, действия — в on ниже"
                  onDragStart={(event) => startBlockDrag(event, EVENT_DECLARATION)}
                  onClick={() => insertSnippet(EVENT_DECLARATION)}
                >
                  <code>event имя() {"{ условие }"}</code>
                  <small>своё событие: имя, переменные и пауза в скобках</small>
                </button>
              </div>
            </div>
            <div className="editor-hint">
              <span><b>{"event имя(переменные ; пауза) { условие }"}</b> — условие пишет автор</span>
              <span><b>on имя {"{ … }"}</b> — действия; <b>on start</b> — первый кадр и после «Стоп»</span>
              <span>событие из глобального скрипта видно всем; локальное — только своему объекту</span>
              <span>переменные события — живые в условии и снимок в <b>on</b>; имя параметра объекта занимать нельзя</span>
              <span><b>in</b> — длительность: <b>mic.talking &gt; 0.2 in 500</b>, <b>in 0.5s</b></span>
              <span><b>.up</b> вырос · <b>.down</b> упал · <b>.change</b> отличается от прошлого кадра</span>
              <span>активность входа (любого): <b>mouse.left.count(5)</b> · <b>twitch.chat.sum(5)</b> · <b>avg(5)</b></span>
              <span><b>call имя(аргументы)</b> — обработчик выполняется сразу, пауза не мешает</span>
              <span>команды — отдельной строкой: <b>{"on start { play() }"}</b>, <b>seek(2.5)</b>, <b>{'play("дождь")'}</b></span>
              <span>чужой объект: <b>{'label.text = "…"'}</b>, <b>{'text("label", "…")'}</b></span>
              <span>текст — переменная: <b>{'text = "привет"'}</b> — база, в событии переопределяет до «Стопа»</span>
              <span>число в текст: <b>text = text(mic.db)</b>, склейка — <b>{'text = "db " + text(mic.db)'}</b></span>
              <span>текст всегда в кавычках: <b>{'text("привет")'}</b>; кириллица без кавычек — ошибка разбора</span>
            </div>
            <div className="function-chips">
              {GROUPS.map((group) => (
                <div className="function-chip-group" key={group.id}>
                  <span className="function-chip-title">{group.title}</span>
                  {Object.entries(SIGNATURES)
                    .filter(([, entry]) => entry.group === group.id)
                    .map(([name]) => {
                      const fav = favorites.includes(name);
                      return (
                        <span className={`function-chip ${fav ? "fav" : ""}`} key={name}>
                          <button
                            className="chip-insert"
                            draggable
                            title={`${SIGNATURES[name].summary}. Клик — вставить вызов, можно перетащить в скрипт`}
                            onDragStart={(event) => startBlockDrag(event, `${name}()`)}
                            onClick={() => insert(name)}
                          >
                            {signatureOf(name)}
                          </button>
                          <button
                            className="chip-star"
                            title={fav ? "Убрать из избранных" : "В избранные: функция всегда под рукой"}
                            aria-label={`${fav ? "Убрать из избранных" : "В избранные"}: ${name}`}
                            aria-pressed={fav}
                            onClick={() => toggleFavorite(name)}
                          >
                            ★
                          </button>
                        </span>
                      );
                    })}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
