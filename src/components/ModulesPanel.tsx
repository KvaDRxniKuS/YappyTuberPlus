import { useState } from "react";
import { AudioLines, Copy, Mic, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import type { ModuleInstance, ModuleType } from "../types";
import type { DeviceOption } from "../modules/audio";
import { MODULES, moduleDefinition } from "../modules/registry";
import { inputKey, sanitizeModuleName, uniqueModuleName, validateModules } from "../modules/values";

interface ModulesPanelProps {
  modules: ModuleInstance[];
  devices: DeviceOption[];
  active: boolean;
  error: string | null;
  onChange: (modules: ModuleInstance[], label?: string) => void;
  onStart: () => void;
  onStop: () => void;
  onRefreshDevices: () => void;
}

/**
 * Список экземпляров модулей. Один тип можно добавить сколько угодно раз:
 * два Loudness с разными микрофонами дают входы `mic_left.*` и `mic_right.*`.
 */
export function ModulesPanel(props: ModulesPanelProps) {
  const problems = validateModules(props.modules);

  const patch = (name: string, change: Partial<ModuleInstance>, label?: string) => {
    props.onChange(props.modules.map((module) => (module.name === name ? { ...module, ...change } : module)), label);
  };

  const rename = (name: string, raw: string) => {
    const next = sanitizeModuleName(raw);
    if (!next || next === name) return;
    const taken = props.modules.some((module) => module.name === next);
    if (taken) return;
    props.onChange(
      props.modules.map((module) => (module.name === name ? { ...module, name: next } : module)),
      "Переименование модуля",
    );
  };

  const add = (type: ModuleType) => {
    const definition = moduleDefinition(type);
    const instance: ModuleInstance = {
      name: uniqueModuleName(props.modules, type),
      type,
      enabled: true,
      source: definition.audio ? "live" : "manual",
      config: { ...definition.defaults },
    };
    props.onChange([...props.modules, instance], "Добавление модуля");
  };

  const duplicate = (module: ModuleInstance) => {
    const instance: ModuleInstance = {
      ...module,
      name: uniqueModuleName(props.modules, `${module.name}_copy`),
      config: { ...module.config },
    };
    props.onChange([...props.modules, instance], "Дублирование модуля");
  };

  return (
    <div className="modules-panel">
      <div className="module-actions">
        <button className={`mic-button ${props.active ? "active" : ""}`} onClick={() => (props.active ? props.onStop() : props.onStart())}>
          <Mic size={14} /> {props.active ? "Микрофоны включены" : "Включить микрофоны"}
        </button>
        <button className="icon-button" title="Обновить список устройств" onClick={props.onRefreshDevices}><AudioLines size={14} /></button>
      </div>
      {props.error && <div className="inline-error">{props.error}</div>}
      {problems.length > 0 && <div className="inline-error">{problems.join(" · ")}</div>}

      <div className="module-list">
        {props.modules.map((module) => {
          const definition = moduleDefinition(module.type);
          return (
            <section className={`module-card ${module.enabled ? "" : "disabled"}`} key={module.name}>
              <header>
                <input
                  className="module-enabled"
                  type="checkbox"
                  checked={module.enabled}
                  title={module.enabled ? "Выключить модуль" : "Включить модуль"}
                  onChange={(event) => patch(module.name, { enabled: event.target.checked }, "Модуль вкл/выкл")}
                />
                <input
                  className="module-name"
                  defaultValue={module.name}
                  key={`${module.name}-name`}
                  spellCheck={false}
                  title="Имя модуля: префикс входов, только латиница, цифры и _"
                  onBlur={(event) => rename(module.name, event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                />
                <span className="module-type">{definition.title}</span>
                <button className="icon-button" title="Дублировать модуль" onClick={() => duplicate(module)}><Copy size={13} /></button>
                <button
                  className="icon-button"
                  title="Удалить модуль"
                  onClick={() => props.onChange(props.modules.filter((item) => item.name !== module.name), "Удаление модуля")}
                ><Trash2 size={13} /></button>
              </header>

              {definition.audio && (
                <>
                  <div className="module-source">
                    <div className="segmented small">
                      <button className={module.source === "live" ? "active" : ""} onClick={() => patch(module.name, { source: "live" }, "Источник модуля")}>Микрофон</button>
                      <button className={module.source === "manual" ? "active" : ""} onClick={() => patch(module.name, { source: "manual" }, "Источник модуля")}>Ползунки</button>
                    </div>
                    <span className="module-hint">{module.source === "live" ? "значения идут со звука" : "значения из вкладки «Входы»"}</span>
                  </div>
                  {module.source === "live" && (
                    <label className="select-field">
                      <span>Устройство</span>
                      <select
                        value={module.config.deviceId || "default"}
                        onChange={(event) => patch(module.name, {
                          config: { ...module.config, deviceId: event.target.value === "default" ? undefined : event.target.value },
                        }, "Микрофон модуля")}
                      >
                        <option value="default">Системный по умолчанию</option>
                        {props.devices.map((device) => (
                          <option key={device.id} value={device.id}>{device.label}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              )}

              <div className="module-settings">
                {definition.audio && module.source === "live" && (
                  <>
                    <label className="module-number">
                      <span>Усиление</span>
                      <input
                        type="number" min={0.1} max={8} step={0.1}
                        value={module.config.gain ?? 1}
                        onChange={(event) => patch(module.name, {
                          config: { ...module.config, gain: clamp(Number(event.target.value), 0.1, 8) },
                        }, "Усиление микрофона")}
                      />
                    </label>
                    <label className="module-number">
                      <span>Порог речи, дБ</span>
                      <input
                        type="number" min={-80} max={0} step={1}
                        value={module.config.threshold ?? -43}
                        onChange={(event) => patch(module.name, {
                          config: { ...module.config, threshold: clamp(Number(event.target.value), -80, 0) },
                        }, "Порог речи")}
                      />
                    </label>
                    <label className="module-check">
                      <input
                        type="checkbox"
                        checked={module.config.processing === true}
                        onChange={(event) => patch(module.name, {
                          config: { ...module.config, processing: event.target.checked },
                        }, "Обработка звука")}
                      />
                      <span>Шумоподавление</span>
                    </label>
                  </>
                )}
              </div>

              <footer>
                {moduleDefinition(module.type).inputs.map((spec) => (
                  <code key={spec.name} title={spec.label}>{inputKey(module, spec.name)}</code>
                ))}
              </footer>
            </section>
          );
        })}
      </div>

      <div className="module-add">
        <span><Plus size={12} /> Добавить модуль</span>
        <div>
          {MODULES.map((definition) => (
            <button key={definition.type} className="button secondary" onClick={() => add(definition.type)}>
              {definition.audio ? <Mic size={13} /> : <SlidersHorizontal size={13} />} {definition.title}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
