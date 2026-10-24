import type { BasePose, OverlayConfig, RigFrame, RigPreset } from "../types";
import type { CompositeBus } from "./bus";
import {
  basesOf, configSignature, OVERLAY_PROTOCOL, poseSignature, structureSignature,
  toOverlayScene, type HelloMessage, type OverlayScene, type WireMessage,
} from "./protocol";

export interface OverlayHostOptions {
  hostName: string;
  onViewers?: (viewers: string[]) => void;
  now?: () => number;
  /** A viewer that stays silent for this long is considered gone. */
  viewerTimeoutMs?: number;
  /** Periodic announce also acts as the host heartbeat for viewers. */
  announceIntervalMs?: number;
}

/**
 * The editor side of the overlay link. The host owns the only runtime and
 * therefore the only frame clock; overlays are read-only subscribers.
 */
export class OverlayHost {
  readonly id = `host-${Math.random().toString(36).slice(2, 10)}`;
  private viewers = new Map<string, number>();
  private scene: OverlayScene | null = null;
  private sceneVersion = 0;
  private config: OverlayConfig | null = null;
  private bases: Record<string, BasePose> | null = null;
  private structures = "";
  private poses = "";
  private configs = "";
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly now: () => number;
  private readonly viewerTimeoutMs: number;
  private readonly announceIntervalMs: number;

  constructor(private readonly bus: CompositeBus, private readonly options: OverlayHostOptions) {
    this.now = options.now || (() => Date.now());
    this.viewerTimeoutMs = options.viewerTimeoutMs ?? 7000;
    this.announceIntervalMs = options.announceIntervalMs ?? 2500;
  }

  get viewerIds(): string[] {
    return [...this.viewers.keys()];
  }

  get sceneVersionValue(): number {
    return this.sceneVersion;
  }

  start(): void {
    if (this.disposed || this.unsubscribe) return;
    this.unsubscribe = this.bus.subscribe((message) => this.receive(message));
    this.timer = setInterval(() => this.sweep(), this.announceIntervalMs);
  }

  /** Publishes only the parts of the preset that actually changed. */
  setPreset(preset: RigPreset): void {
    if (this.disposed) return;
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
  }

  /** Called by the engine loop after every produced frame. */
  pushFrame(frame: RigFrame): void {
    if (this.disposed || this.viewers.size === 0 || !this.scene) return;
    this.bus.post({ t: "frame", sender: this.id, frame, sceneVersion: this.sceneVersion });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.bus.post({ t: "bye", sender: this.id, role: "host" });
    this.viewers.clear();
  }

  private receive(message: WireMessage): void {
    if (this.disposed || message.sender === this.id) return;
    if (message.t === "hello") {
      const hello = message as HelloMessage;
      const known = this.viewers.has(hello.sender);
      this.registerViewer(hello.sender);
      this.publishAnnounce();
      // Full payload only for new viewers or viewers that were rebuilt and lost
      // the scene; otherwise the periodic frame stream is enough.
      if (!known || hello.sceneVersion < this.sceneVersion) this.publishScene();
      return;
    }
    if (message.t === "bye" && message.role === "viewer") {
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
        changed = true;
      }
    }
    if (changed) this.notifyViewers();
    if (this.viewers.size > 0) this.publishAnnounce();
  }

  private notifyViewers(): void {
    this.options.onViewers?.(this.viewerIds);
  }
}
