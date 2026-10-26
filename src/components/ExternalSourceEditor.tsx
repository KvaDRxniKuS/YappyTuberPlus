import { useState } from "react";
import { Activity, ChevronDown, Plus, Trash2 } from "lucide-react";
import type { ExternalSourceRule, ExternalSourceConfig, ModuleInstance } from "../types";
import {
  EXTERNAL_TRANSPORTS, TEXT_HISTORY_DEFAULT, TEXT_HISTORY_MAX, TEXT_HISTORY_MIN,
  TEXT_RETAIN_DEFAULT, TEXT_RETAIN_MAX, TEXT_RETAIN_MIN, TRANSPORT_INFO,
  defaultRule, externalInputName, readExternalSource,
} from "../modules/external";
import {
  TWITCH_APPS, TWITCH_EVENTS, TWITCH_VERIFY, commandRule, eventRule, rewardRule, selectedEvents,
  twitchCommands, twitchRewards,
} from "../modules/twitch";
import { openExternal } from "../engine/links";
import type { ExternalLogEntry, ExternalStatus } from "../modules/sources";
import { Switch } from "./Switch";
import { NumberField } from "./NumberField";
import { moduleDefinition } from "../modules/registry";
import { tableMinWidth, tableTemplate, type TableColumn } from "./tableLayout";

/**
 * Роли колонок таблицы отображения. Ширины по умолчанию — нижняя граница:
 * шаблон модуля может их увеличить (`editor.columns`), но не сделать уже 24 px.
 * «Поле JSON» и подпись тянутся, числа — фиксированные: им больше не нужно.
 */
const MAPPING_COLUMNS: TableColumn[] = [
  { key: "input", width: 62, grow: 1 },
  { key: "path", width: 104, grow: 1.6 },
  { key: "label", width: 64, grow: 1 },
  { key: "min", width: 42 },
  { key: "max", width: 42 },
  { key: "duration", width: 96 },
  { key: "action", width: 26 },
];

interface ExternalSourceEditorProps {
  module: ModuleInstance;
  /** Состояние соединения: подключён, ждёт, ошибка. */
  status?: ExternalStatus;
  /** Вход в Twitch: показывает код и страницу активации. */
  onAuthorize?: () => void;
  /** Забыть токен Twitch. */
  onSignOut?: () => void;
  /** Последние строки журнала: что пришло и что не разобралось. */
  logs?: ExternalLogEntry[];
  /** Проверка соединения по кнопке. */
  onProbe?: () => Promise<string>;
  onChange: (source: ExternalSourceConfig, label?: string) => void;
}

const STATUS_LABEL: Record<ExternalStatus["state"], string> = {
  idle: "не запущен",
  connecting: "подключаюсь",
  live: "подключён",
  error: "нет связи",
  unsupported: "только в приложении",
};

/**
 * Редактор внешнего источника.
 *
 * Сверху — куда подключаться, снизу — таблица «поле JSON → вход модуля». Таблица
 * и есть детальная настройка: у каждой строки своя подпись, границы и
 * длительность значения. Входы модуля появляются ровно из этих строк, поэтому
 * ручного кода для новой интеграции не нужно.
 */
