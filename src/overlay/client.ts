import type { BasePose, OverlayConfig, RigFrame } from "../types";
import type { CompositeBus } from "./bus";
import {
  OVERLAY_PROTOCOL, type AssetStartMessage, type FrameColors, type OverlayScene, type WireMessage,
} from "./protocol";
import {
  acceptAssetBlob, acceptAssetData, clearAssetRequestPending,
  markAssetRequestFailed, markAssetRequestPending,
} from "../engine/assets";

export type OverlayStatus = "connecting" | "waiting" | "live" | "stale";

export interface OverlayClientSnapshot {
  status: OverlayStatus;
  host: string | null;
  scene: OverlayScene | null;
  config: OverlayConfig | null;
  bases: Record<string, BasePose> | null;
  frameCount: number;
  transport: string;
  windowControl: boolean;
}

export interface OverlayClientOptions {
  now?: () => number;
  /** A viewer pings this often while waiting for the scene. */
  helloIntervalMs?: number;
  /** No host message for this long means the editor is gone. */
  staleAfterMs?: number;
  /** No asset-transfer progress for this long is reported to the HUD. */
  assetRequestTimeoutMs?: number;
  /** Test seam; production stores the completed Blob in the asset cache. */
  acceptAsset?: (id: string, blob: Blob) => void;
  /** Test seam; production reports the failure in the overlay asset HUD. */
  onAssetFailure?: (id: string, reason: string) => void;
}

const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const MIN_ASSET_CHUNK_SIZE = 16 * 1024;
const MAX_ASSET_CHUNK_SIZE = 64 * 1024;

interface AssetAssembly {
  sender: string;
  assetId: string;
  requestId: string;
  size: number;
  mime: string;
  chunkSize: number;
  chunks: number;
  received: number;
  receivedBytes: number;
  parts: Array<Uint8Array | undefined>;
  completed: boolean;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The overlay side of the overlay link. It never runs the rig engine: it only
 * stores the latest scene, base patch and prepared frame, and reports status.
 */
export class OverlayClient {
  readonly id = `viewer-${Math.random().toString(36).slice(2, 10)}`;
  scene: OverlayScene | null = null;
  config: OverlayConfig | null = null;
  bases: Record<string, BasePose> | null = null;
  frame: RigFrame | null = null;
  /** Цвета из модулей с последнего кадра: ядро их не считает. */
  colors: FrameColors | null = null;
  status: OverlayStatus = "connecting";
  host: string | null = null;
  frameCount = 0;
  windowControl = false;
  private lastSeq = -1;
  /**
   * Хост, от которого принят последний кадр. Сменился хост (редактор
   * перезапустили, а источник в OBS остался открыт) — его нумерация начинается
   * заново, и держать старый номер нельзя: оверлей замер бы навсегда.
   */
  private lastSender: string | null = null;
  /** Хост, от которого пришёл последний анонс: смена — это перезапуск редактора. */
  private lastHostSender: string | null = null;
  private lastHostSeen = 0;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private frameListeners = new Set<() => void>();
  private assetRequests = new Map<string, string>();
  private assetRequestTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private assetTransfers = new Map<string, AssetAssembly>();
  private readonly acceptAsset: (id: string, blob: Blob) => void;
  private readonly onAssetFailure: (id: string, reason: string) => void;
  private readonly now: () => number;
  private readonly helloIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly assetRequestTimeoutMs: number;
  private disposed = false;

