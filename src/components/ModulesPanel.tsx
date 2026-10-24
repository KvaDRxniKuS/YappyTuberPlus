import { useEffect, useMemo, useState } from "react";
import {
  AudioLines, ChevronDown, Copy, Mic, Plus, RefreshCw, Search, SlidersHorizontal, Trash2, X,
} from "lucide-react";
import type { ModuleInstance } from "../types";
import type { DeviceOption } from "../modules/audio";
import {
  fieldVisible, inputRange, moduleDefaults, moduleDefinition,
  type ModuleDefinition, type ModuleField,
} from "../modules/registry";
import { useModuleLibrary } from "../hooks/useModuleLibrary";
import { inputEnabled, moduleInputs, sanitizeModuleName, uniqueModuleName, validateModules } from "../modules/values";
import { Switch } from "./Switch";

interface ModulesPanelProps {
  modules: ModuleInstance[];
  devices: DeviceOption[];
  error: string | null;
  onChange: (modules: ModuleInstance[], label?: string) => void;
  onRefreshDevices: () => void;
}

/**
 * Панель модулей: сверху поиск по уже включённым, снизу — библиотека шаблонов.
 *
 * Входы модуля можно выключать по одному: выключенный вход не считается и не
 * уходит в кадр, поэтому ошибку «неизвестное имя» видно сразу. Карточки
 * сворачиваются, настройки идут сеткой «поле — значение».
 */
