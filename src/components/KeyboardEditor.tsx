import { useEffect, useState } from "react";
import { Keyboard, Plus, Trash2 } from "lucide-react";
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

/** Один вход-клавиша: показываем подпись, по клику ждём нажатие. */
export function KeyPicker(props: { code: string; onChange: (code: string) => void }) {
  const [capturing, setCapturing] = useState(false);
  return (
    <div className="key-picker">
      <Keyboard size={13} />
      <span className="key-cap" title={props.code}>{keyLabel(props.code)}</span>
      <KeyCaptureButton
        capturing={capturing}
        label="Сменить"
        onStart={() => setCapturing(true)}
        onCancel={() => setCapturing(false)}
        onCapture={(code) => { setCapturing(false); if (code) props.onChange(code); }}
      />
    </div>
  );
}

/**
 * Ждём следующее нажатие. Esc отменяет выбор, модификаторы сами по себе тоже
 * считаются клавишами (Shift, Ctrl) — иногда это и нужно.
 */
function KeyCaptureButton(props: {
  capturing: boolean;
  label: string;
  onStart: () => void;
  onCancel: () => void;
  onCapture: (code: string | null) => void;
}) {
  useEffect(() => {
    if (!props.capturing) return;
    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === "Escape") props.onCancel();
      else props.onCapture(event.repeat ? null : event.code);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [props]);

  if (props.capturing) {
    return <span className="key-capture">Нажмите клавишу… (Esc — отмена)</span>;
  }
  return (
    <button className="button small key-add" onClick={props.onStart}>
      <Plus size={12} /> {props.label}
    </button>
  );
}
