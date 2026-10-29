import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown, Copy, Keyboard, Mic, MonitorSmartphone, MousePointerClick, Palette, Plus, RefreshCw, Search,
  SlidersHorizontal, Trash2, Wifi, X,
} from "lucide-react";
import type { ModuleInstance, ModuleKind } from "../types";
import type { DeviceOption } from "../modules/audio";
import type { MonitorOption } from "../modules/pointer";
import {
  fieldVisible, inputRange, moduleDefaults, moduleDefinition, refreshLibrary,
  type ModuleDefinition, type ModuleField,
} from "../modules/registry";
import { useModuleLibrary } from "../hooks/useModuleLibrary";
import { inputEnabled, instanceInputs, moduleInputs, sanitizeModuleName, uniqueModuleName, validateModules } from "../modules/values";
import { Switch } from "./Switch";
import { VisemeEditor } from "./VisemeEditor";
import { KeyBindingRow, KeyboardKeysEditor } from "./KeyboardEditor";
import { EnumStatesEditor } from "./EnumStatesEditor";
import { ENUM_STATES_BASE } from "../modules/manual";
import { MouseButtonsEditor } from "./MouseButtonsEditor";
import { ExternalSourceEditor } from "./ExternalSourceEditor";
import { PresetsEditor } from "./PresetsEditor";
import { ColorEditor } from "./ColorEditor";
import { AmbientEditor } from "./AmbientEditor";
import { AutoBlinkEditor } from "./AutoBlinkEditor";
import type { ObsModuleInfo } from "../hooks/useAmbientSample";
import { NumberField } from "./NumberField";
import type { ExternalLogEntry, ExternalStatus } from "../modules/sources";
import { useVisemeRecorder, type CalibrationApi } from "./VisemeCalibration";

