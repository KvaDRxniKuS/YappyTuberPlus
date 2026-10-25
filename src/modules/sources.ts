import type { ExternalSourceConfig, ExternalSourceRule, ModuleInstance } from "../types";
import { applyMapping, isNativeTransport, isTwitchTransport, readExternalSource, readPath, ruleMatches } from "./external";
import { isTauri } from "../engine/presetFile";
import { TwitchChannel, type TwitchInfo, type TwitchState } from "./twitch";

/**
 * Хост внешних источников.
 *
 * Задача одна: превратить настройки модулей в живые числа. Транспорт при этом
 * разный, но правила отображения — общие, поэтому пресет не зависит от того,
 * как именно пришли данные.
 *
 * - `ws` держит само окно: WebSocket не подчиняется CORS и работает и в браузере,
 *   и в нативном окне.
 * - `http`, `sse`, `osc` выполняет Rust (`src-tauri/src/sources.rs`) и присылает
 *   в окно событие `yappy://source` с сырым текстом пакета. В браузере этих
 *   транспортов нет: там честный статус «только в приложении», а не тишина.
 *
 * Значения не толкаются в React на каждый пакет: хост складывает их у себя, а
 * окно забирает раз в тик — так поток 60–120 пакетов в секунду не превращается
 * в поток перерисовок.
 */

export type ExternalState = "idle" | "connecting" | "live" | "error" | "unsupported";

/** Строка журнала источника: что пришло, что не разобралось, что сломалось. */
export interface ExternalLogEntry {
  at: number;
  kind: "packet" | "warn" | "error";
  text: string;
}

export interface ExternalStatus {
  state: ExternalState;
  message: string | null;
  /** Сколько пакетов пришло с момента подключения: видно, что канал живой. */
  packets: number;
  /** Twitch: своё состояние, код входа и имя канала. */
  twitch?: TwitchInfo;
}

interface Hold {
  value: number;
  until: number;
}

interface Entry {
  source: ExternalSourceConfig;
  key: string;
  socket: WebSocket | null;
  status: ExternalStatus;
  values: Record<string, number>;
  holds: Record<string, Hold>;
  retry: ReturnType<typeof setTimeout> | null;
  attempts: number;
  closed: boolean;
  /** Транспорт живёт в Rust: останавливать его нужно командой, а не close(). */
  native: boolean;
  /** Twitch: свой канал с OAuth и подписками вместо обычного сокета. */
  twitch?: TwitchChannel;
  /** Последние события источника: пакеты, предупреждения, ошибки. */
  log: ExternalLogEntry[];
  /** Счётчики: `chat` растёт с каждым сообщением, а не читается из поля. */
  counters: Record<string, number>;
  /** Последние тексты (чат): только для показа, в кадр не идут. */
  texts: ExternalTextLine[];
}

/** Событие из Rust: состояние источника или сырой текст пакета. */
type NativePayload =
  | { kind: "state"; name: string; state: ExternalState; message?: string | null }
  | { kind: "text"; name: string; text: string };

const NATIVE_EVENT = "yappy://source";
/** Сколько строк журнала держим на источник: больше в карточке не прочитать. */
export const LOG_LIMIT = 20;
/** Сколько сообщений чата помним для показа в панели «Входы». */
export const TEXT_LIMIT = 12;

/** Строка текста из источника: чат, текст награды. В формулы не попадает. */
export interface ExternalTextLine {
  at: number;
  author?: string;
  text: string;
}
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 8000;

function emptyStatus(state: ExternalState = "idle", message: string | null = null): ExternalStatus {
  return { state, message, packets: 0 };
}

/** Команда Rust: запуск и остановка источника. */
async function invokeSource(command: string, args: Record<string, unknown>): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke(command, args);
}

export class ExternalSourceHost {
  private entries = new Map<string, Entry>();
  private unlisten: (() => void) | null = null;
  private listener: Promise<boolean> | null = null;