export function ExternalSourceEditor(props: ExternalSourceEditorProps) {
  const source = readExternalSource(props.module.config as Record<string, unknown>);
  const status = props.status;
  // Минимальные ширины колонок задаёт шаблон модуля: у Twitch поле JSON
  // длинное, у пульсометра короткое, и одна общая сетка тут не подходит.
  const editor = moduleDefinition(props.module.type).editor;
  const columns = editor?.columns ?? {};
  const gridTemplate = tableTemplate(MAPPING_COLUMNS, columns);
  const gridMinWidth = tableMinWidth(MAPPING_COLUMNS, columns, 4, editor?.minWidth);
  // Результат проверки живёт здесь: он не часть пресета и не должен в него попадать.
  const [check, setCheck] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  // Поля ввода для новых команды и награды: до нажатия Enter они никуда не пишутся.
  const [commandDraft, setCommandDraft] = useState("");
  const [rewardDraft, setRewardDraft] = useState("");
  const runProbe = async () => {
    if (!props.onProbe) return;
    setChecking(true);
    try {
      setCheck(await props.onProbe());
    } finally {
      setChecking(false);
    }
  };
  const info = TRANSPORT_INFO[source.transport];
  // Текст источника (чат) настраивается, только если он вообще собирается.
  const text = source.text;
  const patch = (change: Partial<ExternalSourceConfig>, label?: string) => {
    props.onChange({ ...source, ...change }, label);
  };
  const patchRule = (index: number, change: Partial<ExternalSourceRule>, label?: string) => {
    const mapping = source.mapping.map((rule, position) => (position === index ? { ...rule, ...change } : rule));
    patch({ mapping }, label);
  };
  const removeRule = (index: number) => {
    patch({ mapping: source.mapping.filter((_, position) => position !== index) }, "Удаление входа источника");
  };
  /** Twitch: включение события добавляет его строку в таблицу, снятие — убирает. */
  const toggleEvent = (type: string, on: boolean) => {
    if (!on) {
      patch({ mapping: source.mapping.filter((rule) => rule.event !== type) }, "Событие Twitch выключено");
      return;
    }
    const spec = TWITCH_EVENTS.find((item) => item.type === type);
    if (!spec) return;
    // Такой вход мог остаться от прошлой настройки — заменяем, а не дублируем.
    const mapping = source.mapping.filter((rule) => rule.input !== spec.rule.input);
    patch({ mapping: [...mapping, eventRule(spec)] }, "Событие Twitch включено");
  };
  const addRule = () => {
    // Имя входа должно быть свободно: дубль молча съел бы строку.
    let name = "value";
    let index = 2;
    while (source.mapping.some((rule) => rule.input === name)) {
      name = `value_${index}`;
      index += 1;
    }
    patch({ mapping: [...source.mapping, defaultRule(name, "$.value")] }, "Новый вход источника");
  };

  /** Команда чата: строка правила заводится сразу, вместе с условием «содержит !имя». */
  const addCommand = () => {
    const name = commandDraft.trim().replace(/^!/, "");
    if (!name) return;
    const rule = commandRule(name);
    if (source.mapping.some((item) => item.input === rule.input)) {
      setCommandDraft("");
      return;
    }
    patch({ mapping: [...source.mapping, rule] }, "Добавлена команда чата");
    setCommandDraft("");
  };

  const addReward = () => {
    const title = rewardDraft.trim();
    if (!title) return;
    const rule = rewardRule(title);
    if (source.mapping.some((item) => item.input === rule.input)) {
      setRewardDraft("");
      return;
    }
    patch({ mapping: [...source.mapping, rule] }, "Добавлена награда по имени");
    setRewardDraft("");
  };

  return (
    <div className="external-editor">
      <div className="external-status">
        <span className={`external-dot ${status?.state ?? "idle"}`} />
        <b>{STATUS_LABEL[status?.state ?? "idle"]}</b>
        {status?.state === "live" && <span className="muted">{status.packets} пакетов</span>}
        {status?.message && <span className="external-status-message">{status.message}</span>}
        {props.onProbe && (
          <button
            className="button ghost external-probe"
            onClick={() => void runProbe()}
            disabled={checking}
            title="Проверить адрес, не меняя работу источника"
          >
            <Activity size={11} /> {checking ? "…" : "Проверить"}
          </button>
        )}
      </div>

      {check && <p className={`external-check ${/не |нет |ошиб|занят|неверн/i.test(check) ? "bad" : "ok"}`}>{check}</p>}

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

      <div className="module-fields">
        <div className="module-field" title="Как соединяться с источником: WebSocket работает и в браузере, остальные транспорты — только в приложении.">
          <span className="module-field-label">Транспорт</span>
          <div className="module-field-value">
            <select
              value={source.transport}
              onChange={(event) => patch({ transport: event.target.value as ExternalSourceConfig["transport"] }, "Транспорт источника")}
            >
              {EXTERNAL_TRANSPORTS.map((transport) => (
                <option key={transport} value={transport}>{TRANSPORT_INFO[transport].label}</option>
              ))}
            </select>
          </div>
        </div>

        {source.transport === "twitch" ? (
          <>
            <div className="module-field" title="Client ID приложения Twitch: консоль разработчика → Applications → Manage. Это не секрет: он едет вместе с пресетом.">
              <span className="module-field-label">Client ID</span>
              <div className="module-field-value">
                <input
                  className="module-field-text"
                  value={source.clientId ?? ""}
                  spellCheck={false}
                  placeholder="abcdef123456…"
                  onChange={(event) => patch({ clientId: event.target.value.trim() || undefined }, "Client ID Twitch")}
                />
              </div>
            </div>
            <div className="module-field" title="Логин канала, за событиями которого следим: имя из адреса twitch.tv/имя.">
              <span className="module-field-label">Канал</span>
              <div className="module-field-value">
                <input
                  className="module-field-text"
                  value={source.channel ?? ""}
                  spellCheck={false}
                  placeholder="yappy"
                  onChange={(event) => patch({ channel: event.target.value.trim() || undefined }, "Канал Twitch")}
                />
              </div>
            </div>
            {/* Адрес консоли раньше жил только в документации: поле Client ID
                просило строку, а где её взять — знал лишь README. Ссылка стоит
                рядом с полем и открывается в браузере, а не в окне студии. */}
            <p className="module-hint">
              Где взять Client ID:{" "}
              <button
                type="button"
                className="link-button"
                title={TWITCH_APPS}
                onClick={() => void openExternal(TWITCH_APPS)}
              >
                dev.twitch.tv/console/apps
              </button>
              {" "}→ Applications → Manage. Тип приложения — <b>Public</b>, Client Secret не нужен.
            </p>
          </>
        ) : (
          <div className="module-field" title={info.placeholder}>
            <span className="module-field-label">Адрес</span>
            <div className="module-field-value">
              <input
                className="module-field-text"
                value={source.url}
                spellCheck={false}
                placeholder={info.placeholder}
                onChange={(event) => patch({ url: event.target.value }, "Адрес источника")}
              />
            </div>
          </div>
        )}

        {source.transport === "http" && (
          <div className="module-field" title="Как часто опрашивать адрес: 100…600000 мс.">
            <span className="module-field-label">Опрос</span>
            <div className="module-field-value">
              <NumberField
                className="module-field-number"
                value={source.intervalMs ?? 1000}
                min={100}
                max={600000}
                step={100}
                integer
                title="Пауза опроса, мс: 100…600000"
                onCommit={(next) => patch({ intervalMs: next }, "Пауза опроса")}
              />
            </div>
          </div>
        )}

        {source.transport === "ws" && (
          <div className="module-field" title="Сообщение сразу после подключения: подписка или авторизация (JSON-строка).">
            <span className="module-field-label">Подписка</span>
            <div className="module-field-value">
              <input
                className="module-field-text"
                value={source.subscribe ?? ""}
                spellCheck={false}
                placeholder='{"type":"subscribe","channel":"hr"}'
                onChange={(event) => patch({ subscribe: event.target.value.trim() ? event.target.value : undefined }, "Подписка источника")}
              />
            </div>
          </div>
        )}

        {/* Текст источника: чат. Раньше путь и автор были только в шаблоне
            модуля, и «последние сообщения» нельзя было ни настроить, ни
            прочитать из скрипта. */}
        {text && (
          <>
            <div className="module-field" title="Путь к тексту в сообщении источника: $.payload.event.message.text">
              <span className="module-field-label">Текст</span>
              <div className="module-field-value">
                <input
                  className="module-field-text"
                  value={text.path}
                  spellCheck={false}
                  placeholder="$.payload.event.message.text"
                  onChange={(event) => patch({ text: { ...text, path: event.target.value } }, "Путь текста")}
                />
              </div>
            </div>
            <div className="module-field" title="Путь к имени автора: $.payload.event.chatter_user_name">
              <span className="module-field-label">Автор</span>
              <div className="module-field-value">
                <input
                  className="module-field-text"
                  value={text.authorPath ?? ""}
                  spellCheck={false}
                  placeholder="$.payload.event.chatter_user_name"
                  onChange={(event) => patch({ text: { ...text, authorPath: event.target.value || undefined } }, "Путь автора")}
                />
              </div>
            </div>
            <div className="module-field" title="Вход, к которому относится текст: в скрипте это twitch.chat.message(-1)">
              <span className="module-field-label">Вход текста</span>
              <div className="module-field-value">
                <select
                  value={text.input ?? source.mapping.find((rule) => rule.count)?.input ?? source.mapping[0]?.input ?? ""}
                  onChange={(event) => patch({ text: { ...text, input: event.target.value || undefined } }, "Вход текста")}
                >
                  {source.mapping.map((rule) => (
                    <option key={rule.input} value={rule.input}>{rule.input}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="module-field" title="Сколько последних строк держать: столько же видно в панели и в скрипте">
              <span className="module-field-label">Хранить</span>
              <div className="module-field-value">
                <NumberField
                  className="module-field-number"
                  value={text.history ?? TEXT_HISTORY_DEFAULT}
                  min={TEXT_HISTORY_MIN}
                  max={TEXT_HISTORY_MAX}
                  step={1}
                  integer
                  title={`Сколько сообщений помним: ${TEXT_HISTORY_MIN}…${TEXT_HISTORY_MAX}`}
                  onCommit={(next) => patch({ text: { ...text, history: next } }, "История сообщений")}
                />
              </div>
            </div>
            <div className="module-field" title="Срок хранения сообщения: через столько секунд строка пропадает. 0 — не ограничивать по времени">
              <span className="module-field-label">Хранить, с</span>
              <div className="module-field-value">
                <NumberField
                  className="module-field-number"
                  value={text.retainSeconds ?? TEXT_RETAIN_DEFAULT}
                  min={TEXT_RETAIN_MIN}
                  max={TEXT_RETAIN_MAX}
                  step={1}
                  integer
                  title={`Секунды хранения: ${TEXT_RETAIN_MIN}…${TEXT_RETAIN_MAX}, 0 — только по количеству`}
                  onCommit={(next) => patch({ text: { ...text, retainSeconds: next } }, "Срок хранения сообщений")}
                />
              </div>
            </div>
            <div className="module-field" title="Показывать автора рядом с текстом в панели «Входы»">
              <span className="module-field-label">Автор в панели</span>
              <div className="module-field-value">
                <div className="module-field-flag">
                  <Switch
                    checked={text.showAuthor !== false}
                    onChange={(next) => patch({ text: { ...text, showAuthor: next } }, "Автор в панели")}
                    title="Показывать автора сообщения"
                  />
                  <span>{text.showAuthor !== false ? "да" : "нет"}</span>
                </div>
              </div>
            </div>
          </>
        )}

        <div className="module-field" title="Переподключаться при обрыве: значения на время обрыва обнуляются.">
          <span className="module-field-label">Переподключение</span>
          <div className="module-field-value">
            <div className="module-field-flag">
              <Switch
                checked={source.reconnect !== false}
                onChange={(next) => patch({ reconnect: next }, "Переподключение")}
                title="Переподключаться при обрыве"
              />
              <span>{source.reconnect !== false ? "да" : "нет"}</span>
            </div>
          </div>
        </div>
      </div>

      {source.transport === "twitch" && (
        <div className="twitch-panel">
          <div className="twitch-auth">
            {status?.twitch?.state === "authorizing" && status.twitch.userCode ? (
              <div className="twitch-code">
                <span className="muted">Код для входа:</span>
                <b>{status.twitch.userCode}</b>
                <a
                  href={status.twitch.verificationUri || TWITCH_VERIFY}
                  title="Открыть страницу активации в браузере"
                  onClick={(event) => {
                    // Ссылка открывается системным браузером: навигация внутри
                    // вебвью увела бы окно студии на twitch.tv.
                    event.preventDefault();
                    void openExternal(status.twitch?.verificationUri || TWITCH_VERIFY);
                  }}
                >
                  {status.twitch.verificationUri || TWITCH_VERIFY}
                </a>
              </div>
            ) : (
              <div className="twitch-buttons">
                <button className="button secondary" onClick={() => props.onAuthorize?.()} disabled={!props.onAuthorize || !source.clientId}>
                  Войти в Twitch
                </button>
                <button className="button ghost" onClick={() => props.onSignOut?.()} disabled={!props.onSignOut}>
                  Выйти
                </button>
                {status?.twitch?.login && <span className="muted">вошли как {status.twitch.login}</span>}
              </div>
            )}
          </div>

          <div className="twitch-events">
            <span className="twitch-events-title">События</span>
            {TWITCH_EVENTS.map((spec) => {
              const on = selectedEvents(source).some((item) => item.type === spec.type);
              return (
                <label className="twitch-event" key={spec.type} title={`${spec.type} · право ${spec.scope || "не требуется"}`}>
                  <Switch checked={on} onChange={(next) => toggleEvent(spec.type, next)} title={spec.label} />
                  <span>{spec.label}</span>
                  <code>{spec.rule.input}</code>
                </label>
              );
            })}
          </div>

          <div className="twitch-events">
            <span className="twitch-events-title">Команды чата</span>
            {twitchCommands(source).map((name) => (
              <div className="twitch-line" key={`cmd-${name}`}>
                <code>!{name}</code>
                <span className="muted">→ {`cmd_${externalInputName(name)}`}</span>
                <button
                  className="icon-button"
                  title="Убрать команду"
                  onClick={() => patch({ mapping: source.mapping.filter((rule) => rule.input !== `cmd_${externalInputName(name)}`) }, "Команда удалена")}
                ><Trash2 size={12} /></button>
              </div>
            ))}
            <div className="twitch-add">
              <input
                value={commandDraft}
                spellCheck={false}
                placeholder="dance"
                title="Имя команды без «!»: станет входом cmd_dance"
                onChange={(event) => setCommandDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") addCommand(); }}
              />
              <button className="button secondary" onClick={addCommand} disabled={!commandDraft.trim()}><Plus size={12} /></button>
            </div>

            <span className="twitch-events-title">Награды по именам</span>
            {twitchRewards(source).map((title) => (
              <div className="twitch-line" key={`reward-${title}`}>
                <span>{title}</span>
                <span className="muted">→ {`redeem_${externalInputName(title)}`}</span>
                <button
                  className="icon-button"
                  title="Убрать награду"
                  onClick={() => patch({ mapping: source.mapping.filter((rule) => !(rule.input === `redeem_${externalInputName(title)}` && rule.when?.equals === title)) }, "Награда удалена")}
                ><Trash2 size={12} /></button>
              </div>
            ))}
            <div className="twitch-add">
              <input
                value={rewardDraft}
                spellCheck={false}
                placeholder="Смена аватара"
                title="Название награды ровно как в Twitch: станет входом redeem_…"
                onChange={(event) => setRewardDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") addReward(); }}
              />
              <button className="button secondary" onClick={addReward} disabled={!rewardDraft.trim()}><Plus size={12} /></button>
            </div>
            <p className="module-hint">
              Команда даёт флаг на 3 с, награда — на 5 с. Текст сообщения читается в скрипте:
              <code> twitch.chat.message(0)</code> — последнее, <code>(-1)</code> — предыдущее.
            </p>
          </div>
        </div>
      )}

      <p className="module-hint external-hint">{transportHint(source.transport)}</p>

      <div className="external-mapping">
        {/* Прокрутка живёт внутри блока: сузили панель — листается таблица,
            а не уезжает вся вкладка и не пропадают поля за краем экрана. */}
        <div className="external-mapping-scroll">
        <div
          className="external-mapping-table"
          style={{ minWidth: gridMinWidth, gridTemplateColumns: gridTemplate }}
        >
        <div className="external-mapping-head" style={{ gridTemplateColumns: gridTemplate }}>
          <span>вход</span>
          <span>поле JSON</span>
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
              placeholder="hr"
              title="Имя входа: в скрипте это <модуль>.<вход>"
              onChange={(event) => patchRule(index, { input: event.target.value }, "Имя входа источника")}
            />
            <input
              value={rule.path}
              spellCheck={false}
              placeholder="$.heart_rate"
              title={pathHint(source.transport)}
              onChange={(event) => patchRule(index, { path: event.target.value }, "Поле источника")}
            />
            <input
              value={rule.label ?? ""}
              spellCheck={false}
              placeholder="Пульс"
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
              title="Длительность значения, мс: столько вход помнит пришедшее число, потом ноль. Нужно событиям: «пришла награда» — это один пакет, а не постоянный уровень"
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
          <p className="muted">Таблица пуста: модуль использует входы шаблона. Добавьте строку — появится свой вход.</p>
        )}
        </div>
        </div>
        <button className="button secondary external-add" onClick={addRule}><Plus size={12} /> Добавить вход</button>
      </div>
    </div>
  );
}

function transportHint(transport: ExternalSourceConfig["transport"]): string {
  if (transport === "twitch") {
    return "Вход по коду: Twitch покажет страницу активации. Токен хранится в профиле окна, а не в пресете.";
  }
  if (transport === "ws") return "WebSocket работает и в браузере, и в приложении.";
  if (transport === "osc") return "OSC принимает UDP-пакеты из сети; адрес OSC виден как ключ: $[\"/avatar/parameters/HR\"].";
  if (transport === "sse") return "Сервер событий: каждое событие data: приходит одним пакетом.";
  return "Ответ на каждый опрос приходит одним пакетом; пауза настраивается выше.";
}

function pathHint(transport: ExternalSourceConfig["transport"]): string {
  if (transport === "twitch") return "Поле события EventSub: $.payload.event.reward.cost";
  if (transport === "osc") return 'Адрес OSC в кавычках: $["/avatar/parameters/HR"]';
  return "Путь в сообщении: $.value, $.data.bpm, $.items[0].n";
}
