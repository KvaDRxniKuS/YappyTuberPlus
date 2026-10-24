import { useEffect, useState } from "react";
import { Mic, Plus, Trash2, X } from "lucide-react";
import type { ModuleInstance, VisemeEntry } from "../types";
import { sanitizeVisemeName, uniqueVisemeName, visemeEntries } from "../modules/viseme";
import { CalibrateButton, SpectrumBars, type CalibrationApi, type RecordingState } from "./VisemeCalibration";

interface VisemeEditorProps extends CalibrationApi {
  module: ModuleInstance;
  /** Сохраняет список визем в настройки экземпляра: он же уходит в пресет. */
  onVisemes: (visemes: VisemeEntry[], label?: string) => void;
  /** Переименование входа: список выключенных входов надо догнать. */
  onRenameInput?: (from: string, to: string) => void;
  recorder: {
    recording: RecordingState | null;
    error: string | null;
    start: (key: string, settings: ModuleInstance["config"], onTemplate: (template: number[]) => void) => Promise<void>;
  };
}

/**
 * Список визем экземпляра: имя входа, подпись и варианты записи.
 *
 * У одной виземы может быть сколько угодно эталонов: один и тот же звук,
 * произнесённый выше или ниже, даёт разный спектр. Значение входа — лучшая
 * похожесть по всем вариантам, поэтому несколько записей описывают звук
 * надёжнее одной.
 *
 * База (a, e, i, o, u) — обычные записи: их можно переименовать, перезаписать
 * и удалить. Новые звуки добавляются вручную: подпись свободная (можно `ö`),
 * имя входа — латиница, потому что оно попадает в выражение скрипта.
 */
export function VisemeEditor(props: VisemeEditorProps) {
  const [draft, setDraft] = useState("");
  const entries = visemeEntries(props.module);
  const prefix = props.module.name;

  const patchEntry = (name: string, change: Partial<VisemeEntry>, label?: string) => {
    props.onVisemes(entries.map((entry) => (entry.name === name ? { ...entry, ...change } : entry)), label);
  };

  const removeEntry = (entry: VisemeEntry) => {
    props.onVisemes(entries.filter((item) => item.name !== entry.name), "Удаление виземы");
  };

  const addTemplate = (entry: VisemeEntry, template: number[]) => {
    patchEntry(entry.name, { templates: [...entry.templates, template] }, "Калибровка виземы");
  };

  const removeTemplate = (entry: VisemeEntry, index: number) => {
    patchEntry(entry.name, { templates: entry.templates.filter((_, position) => position !== index) }, "Удаление варианта виземы");
  };

  const renameEntry = (entry: VisemeEntry, raw: string) => {
    const next = uniqueVisemeName(entries.filter((item) => item.name !== entry.name), raw);
    if (!next || next === entry.name) return;
    patchEntry(entry.name, { name: next }, "Переименование виземы");
    props.onRenameInput?.(entry.name, next);
  };

  const addEntry = () => {
    const raw = draft.trim();
    if (!raw) return;
    const name = uniqueVisemeName(entries, raw);
    const label = raw.slice(0, 12);
    props.onVisemes([...entries, { name, label, templates: [] }], "Добавление виземы");
    setDraft("");
  };

  return (
    <div className="viseme-editor">
      <div className="viseme-head">
        <span>Звук</span>
        <span>Имя входа</span>
        <span>Эталоны записи</span>
        <span />
      </div>

      {entries.map((entry) => {
        const key = `${prefix}.${entry.name}`;
        const active = props.recorder.recording?.key === key;
        const busy = !!props.recorder.recording;
        return (
          <div className={`viseme-row ${entry.templates.length ? "ready" : ""}`} key={entry.name}>
            <input
              className="viseme-label"
              value={entry.label}
              spellCheck={false}
              title="Как звук называется в панели: можно ö, ä, ы"
              onChange={(event) => patchEntry(entry.name, { label: event.target.value.slice(0, 12) })}
            />
            <VisemeNameField
              name={entry.name}
              onRename={(next) => renameEntry(entry, next)}
            />
            <div className="viseme-variants">
              {entry.templates.map((template, index) => (
                <div className="viseme-variant" key={`${entry.name}-${index}`}>
                  <SpectrumBars bands={template} title={`Вариант ${index + 1}`} />
                  <button
                    className="icon-button variant-remove"
                    title="Удалить вариант записи"
                    onClick={() => removeTemplate(entry, index)}
                  ><X size={11} /></button>
                </div>
              ))}
              {active && (
                <div className="viseme-variant recording">
                  <SpectrumBars
                    bands={props.recorder.recording?.bands}
                    active
                    progress={props.recorder.recording?.progress}
                    title="Пишу 3 секунды: спектр звука"
                  />
                  <span className="viseme-rec">запись</span>
                </div>
              )}
              {entry.templates.length === 0 && !active && <span className="viseme-empty">нет эталона</span>}
            </div>
            <div className="viseme-actions">
              <button
                type="button"
                className={`icon-button viseme-add-variant ${active ? "recording" : ""}`}
                title={entry.templates.length ? "Добавить ещё вариант записи (3 с)" : "Записать эталон (3 с)"}
                disabled={busy}
                onClick={() => void props.recorder.start(key, props.module.config, (template) => addTemplate(entry, template))}
              >{active ? <Mic size={12} /> : <Plus size={12} />}</button>
              <button
                className="icon-button"
                title="Удалить визему"
                onClick={() => removeEntry(entry)}
              ><Trash2 size={12} /></button>
            </div>
          </div>
        );
      })}

      {entries.length === 0 && <p className="muted">Визем нет: добавьте звуки, которые должен различать персонаж.</p>}

      <div className="viseme-add">
        <input
          value={draft}
          placeholder="Новый звук: ö, ä, ы…"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") addEntry(); }}
        />
        <code>{`${prefix}.${draft.trim() ? sanitizeVisemeName(draft) : "…"}`}</code>
        <button className="button small" disabled={!draft.trim()} onClick={addEntry}><Plus size={12} /> Добавить визему</button>
      </div>

      {props.recorder.error && <div className="inline-error">{props.recorder.error}</div>}
    </div>
  );
}

/**
 * Имя входа: принимает только латиницу, цифры и `_`. Всё остальное просто не
 * набирается — иначе в скрипт попадёт имя, которое не скомпилируется.
 */
function VisemeNameField(props: { name: string; onRename: (name: string) => void }) {
  const [draft, setDraft] = useState(props.name);

  useEffect(() => { setDraft(props.name); }, [props.name]);

  const commit = () => {
    if (!draft || draft === props.name) { setDraft(props.name); return; }
    props.onRename(draft);
  };

  return (
    <input
      className="viseme-name"
      value={draft}
      spellCheck={false}
      inputMode="text"
      title="Имя входа в скрипте: только латиница, цифры и _"
      onChange={(event) => setDraft(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24))}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
    />
  );
}