export function ModulesPanel(props: ModulesPanelProps) {
  const [query, setQuery] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const library = useModuleLibrary();

  useEffect(() => {
    // Свёрнутость живёт в компоненте: после перезапуска карточки снова раскрыты.
    setCollapsed((current) => {
      const next = current.filter((name) => props.modules.some((module) => module.name === name));
      return next.length === current.length ? current : next;
    });
  }, [props.modules]);

  const problems = validateModules(props.modules);
  const isCollapsed = (name: string) => collapsed.includes(name);
  const toggleCollapsed = (name: string) => {
    setCollapsed((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]));
  };

  const patch = (name: string, change: Partial<ModuleInstance>, label?: string) => {
    props.onChange(props.modules.map((module) => (module.name === name ? { ...module, ...change } : module)), label);
  };

  const patchConfig = (module: ModuleInstance, key: string, value: number | string | boolean, label?: string) => {
    patch(module.name, { config: { ...module.config, [key]: value } }, label);
  };

  const rename = (name: string, raw: string) => {
    const next = sanitizeModuleName(raw);
    if (!next || next === name) return;
    if (props.modules.some((module) => module.name === next)) return;
    props.onChange(
      props.modules.map((module) => (module.name === name ? { ...module, name: next } : module)),
      "Переименование модуля",
    );
  };

  const add = (definition: ModuleDefinition) => {
    const instance: ModuleInstance = {
      name: uniqueModuleName(props.modules, definition.id),
      type: definition.id,
      enabled: true,
      source: definition.audio ? "live" : "manual",
      config: moduleDefaults(definition),
    };
    props.onChange([...props.modules, instance], "Добавление модуля");
    setPaletteOpen(false);
    setPaletteQuery("");
  };

  const duplicate = (module: ModuleInstance) => {
    const instance: ModuleInstance = {
      ...module,
      name: uniqueModuleName(props.modules, `${module.name}_copy`),
      config: { ...module.config },
      disabledInputs: module.disabledInputs ? [...module.disabledInputs] : undefined,
    };
    props.onChange([...props.modules, instance], "Дублирование модуля");
  };

  const toggleInput = (module: ModuleInstance, input: string, enabled: boolean) => {
    const current = module.disabledInputs || [];
    const next = enabled ? current.filter((name) => name !== input) : [...current, input];
    patch(module.name, { disabledInputs: next.length > 0 ? next : undefined },
      enabled ? `Вход ${input} включён` : `Вход ${input} выключен`);
  };

  const needle = query.trim().toLowerCase();
  const visibleModules = useMemo(() => {
    if (!needle) return props.modules;
    return props.modules.filter((module) => {
      const definition = moduleDefinition(module.type);
      const haystack = [module.name, definition.title, definition.id, ...moduleInputs(module).map((item) => item.key)].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  }, [props.modules, needle]);

  const paletteItems = useMemo(() => {
    const items = library.definitions;
    const paletteNeedle = paletteQuery.trim().toLowerCase();
    if (!paletteNeedle) return items;
    return items.filter((definition) =>
      [definition.title, definition.id, definition.description].join(" ").toLowerCase().includes(paletteNeedle));
  }, [library.definitions, paletteQuery]);

  return (
    <div className="modules-panel">
      <div className="module-search">
        <Search size={13} />
        <input
          value={query}
          placeholder="Поиск по модулям и входам"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && <button className="icon-button" title="Сбросить поиск" onClick={() => setQuery("")}><X size={12} /></button>}
        <b>{props.modules.length}</b>
      </div>

      {props.error && <div className="inline-error">{props.error}</div>}
      {problems.length > 0 && <div className="inline-error">{problems.join(" · ")}</div>}

      <div className="module-list">
        {props.modules.length === 0 && (
          <p className="muted">Модулей нет. Добавьте шаблон из библиотеки — входы появятся во вкладке «Входы».</p>
        )}
        {props.modules.length > 0 && visibleModules.length === 0 && (
          <p className="muted">Ничего не нашлось по запросу «{query}».</p>
        )}
        {visibleModules.map((module) => {
          const definition = moduleDefinition(module.type);
          const live = module.enabled && definition.audio === true && module.source === "live";
          const open = !isCollapsed(module.name);
          const fields = definition.fields.filter((field) => fieldVisible(field, module.config));
          return (
            <section className={`module-card ${module.enabled ? "" : "disabled"} ${open ? "" : "collapsed"}`} key={module.name}>
              <header>
                <Switch
                  checked={module.enabled}
                  title={module.enabled ? "Выключить модуль" : "Включить модуль"}
                  onChange={(checked) => patch(module.name, { enabled: checked }, "Модуль вкл/выкл")}
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
                {!open && (
                  <span className="module-summary">
                    {moduleInputs(module).filter((item) => inputEnabled(module, item.spec.name)).map((item) => item.key).join(" · ")}
                  </span>
                )}
                <button
                  className={`icon-button module-collapse ${open ? "open" : ""}`}
                  title={open ? "Свернуть модуль" : "Развернуть модуль"}
                  onClick={() => toggleCollapsed(module.name)}
                ><ChevronDown size={13} /></button>
                <button className="icon-button" title="Дублировать модуль" onClick={() => duplicate(module)}><Copy size={13} /></button>
                <button
                  className="icon-button"
                  title="Удалить модуль"
                  onClick={() => props.onChange(props.modules.filter((item) => item.name !== module.name), "Удаление модуля")}
                ><Trash2 size={13} /></button>
              </header>

              {open && (
                <>
                  {definition.description && <p className="module-description">{definition.description}</p>}

                  {definition.audio && (
                    <div className="module-source">
                      <div className="segmented small">
                        <button className={module.source === "live" ? "active" : ""} onClick={() => patch(module.name, { source: "live" }, "Источник модуля")}>Микрофон</button>
                        <button className={module.source === "manual" ? "active" : ""} onClick={() => patch(module.name, { source: "manual" }, "Источник модуля")}>Ползунок</button>
                      </div>
                      <span className="module-hint">
                        {module.source === "live" ? "рабочий режим: значения со звука" : "отладка: значения ставятся вручную"}
                      </span>
                    </div>
                  )}

                  {fields.length > 0 && (
                    <div className="module-fields">
                      {fields.map((field) => (
                        <div className="module-field" key={field.key} title={field.hint}>
                          <span className="module-field-label">
                            {field.label}{field.suffix ? `, ${field.suffix}` : ""}
                          </span>
                          <div className="module-field-value">
                            <FieldControl
                              field={field}
                              module={module}
                              devices={props.devices}
                              onValue={(value, label) => patchConfig(module, field.key, value, label)}
                              onRefreshDevices={props.onRefreshDevices}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <footer className="module-inputs">
                    <span className="module-inputs-title">Входы</span>
                    {definition.inputs.map((spec) => {
                      const on = inputEnabled(module, spec.name);
                      const range = inputRange(module, spec);
                      return (
                        <button
                          type="button"
                          className={`module-input-chip ${on ? "" : "off"}`}
                          key={spec.name}
                          title={spec.hint || `${range.min}…${range.max}`}
                          onClick={() => toggleInput(module, spec.name, !on)}
                        >
                          <Switch size="tiny" checked={on} onChange={(next) => toggleInput(module, spec.name, next)} title={on ? "Выключить вход" : "Включить вход"} />
                          <code>{module.name}.{spec.name}</code>
                        </button>
                      );
                    })}
                    {definition.inputs.length === 0 && <span className="muted">шаблон без входов</span>}
                  </footer>
                </>
              )}
            </section>
          );
        })}
      </div>

      <div className="module-add">
        <button className={`button primary module-add-button ${paletteOpen ? "active" : ""}`} onClick={() => setPaletteOpen(!paletteOpen)}>
          <Plus size={14} /> Добавить модуль
        </button>
        <button className="icon-button" title="Обновить список микрофонов" onClick={props.onRefreshDevices}><AudioLines size={14} /></button>
      </div>

      {paletteOpen && (
        <div className="module-palette">
          <div className="module-search">
            <Search size={13} />
            <input
              autoFocus
              value={paletteQuery}
              placeholder="Поиск по библиотеке шаблонов"
              spellCheck={false}
              onChange={(event) => setPaletteQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") { setPaletteOpen(false); setPaletteQuery(""); }
                if (event.key === "Enter" && paletteItems[0]) add(paletteItems[0]);
              }}
            />
            <button className="icon-button" title="Закрыть" onClick={() => { setPaletteOpen(false); setPaletteQuery(""); }}><X size={12} /></button>
          </div>
          <div className="module-palette-list">
            {paletteItems.map((definition) => (
              <button key={definition.id} className="module-palette-item" onClick={() => add(definition)}>
                <span className="module-palette-icon">{definition.audio ? <Mic size={14} /> : <SlidersHorizontal size={14} />}</span>
                <span className="module-palette-text">
                  <b>{definition.title}</b>
                  <small>{definition.description || definition.id}</small>
                </span>
                <span className="module-palette-inputs">{definition.inputs.map((input) => input.name).join(" · ")}</span>
              </button>
            ))}
            {!library.ready && <p className="muted">Читаю папку modules…</p>}
            {library.ready && paletteItems.length === 0 && <p className="muted">В папке modules нет шаблонов под этот запрос.</p>}
          </div>
          <p className="module-palette-note">
            Шаблоны лежат в папке <code>modules</code>: <code>{library.definitions.length}</code> шт.
            Настройки шаблона — входы и поля — читаются из JSON.
          </p>
          {library.error && <div className="inline-error">{library.error}</div>}
        </div>
      )}
    </div>
  );
}

/** Контрол поля без подписи: подпись рисует сетка карточки. */
function FieldControl(props: {
  field: ModuleField;
  module: ModuleInstance;
  devices: DeviceOption[];
  onValue: (value: number | string | boolean, label?: string) => void;
  onRefreshDevices: () => void;
}) {
  const { field, module } = props;
  const value = module.config[field.key] ?? field.default;

  if (field.type === "flag") {
    return (
      <div className="module-field-flag">
        <Switch checked={value === true} onChange={(next) => props.onValue(next, field.label)} title={field.label} />
        <span>{value === true ? "да" : "нет"}</span>
      </div>
    );
  }

  if (field.type === "device") {
    return (
      <div className="module-device">
        <select
          value={typeof value === "string" && value ? value : "default"}
          onChange={(event) => props.onValue(event.target.value === "default" ? "" : event.target.value, "Микрофон модуля")}
        >
          <option value="default">Системный по умолчанию</option>
          {props.devices.map((device) => (
            <option key={device.id} value={device.id}>{device.label}</option>
          ))}
        </select>
        <button className="icon-button" title="Обновить список микрофонов" onClick={props.onRefreshDevices}><RefreshCw size={12} /></button>
      </div>
    );
  }

  if (field.type === "select") {
    const options = field.options || [];
    return (
      <select
        value={String(value ?? options[0]?.value ?? "")}
        onChange={(event) => props.onValue(event.target.value, field.label)}
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }

  const numeric = typeof value === "number" ? value : Number(value ?? field.default ?? 0);
  return (
    <input
      className="module-field-number"
      type="number"
      min={field.min}
      max={field.max}
      step={field.step ?? 1}
      value={Number.isFinite(numeric) ? numeric : 0}
      onChange={(event) => props.onValue(clampNumber(Number(event.target.value), field), field.label)}
    />
  );
}

function clampNumber(value: number, field: ModuleField): number {
  if (!Number.isFinite(value)) return Number(field.default ?? 0);
  const min = field.min ?? -Infinity;
  const max = field.max ?? Infinity;
  return Math.min(max, Math.max(min, value));
}
