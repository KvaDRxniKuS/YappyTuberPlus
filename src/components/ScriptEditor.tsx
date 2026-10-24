import { useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { autocompletion, snippet, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";
import { FUNCTION_NAMES, SIGNATURES, signatureAt, signatureLine, signatureOf } from "../engine/signatures";

const EVENT_KINDS = ["down", "up", "change", "hold", "relax"];

const language = StreamLanguage.define({
  startState: () => ({ inEvent: false }),
  token(stream, state) {
    if (stream.sol()) state.inEvent = false;
    if (stream.eatSpace()) return null;
    if (stream.match(/^\/\/.*/)) return "comment";
    if (stream.match(/^(?:and|or|not|inherit|parent|offset|on)\b/)) return "keyword";
    if (stream.match(/^(?:time|dt|canvasWidth|canvasHeight|width|height|pi|e|signal)\b/)) return "variableName.special";
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
  { tag: tags.keyword, color: "#91b9d5" },
  { tag: tags.function(tags.variableName), color: "#91d4c3" },
  { tag: tags.special(tags.variableName), color: "#c2a9df" },
  { tag: tags.typeName, color: "#d8a4bd" },
  { tag: tags.operator, color: "#a7adb7" },
  { tag: tags.propertyName, color: "#d8dce2" },
  { tag: tags.punctuation, color: "#8a929c" },
]);

const PARAMETERS = ["x", "y", "rotation", "sizeX", "sizeY", "skewX", "skewY", "opacity", "visible", "layer"];
// Входы приходят из модулей и подставляются в автодополнение динамически.
const INPUTS = ["time", "dt", "signal", "parent", "inherit", "offset", "width", "height", "canvasWidth", "canvasHeight", "state"];
// Типы событий: `event.мышь.вход.down`. `hold`/`relax` ждут время в секундах.
const EVENT_CHOICES = [
  { kind: "down", detail: "нажатие" },
  { kind: "up", detail: "отпускание" },
  { kind: "change", detail: "значение изменилось" },
  { kind: "hold(0.5)", detail: "держать 0.5 с; срабатывает кадром позже нажатия" },
  { kind: "relax(0.5)", detail: "отпущено 0.5 с; срабатывает кадром позже отпускания" },
];

// Порядок групп в списке функций под редактором.
const GROUPS: Array<{ id: "math" | "vector" | "physics" | "random"; title: string }> = [
  { id: "math", title: "математика" },
  { id: "vector", title: "векторы" },
  { id: "physics", title: "физика" },
  { id: "random", title: "случайность" },
];

interface ScriptEditorProps {
  value: string;
  objectIds: string[];
  globals: string[];
  /** Полные имена входов модулей: `mic.talking`, `auto.blink`, `manual.value`. */
  moduleInputs?: string[];
  onApply: (value: string) => void;
}

export function ScriptEditor({ value, objectIds, globals, moduleInputs = [], onApply }: ScriptEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const applyRef = useRef(onApply);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completionData = useRef({ objectIds, globals, moduleInputs });
  const [hint, setHint] = useState("");
  applyRef.current = onApply;
  completionData.current = { objectIds, globals, moduleInputs };

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
    const completion = (context: CompletionContext): CompletionResult | null => {
      const word = context.matchBefore(/[A-Za-z0-9_.]*/);
      if (!word || (word.from === word.to && !context.explicit)) return null;
      const { objectIds: ids, globals: globalNames, moduleInputs: inputNames } = completionData.current;
      const line = context.state.doc.lineAt(context.pos);
      const prefix = context.state.sliceDoc(line.from, context.pos);
      // Внутри заголовка события подсказки идут по шагам: вход → тип.
      const inHeader = /^\s*on\s+event\.[\w.]*$/.test(prefix);
      if (inHeader) {
        const typed = word.text.replace(/^event\./, "");
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
          options: inputNames.map((name) => ({ label: `event.${name}`, detail: "вход модуля", type: "property" })),
        };
      }
      if (/^\s*on\s+$/.test(prefix)) {
        return { from: word.from, options: [{ label: "on event.", detail: "блок события", type: "keyword" }] };
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
      const options = [...new Set([
        ...ids, ...globalNames, ...PARAMETERS, ...INPUTS, ...inputNames, ...FUNCTION_NAMES,
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
        autocompletion({ override: [completion], activateOnTyping: true }),
        Prec.highest(keymap.of([{ key: "Mod-s", run: () => { applyNow(); return true; } }])),
        EditorView.updateListener.of((update) => {
          if (update.docChanged || update.selectionSet) readHint(update.state);
          if (!update.docChanged) return;
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(applyNow, 420);
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "12.5px", backgroundColor: "transparent" },
          ".cm-scroller": { fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace", lineHeight: "1.65" },
          ".cm-gutters": { backgroundColor: "#1b1e23", color: "#5f6670", border: "none" },
          ".cm-activeLine": { backgroundColor: "#ffffff05" },
          ".cm-activeLineGutter": { backgroundColor: "#ffffff06", color: "#aab1bb" },
          ".cm-content": { caretColor: "#8ad8c6", padding: "10px 0" },
          ".cm-line": { padding: "0 14px 0 10px" },
          "&.cm-focused": { outline: "none" },
          ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "#6eb8a834 !important" },
          ".cm-cursor": { borderLeftColor: "#8ad8c6" },
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
    return () => {
      if (timer.current) clearTimeout(timer.current);
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
      <div className="signature-hint" data-empty={hint ? "false" : "true"}>
        {hint || "Поставьте курсор внутрь вызова функции — покажу ожидаемые аргументы."}
      </div>
      <div className="editor-hint">
        <span><b>on event.mouse.left.down</b> {"{ a = !a }"}</span>
        <span>прошлый кадр: <b>state.a</b> · чужой объект: <b>объект.parent.x</b></span>
        <span><b>hold(0.5)</b> — держать, <b>relax(0.5)</b> — отпущено; с нулём срабатывают на следующем кадре</span>
      </div>
      <div className="function-chips">
        {GROUPS.map((group) => (
          <div className="function-chip-group" key={group.id}>
            <span className="function-chip-title">{group.title}</span>
            {Object.entries(SIGNATURES)
              .filter(([, entry]) => entry.group === group.id)
              .map(([name]) => (
                <code key={name} title={SIGNATURES[name].summary} onClick={() => insert(name)}>
                  {signatureOf(name)}
                </code>
              ))}
          </div>
        ))}
      </div>
    </>
  );
}
