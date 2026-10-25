import type { ExternalSourceConfig, ExternalSourceRule, ModuleInstance } from "../types";
import { applyMapping, readExternalSource } from "./external";

/**
 * Хост внешних источников.
 *
 * Один экземпляр на приложение: он держит сокеты, переподключается и превращает
 * пакеты в числа. Модули только описывают источник, поэтому два модуля с одинаковым
 * адресом делят одно соединение, а выключение модуля честно закрывает сокет.
 *
 * Значения не толкаются в React на каждый пакет: хост складывает их у себя, а окно
 * забирает раз в тик — так поток 60–120 пакетов в секунду не превращается в поток
 * перерисовок.
 */

export type ExternalState = "idle" | "connecting" | "live" | "error" | "unsupported";

export interface ExternalStatus {
  state: ExternalState;
  message: string | null;
  /** Сколько пакетов пришло с момента подключения: видно, что канал живой. */
  packets: number;
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
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 8000;

function emptyStatus(state: ExternalState = "idle", message: string | null = null): ExternalStatus {
  return { state, message, packets: 0 };
}

function sameRules(left: ExternalSourceRule[], right: ExternalSourceRule[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Конфиг из настроек экземпляра в виде, пригодном для сравнения и запуска. */
export function sourceConfig(module: ModuleInstance): ExternalSourceConfig {
  return readExternalSource(module.config as Record<string, unknown>);
}

export class ExternalSourceHost {
  private entries = new Map<string, Entry>();

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
      if (hold.until > now) result[input] = hold.value;
    }
    return result;
  }

  status(name: string): ExternalStatus {
    return this.entries.get(name)?.status ?? emptyStatus();
  }

  /** Состояния всех источников: панель показывает их в карточке модуля. */
  statuses(): Record<string, ExternalStatus> {
    const result: Record<string, ExternalStatus> = {};
    for (const [name, entry] of this.entries) result[name] = entry.status;
    return result;
  }

  close(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.closed = true;
    if (entry.retry) clearTimeout(entry.retry);
    entry.retry = null;
    try { entry.socket?.close(); } catch { /* сокет мог уже закрыться */ }
    entry.socket = null;
    this.entries.delete(name);
  }

  dispose(): void {
    for (const name of [...this.entries.keys()]) this.close(name);
  }

  private open(name: string, source: ExternalSourceConfig, key: string): void {
    const entry: Entry = {
      source, key, socket: null, status: emptyStatus(), values: {}, holds: {},
      retry: null, attempts: 0, closed: false,
    };
    this.entries.set(name, entry);
    if (!source.url) {
      entry.status = emptyStatus("idle", "не указан адрес источника");
      return;
    }
    if (source.transport !== "ws") {
      // Честно: транспорт появится вместе с Rust-слоем, тихо не притворяемся.
      entry.status = emptyStatus("unsupported", `транспорт «${source.transport}» появится позже: сейчас доступен ws`);
      return;
    }
    if (typeof WebSocket === "undefined") {
      entry.status = emptyStatus("error", "WebSocket недоступен в этом окружении");
      return;
    }
    this.connect(entry);
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
      if (!payload) return;
      let parsed: unknown;
      try { parsed = JSON.parse(payload); } catch { return; }
      const mapped = applyMapping(parsed, entry.source.mapping);
      const now = Date.now();
      for (const [input, value] of Object.entries(mapped)) {
        const rule = entry.source.mapping.find((item) => item.input === input);
        // Импульс: ненулевое значение держится, чтобы событие успело сработать.
        if (rule?.holdMs && value !== 0) entry.holds[input] = { value, until: now + rule.holdMs };
        else if (!rule?.holdMs) delete entry.holds[input];
        entry.values[input] = value;
      }
      entry.status = { ...entry.status, state: "live", packets: entry.status.packets + 1 };
    };
    socket.onerror = () => {
      if (entry.closed) return;
      entry.status = { state: "error", message: "ошибка соединения", packets: entry.status.packets };
    };
    socket.onclose = () => {
      if (entry.closed) return;
      entry.socket = null;
      if (entry.status.state !== "error") {
        entry.status = { state: "error", message: "соединение закрыто", packets: entry.status.packets };
      }
      // Обрыв — нули, а не «залипшее» последнее значение.
      entry.values = {};
      entry.holds = {};
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

/** Правила отображения модуля — короткий доступ для панелей. */
export function sourceRules(module: ModuleInstance): ExternalSourceRule[] {
  return sourceConfig(module).mapping;
}

export { sameRules };
