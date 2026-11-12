import { useState } from "react";
import { ChevronDown, Plus, Radar, Trash2 } from "lucide-react";
import type { ExternalSourceConfig, ExternalSourceRule, ModuleInstance } from "../types";
import { externalInputName, readExternalSource } from "../modules/external";
import {
  TRACKER_FIELDS, TRACKER_INFO, discoverTrackers, trackerField, trackerInputName, trackerPorts,
  type TrackerField, type TrackerGroup, type TrackerTransport,
} from "../modules/tracker";
import type { ExternalLogEntry, ExternalStatus } from "../modules/sources";
import { moduleDefinition } from "../modules/registry";
import { NumberField } from "./NumberField";
import { tableMinWidth, tableTemplate, type TableColumn } from "./tableLayout";

/**
 * Редактор трекера лица.
 *
 * Отличие от «Внешнего источника» в одном: набор полей известен заранее. Поэтому
 * путь не пишется руками — поле выбирается из списка, а живая таблица показывает
 * приходящие значения ещё до того, как поле куда-то отнесено. Так видно, работает
 * ли телефон, и не приходится угадывать имена блендшейпов.
 */

const MAPPING_COLUMNS: TableColumn[] = [
  { key: "input", width: 62, grow: 1 },
  { key: "path", width: 118, grow: 1.4 },
  { key: "label", width: 64, grow: 1 },
  { key: "min", width: 42 },
  { key: "max", width: 42 },
  { key: "duration", width: 96 },
  { key: "action", width: 26 },
];

const STATUS_LABEL: Record<ExternalStatus["state"], string> = {
  idle: "не запущен",
  connecting: "слушаю порт",
  live: "на связи",
  error: "нет связи",
  unsupported: "только в приложении",
};

const GROUP_LABEL: Record<TrackerGroup, string> = {
  arkit: "Лицо (52 блендшейпа)",
  head: "Голова",
  eye: "Глаза",
  service: "Служебные",
};

const GROUPS: TrackerGroup[] = ["arkit", "head", "eye", "service"];

interface FaceTrackerEditorProps {
  module: ModuleInstance;
  /** Какое приложение слушаем: тип задан шаблоном модуля. */
  transport: TrackerTransport;
  status?: ExternalStatus;
  /** Последний кадр плоско: `{ "arkit.jawOpen": 0.12 }`. */
  preview?: Record<string, number>;
  logs?: ExternalLogEntry[];
  onChange: (source: ExternalSourceConfig, label?: string) => void;
}

/** Значение для показа: доли — сотыми, повороты — градусами, флаги — да/нет. */
function formatValue(field: TrackerField, value: number | undefined): string {
  if (value === undefined) return "—";
  if (field.kind === "flag") return value >= 0.5 ? "да" : "нет";
  if (field.group === "arkit") return value.toFixed(2);
  if (field.group === "service") return String(Math.round(value));
  const degrees = /\.r[xyz]$/.test(field.key);
  return degrees ? `${value.toFixed(1)}°` : value.toFixed(2);
}

/** Доля заполнения полоски: у углов диапазон шире, у блендшейпов 0…1. */
function shareOf(field: TrackerField, value: number | undefined): number {
  if (value === undefined) return 0;
  const span = field.max - field.min || 1;
  return Math.max(0, Math.min(1, (value - field.min) / span));
}

