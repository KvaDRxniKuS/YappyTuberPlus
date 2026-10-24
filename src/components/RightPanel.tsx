import { useEffect, useState } from "react";
import { Braces, CircleAlert, Gauge, Globe2, SlidersHorizontal } from "lucide-react";
import type { InputValues, RigFrame, RigObject } from "../types";
import { ScriptEditor } from "./ScriptEditor";
import { InputsPanel } from "./InputsPanel";
import { Splitter } from "./Splitter";

interface RightPanelProps {
  selected: RigObject | null;
  objects: RigObject[];
  globals: string[];
  globalScript: string;
  frame: RigFrame | null;
  engineError: string | null;
  inputs: InputValues;
  editorHeight: number;
  onEditorHeight: (delta: number) => void;
  onResetEditorHeight: () => void;
  onObjectScript: (script: string) => void;
  onGlobalScript: (script: string) => void;
  onInputs: (patch: Partial<InputValues>) => void;
}

type Tab = "object" | "globals" | "inputs";

export function RightPanel(props: RightPanelProps) {
  const [tab, setTab] = useState<Tab>("object");
  useEffect(() => { setTab("object"); }, [props.selected?.id]);
  const editorValue = tab === "globals" ? props.globalScript : props.selected?.script || "";
  const editorKey = tab === "globals" ? "globals" : props.selected?.id || "empty";
  const dynamic = props.selected ? props.frame?.objects[props.selected.id] : null;

  return (
    <aside className="right-panel panel-surface">
      <div className="right-tabs">
        <button className={tab === "object" ? "active" : ""} onClick={() => setTab("object")}><Braces size={14} /> Объект</button>
        <button className={tab === "globals" ? "active" : ""} onClick={() => setTab("globals")}><Globe2 size={14} /> Глобальные</button>
        <button className={tab === "inputs" ? "active" : ""} onClick={() => setTab("inputs")}><SlidersHorizontal size={14} /> Входы</button>
      </div>

      {tab === "inputs" ? <InputsPanel inputs={props.inputs} frame={props.frame} onChange={props.onInputs} /> : <>
        <div className="script-workspace" style={{ height: props.editorHeight }}>
          <div className="script-caption">
            <span>{tab === "globals" ? "globals.rig" : `${props.selected?.id || "object"}.rig`}</span>
            <span className="autosave-note">авто · 420 мс</span>
          </div>
          {(tab === "globals" || props.selected) ? <ScriptEditor
            key={editorKey}
            value={editorValue}
            objectIds={props.objects.map((object) => object.id)}
            globals={props.globals}
            onApply={tab === "globals" ? props.onGlobalScript : props.onObjectScript}
          /> : <div className="empty-state"><Braces size={24} /><p>Выберите объект для редактирования скрипта</p></div>}
        </div>
        <Splitter orientation="horizontal" onDelta={props.onEditorHeight} onReset={props.onResetEditorHeight} label="Высота редактора скрипта" />
        <div className="runtime-panel">
          <div className="runtime-heading"><Gauge size={14} /><span>Значения кадра</span>{props.frame && <small>#{props.frame.seq}</small>}</div>
          {props.engineError && <div className="diagnostic error"><CircleAlert size={14} /><span>{props.engineError}</span></div>}
          {props.frame?.diagnostics.map((message, index) => <div className="diagnostic" key={`${index}-${message}`}><CircleAlert size={13} /><span>{message}</span></div>)}
          <div className="runtime-values">
            {dynamic ? Object.entries(dynamic).map(([name, value]) => (
              <div className="runtime-value" key={name}><span>{name}</span><b>{formatValue(value)}</b></div>
            )) : tab === "globals" ? Object.entries(props.frame?.globals || {}).map(([name, value]) => (
              <div className="runtime-value" key={name}><span>{name}</span><b>{formatValue(value)}</b></div>
            )) : <span className="muted">Нет данных кадра</span>}
          </div>
          <div className="function-hints">
            <code>smooth(target, ms)</code><code>spring(target, hz, damping)</code><code>follow(offset, parent).x</code>
          </div>
        </div>
      </>}
    </aside>
  );
}

function formatValue(value: number) {
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(2);
  return value.toFixed(3);
}
