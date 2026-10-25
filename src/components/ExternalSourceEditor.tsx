import { Plus, Trash2 } from "lucide-react";
import type { ExternalSourceRule, ExternalSourceConfig, ModuleInstance } from "../types";
import { EXTERNAL_TRANSPORTS, TRANSPORT_INFO, defaultRule, readExternalSource } from "../modules/external";
import type { ExternalStatus } from "../modules/sources";
import { Switch } from "./Switch";

interface ExternalSourceEditorProps {
  module: ModuleInstance;
  /** Состояние соединения: подключён, ждёт, ошибка. */
  status?: ExternalStatus;
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

  return (
    <div className="external-editor">
      <div className="external-status">
        <span className={`external-dot ${status?.state ?? "idle"}`} />
        <b>{STATUS_LABEL[status?.state ?? "idle"]}</b>
        {status?.state === "live" && <span className="muted">{status.packets} пакетов</span>}
        {status?.message && <span className="external-status-message">{status.message}</span>}
      </div>

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
  if (transport === "ws") return "WebSocket работает и в браузере, и в приложении.";
  if (transport === "osc") return "OSC принимает UDP-пакеты из сети; адрес OSC виден как ключ: $[\"/avatar/parameters/HR\"].";
  if (transport === "sse") return "Сервер событий: каждое событие data: приходит одним пакетом.";
  return "Ответ на каждый опрос приходит одним пакетом; пауза настраивается выше.";
}

function pathHint(transport: ExternalSourceConfig["transport"]): string {
  if (transport === "osc") return 'Адрес OSC в кавычках: $["/avatar/parameters/HR"]';
  return "Путь в сообщении: $.value, $.data.bpm, $.items[0].n";
}