  /**
   * Приводит соединения к желаемому списку: новые открывает, изменившиеся
   * перезапускает, лишние закрывает. Вызывается при любом изменении модулей.
   */
  sync(desired: Array<{ name: string; source: ExternalSourceConfig }>): void {
    const seen = new Set<string>();
    for (const item of desired) {
      seen.add(item.name);
      const key = JSON.stringify(item.source);
      const existing = this.entries.get(item.name);
      if (existing && existing.key === key) {
        existing.source = item.source;
        continue;
      }
      if (existing) this.close(item.name);
      this.open(item.name, item.source, key);
    }
    for (const name of [...this.entries.keys()]) {
      if (!seen.has(name)) this.close(name);
    }
  }

  /** Значения модуля с учётом удержания импульсов. */
  values(name: string): Record<string, number> {
    const entry = this.entries.get(name);
    if (!entry) return {};
    const now = Date.now();
    const result: Record<string, number> = { ...entry.values };
    for (const [input, hold] of Object.entries(entry.holds)) {
      if (hold.until > now) {
        result[input] = hold.value;
        continue;
      }
      // Импульс погас: значение возвращается в ноль, а не залипает на последнем.
      delete entry.holds[input];
      entry.values[input] = 0;
      result[input] = 0;
    }
    return result;
  }

  status(name: string): ExternalStatus {
    return this.entries.get(name)?.status ?? emptyStatus();
  }

  /** Вход в Twitch: кнопка в карточке модуля. */
  async authorize(name: string): Promise<TwitchInfo | null> {
    const entry = this.entries.get(name);
    if (!entry?.twitch) return null;
    return entry.twitch.authorize();
  }

  /** Забыть токен Twitch: он живёт в профиле окна, а не в пресете. */
  signOut(name: string): void {
    this.entries.get(name)?.twitch?.signOut();
  }

  /** Состояния всех источников: панель показывает их в карточке модуля. */
  statuses(): Record<string, ExternalStatus> {
    const result: Record<string, ExternalStatus> = {};
    for (const [name, entry] of this.entries) result[name] = entry.status;
    return result;
  }

  /** Последние тексты каждого источника: панель «Входы» показывает их как есть. */
  texts(): Record<string, ExternalTextLine[]> {
    const result: Record<string, ExternalTextLine[]> = {};
    for (const [name, entry] of this.entries) result[name] = entry.texts;
    return result;
  }

  /** Журналы всех источников: последние строки для карточки модуля. */
  logs(): Record<string, ExternalLogEntry[]> {
    const result: Record<string, ExternalLogEntry[]> = {};
    for (const [name, entry] of this.entries) result[name] = entry.log;
    return result;
  }

  /**
   * Проверка источника по кнопке: «дозвонились ли и что ответили».
   *
   * Проверка ничего не меняет в работе: WebSocket открывается отдельный и сразу
   * закрывается, нативные транспорты опрашиваются командой Rust, Twitch —
   * запросом к своему API.
   */
  async probe(name: string): Promise<string> {
    const entry = this.entries.get(name);
    if (!entry) return "источник не запущен: включите модуль";
    const source = entry.source;
    if (isTwitchTransport(source.transport)) {
      return entry.twitch ? entry.twitch.probe() : "Twitch не запущен: укажите Client ID и канал";
    }
    if (!source.url) return "не указан адрес источника";
    if (source.transport === "ws") {
      const result = await probeSocket(source.url);
      this.record(entry, result.ok ? "packet" : "error", `проверка: ${result.text}`);
      return result.text;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const text = await invoke<string>("source_probe", {
        config: { transport: source.transport, url: source.url },
      });
      this.record(entry, "packet", `проверка: ${text}`);
      return text;
    } catch (reason) {
      const raw = describe(reason);
      // Старая сборка приложения команду не знает: это не ошибка адреса.
      const text = /not found|unknown command/i.test(raw)
        ? "проверка появится после пересборки приложения (npm run tauri build)"
        : raw;
      this.record(entry, "error", `проверка: ${text}`);
      return text;
    }
  }