export function FaceTrackerEditor(props: FaceTrackerEditorProps) {
  const source = readExternalSource(props.module.config as Record<string, unknown>);
  const info = TRACKER_INFO[props.transport];
  const ports = trackerPorts(source, props.transport);
  const editor = moduleDefinition(props.module.type).editor;
  const gridTemplate = tableTemplate(MAPPING_COLUMNS, editor?.columns ?? {});
  const gridMinWidth = tableMinWidth(MAPPING_COLUMNS, editor?.columns ?? {}, 4, editor?.minWidth);
  // Живая таблица открыта сразу, пока отображение пустое: именно в этот момент
  // она и нужна — иначе непонятно, приходит ли что-нибудь с телефона.
  const [liveOpen, setLiveOpen] = useState(source.mapping.length === 0);
  const [logOpen, setLogOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<string[]>([]);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const patch = (change: Partial<ExternalSourceConfig>, label?: string) => {
    props.onChange({ ...source, ...change }, label);
  };
  const patchRule = (index: number, change: Partial<ExternalSourceRule>, label?: string) => {
    const mapping = source.mapping.map((rule, position) => (position === index ? { ...rule, ...change } : rule));
    patch({ mapping }, label);
  };
  const removeRule = (index: number) => {
    patch({ mapping: source.mapping.filter((_, position) => position !== index) }, "Удаление входа трекера");
  };
  /** Добавление поля: вход получает имя по полю, всё остальное — из каталога. */
  const addField = (field: TrackerField) => {
    if (source.mapping.some((rule) => rule.path === field.path)) return;
    let input = trackerInputName(field);
    let index = 2;
    while (source.mapping.some((rule) => rule.input === input)) {
      input = `${trackerInputName(field)}_${index}`;
      index += 1;
    }
    patch({
      mapping: [...source.mapping, {
        input,
        path: field.path,
        label: field.label,
        kind: field.kind,
        min: field.min,
        max: field.max,
        holdMs: 0,
      }],
    }, `Вход «${field.label}»`);
  };
  /** Строка без поля: выбирается из каталога, поэтому заведомо рабочая. */
  const addRule = () => {
    const field = TRACKER_FIELDS.find((item) => !source.mapping.some((rule) => rule.path === item.path));
    if (field) addField(field);
  };
  const search = async () => {
    setSearching(true);
    try {
      const result = await discoverTrackers(props.transport, ports.port);
      setFound(result.hosts);
      setSearchNote(result.message ?? `нашли: ${result.hosts.join(", ")}`);
    } finally {
      setSearching(false);
    }
  };

  const needle = query.trim().toLowerCase();
  const visible = TRACKER_FIELDS.filter((field) => !needle
    || field.label.toLowerCase().includes(needle)
    || field.key.toLowerCase().includes(needle));

  return (
    <div className="external-editor">
      <div className="external-status">
        <span className={`external-dot ${props.status?.state ?? "idle"}`} />
        <b>{STATUS_LABEL[props.status?.state ?? "idle"]}</b>
        {props.status?.state !== "unsupported" && <span className="muted">{props.status?.packets ?? 0} кадров</span>}
        {props.status?.message && <span className="external-status-message">{props.status.message}</span>}
      </div>

      <p className="module-hint">
        {info.setup}. {info.note}
      </p>

      <div className="module-fields">
        <div className="module-field" title="Адрес телефона в вашей сети. Пусто — рукопожатие идёт широковещательно, а адрес запомнится из первого кадра.">
          <span className="module-field-label">Телефон</span>
          <div className="module-field-value">
            <input
              className="module-field-text"
              value={source.host ?? ""}
              spellCheck={false}
              placeholder="192.168.1.7"
              onChange={(event) => patch({ host: event.target.value.trim() }, "Адрес телефона")}
            />
            <button
              className="button ghost tracker-search"
              onClick={() => void search()}
              disabled={searching || props.status?.state === "unsupported"}
              title="Широковещательный поиск: телефон ответит, если он в той же сети и приложение открыто"
            >
              <Radar size={12} /> {searching ? "ищу…" : "Найти телефон"}
            </button>
          </div>
        </div>

        <div className="module-field" title="Порт приложения на телефоне: iFacialMocap и Facemotion3D слушают 49983, VTube Studio — 21412.">
          <span className="module-field-label">Порт приложения</span>
          <div className="module-field-value">
            <NumberField
              value={ports.port}
              min={1}
              max={65_535}
              step={1}
              integer
              title="Порт приложения на телефоне"
              onCommit={(next) => patch({ port: next }, "Порт приложения трекера")}
            />
          </div>
        </div>

        <div className="module-field" title="Порт, на который приходят кадры. У iFacialMocap он совпадает с портом приложения (49983), у VTube Studio может быть своим.">
          <span className="module-field-label">Порт приёма</span>
          <div className="module-field-value">
            <NumberField
              value={ports.listenPort}
              min={1}
              max={65_535}
              step={1}
              integer
              title="Порт приёма кадров на этом компьютере"
              onCommit={(next) => patch({ listenPort: next }, "Порт приёма трекера")}
            />
          </div>
        </div>
      </div>

      {searchNote && <p className="external-check">{searchNote}</p>}

      {found.length > 0 && (
        <div className="tracker-found">
          <span className="muted">Найдены:</span>
          {found.map((host) => (
            <button
              key={host}
              className="button secondary"
              onClick={() => patch({ host }, "Адрес телефона найден")}
            >
              {host}
            </button>
          ))}
        </div>
      )}

      {props.logs && props.logs.length > 0 && (
        <div className="external-log">
          <button className={`external-log-toggle ${logOpen ? "open" : ""}`} onClick={() => setLogOpen(!logOpen)}>
            <ChevronDown size={11} /> Журнал <b>{props.logs.length}</b>
          </button>
          {logOpen && (
            <ol>
              {props.logs.map((entry, index) => (
                <li className={entry.kind} key={`${entry.at}-${index}`}>
                  <span className="external-log-time">{new Date(entry.at).toLocaleTimeString("ru-RU")}</span>
                  <span className="external-log-text">{entry.text}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <div className="tracker-live">
        <button className={`external-log-toggle ${liveOpen ? "open" : ""}`} onClick={() => setLiveOpen(!liveOpen)}>
          <ChevronDown size={11} /> Живые значения <b>{TRACKER_FIELDS.length}</b>
        </button>
        {liveOpen && (
          <div className="tracker-live-body">
            <input
              className="tracker-live-search"
              value={query}
              spellCheck={false}
              placeholder="поиск поля: рот, глаз, jaw, head"
              onChange={(event) => setQuery(event.target.value)}
            />
            {GROUPS.map((group) => {
              const fields = visible.filter((field) => field.group === group);
              if (fields.length === 0) return null;
              return (
                <div className="tracker-live-group" key={group}>
                  <span className="tracker-live-title">{GROUP_LABEL[group]}</span>
                  {fields.map((field) => {
                    const value = props.preview?.[field.key];
                    const mapped = source.mapping.some((rule) => rule.path === field.path);
                    return (
                      <div className={`tracker-live-row ${mapped ? "mapped" : ""}`} key={field.path}>
                        <span className="tracker-live-label" title={field.path}>{field.label}</span>
                        <span className="tracker-bar">
                          <i style={{ width: `${Math.round(shareOf(field, value) * 100)}%` }} />
                        </span>
                        <span className="tracker-live-value">{formatValue(field, value)}</span>
                        <button
                          className="icon-button"
                          title={mapped ? "Поле уже в отображении" : `Добавить вход «${trackerInputName(field)}»`}
                          disabled={mapped}
                          onClick={() => addField(field)}
                        ><Plus size={12} /></button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="external-mapping">
        {/* Прокрутка внутри блока: таблица не должна уводить панель за край. */}
        <div className="external-mapping-scroll">
          <div
            className="external-mapping-table"
            style={{ minWidth: gridMinWidth, gridTemplateColumns: gridTemplate }}
          >
            <div className="external-mapping-head" style={{ gridTemplateColumns: gridTemplate }}>
              <span>вход</span>
              <span>поле</span>
              <span>подпись</span>
              <span>мин</span>
              <span>макс</span>
              <span>длительность</span>
              <span />
            </div>
            {source.mapping.map((rule, index) => (
              <div className="external-mapping-row" key={`${rule.input}-${index}`} style={{ gridTemplateColumns: gridTemplate }}>
                <input
                  value={rule.input}
                  spellCheck={false}
                  placeholder="jawOpen"
                  title="Имя входа: в скрипте это <модуль>.<вход>"
                  onChange={(event) => patchRule(index, { input: externalInputName(event.target.value) }, "Имя входа трекера")}
                />
                <select
                  value={rule.path}
                  title="Поле кадра: имена общие для всех трёх приложений"
                  onChange={(event) => {
                    const field = trackerField(event.target.value);
                    patchRule(index, field ? { path: field.path, label: field.label, kind: field.kind, min: field.min, max: field.max } : { path: event.target.value });
                  }}
                >
                  {GROUPS.map((group) => (
                    <optgroup label={GROUP_LABEL[group]} key={group}>
                      {TRACKER_FIELDS.filter((field) => field.group === group).map((field) => (
                        <option key={field.path} value={field.path}>{field.label}</option>
                      ))}
                    </optgroup>
                  ))}
                  {!trackerField(rule.path) && <option value={rule.path}>{rule.path}</option>}
                </select>
                <input
                  value={rule.label ?? ""}
                  spellCheck={false}
                  placeholder="Рот"
                  title="Подпись входа в панели"
                  onChange={(event) => patchRule(index, { label: event.target.value || undefined }, "Подпись входа")}
                />
                <NumberField
                  className="mapping-number"
                  value={rule.min ?? 0}
                  step={0.1}
                  title="Нижняя граница значения"
                  onCommit={(next) => patchRule(index, { min: next }, "Нижняя граница")}
                />
                <NumberField
                  className="mapping-number"
                  value={rule.max ?? 1}
                  step={0.1}
                  title="Верхняя граница значения"
                  onCommit={(next) => patchRule(index, { max: next }, "Верхняя граница")}
                />
                <NumberField
                  className="mapping-number"
                  value={rule.holdMs ?? 0}
                  min={0}
                  step={50}
                  integer
                  title="Длительность значения, мс: столько вход помнит число, потом ноль"
                  onCommit={(next) => patchRule(index, { holdMs: next }, "Длительность значения")}
                />
                <button
                  className="icon-button row-action"
                  title="Удалить вход"
                  onClick={() => removeRule(index)}
                ><Trash2 size={12} /></button>
              </div>
            ))}
            {source.mapping.length === 0 && (
              <p className="muted">
                Отображение пустое: модуль пока ничего не передаёт. Нажмите «+» в живых значениях —
                строка появится здесь с готовым полем и именем входа.
              </p>
            )}
          </div>
        </div>
        <button className="button secondary external-add" onClick={addRule} disabled={source.mapping.length >= TRACKER_FIELDS.length}>
          <Plus size={12} /> Добавить вход
        </button>
      </div>
    </div>
  );
}
