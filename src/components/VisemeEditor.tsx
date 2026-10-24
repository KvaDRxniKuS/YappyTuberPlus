import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
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
 * Список визем экземпляра: имя входа, подпись, спектр-эталон и запись.
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

  const renameEntry = (entry: VisemeEntry, raw: string) => {
    const next = uniqueVisemeName(entries.filter((item) => item.name !== entry.name), raw);
    if (!next || next === entry.name) return;
    patchEntry(entry.name, { name: next }, "Переименование виземы");
    props.onRenameInput?.(entry.name, next);
  };

  const removeEntry = (entry: VisemeEntry) => {
    props.onVisemes(entries.filter((item) => item.name !== entry.name), "Удаление виземы");
  };

  const addEntry = () => {
    const raw = draft.trim();
    if (!raw) return;
    const name = uniqueVisemeName(entries, raw);
    const label = raw.slice(0, 12);
    props.onVisemes([...entries, { name, label, template: null }], "Добавление виземы");
    setDraft("");
  };

  return (
    <div className="viseme-editor">
      <div className="viseme-head">
        <span>Звук</span>
        <span>Имя входа</span>
        <span>Спектр-эталон</span>
        <span>Запись</span>
      </div>

      {entries.map((entry) => {
        const key = `${prefix}.${entry.name}`;
        const active = props.recorder.recording?.key === key;
        return (
          <div className={`viseme-row ${entry.template ? "ready" : ""}`} key={entry.name}>
            <input
              className="viseme-label"
              value={entry.label}
              spellCheck={false}
              title="Как звук называется в панели: можно ö, ä, ы"
              onChange={(event) => patchEntry(entry.name, { label: event.target.value.slice(0, 12) })}
            />
            <input
              className="viseme-name"
              defaultValue={entry.name}
              key={`${entry.name}-name`}
              spellCheck={false}
              title="Имя входа в скрипте: латиница, цифры и _"
              onBlur={(event) => renameEntry(entry, event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            />
            <SpectrumBars
              bands={active ? props.recorder.recording?.bands : entry.template}
              active={active}
              progress={active ? props.recorder.recording?.progress : undefined}
              title={active ? "Пишу 3 секунды" : entry.template ? "Сохранённый эталон" : "Эталона нет: визема всегда 0"}
            />
            <div className="viseme-actions">
              <CalibrateButton
                title={entry.template ? "Перезаписать эталон (3 с)" : "Записать эталон (3 с)"}
                recording={active}
                disabled={!!props.recorder.recording && !active}
                onClick={() => void props.recorder.start(key, props.module.config, (template) => {
                  patchEntry(entry.name, { template }, "Калибровка виземы");
                })}
              />
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
