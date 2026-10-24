import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { autocompletion, snippet, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { tags } from "@lezer/highlight";

const language = StreamLanguage.define({
  token(stream) {
    if (stream.match(/^\/\/.*/)) return "comment";
    if (stream.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/)) return "number";
    if (stream.match(/^(?:and|or|not|inherit|parent|offset|on)\b/)) return "keyword";
    if (stream.match(/^(?:time|dt|canvasWidth|canvasHeight|width|height|pi|e|signal|event|state)\b/)) return "variableName.special";
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/)) return "function";
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) return "variableName";
    if (stream.match(/^[+\-*/%^<>=?:]+/)) return "operator";
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
  { tag: tags.operator, color: "#a7adb7" },
  { tag: tags.propertyName, color: "#d8dce2" },
]);

const FUNCTIONS = [
  "abs", "sign", "min", "max", "limit", "clamp", "round", "floor", "ceil", "sqrt", "pow",
  "sin", "cos", "sind", "cosd", "atan2", "lerp", "smoothstep", "vec", "vadd", "vsub",
  "vmul", "vscale", "vlen", "vnorm", "vdot", "vangle", "rotate", "orbit", "follow",
  "px", "uv", "pxv", "uvv", "smooth", "spring", "rnd", "noise", "shake", "random", "autoblink",
];
const PARAMETERS = ["x", "y", "rotation", "sizeX", "sizeY", "skewX", "skewY", "opacity", "visible", "layer"];
// Входы приходят из модулей и подставляются в автодополнение динамически.
const INPUTS = ["time", "dt", "signal", "parent", "inherit", "offset", "width", "height", "canvasWidth", "canvasHeight", "event", "state"];
// Типы событий: `event.мышь.вход.down`. `hold`/`relax` ждут время в секундах.
const EVENT_KINDS = [
  { kind: "down", detail: "нажатие" },
  { kind: "up", detail: "отпускание" },
  { kind: "change", detail: "значение изменилось" },
  { kind: "hold(0.5)", detail: "держать 0.5 с" },
  { kind: "relax(0.5)", detail: "отпущено 0.5 с" },
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
  applyRef.current = onApply;
  completionData.current = { objectIds, globals, moduleInputs };

  useEffect(() => {
    if (!host.current) return;
    const applyNow = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (view.current) applyRef.current(view.current.state.doc.toString());
    };
    const completion = (context: CompletionContext): CompletionResult | null => {
      const word = context.matchBefore(/[A-Za-z0-9_.]*/);
      if (!word || (word.from === word.to && !context.explicit)) return null;
      const { objectIds: ids, globals: globalNames, moduleInputs: inputNames } = completionData.current;
      const doc = context.state;
      const line = doc.doc.lineAt(context.pos);
      const prefix = doc.sliceDoc(line.from, context.pos);
      // Внутри заголовка события подсказки идут по шагам: вход → тип.
      const inHeader = /^\s*on\s+event\.[\w.]*$/.test(prefix);
      if (inHeader) {
        const typed = word.text.replace(/^event\./, "");
        if (inputNames.includes(typed)) {
          // Вход выбран целиком: подсказываем тип и сразу раскрываем тело блока.
          const withBody = /^\s*on\s+/.test(prefix);
          return {
            from: context.pos,
            validFor: /^[\w()]*$/,
            options: EVENT_KINDS.map((entry) => ({
              label: entry.kind,
              detail: entry.detail,
              type: "enum",
              apply: withBody ? snippet(`${entry.kind} {\n\t\${}\n}`) : entry.kind,
            })),
          };
        }
        return {
          from: word.from,
          validFor: /^[A-Za-z0-9_.]*$/,
          options: inputNames.map((name) => ({ label: `event.${name}`, type: "property" })),
        };
      }
      if (/^\s*on\s+$/.test(prefix)) {
        return { from: word.from, options: [{ label: "on event.", detail: "блок события", type: "keyword" }] };
      }
      const options = [...new Set([...ids, ...globalNames, ...PARAMETERS, ...INPUTS, ...inputNames, ...FUNCTIONS])].map((label) => ({
        label,
        type: FUNCTIONS.includes(label) ? "function" : PARAMETERS.includes(label) ? "property" : "variable",
      }));
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
        }),
      ],
    });
    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;
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

  return (
    <>
      <div className="code-editor" ref={host} />
      <div className="editor-hint">
        <span><b>on event.mouse.left.down</b> {"{ a = !a }"}</span>
        <span>прошлый кадр: <b>state.a</b> · чужой объект: <b>объект.parent.x</b></span>
      </div>
    </>
  );
}
