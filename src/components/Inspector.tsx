import { useEffect, useState } from "react";
import { Crosshair, Eye, EyeOff, Layers, Link2, RotateCcw } from "lucide-react";
import type { BasePose, RigFrame, RigObject } from "../types";
import { scriptValue, setScriptValue } from "../engine/preset";

interface InspectorProps {
  object: RigObject | null;
  selection: RigObject[];
  objects: RigObject[];
  frame: RigFrame | null;
  onChange: (object: RigObject) => void;
  onSelect: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onBases: (patch: Partial<BasePose>, coalesce?: string) => void;
  onOffset: (delta: { x?: number; y?: number }) => void;
  onLayer: (layer: number) => void;
  onVisible: (visible: number) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}

function NumberField({ label, value, step = 1, onCommit, suffix }: {
  label: string; value: number; step?: number; suffix?: string; onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(Number(value.toFixed(4))));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(String(Number(value.toFixed(4)))); }, [value, focused]);
  const commit = () => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) onCommit(parsed);
    else setDraft(String(value));
  };
  return (
    <label className="number-field">
      <span>{label}</span>
      <div><input
        type="number" value={draft} step={step}
        onFocus={() => setFocused(true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => { setFocused(false); commit(); }}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
      />{suffix && <em>{suffix}</em>}</div>
    </label>
  );
}

/** Поле относительного сдвига: значение применяется по Enter и сразу очищается. */
function DeltaField({ label, onApply }: { label: string; onApply: (value: number) => void }) {
  const [draft, setDraft] = useState("");
  const apply = () => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed) && parsed !== 0) onApply(parsed);
    setDraft("");
  };
  return (
    <label className="number-field">
      <span>{label}</span>
      <div><input
        type="number" value={draft} step={1} placeholder="0"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); apply(); } }}
        onBlur={apply}
      /><em>±</em></div>
    </label>
  );
}

function FormulaField({ parameter, script, onChange }: {
  parameter: string; script: string; onChange: (script: string) => void;
}) {
  const external = scriptValue(script, parameter);
  const [draft, setDraft] = useState(external);
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(external); }, [external, focused]);
  const commit = () => { if (draft.trim() && draft !== external) onChange(setScriptValue(script, parameter, draft.trim())); };
  return (
    <label className="formula-field">
      <span>{parameter}</span>
      <input
        value={draft} spellCheck={false}
        onFocus={() => setFocused(true)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => { setFocused(false); commit(); }}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
      />
    </label>
  );
}

export function Inspector(props: InspectorProps) {
  const { object, selection, objects, frame, onChange } = props;

  if (selection.length > 1) return <MultiInspector {...props} />;

  if (!object) {
    return <section className="inspector panel-surface empty-state"><Crosshair size={25} /><p>Выберите объект на сцене или в дереве</p></section>;
  }
  const updateBase = (patch: Partial<BasePose>) => onChange({ ...object, base: { ...object.base, ...patch } });
  const updateScript = (script: string) => onChange({ ...object, script });
  const parent = objects.find((item) => item.id === object.parentId);
  const dynamic = frame?.objects[object.id];

  return (
    <section className="inspector panel-surface">
      <div className="inspector-header">
        <div className={`inspector-preview ${object.kind}`}>
          {object.image ? <img src={object.image} alt="" /> : <Link2 size={20} />}
        </div>
        <div className="inspector-title">
          <input
            value={object.name}
            title="F2 — переименовать"
            onChange={(event) => onChange({ ...object, name: event.target.value })}
          />
          <span>{object.id} · {object.kind === "group" ? "группа" : `${object.width}×${object.height}`}</span>
        </div>
        <button className="icon-button" title="Сбросить трансформацию" onClick={() => updateBase({ rotation: 0, sizeX: 1, sizeY: 1, skewX: 0, skewY: 0 })}><RotateCcw size={15} /></button>
      </div>

      <div className="inspector-scroll">
        <div className="property-section">
          <div className="section-title"><span>Базовая поза</span><small>PIXELS</small></div>
          <div className="property-grid">
            <NumberField label="Позиция X" value={object.base.x} step={1} onCommit={(x) => updateBase({ x })} />
            <NumberField label="Позиция Y" value={object.base.y} step={1} onCommit={(y) => updateBase({ y })} />
            <NumberField label="Поворот" value={object.base.rotation} step={0.1} suffix="°" onCommit={(rotation) => updateBase({ rotation })} />
            <NumberField label="Слой" value={object.base.layer} step={1} onCommit={(layer) => {
              onChange({ ...object, base: { ...object.base, layer }, script: setScriptValue(object.script, "layer", String(layer)) });
            }} />
            <NumberField label="Масштаб X" value={object.base.sizeX} step={0.05} onCommit={(sizeX) => updateBase({ sizeX })} />
            <NumberField label="Масштаб Y" value={object.base.sizeY} step={0.05} onCommit={(sizeY) => updateBase({ sizeY })} />
          </div>
          <label className="range-property">
            <span>Непрозрачность <b>{Math.round(object.base.opacity * 100)}%</b></span>
            <input type="range" min="0" max="1" step="0.01" value={object.base.opacity} onChange={(event) => updateBase({ opacity: Number(event.target.value) })} />
          </label>
        </div>

        {object.kind === "sprite" && <div className="property-section compact-section">
          <div className="section-title"><span>Пивот</span><small>UV</small></div>
          <div className="property-grid two-columns">
            <NumberField label="Pivot X" value={object.pivot.x} step={0.01} onCommit={(x) => onChange({ ...object, pivot: { ...object.pivot, x } })} />
            <NumberField label="Pivot Y" value={object.pivot.y} step={0.01} onCommit={(y) => onChange({ ...object, pivot: { ...object.pivot, y } })} />
          </div>
        </div>}

        <div className="property-section">
          <div className="section-title"><span>Формулы</span><small>ДИНАМИКА</small></div>
          <div className="formula-list">
            {["x", "y", "rotation", "sizeY"].map((parameter) => <FormulaField key={parameter} parameter={parameter} script={object.script} onChange={updateScript} />)}
          </div>
        </div>

        <div className="runtime-readout">
          <div><span>Родитель</span><b>{parent?.name || "Корень сцены"}</b></div>
          {dynamic && <div><span>Кадр</span><b>x {dynamic.x.toFixed(2)} · y {dynamic.y.toFixed(2)} · r {dynamic.rotation.toFixed(2)}°</b></div>}
        </div>
      </div>
    </section>
  );
}

