import { useEffect, useRef } from "react";
import { AudioLines, Mic, MicOff, Sparkles } from "lucide-react";
import type { InputValues, ModuleInstance, RigFrame } from "../types";
import type { AudioFrame } from "../modules/audio";
import { inputDefault, moduleDefinition, type ModuleInputSpec } from "../modules/registry";
import { inputKey } from "../modules/values";

interface InputsPanelProps {
  modules: ModuleInstance[];
  inputs: InputValues;
  audio: Record<string, AudioFrame>;
  manual: Record<string, number>;
  active: boolean;
  error: string | null;
  frame: RigFrame | null;
  onStart: () => void;
  onStop: () => void;
  onManual: (key: string, value: number) => void;
  onPulse: (key: string) => void;
}

/**
 * Живые значения входов. Строится по модулям: у каждого — свой блок, а входы
 * подписаны полным именем `<модуль>.<вход>`, как их видит скрипт.
 */
export function InputsPanel(props: InputsPanelProps) {
  const blinkTimer = useRef<number | null>(null);
  useEffect(() => () => { if (blinkTimer.current) window.clearTimeout(blinkTimer.current); }, []);

  const liveModules = props.modules.filter((module) => module.enabled && module.source === "live" && moduleDefinition(module.type).audio);
  const blinkKey = props.modules
    .filter((module) => module.enabled && module.type === "manual")
    .map((module) => inputKey(module, "blink"))[0];

  const blink = () => {
    if (!blinkKey) return;
    props.onPulse(blinkKey);
    blinkTimer.current = window.setTimeout(() => props.onManual(blinkKey, 0), 160);
  };

  const loudest = liveModules
    .map((module) => props.audio[module.name]?.speak ?? 0)
    .reduce((max, value) => Math.max(max, value), 0);
  const db = liveModules.length
    ? Math.min(...liveModules.map((module) => props.audio[module.name]?.db ?? -80))
    : -60;

  return (
    <div className="inputs-panel">
      <div className="input-actions">
        <button className={`mic-button ${props.active ? "active" : ""}`} onClick={() => (props.active ? props.onStop() : props.onStart())}>
          {props.active ? <MicOff size={15} /> : <Mic size={15} />}
          {props.active ? "Выключить микрофоны" : "Включить микрофоны"}
        </button>
        <button className="icon-button" title="Тестовое моргание" onClick={blink} disabled={!blinkKey}><Sparkles size={15} /></button>
      </div>
      {props.error && <div className="inline-error">{props.error}</div>}
      <div className={`audio-meter ${props.active ? "live" : ""}`}>
        <AudioLines size={18} />
        <div className="meter-track"><span style={{ width: `${Math.round(loudest * 100)}%` }} /></div>
        <b>{db.toFixed(0)} dB</b>
      </div>

      {props.modules.length === 0 && (
        <p className="muted">Модулей нет. Добавьте их на вкладке «Модули» — входы появятся здесь.</p>
      )}

      {props.modules.map((module) => {
        const definition = moduleDefinition(module.type);
        const live = module.enabled && module.source === "live" && definition.audio === true;
        return (
          <section className={`module-group ${module.enabled ? "" : "disabled"}`} key={module.name}>
            <div className="module-group-head">
              <code>{module.name}</code>
              <span>{definition.title}</span>
              <small>{live ? "микрофон" : module.source === "manual" ? "ручной" : "выключен"}</small>
            </div>
            {definition.inputs.map((spec) => {
              const key = inputKey(module, spec.name);
              const value = live
                ? props.audio[module.name]?.[spec.name] ?? inputDefault(spec)
                : props.manual[key] ?? inputDefault(spec);
              return (
                <InputRow
                  key={key}
                  spec={spec}
                  name={key}
                  value={value}
                  live={live}
                  disabled={!module.enabled}
                  onClick={spec.kind === "flag" ? () => (spec.name === "blink" ? blink() : props.onManual(key, value > 0.5 ? 0 : 1)) : undefined}
                  onChange={(next) => props.onManual(key, next)}
                />
              );
            })}
          </section>
        );
      })}

      <div className="globals-monitor">
        <div className="section-title"><span>Глобальные значения</span><small>LIVE</small></div>
        {Object.entries(props.frame?.globals || {}).map(([name, value]) => (
          <div className="monitor-row" key={name}><span>{name}</span><b>{value.toFixed(4)}</b></div>
        ))}
        {!props.frame && <p className="muted">Ожидание первого кадра…</p>}
      </div>
    </div>
  );
}

function InputRow(props: {
  spec: ModuleInputSpec;
  name: string;
  value: number;
  live: boolean;
  disabled: boolean;
  onClick?: () => void;
  onChange: (value: number) => void;
}) {
  const { spec, value } = props;
  const percent = spec.kind === "db" ? Math.max(0, Math.min(1, (value + 80) / 80)) : Math.max(0, Math.min(1, value));
  const display = spec.kind === "db" ? `${value.toFixed(0)} dB` : value.toFixed(2);
  if (spec.kind === "flag") {
    return (
      <div className={`input-flag ${props.disabled ? "disabled" : ""}`}>
        <code>{props.name}</code>
        <div className="segmented small">
          <button className={value === 0 ? "active" : ""} onClick={() => props.onClick?.()}>0</button>
          <button className={value !== 0 ? "active" : ""} onClick={() => props.onClick?.()}>1</button>
        </div>
        <span className={`signal-dot ${value ? "on" : ""}`} />
      </div>
    );
  }
  return (
    <label className={`input-slider ${props.disabled ? "disabled" : ""} ${props.live ? "live" : ""}`}>
      <span><code>{props.name}</code><b>{display}</b></span>
      {props.live
        ? <div className="meter-track slim"><span style={{ width: `${Math.round(percent * 100)}%` }} /></div>
        : <input
          type="range"
          min={spec.min}
          max={spec.max}
          step={spec.step ?? 0.01}
          value={value}
          disabled={props.disabled}
          onChange={(event) => props.onChange(Number(event.target.value))}
        />}
    </label>
  );
}
