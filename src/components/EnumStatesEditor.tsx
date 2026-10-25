import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { EnumState, ModuleInstance } from "../types";
import { enumStates, sanitizeStateName, uniqueStateName } from "../modules/manual";

/**
 * Состояния ручного модуля в режиме «enum».
 *
 * Состояние — это пара «подпись для панели» и «имя для скрипта». Номер состояния
 * (0, 1, 2…) — значение входа `manual.value`, поэтому в скрипте сравнение
 * пишется по имени: `manual.value == walk`, а флаг `manual.walk` даёт точные
 * события `on manual.walk.down { … }`.
 */
export function EnumStatesEditor(props: {
  module: ModuleInstance;
  onStates: (states: EnumState[], label?: string) => void;
}) {
  const states = enumStates(props.module);
  const [draftLabel, setDraftLabel] = useState("");

  const patch = (next: EnumState[], label: string) => props.onStates(next, label);

  const add = () => {
    const label = draftLabel.trim();
    if (!label) return;
    const name = uniqueStateName(states, sanitizeStateName(label));
    patch([...states, { name, label: label.slice(0, 24) }], "Добавление состояния");
    setDraftLabel("");
  };

  const renameLabel = (state: EnumState, raw: string) => {
    const label = raw.trim();
    if (!label || label === state.label) return;
    patch(states.map((item) => (item.name === state.name ? { ...item, label: label.slice(0, 24) } : item)), "Подпись состояния");
  };

  const renameName = (state: EnumState, raw: string) => {
    const clean = raw.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24);
    if (!clean || clean === state.name) return;
    const name = uniqueStateName(states.filter((item) => item.name !== state.name), clean);
    patch(states.map((item) => (item.name === state.name ? { ...item, name } : item)), "Имя состояния");
  };

  const remove = (state: EnumState) => {
    // Последнее состояние удалять не даём: модулю нужно хотя бы одно.
    if (states.length <= 1) return;
    patch(states.filter((item) => item.name !== state.name), "Удаление состояния");
  };

  return (
    <div className="key-editor">
      <div className="key-editor-head">
        <span>Состояние</span>
        <span>Имя в скрипте</span>
        <span>№</span>
        <span />
      </div>

      {states.map((state, index) => (
        <div className="key-row" key={state.name}>
          <input
            className="key-name"
            defaultValue={state.label}
            key={`${state.name}-${state.label}`}
            spellCheck={false}
            title="Подпись: как состояние называется в панели"
            onBlur={(event) => renameLabel(state, event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          />
          <input
            className="key-name"
            defaultValue={state.name}
            key={`${state.name}-name`}
            spellCheck={false}
            title="Имя для скрипта: латиница, цифры и _"
            onBlur={(event) => renameName(state, event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          />
          <span className="enum-index" title="Номер состояния — это значение manual.value">{index}</span>
          <button
            className="icon-button"
            title={states.length <= 1 ? "Нужно хотя бы одно состояние" : "Удалить состояние"}
            disabled={states.length <= 1}
            onClick={() => remove(state)}
          ><Trash2 size={12} /></button>
        </div>
      ))}

      <div className="key-capture enum-add">
        <input
          className="key-name"
          value={draftLabel}
          placeholder="Новое состояние: «Прыжок»"
          spellCheck={false}
          onChange={(event) => setDraftLabel(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") add(); }}
        />
        <button className="button secondary" disabled={!draftLabel.trim()} onClick={add}>
          <Plus size={13} /> Добавить
        </button>
      </div>

      <p className="muted">
        Подпись любая, имя — латиницей: в скрипте это <code>manual.value == {states[0]?.name ?? "state"}</code> и
        флаг <code>manual.{states[1]?.name ?? states[0]?.name ?? "state"}</code>.
      </p>
    </div>
  );
}
