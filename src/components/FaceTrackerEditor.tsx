import { useEffect, useRef, useState } from "react";
import { ChevronDown, Crosshair, Radar } from "lucide-react";
import type { ExternalSourceConfig, ExternalSourceRule, ModuleInstance } from "../types";
import { externalInputName, readExternalSource } from "../modules/external";
import { sourceWithProfile, writeTrackerProfile } from "../modules/trackerProfile";
import {
  TRACKER_FIELDS, TRACKER_INFO, allTrackerFieldsMapped, anyTrackerFieldMapped, calibrationOffsets,
  calibratedValue, clearAllTrackerFields, discoverTrackers, selectAllTrackerFields, trackerField,
  trackerInputName, trackerPorts, trackerRule, uniqueTrackerInput,
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
 *
 * Галочка слева от поля и есть «есть ли такой вход»: отмечено — строка появилась
 * в отображении, снято — вход исчез. Отдельных кнопок «добавить» и «удалить» нет:
 * два места для одного действия путают, а «добавить вход» без поля всё равно
 * добавлял одну и ту же строку.
 */

const MAPPING_COLUMNS: TableColumn[] = [
  { key: "input", width: 62, grow: 1 },
  { key: "path", width: 118, grow: 1.4 },
  { key: "label", width: 64, grow: 1 },
  { key: "min", width: 42 },
  { key: "max", width: 42 },
  { key: "duration", width: 96 },
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

/** «1 поле», «2 поля», «12 полей» — число полей эталона в подписи. */
function fieldCount(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} поле`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} поля`;
  return `${count} полей`;
}

/** Доля заполнения полоски: у углов диапазон шире, у блендшейпов 0…1. */
function shareOf(field: TrackerField, value: number | undefined): number {
  if (value === undefined) return 0;
  const span = field.max - field.min || 1;
  return Math.max(0, Math.min(1, (value - field.min) / span));
}

export function FaceTrackerEditor(props: FaceTrackerEditorProps) {
  // Адрес, порты и эталон приходят из профиля приложения: в риге их нет.
  const source = sourceWithProfile(readExternalSource(props.module.config as Record<string, unknown>));
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
  const allRef = useRef<HTMLInputElement>(null);
  // Что сказать про калибровку: «лицо не найдено» или «эталон снят».
  const [calibrationNote, setCalibrationNote] = useState<string | null>(null);

  /**
   * Правка карточки. Машинные настройки (адрес, порты, эталон) уходят в профиль
   * приложения, остальное — в риг. Копия в пресете нужна только затем, чтобы
   * приёмник перезапустился на новые значения: при записи файла её вырезает
   * `stampPreset`.
   */
  const patch = (change: Partial<ExternalSourceConfig>, label?: string) => {
    const next = { ...source, ...change };
    writeTrackerProfile(props.transport, {
      host: next.host,
      port: next.port,
      listenPort: next.listenPort,
      calibration: next.calibration,
    });
    props.onChange(next, label);
  };
  const patchRule = (index: number, change: Partial<ExternalSourceRule>, label?: string) => {
    const mapping = source.mapping.map((rule, position) => (position === index ? { ...rule, ...change } : rule));
    patch({ mapping }, label);
  };
  /**
   * Галочка у поля: отметить — добавить вход, снять — убрать его вместе со
   * строкой отображения. Имя входа подбирается по полю и не повторяется.
   */
  const toggleField = (field: TrackerField) => {
    const index = source.mapping.findIndex((rule) => rule.path === field.path);
    if (index >= 0) {
      patch({ mapping: source.mapping.filter((_, position) => position !== index) }, "Поле убрано из отображения");
      return;
    }
    const input = uniqueTrackerInput(field, new Set(source.mapping.map((rule) => rule.input)));
    patch({ mapping: [...source.mapping, trackerRule(field, input)] }, `Вход «${field.label}»`);
  };
  /**
   * «Выбрать все» — не отдельная кнопка, а галочка-модификатор: её состояние
   * целиком выводится из подопечных полей. Все отмечены — стоит галочка, часть —
   * промежуточная, ни одного — пусто. Снял одно поле, и «все» тоже погасло;
   * вернул — снова горит. Поэтому состояние нельзя рассинхронизировать с полями.
   */
  const mappedTrackers = TRACKER_FIELDS.filter((field) => source.mapping.some((rule) => rule.path === field.path));
  const allSelected = allTrackerFieldsMapped(source.mapping);
  const someSelected = anyTrackerFieldMapped(source.mapping);

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);

  const toggleAll = () => {
    if (allSelected) {
      // Убираются только поля этого трекера: чужие строки остаются, чтобы
      // «выбрать все» не стирало чужую работу.
      patch({ mapping: clearAllTrackerFields(source.mapping) }, "Все поля убраны из отображения");
      return;
    }
    patch({ mapping: selectAllTrackerFields(source.mapping) }, "Все поля добавлены в отображение");
  };

  /**
   * Эталон позы телефона — «здесь и сейчас».
   *
   * Берётся текущий кадр: голова и глаза становятся нулём, мимика остаётся как
   * есть. Пустой кадр или «лицо не найдено» эталон не пишут: иначе в пресет
   * ушли бы нули, а персонаж «выпрямился» бы по случайности.
   */
  const calibrate = () => {
    const frame = props.preview;
    if (!frame || Object.keys(frame).length === 0) {
      setCalibrationNote("кадров ещё нет: телефон не прислал ни одного кадра");
      return;
    }
    if (frame.faceFound !== undefined && frame.faceFound < 0.5) {
      setCalibrationNote("лицо не найдено: телефон не видит лицо, эталон не снят");
      return;
    }
    const offsets = calibrationOffsets(frame);
    if (Object.keys(offsets).length === 0) {
      setCalibrationNote("в кадре нет головы и глаз: калибровать нечего");
      return;
    }
    patch({ calibration: { at: Date.now(), offsets } }, "Калибровка трекера");
    setCalibrationNote(`эталон снят: ${fieldCount(Object.keys(offsets).length)}`);
  };

  const resetCalibration = () => {
    patch({ calibration: undefined }, "Калибровка трекера сброшена");
    setCalibrationNote(null);
  };

  const calibration = source.calibration;
  const offsets = calibration?.offsets ?? {};
  /** Подпись под кнопками: когда снят эталон и что именно он вычитает. */
  const calibrationState = calibration
    ? `эталон ${new Date(calibration.at).toLocaleTimeString("ru-RU")} · ${fieldCount(Object.keys(calibration.offsets).length)}`
    : "не задан: значения идут как есть";

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
        {/* Частота потока: по ней видно, 60 кадров идёт или 12 — и есть ли смысл
            искать узкое место в сети или в самом приложении. */}
        {props.status?.state !== "unsupported" && (
          <span className="muted tracker-rate" title="Сколько кадров приходит в секунду (окно — одна секунда)">
            {props.status?.rate ?? 0} кадров/с
          </span>
        )}
        {props.status?.packets ? <span className="muted">всего {props.status.packets}</span> : null}
        {props.status?.message && <span className="external-status-message">{props.status.message}</span>}
      </div>

      <p className="module-hint">
        {info.setup}. {info.note}
      </p>

      <div className="module-fields">
        <div className="module-field" title="Адрес телефона в вашей сети. Пусто — рукопожатие идёт широковещательно, а адрес запомнится из первого кадра. Адрес хранится в профиле приложения и в файл рига не попадает.">
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

      {/* Риг переносят на другую машину, а телефон остаётся в своей сети: адрес,
          порты и эталон — настройки этой машины, не сцены. */}
      <p className="module-hint">
        Адрес телефона, порты и эталон позы хранятся в профиле приложения:
        риг переносится на другой компьютер без них.
      </p>

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

      {/* Положение телефона: телефон может лежать как угодно — персонаж должен
          стоять ровно. Эталон снимается текущим кадром и живёт в профиле
          приложения: оно у стола своё, а риг переносят. */}
      <div className="tracker-calibration">
        <div className="tracker-calibration-head">
          <span className="module-field-label">Положение телефона</span>
          <span className="muted">{calibrationState}</span>
        </div>
        <div className="tracker-calibration-actions">
          <button
            className="button ghost"
            onClick={calibrate}
            title="Текущее положение телефона станет нулём: голова и глаза будут вычитаться из кадров"
          >
            <Crosshair size={12} /> Откалибровать
          </button>
          <button
            className="button ghost"
            onClick={resetCalibration}
            disabled={!calibration}
            title="Забыть эталон: значения пойдут так, как их присылает телефон"
          >
            Сбросить
          </button>
          {calibrationNote && <span className="external-check">{calibrationNote}</span>}
        </div>
        <p className="module-hint">
          Держите голову прямо и смотрите в телефон, когда нажимаете «Откалибровать».
          Эталон вычитается из головы и глаз; мимика приходит как есть и от положения
          телефона не зависит.
        </p>
      </div>

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
            <div className="tracker-live-toolbar">
              <input
                className="tracker-live-search"
                value={query}
                spellCheck={false}
                placeholder="поиск: рот, глаз, jaw…"
                onChange={(event) => setQuery(event.target.value)}
              />
              <label className="tracker-select-all" title="Отметить все 66 полей или снять все">
                <input
                  type="checkbox"
                  className="tracker-check"
                  ref={allRef}
                  checked={allSelected}
                  onChange={toggleAll}
                />
                Выбрать все
              </label>
              <span className="tracker-count">
                {mappedTrackers.length} из {TRACKER_FIELDS.length}
              </span>
            </div>
            {/* Две колонки чисел появляются только с эталоном: без него показывать
                одно и то же дважды незачем. */}
            {calibration && (
              <div className="tracker-live-head">
                <span />
                <span>поле</span>
                <span />
                <span title="Что прислал телефон">телефон</span>
                <span title="Что получил персонаж после вычитания эталона">персонаж</span>
              </div>
            )}
            {GROUPS.map((group) => {
              const fields = visible.filter((field) => field.group === group);
              if (fields.length === 0) return null;
              return (
                <div className="tracker-live-group" key={group}>
                  <span className="tracker-live-title">{GROUP_LABEL[group]}</span>
                  {fields.map((field) => {
                    const value = props.preview?.[field.key];
                    const offset = offsets[field.key];
                    const shown = calibratedValue(value, offset);
                    const mapped = source.mapping.some((rule) => rule.path === field.path);
                    return (
                      <div
                        className={`tracker-live-row ${mapped ? "mapped" : ""} ${calibration ? "calibrated" : ""}`}
                        key={field.path}
                      >
                        <input
                          type="checkbox"
                          className="tracker-check"
                          checked={mapped}
                          title={mapped ? "Убрать вход из отображения" : `Добавить вход «${trackerInputName(field)}»`}
                          onChange={() => toggleField(field)}
                        />
                        {/* Точки-выноска — часть подписи, а не отдельная колонка:
                            иначе они начинались бы от невидимой границы колонки, а
                            не от конца самого текста. */}
                        <span className="tracker-live-label" title={field.path}>
                          <span className="tracker-live-text">{field.label}</span>
                        </span>
                        <span className="tracker-bar">
                          <i style={{ width: `${Math.round(shareOf(field, shown) * 100)}%` }} />
                        </span>
                        {calibration && (
                          <span className="tracker-live-raw" title="Что прислал телефон">
                            {offset === undefined ? "" : formatValue(field, value)}
                          </span>
                        )}
                        <span className="tracker-live-value" title={offset === undefined ? undefined : "Что получил персонаж"}>
                          {formatValue(field, shown)}
                        </span>
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
            </div>
            {source.mapping.map((rule, index) => (
              <div className="external-mapping-row" key={`${rule.input}-${index}`} style={{ gridTemplateColumns: gridTemplate }}>
                <input
                  value={rule.input}
                  spellCheck={false}
                  placeholder="jawopen"
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
              </div>
            ))}
            {source.mapping.length === 0 && (
              <p className="muted">
                Отображение пустое: модуль пока ничего не передаёт. Отметьте галочкой нужные поля
                в живых значениях — строки появятся здесь с готовым путём и именем входа.
              </p>
            )}
          </div>
        </div>
        <p className="module-hint">
          Галочка у поля в живых значениях добавляет и убирает вход. Здесь правятся имя,
          подпись, границы и длительность; убрать строку — снять галочку у её поля.
        </p>
      </div>
    </div>
  );
}
