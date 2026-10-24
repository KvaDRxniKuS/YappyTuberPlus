import { useState } from "react";
import { AudioLines, ChevronDown, Code2, RefreshCw, Trash2 } from "lucide-react";
import type { InputValues, ModuleInstance, RigFrame, VisemeEntry } from "../types";
import { frameValue, type AudioFrame } from "../modules/audio";
import {
  inputDefault, inputRange, moduleDefaults, moduleDefinition, refreshLibrary, type ModuleInputSpec,
} from "../modules/registry";
import { inputEnabled, inputKey, instanceInputs, isPointerKind } from "../modules/values";
import { visemeEntries } from "../modules/viseme";
import { CalibrateButton, SpectrumBars, useVisemeRecorder, type CalibrationApi } from "./VisemeCalibration";
import { eventSnippet } from "../engine/scripts";

interface InputsPanelProps extends CalibrationApi {
  modules: ModuleInstance[];
  inputs: InputValues;
  audio: Record<string, AudioFrame>;
  manual: Record<string, number>;
  auto: Record<string, number>;
  error: string | null;
  frame: RigFrame | null;
  onManual: (key: string, value: number) => void;
  onModules: (modules: ModuleInstance[], label?: string) => void;
  /** Вставка готового блока события в текущий скрипт. */
  onInsertSnippet: (snippet: string) => void;
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
  // «Действия» — список готовых блоков событий для модуля.
  const [actions, setActions] = useState<string[]>([]);
  const recorder = useVisemeRecorder(props);
  const isActionsOpen = (name: string) => actions.includes(name);
  const toggleActions = (name: string) => {
    setActions((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]));
  };
  /** Перечитать шаблон из папки modules и вернуть настройки к умолчаниям. */
  const reloadTemplate = async (module: ModuleInstance) => {
    await refreshLibrary();
    const config = moduleDefaults(moduleDefinition(module.type));
    props.onModules(
      props.modules.map((item) => (item.name === module.name ? { ...item, config } : item)),
      "Обновление модуля из шаблона",
    );
  };
  const removeModule = (module: ModuleInstance) => {
    props.onModules(
      props.modules.filter((item) => item.name !== module.name),
      "Удаление модуля",
    );
  };
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
      {recorder.error && <div className="inline-error">{recorder.error}</div>}
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
        const pointer = isPointerKind(definition.kind);
        const specs = instanceInputs(module);
        return (
          <section className={`module-group ${module.enabled ? "" : "disabled"}`} key={module.name}>
            <div className={`module-group-head ${isCollapsed(module.name) ? "collapsed" : ""}`}>
              <button
                type="button"
                className="module-group-toggle"
                title={isCollapsed(module.name) ? "Развернуть входы" : "Свернуть входы"}
                onClick={() => toggle(module.name)}
              >
                <ChevronDown size={12} />
                <code>{module.name}</code>
                <span>{definition.title}</span>
              </button>
              <small>
                {!module.enabled ? "выключен" : live ? "микрофон" : auto ? "авто" : pointer ? "ввод" : "ручной"}
              </small>
              <div className="module-group-tools">
                <button
                  type="button"
                  className={`tool-chip ${isActionsOpen(module.name) ? "active" : ""}`}
                  title="Действия: какие блоки событий можно поставить"
                  onClick={() => toggleActions(module.name)}
                >
                  <Code2 size={11} /> действия
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="Перечитать шаблон из папки modules и сбросить настройки"
                  onClick={() => { void reloadTemplate(module); }}
                >
                  <RefreshCw size={12} />
                </button>
                <button
                  type="button"
                  className="icon-button danger"
                  title="Удалить модуль"
                  onClick={() => removeModule(module)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
            {isActionsOpen(module.name) && (
              <div className="module-actions">
                <p className="module-actions-hint">
                  Клик вставляет блок в текущий скрипт: своё имя объявляется в глобальных
                  {" "}<code>trigger … = …</code>, подписка — <code>on …</code>.
                </p>
                {specs.filter((spec) => inputEnabled(module, spec.name)).flatMap((spec) => {
                  const key = inputKey(module, spec.name);
                  return ["down", "up", "change", "hold(0.5)", "relax(0.5)"].map((kind) => (
                    <code
                      key={`${key}.${kind}`}
                      title={`Вставить блок события ${key}.${kind}`}
                      onClick={() => props.onInsertSnippet(eventSnippet(`${key}.${kind}`))}
                    >
                      {key}.{kind}
                    </code>
                  ));
                })}
                {specs.every((spec) => !inputEnabled(module, spec.name)) && (
                  <span className="muted">У модуля нет включённых входов — событий не будет.</span>
                )}
              </div>
            )}
            {isCollapsed(module.name) && (
              <span className="module-group-summary">
                {specs
                  .filter((spec) => inputEnabled(module, spec.name))
                  .map((spec) => inputKey(module, spec.name))
                  .join(" · ") || "входы выключены"}
              </span>
            )}
            {!isCollapsed(module.name) && live && props.error && <div className="inline-error">{props.error}</div>}
            {!isCollapsed(module.name) && specs.map((spec) => {
              const key = inputKey(module, spec.name);
              const on = inputEnabled(module, spec.name);
              const range = inputRange(module, spec);
              // Полоска удержания в модуле Key: диапазон задаётся в настройках,
              // само значение остаётся секундами.
              const meter = definition.kind === "key" && spec.name === "hold"
                ? holdMeter(module)
                : { min: range.min, max: range.max };
              const viseme = definition.kind === "viseme";
              const value = !module.enabled || !on
                ? undefined
                : pointer
                  ? props.inputs.values[key] ?? 0
                  : live
                    ? viseme
                      ? props.inputs.values[key] ?? 0
                      : frameValue(props.audio[module.name], spec.name) ?? inputDefault(spec)
                    : auto
                      ? props.auto[key] ?? range.min
                      : props.manual[key] ?? range.min;
              const entry = viseme ? visemeEntries(module).find((item) => item.name === spec.name) : undefined;
              const active = recorder.recording?.key === key;
              return (
                <div className="input-line" key={key}>
                  <InputRow
                    spec={spec}
                    name={key}
                    value={value}
                    min={meter.min}
                    max={meter.max}
                    step={range.step}
                    mode={live || auto || pointer ? "read" : module.config.mode === "flag" && definition.kind === "manual" ? "flag" : "slider"}
                    reason={!module.enabled ? "модуль выключен" : !on ? "вход выключен" : null}
                    onChange={(next) => props.onManual(key, next)}
                    action={viseme ? (
                      <CalibrateButton
                        title={entry?.templates.length ? `Добавить вариант записи виземы (${entry.templates.length} есть, 3 с)` : "Записать эталон виземы (3 с)"}
                        recording={active}
                        disabled={!!recorder.recording && !active}
                        onClick={() => {
                          if (!entry) return;
                          void recorder.start(key, module.config, (template) => {
                            const visemes: VisemeEntry[] = visemeEntries(module).map((item) => (
                              item.name === entry.name ? { ...item, templates: [...item.templates, template] } : item
                            ));
                            props.onModules(
                              props.modules.map((item) => (item.name === module.name ? { ...item, config: { ...item.config, visemes } } : item)),
                              "Калибровка виземы",
                            );
                          });
                        }}
                      />
                    ) : undefined}
                  />
                  {active && (
                    <SpectrumBars
                      bands={recorder.recording?.bands}
                      active
                      progress={recorder.recording?.progress}
                      title="Пишу 3 секунды: спектр звука"
                    />
                  )}
                </div>
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

/** Визуальный диапазон полоски `hold`: настройки модуля, но не вырожденный. */
function holdMeter(module: ModuleInstance): { min: number; max: number } {
  const from = Number(module.config.meterFrom ?? 0);
  const to = Number(module.config.meterTo ?? 2);
  const min = Number.isFinite(from) ? Math.max(0, from) : 0;
  const max = Number.isFinite(to) && to > min ? to : min + 0.1;
  return { min, max };
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
  /** Дополнительная кнопка в строке значения: у визем это запись эталона. */
  action?: React.ReactNode;
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
        <span><code>{props.name}</code><b>{display}</b>{props.action}</span>
        <div className="meter-track slim"><span style={{ width: `${Math.round(percent * 100)}%` }} /></div>
      </label>
    );
  }

  return (
    <label className="input-slider">
      <span><code>{props.name}</code><b>{display}</b>{props.action}</span>
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
