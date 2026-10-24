import { useState } from "react";
import { MousePointerClick, Plus, Trash2 } from "lucide-react";
import type { ModuleInstance } from "../types";
import { mouseButtonLabel, mouseButtons, uniqueButtonName } from "../modules/pointer";
import { useMouseButtonCapture } from "../hooks/usePointerInputs";

/**
 * Дополнительные кнопки мышиного модуля: одна строка — одна кнопка и её имя.
 *
 * Кнопка ловится следующим нажатием: в браузере — `mousedown`, в нативном окне —
 * глобальный хук, поэтому Mouse 4/5 видно и без фокуса на окне.
 */
export function MouseButtonsEditor(props: {
  module: ModuleInstance;
  onButtons: (buttons: Array<{ button: string; name: string }>, label?: string) => void;
}) {
  const buttons = mouseButtons(props.module);
  const [capturing, setCapturing] = useState(false);

  useMouseButtonCapture(capturing, (button) => {
    setCapturing(false);
    if (!button) return;
    if (buttons.some((item) => item.button === button)) return;
    props.onButtons([...buttons, { button, name: uniqueButtonName(buttons, button) }], "Добавление кнопки мыши");
  });

  const rename = (button: string, raw: string) => {
    const clean = raw.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24);
    if (!clean) return;
    const name = uniqueButtonName(buttons.filter((item) => item.button !== button), clean);
    props.onButtons(buttons.map((item) => (item.button === button ? { ...item, name } : item)),
      "Переименование кнопки мыши");
  };

  return (
    <div className="key-editor">
      <div className="key-editor-head">
        <span>Кнопка</span>
        <span>Имя входа</span>
        <span />
      </div>

      {buttons.map((item) => (
        <div className="key-row" key={item.button}>
          <span className="key-cap" title={item.button}><MousePointerClick size={11} /> {mouseButtonLabel(item.button)}</span>
          <input
            className="key-name"
            defaultValue={item.name}
            key={`${item.button}-${item.name}`}
            spellCheck={false}
            title="Имя входа: латиница, цифры и _"
            onBlur={(event) => rename(item.button, event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          />
          <button
            className="icon-button"
            title="Удалить кнопку"
            onClick={() => props.onButtons(buttons.filter((other) => other.button !== item.button), "Удаление кнопки мыши")}
          ><Trash2 size={12} /></button>
        </div>
      ))}

      {buttons.length === 0 && <p className="muted">Дополнительных кнопок нет: ЛКМ, ПКМ и колесо уже есть выше.</p>}

      {capturing ? (
        <span className="key-capture">Нажмите кнопку мыши… (Esc — отмена)</span>
      ) : (
        <button className="button small key-add" onClick={() => setCapturing(true)}>
          <Plus size={12} /> Добавить кнопку
        </button>
      )}
    </div>
  );
}
