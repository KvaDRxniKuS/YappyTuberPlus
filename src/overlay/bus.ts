import { isWireMessage, OVERLAY_CHANNEL, OVERLAY_EVENT, type WireMessage } from "./protocol";

/**
 * Transports that carry overlay messages between windows.
 *
 * - `broadcast` — BroadcastChannel: editor and overlay in the same browser
 *   process (development, second tab, same-origin preview).
 * - `tauri` — Tauri events: works across native webview windows.
 * - `websocket` — optional local bridge (`npm run overlay:bridge`), needed when
 *   another process such as OBS Browser Source must receive frames.
 *
 * Every transport is additive: the host publishes on all of them, viewers
 * de-duplicate frames by sequence number.
 */

export type BusKind = "broadcast" | "tauri" | "websocket";

export interface OverlayBus {
  readonly kind: BusKind;
  readonly label: string;
  /** True when the transport is currently usable. */
  readonly ready: boolean;
  post(message: WireMessage): void;
  subscribe(listener: (message: WireMessage, source: BusKind) => void): () => void;
  close(): void;
}

type Listener = (message: WireMessage, source: BusKind) => void;

export class BroadcastChannelBus implements OverlayBus {
  readonly kind = "broadcast" as const;
  readonly label = "BroadcastChannel";
  private channel: BroadcastChannel;
  private listeners = new Set<Listener>();

  constructor(name = OVERLAY_CHANNEL) {
    this.channel = new BroadcastChannel(name);
    this.channel.addEventListener("message", (event: MessageEvent) => {
      if (isWireMessage(event.data)) this.emit(event.data);
    });
  }

  get ready() { return true; }

  post(message: WireMessage) {
    this.channel.postMessage(message);
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close() {
    this.listeners.clear();
    this.channel.close();
  }

  private emit(message: WireMessage) {
    for (const listener of this.listeners) listener(message, this.kind);
  }
}

export class TauriEventBus implements OverlayBus {
  readonly kind = "tauri" as const;
  readonly label = "Tauri events";
  private listeners = new Set<Listener>();
  private unlisten: (() => void) | null = null;
  private disposed = false;
  ready = false;

  constructor(private readonly emit: (event: string, payload: WireMessage) => void) {}

  async start(): Promise<void> {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<WireMessage>(OVERLAY_EVENT, (event) => {
      if (isWireMessage(event.payload)) this.emitMessage(event.payload);
    });
    if (this.disposed) unlisten();
    else {
      this.unlisten = unlisten;
      this.ready = true;
    }
  }

  post(message: WireMessage) {
    void this.emit(OVERLAY_EVENT, message);
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close() {
    this.disposed = true;
    this.listeners.clear();
    this.unlisten?.();
    this.unlisten = null;
  }

  private emitMessage(message: WireMessage) {
    for (const listener of this.listeners) listener(message, this.kind);
  }
}

export class WebSocketBus implements OverlayBus {
  readonly kind = "websocket" as const;
  readonly label = "WebSocket · мост";
  private listeners = new Set<Listener>();
  private queue: WireMessage[] = [];
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private disposed = false;
  ready = false;
  lastError: string | null = null;

  constructor(private readonly url: string) {
    this.connect();
  }

  post(message: WireMessage) {
    if (this.socket && this.ready) {
      try { this.socket.send(JSON.stringify(message)); } catch { this.enqueue(message); }
    } else {
      this.enqueue(message);
    }
  }

  /** Frames are only useful while the socket is open; never queue them. */
  private enqueue(message: WireMessage) {
    if (message.t === "frame" || this.queue.length >= 24) return;
    this.queue.push(message);
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close() {
    this.disposed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.listeners.clear();
    this.queue = [];
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = null;
    this.ready = false;
  }

  private connect() {
    if (this.disposed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (reason) {
      this.lastError = reason instanceof Error ? reason.message : String(reason);
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.ready = true;
      this.attempts = 0;
      this.lastError = null;
      const pending = this.queue.splice(0);
      for (const message of pending) {
        try { socket.send(JSON.stringify(message)); } catch { this.queue.push(message); }
      }
    };
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try { parsed = JSON.parse(event.data); } catch { return; }
      if (isWireMessage(parsed)) this.emit(parsed);
    };
    socket.onerror = () => { this.lastError = "мост недоступен"; };
    socket.onclose = () => {
      this.ready = false;
      this.socket = null;
      this.scheduleRetry();
    };
  }

  private scheduleRetry() {
    if (this.disposed || this.retry) return;
    this.attempts += 1;
    const delay = Math.min(1000 * 2 ** Math.min(this.attempts, 3), 8000);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, delay);
  }

  private emit(message: WireMessage) {
    for (const listener of this.listeners) listener(message, this.kind);
  }
}

export interface BusOptions {
  channelName?: string;
  bridgeUrl?: string | null;
  broadcast?: boolean;
  tauri?: boolean;
  websocket?: boolean;
}

/** Composes every available transport into one message stream. */
export class CompositeBus implements OverlayBus {
  get kind(): BusKind { return this.primaryKind; }
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly buses: OverlayBus[]) {}

  get label() {
    return this.buses.map((bus) => bus.label).join(" + ") || "нет транспорта";
  }

  /** The primary transport kind, used for reporting. */
  get primaryKind(): BusKind {
    return this.buses[0]?.kind ?? "broadcast";
  }

  get ready() {
    return this.buses.some((bus) => bus.ready);
  }

  get parts(): OverlayBus[] {
    return this.buses;
  }

  post(message: WireMessage) {
    for (const bus of this.buses) bus.post(message);
  }

  subscribe(listener: Listener) {
    let closed = false;
    const wrapped: Listener = (message, source) => { if (!closed) listener(message, source); };
    for (const bus of this.buses) this.unsubscribers.push(bus.subscribe(wrapped));
    return () => {
      closed = true;
      for (const off of this.unsubscribers.splice(0)) off();
    };
  }

  close() {
    for (const off of this.unsubscribers.splice(0)) off();
    for (const bus of this.buses) bus.close();
  }
}

/**
 * Builds the available transports for the current environment.
 * Failures never throw: a missing bridge simply drops that transport.
 */
export async function createOverlayBus(options: BusOptions = {}): Promise<CompositeBus> {
  const buses: OverlayBus[] = [];
  if (options.broadcast !== false && typeof BroadcastChannel !== "undefined") {
    buses.push(new BroadcastChannelBus(options.channelName));
  }
  if (options.tauri !== false && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    try {
      const { emit } = await import("@tauri-apps/api/event");
      const bus = new TauriEventBus(emit);
      await bus.start();
      buses.push(bus);
    } catch {
      /* Tauri events unavailable — keep the other transports. */
    }
  }
  if (options.websocket !== false && options.bridgeUrl) {
    buses.push(new WebSocketBus(options.bridgeUrl));
  }
  return new CompositeBus(buses);
}
