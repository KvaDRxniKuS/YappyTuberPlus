import { useState } from "react";
import { ArrowUpRight, AudioLines, ChevronDown, Code2, Trash2 } from "lucide-react";
import type { EnumState, InputValues, ModuleInstance, RigFrame, VisemeEntry } from "../types";
import { frameValue, type AudioFrame } from "../modules/audio";
import {
  inputDefault, inputRange, moduleDefinition, type ModuleInputSpec,
} from "../modules/registry";
import { inputEnabled, inputKey, instanceInputs, isPointerKind } from "../modules/values";
import { visemeEntries } from "../modules/viseme";
import { enumStates, manualMode, stateIndex } from "../modules/manual";
import { CalibrateButton, SpectrumBars, useVisemeRecorder, type CalibrationApi } from "./VisemeCalibration";
import { eventSnippet } from "../engine/scripts";
import type { ExternalTextLine } from "../modules/sources";

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
  /** Переход к настройкам модуля: вкладка «Модули» с подсветкой нужной карточки. */
  onOpenModule: (name: string) => void;
  /** Вставка готового блока события в текущий скрипт. */
  onInsertSnippet: (snippet: string) => void;
  /** Последние тексты источников (чат): показываются как есть, в формулы не идут. */
  texts?: Record<string, ExternalTextLine[]>;
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
        // Внешний источник приходит готовыми числами: показывать их из ручных
        // ползунков нельзя — получились бы нули при живом источнике.
        const external = definition.kind === "external";
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
                {!module.enabled ? "выключен" : live ? "микрофон" : auto ? "авто" : pointer ? "ввод" : external ? "источник" : "ручной"}
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
                  title="Открыть модуль в настройках: шаблон, поля, сброс"
                  onClick={() => props.onOpenModule(module.name)}
                >
                  <ArrowUpRight size={12} />
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
              // Ручной модуль в режиме «Состояния»: панель показывает номер
              // выбранного состояния и флаги, которые выводит движок входов.
              const enumMode = definition.kind === "manual" && manualMode(module) === "enum";
              const value = !module.enabled || !on
                ? undefined
                : enumMode
                  ? props.inputs.values[key] ?? 0
                  : pointer || external
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
                    mode={enumMode
                      ? spec.name === "value" ? "enum" : "state"
                      : live || auto || pointer || external ? "read" : module.config.mode === "flag" && definition.kind === "manual" ? "flag" : "slider"}
                    states={enumMode ? enumStates(module) : undefined}
                    stateIndex={enumMode ? stateIndex(module, props.inputs.values[inputKey(module, "value")]) : undefined}
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
            {/* Текст из источника (чат): показываем как есть. В формулы он не
                попадает — движок входов знает только числа. */}
            {!isCollapsed(module.name) && (props.texts?.[module.name]?.length ?? 0) > 0 && (
              <div className="input-texts">
                <span className="input-texts-title">Последние сообщения</span>
                {(props.texts?.[module.name] ?? []).slice(0, 4).map((line, index) => (
                  <div className="input-text-line" key={`${line.at}-${index}`} title={line.text}>
                    {line.author && <b>{line.author}:</b>} <span>{line.text}</span>
                  </div>
                ))}
              </div>
            )}
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
  /** `enum` — выбор состояния, `state` — его флаг. */
  mode: "read" | "flag" | "slider" | "enum" | "state";
  /** Список состояний ручного модуля: нужен режимам `enum` и `state`. */
  states?: EnumState[];
  /** Номер выбранного состояния. */
  stateIndex?: number;
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

  if (props.mode === "state") {
    // Флаг состояния: показывает, выбрано ли оно, и позволяет выбрать его
    // кликом — это тот же выбор, что и в списке номера.
    const index = props.states?.findIndex((state) => state.name === props.spec.name) ?? -1;
    const selected = index >= 0 && index === props.stateIndex;
    return (
      <button
        type="button"
        className={`input-flag input-state ${selected ? "selected" : ""}`}
        title={props.spec.hint}
        onClick={() => { if (index >= 0) props.onChange(index); }}
      >
        <code>{props.name}</code>
        <span className={`signal-dot ${selected ? "on" : ""}`} />
      </button>
    );
  }

  if (props.mode === "enum") {
    const states = props.states ?? [];
    const current = props.stateIndex ?? 0;
    return (
      <label className="input-flag input-enum">
        <code>{props.name}</code>
        <select
          value={String(current)}
          title={props.spec.hint}
          onChange={(event) => props.onChange(Number(event.target.value))}
        >
          {states.map((state, index) => (
            <option key={state.name} value={index}>{state.label} · {state.name}</option>
          ))}
        </select>
      </label>
    );
  }

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
