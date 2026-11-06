import type { BasePose, OverlayConfig, RigFrame, RigPreset } from "../types";
import { neutralFrame } from "../engine/frame";
import { nextFrameSeq } from "../engine/frameSeq";
import { readAssetBlob, assetRef, inlineSource } from "../engine/assets";
import type { CompositeBus, TransportStats } from "./bus";
import {
  basesOf, configSignature, OVERLAY_PROTOCOL, poseSignature, structureSignature,
  toOverlayScene, type FrameColors, type HelloMessage, type OverlayScene, type WireMessage,
} from "./protocol";

export interface OverlayHostOptions {
  hostName: string;
  onViewers?: (viewers: string[]) => void;
  onWindowSize?: (width: number, height: number) => void;
  /** Test seam; production reads the Blob from IndexedDB or the preset folder. */
  readAsset?: (id: string) => Promise<Blob | null>;
  now?: () => number;
  /** A viewer that stays silent for this long is considered gone. */
  viewerTimeoutMs?: number;
  /** Periodic announce also acts as the host heartbeat for viewers. */
  announceIntervalMs?: number;
  assetAckTimeoutMs?: number;
  assetRetryLimit?: number;
}

const ASSET_CHUNK_SIZE = 48 * 1024;
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const MAX_IN_FLIGHT_CHUNKS = 8;
const DEFAULT_ASSET_ACK_TIMEOUT_MS = 900;
const DEFAULT_ASSET_RETRY_LIMIT = 4;

type PendingChunk = {
  data: string | null;
  retries: number;
  timer: ReturnType<typeof setTimeout> | null;
  sending: boolean;
};

interface AssetTransfer {
  transferId: string;
  requestKey: string;
  viewerId: string;
  requestId: string;
  assetId: string;
  blob: Blob;
  chunks: number;
  nextIndex: number;
  pending: Map<number, PendingChunk>;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function requestKey(viewerId: string, requestId: string): string {
  return `${viewerId}\u0000${requestId}`;
}

/**
 * The editor side of the overlay link. The host owns the only runtime and
 * therefore the only frame clock; overlays are read-only subscribers.
 */
export class OverlayHost {
  readonly id = `host-${Math.random().toString(36).slice(2, 10)}`;
  private viewers = new Map<string, number>();
  private assetTransfers = new Map<string, AssetTransfer>();
  private activeAssetRequests = new Map<string, string | null>();
  private windowControl = false;
  /**
   * Оверлеи, которые говорят на другом протоколе.
   *
   * Страница источника в OBS кэшируется браузером, поэтому после обновления
   * редактора там может остаться оверлей прошлой сборки. Молча это выглядит
   * как «кадры перестали обновляться» — лучше сказать прямо.
   */
  private stale = new Set<string>();
  private scene: OverlayScene | null = null;
  private sceneVersion = 0;
  private config: OverlayConfig | null = null;
  private presetRef: RigPreset | null = null;
  /**
   * Последние цвета из модулей. Едут с каждым кадром: цвет меняется по времени,
   * и «один раз при изменении» его не отдать — оверлей застыл бы на первом.
   */
  private colors: FrameColors = {};
  private bases: Record<string, BasePose> | null = null;
  private frozen = false;
  private structures = "";
  private poses = "";
  private configs = "";
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly now: () => number;
  private readonly viewerTimeoutMs: number;
  private readonly announceIntervalMs: number;
  private readonly assetAckTimeoutMs: number;
  private readonly assetRetryLimit: number;

  constructor(private readonly bus: CompositeBus, private readonly options: OverlayHostOptions) {
    this.now = options.now || (() => Date.now());
    this.viewerTimeoutMs = options.viewerTimeoutMs ?? 7000;
    this.announceIntervalMs = options.announceIntervalMs ?? 2500;
    this.assetAckTimeoutMs = options.assetAckTimeoutMs ?? DEFAULT_ASSET_ACK_TIMEOUT_MS;
    this.assetRetryLimit = options.assetRetryLimit ?? DEFAULT_ASSET_RETRY_LIMIT;
  }

  get viewerIds(): string[] {
    return [...this.viewers.keys()];
  }

  /** Подключённые оверлеи другой сборки: им нужно обновить страницу. */
  get staleViewerIds(): string[] {
    return [...this.viewers.keys()].filter((id) => this.stale.has(id));
  }

  get sceneVersionValue(): number {
    return this.sceneVersion;
  }

  /**
   * Здоровье линии до оверлеев: сколько кадров ушло, сколько выброшено из-за
   * занятого буфера и до какого размера он доходил.
   */
  transportStats(): TransportStats {
    return this.bus.stats();
  }

