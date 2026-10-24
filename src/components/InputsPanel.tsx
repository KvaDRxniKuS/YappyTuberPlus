import { useState } from "react";
import { AudioLines, ChevronDown } from "lucide-react";
import type { InputValues, ModuleInstance, RigFrame } from "../types";
import type { AudioFrame } from "../modules/audio";
import { inputDefault, inputRange, moduleDefinition, type ModuleInputSpec } from "../modules/registry";
import { inputEnabled, inputKey } from "../modules/values";

interface InputsPanelProps {
  modules: ModuleInstance[];
  inputs: InputValues;
  audio: Record<string, AudioFrame>;
  manual: Record<string, number>;
  auto: Record<string, number>;
  error: string | null;
  frame: RigFrame | null;
  onManual: (key: string, value: number) => void;
}

/**
 * Живые значения входов. Строится по модулям: у каждого — свой блок, входы
 * подписаны полным именем `<модуль>.<вход>`, как их видит скрипт.
 *
 * Кнопки «включить микрофон» здесь больше нет: звук поднимается сам, когда в
 * модели есть включённый микрофонный модуль.
 */
export function InputsPanel(props: InputsPanelProps) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const isCollapsed = (name: string) => collapsed.includes(name);
  const toggle = (name: string) => {
    setCollapsed((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]));
  };

  const liveModules = props.modules.filter((module) => module.enabled && module.source === "live" && moduleDefinition(module.type).audio === true);
  const loudest = liveModules
    .map((module) => props.audio[module.name]?.speak ?? 0)
    .reduce((max, value) => Math.max(max, value), 0);
  const db = liveModules.length
    ? Math.min(...liveModules.map((module) => props.audio[module.name]?.db ?? -80))
    : -60;

  return (
    <div className="inputs-panel">
      {liveModules.length > 0 && (
        <div className={`audio-meter ${liveModules.length ? "live" : ""}`}>
          <AudioLines size={18} />
          <div className="meter-track"><span style={{ width: `${Math.round(loudest * 100)}%` }} /></div>
          <b>{db.toFixed(0)} dB</b>
        </div>
      )}

      {props.modules.length === 0 && (
        <p className="muted">Модулей нет. Добавьте их на вкладке «Модули» — входы появятся здесь.</p>
      )}

      {props.modules.map((module) => {
        const definition = moduleDefinition(module.type);
        const live = module.enabled && module.source === "live" && definition.audio === true;
        const auto = definition.kind === "autoblink";
        return (
          <section className={`module-group ${module.enabled ? "" : "disabled"}`} key={module.name}>
            <button
              type="button"
              className={`module-group-head ${isCollapsed(module.name) ? "collapsed" : ""}`}
              title={isCollapsed(module.name) ? "Развернуть входы" : "Свернуть входы"}
              onClick={() => toggle(module.name)}
            >
              <ChevronDown size={12} />
              <code>{module.name}</code>
              <span>{definition.title}</span>
              <small>
                {!module.enabled ? "выключен" : live ? "микрофон" : auto ? "авто" : "ручной"}
              </small>
            </button>
            {isCollapsed(module.name) && (
              <span className="module-group-summary">
                {definition.inputs
                  .filter((spec) => inputEnabled(module, spec.name))
                  .map((spec) => inputKey(module, spec.name))
                  .join(" · ") || "входы выключены"}
              </span>
            )}
            {!isCollapsed(module.name) && live && props.error && <div className="inline-error">{props.error}</div>}
            {!isCollapsed(module.name) && definition.inputs.map((spec) => {
              const key = inputKey(module, spec.name);
              const on = inputEnabled(module, spec.name);
              const range = inputRange(module, spec);
              const value = !module.enabled || !on
                ? undefined
                : live
                  ? props.audio[module.name]?.[spec.name] ?? inputDefault(spec)
                  : auto
                    ? props.auto[key] ?? range.min
                    : props.manual[key] ?? range.min;
              return (
                <InputRow
                  key={key}
                  spec={spec}
                  name={key}
                  value={value}
                  min={range.min}
                  max={range.max}
                  step={range.step}
                  mode={live || auto ? "read" : module.config.mode === "flag" && definition.kind === "manual" ? "flag" : "slider"}
                  reason={!module.enabled ? "модуль выключен" : !on ? "вход выключен" : null}
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
  value: number | undefined;
  min: number;
  max: number;
  step: number;
  mode: "read" | "flag" | "slider";
  reason: string | null;
  onChange: (value: number) => void;
}) {
  const { spec, value } = props;
  const off = props.reason !== null || value === undefined;
  if (off) {
    return (
      <div className="input-slider disabled">
        <span><code>{props.name}</code><em>{props.reason}</em></span>
      </div>
    );
  }

  const safe = value as number;
  const span = props.max - props.min || 1;
  const percent = spec.kind === "db"
    ? Math.max(0, Math.min(1, (safe + 80) / 80))
    : Math.max(0, Math.min(1, (safe - props.min) / span));
  const display = spec.kind === "db" ? `${safe.toFixed(0)} dB` : safe.toFixed(2);

  if (props.mode === "flag") {
    return (
      <div className="input-flag">
        <code>{props.name}</code>
        <div className="segmented small">
          <button className={safe < 0.5 ? "active" : ""} onClick={() => props.onChange(props.min)}>0</button>
          <button className={safe >= 0.5 ? "active" : ""} onClick={() => props.onChange(props.max)}>1</button>
        </div>
        <span className={`signal-dot ${safe >= 0.5 ? "on" : ""}`} />
      </div>
    );
  }

  if (props.mode === "read") {
    return (
      <label className="input-slider live">
        <span><code>{props.name}</code><b>{display}</b></span>
        <div className="meter-track slim"><span style={{ width: `${Math.round(percent * 100)}%` }} /></div>
      </label>
    );
  }

  return (
    <label className="input-slider">
      <span><code>{props.name}</code><b>{display}</b></span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={safe}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </label>
  );
}
