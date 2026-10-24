import { useEffect, useRef } from "react";
import { Activity, AudioLines, Mic, MicOff, Sparkles } from "lucide-react";
import type { InputValues, RigFrame } from "../types";
import { useMicrophone } from "../hooks/useMicrophone";

interface InputsPanelProps {
  inputs: InputValues;
  frame: RigFrame | null;
  onChange: (patch: Partial<InputValues>) => void;
}

export function InputsPanel({ inputs, frame, onChange }: InputsPanelProps) {
  const mic = useMicrophone(onChange);
  const blinkTimer = useRef<number | null>(null);
  useEffect(() => () => { if (blinkTimer.current) window.clearTimeout(blinkTimer.current); }, []);

  const blink = () => {
    onChange({ signals: { ...inputs.signals, blink: 1 } });
    if (blinkTimer.current) window.clearTimeout(blinkTimer.current);
    blinkTimer.current = window.setTimeout(() => onChange({ signals: { ...inputs.signals, blink: 0 } }), 160);
  };

  return (
    <div className="inputs-panel">
      <div className="input-actions">
        <button className={`mic-button ${mic.active ? "active" : ""}`} onClick={() => mic.active ? mic.stop() : void mic.start()}>
          {mic.active ? <MicOff size={15} /> : <Mic size={15} />}
          {mic.active ? "Отключить микрофон" : "Включить микрофон"}
        </button>
        <button className="icon-button" title="Тестовое моргание" onClick={blink}><Sparkles size={15} /></button>
      </div>
      {mic.error && <div className="inline-error">{mic.error}</div>}
      <div className={`audio-meter ${mic.active ? "live" : ""}`}>
        <AudioLines size={18} />
        <div className="meter-track"><span style={{ width: `${Math.round(inputs.speak * 100)}%` }} /></div>
        <b>{inputs.db.toFixed(0)} dB</b>
      </div>

      <div className="input-sliders">
        <InputSlider label="speak" value={inputs.speak} disabled={mic.active} onChange={(speak) => onChange({ speak })} />
        <InputSlider label="loudness" value={inputs.loudness} disabled={mic.active} onChange={(loudness) => onChange({ loudness })} />
      </div>
      <div className="talking-row">
        <span>talking</span>
        <div className="segmented small">
          <button className={inputs.talking === 0 ? "active" : ""} onClick={() => onChange({ talking: 0 })}>0</button>
          <button className={inputs.talking !== 0 ? "active" : ""} onClick={() => onChange({ talking: 1 })}>1</button>
        </div>
        <span className={`signal-dot ${inputs.talking ? "on" : ""}`} />
      </div>

      <details className="visemes">
        <summary><Activity size={13} /> Тестовые виземы</summary>
        {(["a", "e", "i", "o", "u"] as const).map((viseme) => {
          const key = `viseme_${viseme}` as keyof InputValues;
          return <InputSlider key={key} label={`viseme_${viseme}`} value={Number(inputs[key])} onChange={(value) => onChange({ [key]: value })} />;
        })}
      </details>

      <div className="globals-monitor">
        <div className="section-title"><span>Глобальные значения</span><small>LIVE</small></div>
        {Object.entries(frame?.globals || {}).map(([name, value]) => (
          <div className="monitor-row" key={name}><span>{name}</span><b>{value.toFixed(4)}</b></div>
        ))}
        {!frame && <p className="muted">Ожидание первого кадра…</p>}
      </div>
    </div>
  );
}

function InputSlider({ label, value, onChange, disabled = false }: {
  label: string; value: number; disabled?: boolean; onChange: (value: number) => void;
}) {
  return (
    <label className={`input-slider ${disabled ? "disabled" : ""}`}>
      <span><code>{label}</code><b>{value.toFixed(2)}</b></span>
      <input type="range" min="0" max="1" step="0.01" value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}
