import type { BasePose, OverlayConfig, RigFrame } from "../types";
import type { CompositeBus } from "./bus";
import { OVERLAY_PROTOCOL, type OverlayScene, type WireMessage } from "./protocol";
import { acceptAssetData } from "../engine/assets";

export type OverlayStatus = "connecting" | "waiting" | "live" | "stale";

export interface OverlayClientSnapshot {
  status: OverlayStatus;
  host: string | null;
  scene: OverlayScene | null;
  config: OverlayConfig | null;
  bases: Record<string, BasePose> | null;
  frameCount: number;
  transport: string;
}

export interface OverlayClientOptions {
  now?: () => number;
  /** A viewer pings this often while waiting for the scene. */
  helloIntervalMs?: number;
  /** No host message for this long means the editor is gone. */
  staleAfterMs?: number;
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
  status: OverlayStatus = "connecting";
  host: string | null = null;
  frameCount = 0;
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
  private readonly now: () => number;
  private readonly helloIntervalMs: number;
  private readonly staleAfterMs: number;
  private disposed = false;

  constructor(private readonly bus: CompositeBus, options: OverlayClientOptions = {}) {
    this.now = options.now || (() => Date.now());
    this.helloIntervalMs = options.helloIntervalMs ?? 2000;
    this.staleAfterMs = options.staleAfterMs ?? 8000;
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
    };
  }

  /** Просит у редактора файл, которого нет в локальном хранилище. */
  requestAsset(id: string): void {
    if (this.disposed || !id) return;
    this.bus.post({ t: "asset-request", sender: this.id, id });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.bus.post({ t: "bye", sender: this.id, role: "viewer" });
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
        this.frameCount += 1;
        for (const listener of this.frameListeners) listener();
        if (this.status !== "live") this.update("live");
        break;
      }
      case "asset": {
        // Файл пришёл от редактора: кэш оверлея общий с редактором по ссылке.
        acceptAssetData(message.id, message.data);
        break;
      }
      default:
        break;
    }
  }

  private update(status: OverlayStatus): void {
    this.status = status;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