  /** Строка журнала. Повторы подряд в пределах секунды схлопываются, чтобы не залить список. */
  private record(entry: Entry, kind: ExternalLogEntry["kind"], text: string): void {
    const short = text.length > 160 ? `${text.slice(0, 157)}…` : text;
    const last = entry.log[0];
    if (last && last.kind === kind && last.text === short && Date.now() - last.at < 1000) return;
    entry.log.unshift({ at: Date.now(), kind, text: short });
    if (entry.log.length > LOG_LIMIT) entry.log.length = LOG_LIMIT;
  }

  close(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.closed = true;
    if (entry.retry) clearTimeout(entry.retry);
    entry.retry = null;
    entry.twitch?.stop();
    if (entry.native) void invokeSource("source_stop", { name }).catch(() => undefined);
    try { entry.socket?.close(); } catch { /* сокет мог уже закрыться */ }
    entry.socket = null;
    this.entries.delete(name);
  }

  dispose(): void {
    for (const name of [...this.entries.keys()]) this.close(name);
    this.unlisten?.();
    this.unlisten = null;
    this.listener = null;
  }

  private open(name: string, source: ExternalSourceConfig, key: string): void {
    // Twitch — не адрес, а сервис: своего URL у него нет, поэтому проверка
    // адреса идёт после него, а не до.
    const twitch = isTwitchTransport(source.transport);
    const native = isNativeTransport(source.transport) && !twitch;
    const entry: Entry = {
      source, key, socket: null, status: emptyStatus(), values: {}, holds: {},
      retry: null, attempts: 0, closed: false, native, log: [], counters: {}, texts: [],
    };
    this.entries.set(name, entry);
    if (twitch) {
      this.startTwitch(entry);
      return;
    }
    if (!source.url) {
      entry.status = emptyStatus("idle", "не указан адрес источника");
      return;
    }
    if (native) {
      void this.startNative(name, entry);
      return;
    }
    if (typeof WebSocket === "undefined") {
      entry.status = emptyStatus("error", "WebSocket недоступен в этом окружении");
      return;
    }
    this.connect(entry);
  }

  /**
   * Twitch: канал сам ходит в API и держит EventSub. Состояние канала
   * переводится в общий статус источника, чтобы карточка не знала
   * подробностей транспорта.
   */
  private startTwitch(entry: Entry): void {
    entry.native = false;
    const channel = new TwitchChannel(entry.source, {
      onState: (info) => {
        if (entry.closed) return;
        entry.status = {
          state: twitchState(info.state),
          message: info.message,
          packets: entry.status.packets,
          twitch: info,
        };
        if (info.state === "needs-auth" || info.state === "error") {
          entry.values = {};
          entry.holds = {};
        }
      },
      onMessage: (text) => {
        if (entry.closed) return;
        this.ingest(entry, text);
      },
    });
    entry.twitch = channel;
    channel.start();
  }

  /** Подписка на события Rust: одна на всё приложение. */
  private ensureListener(): Promise<boolean> {
    if (!this.listener) {
      this.listener = (async () => {
        if (!isTauri()) return false;
        try {
          const event = await import("@tauri-apps/api/event");
          this.unlisten = await event.listen<NativePayload>(NATIVE_EVENT, (message) => {
            this.handleNative(message.payload);
          });
          return true;
        } catch {
          return false;
        }
      })();
    }
    return this.listener;
  }

  private async startNative(name: string, entry: Entry): Promise<void> {
    if (!isTauri()) {
      entry.status = emptyStatus("unsupported", this.nativeHint(entry.source));
      return;
    }
    entry.status = emptyStatus("connecting");
    const ready = await this.ensureListener();
    if (!ready) {
      entry.status = emptyStatus("error", "нет связи с нативной частью приложения");
      return;
    }
    if (entry.closed) return;
    try {
      await invokeSource("source_start", {
        config: {
          name,
          transport: entry.source.transport,
          url: entry.source.url,
          intervalMs: entry.source.intervalMs,
        },
      });
    } catch (reason) {
      entry.status = emptyStatus("error", describe(reason));
    }
  }