  constructor(private readonly bus: CompositeBus, options: OverlayClientOptions = {}) {
    this.now = options.now || (() => Date.now());
    this.acceptAsset = options.acceptAsset ?? acceptAssetBlob;
    this.onAssetFailure = options.onAssetFailure ?? markAssetRequestFailed;
    this.helloIntervalMs = options.helloIntervalMs ?? 2000;
    this.staleAfterMs = options.staleAfterMs ?? 8000;
    this.assetRequestTimeoutMs = options.assetRequestTimeoutMs ?? 20_000;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe((message) => this.receive(message));
    this.hello();
    this.timer = setInterval(() => this.tick(), this.helloIntervalMs);
    this.update("connecting");
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Отдельная подписка на кадры. Кадры приходят чаще, чем меняется состояние
   * (60–120 раз в секунду), и поднимать на каждый из них React незачем:
   * рисующее окно берёт кадр напрямую и перерисовывает холст.
   */
  subscribeFrames(listener: () => void): () => void {
    this.frameListeners.add(listener);
    return () => { this.frameListeners.delete(listener); };
  }

  snapshot(): OverlayClientSnapshot {
    return {
      status: this.status,
      host: this.host,
      scene: this.scene,
      config: this.config,
      bases: this.bases,
      frameCount: this.frameCount,
      transport: this.bus.label,
      windowControl: this.windowControl,
    };
  }

  /** Просит у редактора файл, которого нет в локальном хранилище. */
  requestAsset(id: string): void {
    if (this.disposed || !id || this.assetRequests.has(id)) return;
    const requestId = `${this.id}-${randomId()}`;
    this.assetRequests.set(id, requestId);
    markAssetRequestPending(id);
    this.touchAssetRequest(id, requestId);
    this.bus.post({ t: "asset-request", sender: this.id, id, requestId });
  }

  /** Отправляет размер нативного окна после ручного изменения. */
  reportWindowSize(width: number, height: number): void {
    if (this.disposed || !this.windowControl) return;
    this.bus.post({
      t: "window-size", sender: this.id,
      width: Math.round(width), height: Math.round(height),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.bus.post({ t: "bye", sender: this.id, role: "viewer" });
    for (const id of this.assetRequests.keys()) {
      this.clearAssetRequestTimer(id);
      clearAssetRequestPending(id);
    }
    this.assetRequests.clear();
    this.clearAssetTransfers();
    this.listeners.clear();
    this.frameListeners.clear();
  }

  private hello(): void {
    this.bus.post({
      t: "hello", sender: this.id, role: "viewer", protocol: OVERLAY_PROTOCOL,
      sceneVersion: this.scene?.version ?? 0,
    });
  }

  private tick(): void {
    if (this.disposed) return;
    const now = this.now();
    // Always heartbeat: the host drops viewers that stay silent, and answering a
    // hello is cheap because the client reports which scene it already has.
    this.hello();
    const silent = now - this.lastHostSeen;
    if (silent > this.staleAfterMs) {
      this.update(this.scene ? "stale" : "waiting");
    } else if (this.scene && this.status !== "live") {
      this.update("live");
    }
  }

  private receive(message: WireMessage): void {
    if (this.disposed || message.sender === this.id) return;
    switch (message.t) {
      case "announce": {
        // Редактор перезапустили: у нового хоста своя нумерация и сцены, и
        // кадров. Старую сцену и старый номер кадра держать нельзя — иначе
        // источник в OBS навсегда остался бы на последней картинке прошлого
        // запуска.
        if (this.lastHostSender !== message.sender) {
          this.lastHostSender = message.sender;
          this.scene = null;
          this.frame = null;
          this.lastSender = null;
          this.lastSeq = -1;
          this.windowControl = false;
          for (const id of this.assetRequests.keys()) {
            this.clearAssetRequestTimer(id);
            clearAssetRequestPending(id);
          }
          this.assetRequests.clear();
          this.clearAssetTransfers();
        }
        this.host = message.host;
        this.lastHostSeen = this.now();
        if (!this.scene || message.sceneVersion > this.scene.version) this.hello();
        if (this.scene && this.status !== "live") this.update("live");
        else this.notify();
        break;
      }
      case "scene": {
        if (this.scene && message.scene.version <= this.scene.version) break;
        this.scene = message.scene;
        this.lastHostSeen = this.now();
        this.update(this.frame ? "live" : "waiting");
        break;
      }
      case "config": {
        this.config = { ...message.config };
        this.lastHostSeen = this.now();
        this.notify();
        break;
      }
      case "pose": {
        this.bases = message.bases;
        this.lastHostSeen = this.now();
        this.notify();
        break;
      }
      case "frame": {
        this.lastHostSeen = this.now();
        if (this.scene && message.sceneVersion !== this.scene.version) {
          this.hello();
          break;
        }
        // Two transports may deliver the same frame; only accept newer sequences.
        // Номер считается по хосту: у нового хоста (или у пересозданного
        // движка в нём) счёт начинается заново, и старый номер не мешает.
        if (this.lastSender !== message.sender) {
          this.lastSender = message.sender;
          this.lastSeq = -1;
        }
        if (message.frame.seq <= this.lastSeq) break;
        this.lastSeq = message.frame.seq;
        this.frame = message.frame;
        this.colors = message.colors ?? null;
        this.frameCount += 1;
        for (const listener of this.frameListeners) listener();
        if (this.status !== "live") this.update("live");
        break;
      }
      case "asset": {
        // Старый формат оставлен для ответа v1-хоста.
        acceptAssetData(message.id, message.data);
        if (this.assetRequests.has(message.id)) {
          this.clearAssetRequestTimer(message.id);
          clearAssetRequestPending(message.id);
          this.assetRequests.delete(message.id);
          this.notify();
        }
        break;
      }
      case "asset-start": this.startAssetAssembly(message); break;
      case "asset-chunk": this.receiveAssetChunk(message); break;
      case "asset-error": {
        if (message.to !== this.id || this.assetRequests.get(message.id) !== message.requestId) break;
        this.failAsset(message.id, message.requestId, message.reason || "Передача файла не удалась.");
        break;
      }
      case "window-control": {
        this.windowControl = message.enabled;
        this.notify();
        break;
      }
      default:
        break;
    }
  }

  private startAssetAssembly(message: AssetStartMessage): void {
    if (message.to !== this.id || this.assetRequests.get(message.id) !== message.requestId) return;
    if (this.lastHostSender && message.sender !== this.lastHostSender) return;
    if (this.assetTransfers.has(message.transferId)) return;
    const valid = Number.isSafeInteger(message.size) && message.size >= 0 && message.size <= MAX_ASSET_BYTES
      && Number.isSafeInteger(message.chunkSize) && message.chunkSize >= MIN_ASSET_CHUNK_SIZE
      && message.chunkSize <= MAX_ASSET_CHUNK_SIZE
      && Number.isSafeInteger(message.chunks) && message.chunks >= 0
      && message.chunks === Math.ceil(message.size / message.chunkSize)
      && typeof message.mime === "string" && message.mime.length <= 256;
    if (!valid) {
      this.failAsset(message.id, message.requestId, "Хост прислал некорректный размер файла.", message.transferId, message.sender);
      return;
    }
    const assembly: AssetAssembly = {
      sender: message.sender,
      assetId: message.id,
      requestId: message.requestId,
      size: message.size,
      mime: message.mime || "application/octet-stream",
      chunkSize: message.chunkSize,
      chunks: message.chunks,
      received: 0,
      receivedBytes: 0,
      parts: new Array(message.chunks),
      completed: false,
      cleanupTimer: null,
    };
    this.assetTransfers.set(message.transferId, assembly);
    this.touchAssetRequest(message.id, message.requestId, message.transferId, message.sender);
    if (message.chunks === 0) this.finishAssetAssembly(message.transferId, assembly);
  }

  private receiveAssetChunk(message: Extract<WireMessage, { t: "asset-chunk" }>): void {
    if (message.to !== this.id) return;
    const assembly = this.assetTransfers.get(message.transferId);
    if (!assembly || assembly.sender !== message.sender || assembly.assetId !== message.id) return;
    if (!Number.isSafeInteger(message.index) || message.index < 0 || message.index >= assembly.chunks) {
      this.failAsset(assembly.assetId, assembly.requestId, "Хост прислал неверный номер фрагмента.", message.transferId, message.sender);
      return;
    }
    if (assembly.completed) {
      this.ackAssetChunk(message.sender, message.transferId, message.index);
      return;
    }
    const existing = assembly.parts[message.index];
    if (existing) {
      this.ackAssetChunk(message.sender, message.transferId, message.index);
      this.touchAssetRequest(assembly.assetId, assembly.requestId, message.transferId, message.sender);
      return;
    }
    try {
      if (typeof message.data !== "string" || message.data.length > Math.ceil(assembly.chunkSize * 4 / 3) + 8) {
        throw new Error("Слишком большой фрагмент");
      }
      const bytes = decodeBase64(message.data);
      const expected = message.index === assembly.chunks - 1
        ? assembly.size - assembly.chunkSize * (assembly.chunks - 1)
        : assembly.chunkSize;
      if (bytes.byteLength !== expected) throw new Error("Размер фрагмента не совпадает");
      assembly.parts[message.index] = bytes;
      assembly.received += 1;
      assembly.receivedBytes += bytes.byteLength;
      this.ackAssetChunk(message.sender, message.transferId, message.index);
      this.touchAssetRequest(assembly.assetId, assembly.requestId, message.transferId, message.sender);
      if (assembly.received === assembly.chunks) this.finishAssetAssembly(message.transferId, assembly);
    } catch {
      this.failAsset(assembly.assetId, assembly.requestId, "Не удалось проверить фрагмент файла.", message.transferId, message.sender);
    }
  }

  private ackAssetChunk(sender: string, transferId: string, index: number): void {
    this.bus.post({ t: "asset-ack", sender: this.id, to: sender, transferId, index });
  }

  private finishAssetAssembly(transferId: string, assembly: AssetAssembly): void {
    if (this.assetTransfers.get(transferId) !== assembly) return;
    try {
      if (assembly.receivedBytes !== assembly.size) throw new Error("Размер собранного файла не совпадает");
      const parts = assembly.parts.filter((part): part is Uint8Array => !!part)
        .map((part) => part.buffer as ArrayBuffer);
      const blob = new Blob(parts, { type: assembly.mime });
      assembly.parts.length = 0;
      parts.length = 0;
      if (blob.size !== assembly.size) throw new Error("Размер собранного файла не совпадает");
      this.acceptAsset(assembly.assetId, blob);
      clearAssetRequestPending(assembly.assetId);
      // Keep a lightweight tombstone temporarily so a retransmitted final chunk
      // (lost ACK) is acknowledged instead of being discarded as an unknown id.
      assembly.completed = true;
      assembly.cleanupTimer = setTimeout(() => this.assetTransfers.delete(transferId), 30_000);
      this.clearAssetRequestTimer(assembly.assetId);
      this.assetRequests.delete(assembly.assetId);
      this.notify();
    } catch {
      this.failAsset(assembly.assetId, assembly.requestId, "Собранный файл повреждён.", transferId, assembly.sender);
    }
  }

  private failAsset(id: string, requestId: string, reason: string, transferId?: string, sender?: string): void {
    this.clearAssetRequestTimer(id);
    clearAssetRequestPending(id);
    this.onAssetFailure(id, reason);
    this.assetRequests.delete(id);
    for (const [activeId, assembly] of this.assetTransfers) {
      if ((transferId && activeId === transferId)
          || (assembly.assetId === id && assembly.requestId === requestId)) {
        if (assembly.cleanupTimer) clearTimeout(assembly.cleanupTimer);
        this.assetTransfers.delete(activeId);
      }
    }
    if (sender) this.bus.post({ t: "asset-error", sender: this.id, to: sender, id, requestId, reason });
    this.notify();
  }

  private clearAssetTransfers(): void {
    for (const assembly of this.assetTransfers.values()) {
      if (assembly.cleanupTimer) clearTimeout(assembly.cleanupTimer);
    }
    this.assetTransfers.clear();
  }

  private touchAssetRequest(id: string, requestId: string, transferId?: string, sender?: string): void {
    if (this.assetRequests.get(id) !== requestId) return;
    this.clearAssetRequestTimer(id);
    const timer = setTimeout(() => {
      if (this.assetRequests.get(id) !== requestId) return;
      this.failAsset(
        id,
        requestId,
        "Передача файла остановилась: редактор не прислал данные вовремя.",
        transferId,
        sender ?? this.lastHostSender ?? undefined,
      );
    }, this.assetRequestTimeoutMs);
    this.assetRequestTimers.set(id, timer);
  }

  private clearAssetRequestTimer(id: string): void {
    const timer = this.assetRequestTimers.get(id);
    if (timer) clearTimeout(timer);
    this.assetRequestTimers.delete(id);
  }

  private update(status: OverlayStatus): void {
    this.status = status;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