/** Инспектор при мультивыделении: список, относительный сдвиг и общие свойства. */
function MultiInspector(props: InspectorProps) {
  const { selection, onBases, onOffset, onLayer, onVisible, onSelect, onToggleSelect } = props;
  const primary = selection[selection.length - 1];
  return (
    <section className="inspector panel-surface">
      <div className="inspector-header">
        <div className="inspector-preview group"><Layers size={20} /></div>
        <div className="inspector-title">
          <b className="inspector-title-static">Выделено {selection.length}</b>
          <span>Ctrl+клик — убрать, F2 — переименовать основной</span>
        </div>
      </div>

      <div className="inspector-scroll">
        <div className="property-section">
          <div className="section-title"><span>Выделение</span><small>ОСНОВНОЙ — ПОСЛЕДНИЙ</small></div>
          <div className="multi-list">
            {selection.map((item) => (
              <button
                key={item.id}
                className={`multi-item ${item.id === primary.id ? "primary" : ""}`}
                title="Сделать основным · Ctrl+клик — убрать из выборки"
                onClick={(event) => {
                  if (event.ctrlKey || event.metaKey) onToggleSelect(item.id);
                  else onSelect(item.id);
                }}
              >
                <span className={`multi-dot ${item.kind}`} />
                <span className="multi-name">{item.name}</span>
                <i>{item.kind === "group" ? "группа" : `${item.width}×${item.height}`}</i>
              </button>
            ))}
          </div>
        </div>

        <div className="property-section">
          <div className="section-title"><span>Смещение</span><small>ОТНОСИТЕЛЬНО</small></div>
          <div className="property-grid two-columns">
            <DeltaField label="Сдвиг X" onApply={(x) => onOffset({ x })} />
            <DeltaField label="Сдвиг Y" onApply={(y) => onOffset({ y })} />
          </div>
          <p className="hint">Введите значение и нажмите Enter — сдвинутся все выделенные.</p>
        </div>

        <div className="property-section">
          <div className="section-title"><span>Общие свойства</span><small>ДЛЯ ВСЕХ</small></div>
          <div className="property-grid">
            <NumberField label="Слой" value={primary.base.layer} step={1} onCommit={onLayer} />
            <NumberField label="Масштаб X" value={primary.base.sizeX} step={0.05} onCommit={(sizeX) => onBases({ sizeX })} />
            <NumberField label="Масштаб Y" value={primary.base.sizeY} step={0.05} onCommit={(sizeY) => onBases({ sizeY })} />
            <NumberField label="Поворот" value={primary.base.rotation} step={0.1} suffix="°" onCommit={(rotation) => onBases({ rotation })} />
          </div>
          <label className="range-property">
            <span>Непрозрачность <b>{Math.round(primary.base.opacity * 100)}%</b></span>
            <input
              type="range" min="0" max="1" step="0.01" value={primary.base.opacity}
              onChange={(event) => onBases({ opacity: Number(event.target.value) }, "multi-opacity")}
            />
          </label>
          <div className="multi-actions">
            <button onClick={() => onVisible(1)}><Eye size={14} /> Показать все</button>
            <button onClick={() => onVisible(0)}><EyeOff size={14} /> Скрыть все</button>
          </div>
        </div>

        <div className="runtime-readout">
          <div><span>Выделено</span><b>{selection.length}</b></div>
          <div><span>Основной</span><b>{primary.id}</b></div>
        </div>
      </div>
    </section>
  );
}
