import { useState } from "react";
import { Activity, ChevronDown, Plus, Trash2 } from "lucide-react";
import type { ExternalSourceRule, ExternalSourceConfig, ModuleInstance } from "../types";
import { EXTERNAL_TRANSPORTS, TRANSPORT_INFO, defaultRule, externalInputName, readExternalSource } from "../modules/external";
import {
  TWITCH_EVENTS, TWITCH_VERIFY, commandRule, eventRule, rewardRule, selectedEvents,
  twitchCommands, twitchRewards,
} from "../modules/twitch";
import type { ExternalLogEntry, ExternalStatus } from "../modules/sources";
import { Switch } from "./Switch";

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
 * и есть детальная настройка: у каждой строки своя подпись, границы, множитель,
 * смещение и удержание импульса. Входы модуля появляются ровно из этих строк,
 * поэтому ручного кода для новой интеграции не нужно.
 */
export function ExternalSourceEditor(props: ExternalSourceEditorProps) {
  const source = readExternalSource(props.module.config as Record<string, unknown>);
  const status = props.status;
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
            <div className="module-field" title="Client ID приложения Twitch (dev.twitch.tv). Это не секрет: он едет вместе с пресетом.">
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
              <input
                className="module-field-number"
                type="number"
                min={100}
                max={600000}
                step={100}
                value={source.intervalMs ?? 1000}
                onChange={(event) => patch({ intervalMs: Math.min(600_000, Math.max(100, Number(event.target.value) || 1000)) }, "Пауза опроса")}
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
                <a href={status.twitch.verificationUri || TWITCH_VERIFY} target="_blank" rel="noreferrer">
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
              Команда даёт флаг на 3 с, награда — на 5 с. Текст сообщения виден во «Входах», в формулы он не идёт.
            </p>
          </div>
        </div>
      )}

      <p className="module-hint external-hint">{transportHint(source.transport)}</p>

      <div className="external-mapping">
        <div className="external-mapping-head">
          <span>вход</span>
          <span>поле JSON</span>
          <span>подпись</span>
          <span>мин</span>
          <span>макс</span>
          <span>×</span>
          <span>+</span>
          <span>импульс</span>
          <span />
        </div>
        {source.mapping.map((rule, index) => (
          <div className="external-mapping-row" key={`${rule.input}-${index}`}>
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
            <input
              type="number"
              value={rule.min ?? 0}
              title="Нижняя граница значения"
              onChange={(event) => patchRule(index, { min: Number(event.target.value) }, "Нижняя граница")}
            />
            <input
              type="number"
              value={rule.max ?? 1}
              title="Верхняя граница значения"
              onChange={(event) => patchRule(index, { max: Number(event.target.value) }, "Верхняя граница")}
            />
            <input
              type="number"
              step={0.1}
              value={rule.scale ?? 1}
              title="Множитель: применяется до смещения"
              onChange={(event) => patchRule(index, { scale: Number(event.target.value) }, "Множитель")}
            />
            <input
              type="number"
              step={0.1}
              value={rule.offset ?? 0}
              title="Смещение: прибавляется после множителя"
              onChange={(event) => patchRule(index, { offset: Number(event.target.value) }, "Смещение")}
            />
            <input
              type="number"
              min={0}
              step={50}
              value={rule.holdMs ?? 0}
              title="Удержание импульса, мс: событие живёт это время, потом гаснет"
              onChange={(event) => patchRule(index, { holdMs: Math.max(0, Number(event.target.value)) }, "Удержание импульса")}
            />
            <button className="icon-button" title="Удалить вход" onClick={() => removeRule(index)}><Trash2 size={12} /></button>
          </div>
        ))}
        {source.mapping.length === 0 && (
          <p className="muted">Таблица пуста: модуль использует входы шаблона. Добавьте строку — появится свой вход.</p>
        )}
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
