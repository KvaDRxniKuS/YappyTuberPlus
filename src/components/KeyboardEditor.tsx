import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { KeyboardKey, ModuleInstance } from "../types";
import { keyInputName, keyLabel, keyboardKeys, uniqueKeyName } from "../modules/pointer";

/**
 * Клавиши клавиатурного модуля: одна строка — одна клавиша и её имя входа.
 *
 * Клавиша выбирается нажатием (ловим следующий `keydown`), имя входа — латиница,
 * как и у визем: в скрипте это `keyboard.space`. Несколько клавиш в одном модуле
 * нужны, когда они относятся к одной теме (управление сценой, отладка).
 */
export function KeyboardKeysEditor(props: { module: ModuleInstance; onKeys: (keys: KeyboardKey[], label?: string) => void }) {
  const keys = keyboardKeys(props.module);
  const [capturing, setCapturing] = useState(false);

  const patch = (next: KeyboardKey[], label?: string) => props.onKeys(next, label);

  const add = (code: string) => {
    if (keys.some((key) => key.code === code)) return;
    const name = uniqueKeyName(keys, keyInputName(code));
    patch([...keys, { code, name }], "Добавление клавиши");
  };

  const rename = (code: string, raw: string) => {
    const clean = raw.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24);
    if (!clean) return;
    const name = uniqueKeyName(keys.filter((key) => key.code !== code), clean);
    patch(keys.map((key) => (key.code === code ? { ...key, name } : key)), "Переименование клавиши");
  };

  return (
    <div className="key-editor">
      <div className="key-editor-head">
        <span>Клавиша</span>
        <span>Имя входа</span>
        <span />
      </div>

      {keys.map((key) => (
        <div className="key-row" key={key.code}>
          <span className="key-cap" title={key.code}>{keyLabel(key.code)}</span>
          <input
            className="key-name"
            defaultValue={key.name}
            key={`${key.code}-${key.name}`}
            spellCheck={false}
            title="Имя входа: латиница, цифры и _"
            onBlur={(event) => rename(key.code, event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          />
          <button
            className="icon-button"
            title="Удалить клавишу"
            onClick={() => patch(keys.filter((item) => item.code !== key.code), "Удаление клавиши")}
          ><Trash2 size={12} /></button>
        </div>
      ))}

      {keys.length === 0 && <p className="muted">Клавиш нет: добавьте хотя бы одну.</p>}

      <KeyCaptureButton
        capturing={capturing}
        label="Добавить клавишу"
        onStart={() => setCapturing(true)}
        onCancel={() => setCapturing(false)}
        onCapture={(code) => { setCapturing(false); if (code) add(code); }}
      />
    </div>
  );
}

/**
 * Один бинд модуля `key`: поле с клавишей, кнопка смены и мусорка.
 *
 * Незаданный бинд — это пустая строка, а не «пробел по умолчанию»: пока клавиша
 * не выбрана, входы модуля нулевые, и в поле видно подсказку.
 */
export function KeyBindingRow(props: { code: string; onChange: (code: string) => void }) {
  const [capturing, setCapturing] = useState(false);
  useKeyCapture(capturing, (code) => {
    setCapturing(false);
    if (code) props.onChange(code);
  });
  return (
    <div className="key-binding">
      <button
        type="button"
        className={`key-cap key-bind ${props.code ? "" : "empty"}`}
        title={props.code ? `${keyLabel(props.code)} (${props.code})` : "Нажмите, чтобы назначить клавишу"}
        onClick={() => setCapturing(true)}
      >
        {props.code ? keyLabel(props.code) : "не задана"}
      </button>
      <button type="button" className="button small key-add" disabled={capturing} onClick={() => setCapturing(true)}>
        {props.code ? "Сменить" : "Назначить"}
      </button>
      <button
        type="button"
        className="icon-button"
        title="Очистить бинд"
        disabled={!props.code}
        onClick={() => props.onChange("")}
      ><Trash2 size={12} /></button>
      {capturing && <span className="key-capture">Нажмите клавишу… (Esc — отмена)</span>}
    </div>
  );
}

/**
 * Ждём следующее нажатие. Esc отменяет выбор, модификаторы сами по себе тоже
 * считаются клавишами (Shift, Ctrl) — иногда это и нужно.
 */
/**
 * Ждём следующее нажатие, пока `active`. Обработчик берётся из ref: иначе
 * эффект переподписывался бы на каждое перерисовывание.
 */
function useKeyCapture(active: boolean, onCapture: (code: string | null) => void) {
  const handler = useRef(onCapture);
  handler.current = onCapture;
  useEffect(() => {
    if (!active) return;
    const listener = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      handler.current(event.repeat || event.code === "Escape" ? null : event.code);
    };
    window.addEventListener("keydown", listener, { capture: true });
    return () => window.removeEventListener("keydown", listener, { capture: true });
  }, [active]);
}

function KeyCaptureButton(props: {
  capturing: boolean;
  label: string;
  onStart: () => void;
  onCancel: () => void;
  onCapture: (code: string | null) => void;
}) {
  useKeyCapture(props.capturing, (code) => {
    if (code) props.onCapture(code);
    else props.onCancel();
  });

  if (props.capturing) {
    return <span className="key-capture">Нажмите клавишу… (Esc — отмена)</span>;
  }
  return (
    <button className="button small key-add" onClick={props.onStart}>
      <Plus size={12} /> {props.label}
    </button>
  );
}