  private nativeHint(source: ExternalSourceConfig): string {
    if (source.transport === "osc") {
      return "OSC нужен нативный слой: откройте приложение (в браузере UDP недоступен)";
    }
    return "запросы блокирует CORS: транспорт работает в приложении, в браузере — только WebSocket";
  }

  private handleNative(payload: NativePayload): void {
    if (!payload || typeof payload !== "object") return;
    const entry = this.entries.get(payload.name);
    if (!entry || entry.closed) return;
    if (payload.kind === "state") {
      const state = payload.state;
      entry.status = {
        state,
        message: payload.message ?? null,
        packets: entry.status.packets,
      };
      // Останов или сбой — нули: залипшее значение хуже отсутствия.
      if (state === "error" || state === "idle") {
        entry.values = {};
        entry.holds = {};
        entry.counters = {};
      }
      if (state === "error" && payload.message) this.record(entry, "error", payload.message);
      return;
    }
    if (payload.kind === "text") this.ingest(entry, payload.text);
  }

  /** Разбор одного пакета: таблица отображения превращает его в числа. */
  private ingest(entry: Entry, text: string): void {
    if (!text) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Самая частая причина: источник шлёт не JSON (например, OSC-строку).
      this.record(entry, "warn", `не JSON: ${text.slice(0, 80)}`);
      return;
    }
    const mapping = entry.source.mapping;
    const mapped = applyMapping(parsed, mapping);
    // Счётчики: пакет подошёл по условию — значит, событие произошло.
    for (const rule of mapping) {
      if (!rule.count || !ruleMatches(rule, parsed)) continue;
      entry.counters[rule.input] = (entry.counters[rule.input] ?? 0) + 1;
      mapped[rule.input] = entry.counters[rule.input];
    }
    // Текст (чат): в числа не превращается, поэтому живёт отдельным списком.
    const textConfig = entry.source.text;
    if (textConfig) {
      const body = readPath(parsed, textConfig.path);
      const line = typeof body === "string" ? body.trim() : "";
      if (line) {
        const author = textConfig.authorPath ? readPath(parsed, textConfig.authorPath) : undefined;
        entry.texts.unshift({
          at: Date.now(),
          author: typeof author === "string" && author.trim() ? author.trim().slice(0, 40) : undefined,
          text: line.slice(0, 200),
        });
        if (entry.texts.length > TEXT_LIMIT) entry.texts.length = TEXT_LIMIT;
      }
    }
    if (Object.keys(mapped).length === 0) {
      // Пакет разобрался, но ни одно правило не сработало: показываем, что искали.
      const paths = entry.source.mapping.map((rule) => rule.path).join(", ");
      const note = entry.source.text ? " (текст для показа собран)" : "";
      this.record(entry, "warn", `поля не найдены: ${paths || "таблица отображения пуста"}${note}`);
      return;
    }
    const now = Date.now();
    for (const [input, value] of Object.entries(mapped)) {
      const rule = entry.source.mapping.find((item) => item.input === input);
      // Импульс: ненулевое значение держится, чтобы событие успело сработать.
      // Явный ноль снимает удержание сразу: так ведут себя и OSC-флаги, и
      // источники, которые присылают и начало, и конец события.
      if (rule?.holdMs && value !== 0) entry.holds[input] = { value, until: now + rule.holdMs };
      else if (!rule?.count) delete entry.holds[input];
      entry.values[input] = value;
    }
    this.record(entry, "packet", describeValues(mapped));
    entry.status = { ...entry.status, state: "live", message: null, packets: entry.status.packets + 1 };
  }

  private connect(entry: Entry): void {
    if (entry.closed) return;
    entry.status = { ...entry.status, state: "connecting", message: null };
    let socket: WebSocket;
    try {
      socket = new WebSocket(entry.source.url);
    } catch (reason) {
      entry.status = emptyStatus("error", `не удалось открыть сокет: ${reason instanceof Error ? reason.message : String(reason)}`);
      this.scheduleReconnect(entry);
      return;
    }
    entry.socket = socket;
    socket.onopen = () => {
      if (entry.closed) return;
      entry.attempts = 0;
      entry.status = { state: "live", message: null, packets: 0 };
      if (entry.source.subscribe) {
        try { socket.send(entry.source.subscribe); } catch { /* соединение уже закрылось */ }
      }
    };
    socket.onmessage = (event) => {
      if (entry.closed) return;
      const payload = typeof event.data === "string" ? event.data : "";
      if (payload) this.ingest(entry, payload);
    };
    socket.onerror = () => {
      if (entry.closed) return;
      entry.status = { state: "error", message: "ошибка соединения", packets: entry.status.packets };
      this.record(entry, "error", "ошибка соединения");
    };
    socket.onclose = () => {
      if (entry.closed) return;
      entry.socket = null;
      if (entry.status.state !== "error") {
        entry.status = { state: "error", message: "соединение закрыто", packets: entry.status.packets };
      }
      this.record(entry, "error", entry.source.reconnect === false ? "соединение закрыто" : "соединение закрыто, переподключаюсь");
      // Обрыв — нули, а не «залипшее» последнее значение. Счётчики тоже
      // начинаются заново: иначе после реконнекта число прыгнуло бы.
      entry.values = {};
      entry.holds = {};
      entry.counters = {};
      if (entry.source.reconnect !== false) this.scheduleReconnect(entry);
    };
  }

  private scheduleReconnect(entry: Entry): void {
    if (entry.closed || entry.retry) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** entry.attempts);
    entry.attempts += 1;
    entry.retry = setTimeout(() => {
      entry.retry = null;
      this.connect(entry);
    }, delay);
  }
}

