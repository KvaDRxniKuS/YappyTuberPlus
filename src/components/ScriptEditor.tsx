import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { basicSetup } from "codemirror";
import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { autocompletion, snippet, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";
import type { ScriptErrorInfo } from "../types";
import type { ScriptCheck } from "../engine/scripts";
import { FUNCTION_NAMES, SIGNATURES, signatureAt, signatureLine, signatureOf } from "../engine/signatures";
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
  /** Имена событий из `trigger … = …` в глобальном скрипте. */
  triggers?: string[];
  /** Константы модулей: состояния enum (`walk`, `mode_walk`). */
  constants?: string[];
  onCheck?: ScriptCheck;
  onApply: (value: string) => void;
}

export function ScriptEditor({
  value, objectIds, globals, moduleInputs = [], triggers = [], constants = [], onCheck, onApply,
}: ScriptEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const applyRef = useRef(onApply);
  const checkRef = useRef(onCheck);
  const runCheckRef = useRef<(source: string) => void>(() => {});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completionData = useRef({ objectIds, globals, moduleInputs, triggers, constants });
  const [hint, setHint] = useState("");
  const [errorText, setErrorText] = useState("");
  // Шпаргалка и список функций свёрнуты: редактор важнее, подсказки — по клику.
  const [helpOpen, setHelpOpen] = useState(false);
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
      setHint(signatureLine(signatureAt(state.doc.toString(), state.selection.main.head)));
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

    // Заголовок события: `on …`, `event.…` (без `on`) или правая часть `trigger`.
    const isHeader = (prefix: string) =>
      /^\s*(?:on|event\.)\s*[\w.]*$/.test(prefix) || /^\s*trigger\s+[\w]+\s*=\s*[\w.]*$/.test(prefix);

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
        const typed = word.text.replace(/^event\./, "").replace(/\.$/, "");
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
            ...inputNames.map((name) => ({ label: `event.${name}`, detail: "вход модуля", type: "property" })),
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
        {helpOpen && <>
          <div className="editor-hint">
            <span><b>on mouse.left.down</b> {"{ x = 200 }"}</span>
            <span><b>trigger kick = mouse.left.down</b>, потом <b>{"on kick { … }"}</b></span>
            <span><b>on start</b> — первый кадр · <b>hold(0.5)</b> кадром позже фронта</span>
            <span>команды — строкой в блоке: <b>{"on start { play() }"}</b>, <b>{"seek(2.5)"}</b>, <b>{"play(\"дождь\")"}</b></span>
            <span>текст — переменная объекта: <b>{'text = "привет"'}</b>, в событии переопределяет до стопа; число в текст — <b>{"text(mic.db)"}</b>, склейка — <b>{'text = "db " + text(mic.db)'}</b></span>
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
                          className="chip-star"
                          title={fav ? "Убрать из избранных" : "В избранные: команда всегда будет под рукой"}
                          aria-pressed={fav}
                          onClick={() => toggleFavorite(name)}
                        >
                          ★
                        </button>
                        <button className="chip-insert" title={SIGNATURES[name].summary} onClick={() => insert(name)}>
                          {signatureOf(name)}
                        </button>
                      </span>
                    );
                  })}
              </div>
            ))}
          </div>
        </>}
      </div>
    </>
  );
}
