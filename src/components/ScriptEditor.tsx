import { useEffect, useRef, useState, type DragEvent, type PointerEvent } from "react";
import { ChevronRight } from "lucide-react";
import { basicSetup } from "codemirror";
import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { autocompletion, snippet, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";
import type { ScriptErrorInfo } from "../types";
import type { ScriptCheck } from "../engine/scripts";
import {
  FUNCTION_NAMES, SIGNATURES, eventHintAt, signatureAt, signatureLine, signatureOf,
} from "../engine/signatures";
import { useFavorites } from "../hooks/useFavorites";

const EVENT_KINDS = ["down", "up", "change", "hold", "relax"];

const language = StreamLanguage.define({
  startState: () => ({ inEvent: false }),
  token(stream, state) {
    if (stream.sol()) state.inEvent = false;
    if (stream.eatSpace()) return null;
    if (stream.match(/^\/\/.*/)) return "comment";
    // Строка — значение: `text = "привет"`.
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";
    if (stream.match(/^(?:and|or|not|inherit|parent|offset|on|trigger)\b/)) return "keyword";
    if (stream.match(/^(?:time|dt|canvasWidth|canvasHeight|width|height|pi|e|signal|start|text)\b/)) return "variableName.special";
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const word = stream.current();
      // Внутри заголовка события модуль и вход — обычные свойства, а тип
      // (`down`, `hold`, …) подсвечен отдельно.
      if (state.inEvent) {
        if (EVENT_KINDS.includes(word)) return "typeName";
        return "propertyName";
      }
      if (word === "event") {
        state.inEvent = true;
        return "variableName.special";
      }
      if (word === "state") return "variableName.special";
      if (/^\s*\(/.test(stream.string.slice(stream.pos))) return "function";
      return "variableName";
    }
    if (stream.match(/^[+\-*/%^<>=?:!]+/)) return "operator";
    if (stream.match(/^[{},]/)) {
      state.inEvent = false;
      return "punctuation";
    }
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

const PARAMETERS = ["x", "y", "rotation", "sizeX", "sizeY", "skewX", "skewY", "opacity", "visible", "layer"];
// `text` — строковый параметр текстового объекта: база в скрипте объекта
// (`text = "привет"`), переопределение — в блоке события. Отдельно от чисел,
// потому что кадр отдаёт его строкой, а не числом.
const TEXT_PARAMETER = "text";
// Входы приходят из модулей и подставляются в автодополнение динамически.
const INPUTS = ["time", "dt", "signal", "parent", "inherit", "offset", "width", "height", "canvasWidth", "canvasHeight", "state"];
// Типы событий: `on мышь.вход.down`. `hold`/`relax` ждут время в секундах.
const EVENT_CHOICES = [
  { kind: "down", detail: "нажатие" },
  { kind: "up", detail: "отпускание" },
  { kind: "change", detail: "значение изменилось" },
  { kind: "hold(0.5)", detail: "держать 0.5 с; срабатывает кадром позже нажатия" },
  { kind: "relax(0.5)", detail: "отпущено 0.5 с; срабатывает кадром позже отпускания" },
];

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
  { code: "on mouse.left.down {\n  \n}", note: "нажатие: вход перешёл из 0 в 1" },
  { code: "on mouse.left.up {\n  \n}", note: "отпускание: вход вернулся в 0" },
  { code: "on mic.talking.change {\n  \n}", note: "значение изменилось с прошлого кадра" },
  { code: "on mouse.left.hold(0.5) {\n  \n}", note: "держать дольше 0,5 с — один раз за удержание" },
  { code: "on mouse.left.relax(0.6) {\n  \n}", note: "отпущено дольше 0,6 с — один раз за отпускание" },
];

/** Объявление своего события: живёт только в глобальном скрипте. */
const TRIGGER_BLOCK = "trigger kick = mouse.left.down\n";

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
    const snippet = transfer.getData(SNIPPET_MIME);
    if (!snippet) return false;
    event.preventDefault();
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

/** Подчёркивание места ошибки: диапазон приходит из ядра вместе с сообщением. */
const errorEffect = StateEffect.define<{ from: number; to: number } | null>();

const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(errorEffect)) continue;
      next = effect.value
        ? Decoration.set([Decoration.mark({ class: "cm-script-error" }).range(effect.value.from, effect.value.to)])
        : Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Строка и столбец ошибки в смещения документа. */
function errorRange(state: EditorState, error: ScriptErrorInfo | null): { from: number; to: number } | null {
  if (!error) return null;
  const line = state.doc.line(Math.min(Math.max(error.line, 1), state.doc.lines));
  const from = Math.min(line.from + Math.max(error.column - 1, 0), line.to);
  const to = Math.min(from + Math.max(error.length, 1), state.doc.length);
  if (to <= from) return null;
  return { from, to };
}

interface ScriptEditorProps {
  value: string;
  objectIds: string[];
  globals: string[];
  /** Полные имена входов модулей: `mic.talking`, `auto.blink`, `manual.value`. */
  moduleInputs?: string[];
  /** Подписи входов для подсказки события: `twitch.chat` → «Сообщений». */
  moduleInputLabels?: Record<string, string>;
  /** Имена событий из `trigger … = …` в глобальном скрипте. */
  triggers?: string[];
  /** Константы модулей: состояния enum (`walk`, `mode_walk`). */
  constants?: string[];
  onCheck?: ScriptCheck;
  onApply: (value: string) => void;
}

export function ScriptEditor({
  value, objectIds, globals, moduleInputs = [], moduleInputLabels = {}, triggers = [],
  constants = [], onCheck, onApply,
}: ScriptEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const applyRef = useRef(onApply);
  const checkRef = useRef(onCheck);
  const runCheckRef = useRef<(source: string) => void>(() => {});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completionData = useRef({ objectIds, globals, moduleInputs, triggers, constants });
  const hintData = useRef({ moduleInputs, moduleInputLabels });
  hintData.current = { moduleInputs, moduleInputLabels };
  const [hint, setHint] = useState("");
  const [errorText, setErrorText] = useState("");
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
  completionData.current = { objectIds, globals, moduleInputs, triggers, constants };

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
      // Заголовок события важнее вызова функции: подсказка показывает
      // единственную форму `on модуль.вход.тип` и типы события.
      const inputs = hintData.current.moduleInputs.map((key) => ({
        key,
        label: hintData.current.moduleInputLabels[key],
      }));
      setHint(eventHintAt(source, position, inputs)
        ?? signatureLine(signatureAt(source, position)));
    };
    // Проверка идёт отдельно от применения: ошибка подсвечивается, но текст
    // продолжает автосохраняться — сцену это не останавливает.
    const runCheck = (source: string) => {
      const editor = view.current;
      const check = checkRef.current;
      if (!editor || !check) return;
      void check(source).then((error) => {
        const current = view.current;
        if (!current || current.state.doc.toString() !== source) return;
        setErrorText(error?.message ?? "");
        current.dispatch({ effects: errorEffect.of(errorRange(current.state, error)) });
      }).catch(() => { /* ядро без `check` — просто без подсветки */ });
    };
    runCheckRef.current = runCheck;
    const scheduleCheck = (source: string) => {
      if (checkTimer.current) clearTimeout(checkTimer.current);
      checkTimer.current = setTimeout(() => runCheck(source), 320);
    };

    // Заголовок события — только `on …` или правая часть `trigger`.
    const isHeader = (prefix: string) =>
      /^\s*on\s+[\w.]*$/.test(prefix) || /^\s*trigger\s+[\w]+\s*=\s*[\w.]*$/.test(prefix);

    const completion = (context: CompletionContext): CompletionResult | null => {
      const word = context.matchBefore(/[A-Za-z0-9_.]*/);
      if (!word || (word.from === word.to && !context.explicit)) return null;
      const {
        objectIds: ids, globals: globalNames, moduleInputs: inputNames, triggers: triggerNames,
        constants: constantNames,
      } = completionData.current;
      const line = context.state.doc.lineAt(context.pos);
      const prefix = context.state.sliceDoc(line.from, context.pos);

      // Заголовок события: `on …` или правая часть `trigger имя = …`.
      if (isHeader(prefix)) {
        const typed = word.text.replace(/\.$/, "");
        if (inputNames.includes(typed)) {
          // Вход выбран целиком: подсказываем тип и сразу раскрываем тело блока.
          return {
            from: context.pos,
            validFor: /^[\w()]*$/,
            options: EVENT_CHOICES.map((entry) => ({
              label: entry.kind,
              detail: entry.detail,
              type: "enum",
              apply: snippet(`${entry.kind} {\n\t\${}\n}`),
            })),
          };
        }
        return {
          from: word.from,
          validFor: /^[A-Za-z0-9_.]*$/,
          options: [
            { label: "start", detail: "первый кадр после запуска", type: "keyword" },
            ...triggerNames.map((name) => ({ label: name, detail: "своё событие (trigger)", type: "variable" })),
            ...inputNames.map((name) => ({
              label: name,
              detail: hintData.current.moduleInputLabels[name]
                ? `вход модуля · ${hintData.current.moduleInputLabels[name]}`
                : "вход модуля",
              type: "property",
            })),
          ],
        };
      }
      if (/^\s*trigger\s+$/.test(prefix)) {
        return {
          from: word.from,
          options: [{
            label: "trigger kick = mouse.left.down",
            detail: "своё имя события",
            type: "keyword",
            apply: snippet("trigger ${kick} = ${mouse.left.down}"),
          }],
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
      const options = [...new Set([
        ...ids, ...globalNames, ...PARAMETERS, TEXT_PARAMETER, ...INPUTS, ...inputNames,
        ...triggerNames, ...constantNames, ...FUNCTION_NAMES,
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
                : triggerNames.includes(label)
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
   * Вставка готового блока (клик по шпаргалке — то же, что бросок мышью).
   *
   * Блок встаёт отдельной строкой, а каретка — в пустую строку внутри `{ … }`:
   * сразу видно, где писать тело.
   */
  const insertSnippet = (code: string) => {
    const editor = view.current;
    if (!editor) return;
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

  return (
    <>
      <div className="code-editor" ref={host} />
      {errorText
        ? <div className="script-error-line" title={errorText}>{errorText}</div>
        : <div className="signature-hint" data-empty={hint ? "false" : "true"}>
          {hint || "Поставьте курсор внутрь вызова функции — покажу ожидаемые аргументы."}
        </div>}
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
                  title="Объявление события живёт в глобальном скрипте; дальше пишут on kick { … }"
                  onDragStart={(event) => startBlockDrag(event, TRIGGER_BLOCK)}
                  onClick={() => insertSnippet(TRIGGER_BLOCK)}
                >
                  <code>trigger kick = mouse.left.down</code>
                  <small>своё имя события: объявляется в глобальном скрипте</small>
                </button>
              </div>
            </div>
            <div className="editor-hint">
              <span><b>{"on <вход>.<тип> { … }"}</b> — условие, тело пишет автор</span>
              <span><b>down</b> 0 → 1 · <b>up</b> 1 → 0 · <b>change</b> любое изменение</span>
              <span><b>hold(0.5)</b> / <b>relax(0.5)</b> — секунды, срабатывают кадром позже фронта</span>
              <span><b>on start</b> — первый кадр и после «Стоп»</span>
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