/** Список включённых внешних модулей в виде, который ждёт `sync`. */
export function externalSourcesOf(modules: ModuleInstance[], enabled: (module: ModuleInstance) => boolean): Array<{ name: string; source: ExternalSourceConfig }> {
  return modules
    .filter((module) => module.enabled && enabled(module))
    .map((module) => ({ name: module.name, source: sourceConfig(module) }));
}

/** Конфиг из настроек экземпляра в виде, пригодном для сравнения и запуска. */
export function sourceConfig(module: ModuleInstance): ExternalSourceConfig {
  return readExternalSource(module.config as Record<string, unknown>);
}

/** Правила отображения модуля — короткий доступ для панелей. */
export function sourceRules(module: ModuleInstance): ExternalSourceRule[] {
  return sourceConfig(module).mapping;
}

/** Состояние Twitch в терминах общего статуса источника. */
function twitchState(state: TwitchState): ExternalState {
  if (state === "live") return "live";
  if (state === "error") return "error";
  if (state === "authorizing" || state === "connecting") return "connecting";
  if (state === "needs-auth") return "idle";
  return "idle";
}

/** Значения одной строкой: `hr=72, beat=1` — короче и читаемее JSON. */
function describeValues(values: Record<string, number>): string {
  return Object.entries(values)
    .map(([input, value]) => `${input}=${Number.isInteger(value) ? value : value.toFixed(2)}`)
    .join(", ");
}

/**
 * Проверка WebSocket: открыть отдельный сокет и сразу закрыть.
 * Ждём не дольше трёх секунд — иначе кнопка «Проверить» висела бы.
 */
function probeSocket(url: string): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    let socket: WebSocket | null = null;
    let settled = false;
    const finish = (ok: boolean, text: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      try { socket?.close(); } catch { /* мог уже закрыться */ }
      resolve({ ok, text });
    };
    const timer = window.setTimeout(() => finish(false, "соединение не открылось за 3 с: адрес неверный или мост не запущен"), 3000);
    try {
      socket = new WebSocket(url);
    } catch (reason) {
      finish(false, `не удалось открыть сокет: ${describe(reason)}`);
      return;
    }
    socket.onopen = () => finish(true, "соединение установлено: адрес верный");
    socket.onerror = () => finish(false, "сокет не открылся: проверьте адрес, порт и запущен ли мост");
  });
}

function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

export function sameRules(left: ExternalSourceRule[], right: ExternalSourceRule[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