  start(): void {
    if (this.disposed || this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe((message) => this.receive(message));
    this.timer = setInterval(() => this.sweep(), this.announceIntervalMs);
  }

  /** Publishes only the parts of the preset that actually changed. */
  setPreset(preset: RigPreset): void {
    if (this.disposed) return;
    this.presetRef = preset;
    const structure = structureSignature(preset);
    const pose = poseSignature(preset);
    const config = configSignature(preset);
    const first = this.scene === null;
    const sceneChanged = first || structure !== this.structures;
    const configChanged = first || config !== this.configs;
    const poseChanged = first || pose !== this.poses;

    if (sceneChanged) {
      this.structures = structure;
      this.sceneVersion += 1;
      this.scene = toOverlayScene(preset, this.sceneVersion);
    }
    if (configChanged) {
      this.configs = config;
      this.config = { ...preset.overlay };
    }
    if (poseChanged) {
      this.poses = pose;
      this.bases = basesOf(preset);
    }
    if (!this.scene || !this.config || !this.bases) return;

    if (sceneChanged) this.bus.post({ t: "scene", sender: this.id, scene: this.scene });
    if (configChanged) this.bus.post({ t: "config", sender: this.id, config: this.config });
    if (poseChanged) this.bus.post({ t: "pose", sender: this.id, bases: this.bases });
    // В режиме «Стоп» оверлей показывает ту же нейтральную позу, что и сцена.
    if (this.frozen) this.publishNeutral(this.presetRef);
  }

  /**
   * «Стоп» в редакторе: симуляция не идёт, оверлей получает статичную базовую
   * позу вместо последнего живого кадра.
   */
  setFrozen(frozen: boolean, preset?: RigPreset): void {
    if (this.frozen === frozen) {
      if (frozen && preset) this.publishNeutral(preset);
      return;
    }
    this.frozen = frozen;
    this.presetRef = preset ?? this.presetRef;
    if (frozen) this.publishNeutral(preset ?? this.presetRef);
  }

  private publishNeutral(preset: RigPreset | null): void {
    if (!preset) return;
    // Номер берём из того же счётчика, что и живые кадры: иначе свой счётчик
    // хоста мог совпасть с номером следующего живого кадра, и оверлей отбросил
    // бы его как повтор — источник замирал бы ровно после «Стопа».
    this.bus.post({
      t: "frame", sender: this.id, sceneVersion: this.sceneVersion,
      frame: neutralFrame(preset, nextFrameSeq()),
      colors: Object.keys(this.colors).length ? this.colors : undefined,
    });
  }

  /** Готовые цвета из модулей: их отдаём вместе со следующим кадром. */
  setColors(colors: FrameColors): void {
    this.colors = colors;
  }

  /** Включает/выключает временные элементы управления нативным окном. */
  setWindowControl(enabled: boolean): void {
    if (this.disposed || this.windowControl === enabled) return;
    this.windowControl = enabled;
    this.bus.post({ t: "window-control", sender: this.id, enabled });
  }

  /** Called by the engine loop after every produced frame. */
  pushFrame(frame: RigFrame): void {
    if (this.disposed || this.frozen || this.viewers.size === 0 || !this.scene) return;
    // Номер приходит от редактора и не откатывается при пересоздании движка:
    // оверлей отбрасывает всё, что не новее прошлого кадра.
    this.bus.post({
      t: "frame", sender: this.id, frame, sceneVersion: this.sceneVersion,
      colors: Object.keys(this.colors).length ? this.colors : undefined,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.bus.post({ t: "bye", sender: this.id, role: "host" });
    for (const transfer of [...this.assetTransfers.values()]) this.cancelTransfer(transfer);
    this.activeAssetRequests.clear();
    this.viewers.clear();
    this.stale.clear();
  }

  private receive(message: WireMessage): void {
    if (this.disposed || message.sender === this.id) return;
    if (message.t === "hello") {
      const hello = message as HelloMessage;
      const known = this.viewers.has(hello.sender);
      const wasStale = this.stale.has(hello.sender);
      const stale = Number(hello.protocol) !== OVERLAY_PROTOCOL;
      if (stale) this.stale.add(hello.sender);
      else this.stale.delete(hello.sender);
      this.registerViewer(hello.sender);
      // Оверлей мог обновиться и заговорить на нашем протоколе (или наоборот):
      // об этом надо сказать один раз, а не на каждом hello.
      if (known && stale !== wasStale) this.notifyViewers();
      this.publishAnnounce();
      this.bus.post({ t: "window-control", sender: this.id, enabled: this.windowControl });
      // Full payload only for new viewers or viewers that were rebuilt and lost
      // the scene; otherwise the periodic frame stream is enough.
      if (!known || hello.sceneVersion < this.sceneVersion) this.publishScene();
      if (this.frozen) this.publishNeutral(this.presetRef);
      return;
    }
    if (message.t === "asset-request") {
      this.registerViewer(message.sender);
      // v1-потребитель без requestId получает совместимый ответ одним сообщением.
      if (!message.requestId) {
        void inlineSource(assetRef(message.id)).then((data) => {
          if (data && !this.disposed) this.bus.post({ t: "asset", sender: this.id, id: message.id, data });
        });
      } else {
        this.beginAssetTransfer(message.sender, message.id, message.requestId);
      }
      return;
    }
    if (message.t === "asset-ack") {
      if (message.to !== this.id) return;
      const transfer = this.assetTransfers.get(message.transferId);
      if (!transfer || transfer.viewerId !== message.sender) return;
      const pending = transfer.pending.get(message.index);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      transfer.pending.delete(message.index);
      this.fillAssetWindow(transfer);
      return;
    }
    if (message.t === "asset-error") {
      if (message.to !== this.id) return;
      const key = requestKey(message.sender, message.requestId);
      const transferId = this.activeAssetRequests.get(key);
      if (transferId) {
        const transfer = this.assetTransfers.get(transferId);
        if (transfer) this.cancelTransfer(transfer);
      } else {
        this.activeAssetRequests.delete(key);
      }
      return;
    }
    if (message.t === "window-size") {
      this.registerViewer(message.sender);
      const width = Math.round(Number(message.width));
      const height = Math.round(Number(message.height));
      if (this.windowControl && Number.isFinite(width) && Number.isFinite(height)) {
        this.options.onWindowSize?.(
          Math.max(120, Math.min(7680, width)),
          Math.max(120, Math.min(4320, height)),
        );
      }
      return;
    }
    if (message.t === "bye" && message.role === "viewer") {
      this.stale.delete(message.sender);
      this.cancelViewerTransfers(message.sender);
      if (this.viewers.delete(message.sender)) this.notifyViewers();
      return;
    }
  }

  private registerViewer(id: string): void {
    const known = this.viewers.has(id);
    this.viewers.set(id, this.now());
    if (!known) this.notifyViewers();
  }

  private publishAnnounce(): void {
    this.bus.post({
      t: "announce", sender: this.id, role: "host", protocol: OVERLAY_PROTOCOL,
      host: this.options.hostName, sceneVersion: this.sceneVersion,
    });
  }

  private publishScene(): void {
    if (this.scene) this.bus.post({ t: "scene", sender: this.id, scene: this.scene });
    if (this.config) this.bus.post({ t: "config", sender: this.id, config: this.config });
    if (this.bases) this.bus.post({ t: "pose", sender: this.id, bases: this.bases });
  }

  private sweep(): void {
    if (this.disposed) return;
    const now = this.now();
    let changed = false;
    for (const [id, seen] of this.viewers) {
      if (now - seen > this.viewerTimeoutMs) {
        this.viewers.delete(id);
        this.stale.delete(id);
        changed = true;
      }
    }
    if (changed) this.notifyViewers();
    if (this.viewers.size > 0) this.publishAnnounce();
  }

  private beginAssetTransfer(viewerId: string, id: string, requestId: string): void {
    if (!id || !requestId || this.disposed) return;
    const key = requestKey(viewerId, requestId);
    if (this.activeAssetRequests.has(key)) return;
    this.activeAssetRequests.set(key, null);
    const read = this.options.readAsset ?? readAssetBlob;
    void read(id).then((blob) => {
      if (this.disposed || !this.activeAssetRequests.has(key)) return;
      if (!blob) {
        this.sendAssetError(viewerId, id, requestId, "Не удалось прочитать файл из хранилища.");
        this.activeAssetRequests.delete(key);
        return;
      }
      if (blob.size > MAX_ASSET_BYTES) {
        this.sendAssetError(viewerId, id, requestId, "Файл больше допустимых 256 МиБ.");
        this.activeAssetRequests.delete(key);
        return;
      }
      const transferId = `${this.id}-${Math.random().toString(36).slice(2, 12)}`;
      const chunks = Math.ceil(blob.size / ASSET_CHUNK_SIZE);
      const transfer: AssetTransfer = {
        transferId, requestKey: key, viewerId, requestId, assetId: id, blob,
        chunks, nextIndex: 0, pending: new Map(),
      };
      this.assetTransfers.set(transferId, transfer);
      this.activeAssetRequests.set(key, transferId);
      this.bus.post({
        t: "asset-start", sender: this.id, to: viewerId, id, requestId, transferId,
        size: blob.size, mime: blob.type || "application/octet-stream",
        chunkSize: ASSET_CHUNK_SIZE, chunks,
      });
      this.fillAssetWindow(transfer);
    }).catch((reason: unknown) => {
      if (this.disposed || !this.activeAssetRequests.has(key)) return;
      this.sendAssetError(viewerId, id, requestId,
        reason instanceof Error ? reason.message : "Ошибка чтения файла.");
      this.activeAssetRequests.delete(key);
    });
  }

  private fillAssetWindow(transfer: AssetTransfer): void {
    if (this.assetTransfers.get(transfer.transferId) !== transfer) return;
    while (transfer.pending.size < MAX_IN_FLIGHT_CHUNKS && transfer.nextIndex < transfer.chunks) {
      const index = transfer.nextIndex++;
      transfer.pending.set(index, { data: null, retries: 0, timer: null, sending: false });
      void this.sendAssetChunk(transfer, index);
    }
    if (transfer.nextIndex >= transfer.chunks && transfer.pending.size === 0) this.finishTransfer(transfer);
  }

  private async sendAssetChunk(transfer: AssetTransfer, index: number): Promise<void> {
    const pending = transfer.pending.get(index);
    if (!pending || pending.sending || this.assetTransfers.get(transfer.transferId) !== transfer) return;
    pending.sending = true;
    try {
      if (pending.data === null) {
        const start = index * ASSET_CHUNK_SIZE;
        const bytes = new Uint8Array(await transfer.blob.slice(start, start + ASSET_CHUNK_SIZE).arrayBuffer());
        pending.data = bytesToBase64(bytes);
      }
      if (this.assetTransfers.get(transfer.transferId) !== transfer
          || transfer.pending.get(index) !== pending) return;
      pending.sending = false;
      pending.timer = setTimeout(() => this.retryAssetChunk(transfer, index), this.assetAckTimeoutMs);
      this.bus.post({
        t: "asset-chunk", sender: this.id, to: transfer.viewerId, id: transfer.assetId,
        transferId: transfer.transferId, index, data: pending.data,
      });
    } catch {
      pending.sending = false;
      this.failTransfer(transfer, "Не удалось подготовить фрагмент файла.");
    }
  }

  private retryAssetChunk(transfer: AssetTransfer, index: number): void {
    const pending = transfer.pending.get(index);
    if (!pending || this.assetTransfers.get(transfer.transferId) !== transfer) return;
    pending.timer = null;
    if (pending.retries >= this.assetRetryLimit) {
      this.failTransfer(transfer, "Оверлей не подтвердил файл после повторных попыток.");
      return;
    }
    pending.retries += 1;
    void this.sendAssetChunk(transfer, index);
  }

  private sendAssetError(viewerId: string, id: string, requestId: string, reason: string): void {
    this.bus.post({ t: "asset-error", sender: this.id, to: viewerId, id, requestId, reason });
  }

  private failTransfer(transfer: AssetTransfer, reason: string): void {
    this.sendAssetError(transfer.viewerId, transfer.assetId, transfer.requestId, reason);
    this.cancelTransfer(transfer);
  }

  private finishTransfer(transfer: AssetTransfer): void {
    for (const chunk of transfer.pending.values()) if (chunk.timer) clearTimeout(chunk.timer);
    transfer.pending.clear();
    this.assetTransfers.delete(transfer.transferId);
    this.activeAssetRequests.delete(transfer.requestKey);
  }

  private cancelTransfer(transfer: AssetTransfer): void {
    for (const chunk of transfer.pending.values()) if (chunk.timer) clearTimeout(chunk.timer);
    transfer.pending.clear();
    this.assetTransfers.delete(transfer.transferId);
    this.activeAssetRequests.delete(transfer.requestKey);
  }

  private cancelViewerTransfers(viewerId: string): void {
    for (const transfer of [...this.assetTransfers.values()]) {
      if (transfer.viewerId === viewerId) this.cancelTransfer(transfer);
    }
    for (const key of this.activeAssetRequests.keys()) {
      if (key.startsWith(`${viewerId}\u0000`)) this.activeAssetRequests.delete(key);
    }
  }

  private notifyViewers(): void {
    this.options.onViewers?.(this.viewerIds);
  }
}