interface ModulesPanelProps extends CalibrationApi {
  modules: ModuleInstance[];
  devices: DeviceOption[];
  /** Мониторы для модуля мыши: у каждого свой номер и размер. */
  monitors?: MonitorOption[];
  error: string | null;
  onChange: (modules: ModuleInstance[], label?: string) => void;
  /**
   * Переход к модулю из вкладки «Входы»: карточку нужно раскрыть, показать на
   * экране и подсветить. `nonce` отличается при каждом переходе — иначе
   * повторный клик по тому же модулю ничего бы не изменил.
   */
  focus?: { name: string; nonce: number } | null;
  /** Состояние внешних источников по имени модуля: подключён, ждёт, ошибка. */
  externalStatuses?: Record<string, ExternalStatus>;
  /** Вход в Twitch и выход из него: токен живёт в профиле окна. */
  onAuthorizeSource?: (name: string) => void;
  onSignOutSource?: (name: string) => void;
  /** OBS у модулей «Свет из экрана»: состояние и списки имён из OBS. */
  ambientObs?: Record<string, ObsModuleInfo>;
  /** «Проверить» у ambient: переподключиться к OBS. */
  onProbeAmbient?: (name: string) => void;
  /** Журнал источников и проверка соединения. */
  externalLogs?: Record<string, ExternalLogEntry[]>;
  onProbeSource?: (name: string) => Promise<string>;
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
  const recorder = useVisemeRecorder(props);
  // Сброс настроек спрашивает подтверждение: вместе с полями шаблона пропадут
  // записи визем, состояния enum и калибровки — их не восстановить.
  const [confirmReset, setConfirmReset] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const cardRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    const focus = props.focus;
    if (!focus) return;
    setCollapsed((current) => current.filter((name) => name !== focus.name));
    setConfirmReset(null);
    // Поиск не должен прятать модуль, к которому перешли.
    setQuery((current) => {
      const needle = current.trim().toLowerCase();
      if (!needle) return current;
      const target = props.modules.find((module) => module.name === focus.name);
      if (!target) return current;
      const definition = moduleDefinition(target.type);
      const haystack = [target.name, definition.title, definition.id,
        ...moduleInputs(target).map((item) => item.key)].join(" ").toLowerCase();
      return haystack.includes(needle) ? current : "";
    });
    setHighlight(focus.name);
    // Карточка уже в документе: прокрутка идёт после перерисовки.
    const scroll = requestAnimationFrame(() => {
      cardRefs.current[focus.name]?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    const timer = window.setTimeout(() => setHighlight(null), 2400);
    return () => { cancelAnimationFrame(scroll); window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus?.nonce]);

  /** Вернуть настройки экземпляра к шаблону из папки modules. */
  const resetTemplate = async (module: ModuleInstance) => {
    setConfirmReset(null);
    await refreshLibrary();
    // Возвращаем и выключенные входы: шаблон снова «как новый».
    patch(module.name, {
      config: moduleDefaults(moduleDefinition(module.type)),
      disabledInputs: undefined,
    }, "Сброс настроек модуля");
  };

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

  const patchConfig = (module: ModuleInstance, key: string, value: ModuleInstance["config"][string], label?: string) => {
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
            <section
              className={`module-card ${module.enabled ? "" : "disabled"} ${open ? "" : "collapsed"} ${highlight === module.name ? "focused" : ""}`}
              key={module.name}
              ref={(element) => { cardRefs.current[module.name] = element; }}
            >
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
                {/* Кнопки стоят до сводки: сводка уходит на свою строку и не
                    сдвигает их при сворачивании карточки. */}
                <div className="module-actions">
                  <button
                    className={`icon-button module-collapse ${open ? "open" : ""}`}
                    title={open ? "Свернуть модуль" : "Развернуть модуль"}
                    onClick={() => toggleCollapsed(module.name)}
                  ><ChevronDown size={13} /></button>
                  <button className="icon-button" title="Дублировать модуль" onClick={() => duplicate(module)}><Copy size={13} /></button>
                  <button
                    className={`icon-button ${confirmReset === module.name ? "danger" : ""}`}
                    title="Сбросить настройки экземпляра к шаблону"
                    onClick={() => setConfirmReset(confirmReset === module.name ? null : module.name)}
                  ><RefreshCw size={13} /></button>
                  <button
                    className="icon-button"
                    title="Удалить модуль"
                    onClick={() => props.onChange(props.modules.filter((item) => item.name !== module.name), "Удаление модуля")}
                  ><Trash2 size={13} /></button>
                </div>
                {!open && (
                  <span className="module-summary">
                    {moduleInputs(module).filter((item) => inputEnabled(module, item.spec.name)).map((item) => item.key).join(" · ")}
                  </span>
                )}
              </header>

              {/* Подтверждение сброса — отдельной строкой под заголовком:
                  в строке заголовка ему не хватит места. */}
              {confirmReset === module.name && (
                <div className="module-reset-confirm">
                  <span>
                    Сбросить настройки «{module.name}» к шаблону? Пропадут записи визем,
                    состояния, клавиши, кнопки и калибровки — вернуть их будет нельзя.
                  </span>
                  <div>
                    <button className="button secondary" onClick={() => void resetTemplate(module)}>Сбросить</button>
                    <button className="button ghost" onClick={() => setConfirmReset(null)}>Отмена</button>
                  </div>
                </div>
              )}

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

                  {definition.kind === "keyboard" && (
                    <KeyboardKeysEditor
                      module={module}
                      onKeys={(keys, label) => patchConfig(module, "keys", keys, label)}
                    />
                  )}

                  {definition.kind === "external" && (
                    <ExternalSourceEditor
                      module={module}
                      status={props.externalStatuses?.[module.name]}
                      onAuthorize={props.onAuthorizeSource ? () => props.onAuthorizeSource?.(module.name) : undefined}
                      onSignOut={props.onSignOutSource ? () => props.onSignOutSource?.(module.name) : undefined}
                      logs={props.externalLogs?.[module.name]}
                      onProbe={props.onProbeSource ? () => props.onProbeSource!(module.name) : undefined}
                      onChange={(source, label) => patchConfig(module, "source", source, label)}
                    />
                  )}

                  {definition.kind === "presets" && (
                    <PresetsEditor
                      module={module}
                      modules={props.modules}
                      onPatch={(config, label) => patch(module.name, { config: { ...module.config, ...config } }, label)}
                    />
                  )}

                  {definition.kind === "color" && (
                    <ColorEditor
                      module={module}
                      reactOptions={props.modules
                        .filter((other) => other.name !== module.name && other.enabled)
                        .flatMap((other) => instanceInputs(other).map((spec) => ({
                          key: `${other.name}.${spec.name}`,
                          label: `${other.name}.${spec.name}`,
                        })))}
                      onChannels={(channels, label) => patchConfig(module, "channels", channels, label)}
                    />
                  )}

                  {definition.kind === "ambient" && (
                    <AmbientEditor
                      module={module}
                      obs={{
                        status: props.ambientObs?.[module.name]?.status ?? { text: "", ok: false },
                        scenes: props.ambientObs?.[module.name]?.scenes ?? [],
                        items: props.ambientObs?.[module.name]?.items ?? [],
                        probe: () => props.onProbeAmbient?.(module.name),
                      }}
                      onConfig={(config, label) => patch(module.name, { config }, label)}
                    />
                  )}

                  {definition.kind === "autoblink" && (
                    <AutoBlinkEditor
                      module={module}
                      onOutputs={(outputs, label) => patchConfig(module, "outputs", outputs, label)}
                    />
                  )}

                  {definition.kind === "manual" && module.config.mode === "enum" && (
                    <EnumStatesEditor
                      module={module}
                      onStates={(states, label) => patchConfig(module, "states", states, label)}
                    />
                  )}

                  {definition.kind === "key" && (
                    <div className="key-editor">
                      <div className="key-editor-head"><span>Клавиша</span><span /><span /></div>
                      <KeyBindingRow
                        code={typeof module.config.code === "string" ? module.config.code : ""}
                        onChange={(code) => patchConfig(module, "code", code, code ? "Клавиша модуля" : "Бинд очищен")}
                      />
                    </div>
                  )}

                  {definition.kind === "viseme" && (
                    <VisemeEditor
                      module={module}
                      recorder={recorder}
                      calibrate={props.calibrate}
                      cancelCalibration={props.cancelCalibration}
                      onVisemes={(visemes, label) => patchConfig(module, "visemes", visemes, label)}
                      onRenameInput={(from, to) => {
                        const disabled = module.disabledInputs;
                        if (!disabled || !disabled.includes(from)) return;
                        patch(module.name, {
                          disabledInputs: disabled.map((name) => (name === from ? to : name)),
                        }, "Переименование виземы");
                      }}
                    />
                  )}

                  {definition.kind === "mouse" && (
                    <MouseButtonsEditor
                      module={module}
                      onButtons={(buttons, label) => patchConfig(module, "buttons", buttons, label)}
                    />
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
                              monitors={props.monitors ?? []}
                              onValue={(value, label) => {
                                // Переключение Manual в «Состояния» сразу даёт
                                // список: пустой enum в панели не с чем сравнивать.
                                if (field.key === "mode" && value === "enum" && !Array.isArray(module.config.states)) {
                                  patch(module.name, {
                                    config: { ...module.config, mode: "enum", states: ENUM_STATES_BASE.map((state) => ({ ...state })) },
                                  }, "Режим состояний");
                                  return;
                                }
                                patchConfig(module, field.key, value, label);
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <footer className="module-inputs">
                    <span className="module-inputs-title">Входы</span>
                    {instanceInputs(module).map((spec) => {
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
                    {instanceInputs(module).length === 0 && <span className="muted">шаблон без входов</span>}
                  </footer>
                </>
              )}
            </section>
          );
        })}
      </div>

      {/* Кнопка «Добавить модуль» — в прижатии к нижней границе вкладки: когда
          список короткий, док стоит сразу за последним модулем, когда длинный —
          висит над краем экрана и к нему не надо доезжать. Палитра открывается
          внутри того же дока, поэтому они не наезжают друг на друга. */}
      <div className="module-dock">
        <div className="module-add">
          <button className={`button primary module-add-button ${paletteOpen ? "active" : ""}`} onClick={() => setPaletteOpen(!paletteOpen)}>
            <Plus size={14} /> Добавить модуль
          </button>
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
                <span className="module-palette-icon">{paletteIcon(definition.kind)}</span>
                <span className="module-palette-text">
                  <b>{definition.title}</b>
                  <small>{definition.description || definition.id}</small>
                </span>
                <span className="module-palette-inputs">
                  {definition.kind === "viseme"
                    ? "свои виземы"
                    : definition.kind === "color"
                      ? "каналы: r · g · b · a · яркость"
                    : definition.kind === "ambient"
                      ? "точки: r · g · b · a · яркость"
                    : definition.kind === "keyboard"
                      ? "клавиши из настроек"
                      : definition.inputs.map((input) => input.name).join(" · ")}
                </span>
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
    </div>
  );
}

/** Иконка шаблона в палитре: по ней видно, откуда модуль берёт значения. */
function paletteIcon(kind: ModuleKind) {
  if (kind === "loudness") return <Mic size={14} />;
  if (kind === "keyboard" || kind === "key") return <Keyboard size={14} />;
  if (kind === "mouse") return <MousePointerClick size={14} />;
  if (kind === "external") return <Wifi size={14} />;
  if (kind === "color") return <Palette size={14} />;
  if (kind === "ambient") return <MonitorSmartphone size={14} />;
  return <SlidersHorizontal size={14} />;
}

/** Контрол поля без подписи: подпись рисует сетка карточки. */
function FieldControl(props: {
  field: ModuleField;
  module: ModuleInstance;
  devices: DeviceOption[];
  monitors: MonitorOption[];
  onValue: (value: number | string | boolean, label?: string) => void;
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
      </div>
    );
  }

  if (field.type === "monitor") {
    // Список живой: монитор могли отключить или поменять масштаб. Если номер
    // из настроек исчез, выбираем первый — модуль продолжает работать.
    const list = props.monitors;
    const current = typeof value === "string" ? value : "";
    const exists = list.some((monitor) => monitor.id === current);
    return (
      <div className="module-device">
        <select
          value={exists ? current : (list[0]?.id ?? "")}
          onChange={(event) => props.onValue(event.target.value, field.label)}
        >
          {list.length === 0 && <option value="">Монитор не найден</option>}
          {list.map((monitor) => (
            <option key={monitor.id} value={monitor.id}>{monitor.label}</option>
          ))}
        </select>
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
    <NumberField
      className="module-field-number"
      value={Number.isFinite(numeric) ? numeric : 0}
      min={field.min}
      max={field.max}
      step={field.step ?? 1}
      // Ограничения применяются после ввода, а не на каждом нажатии.
      onCommit={(next) => props.onValue(clampNumber(next, field), field.label)}
    />
  );
}

function clampNumber(value: number, field: ModuleField): number {
  if (!Number.isFinite(value)) return Number(field.default ?? 0);
  const min = field.min ?? -Infinity;
  const max = field.max ?? Infinity;
  return Math.min(max, Math.max(min, value));
}
