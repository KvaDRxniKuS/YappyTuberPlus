import type { BasePose, OverlayConfig, RigFrame, RigPreset } from "../types";

/**
 * Wire protocol between the editor (single owner of the Rust runtime) and any
 * number of overlay windows (thin renderers).
 *
 * The overlay never advances simulation state. It receives the static scene
 * once, small base-pose and config patches when they change, and prepared
 * frames produced by the editor's runtime. That keeps exactly one active
 * driver per rig, as required by docs/DESIGN.md §13.3.
 */

export const OVERLAY_CHANNEL = "yappytuberplus.overlay.v1";
export const OVERLAY_EVENT = "yappytuberplus://overlay";
export const OVERLAY_PROTOCOL = 1;
export const OVERLAY_MARKER = "yappytuberplus-overlay";

/** Objects are sent without scripts: the overlay only draws. */
export interface OverlayScene {
  version: number;
  name: string;
  canvas: { width: number; height: number };
  objects: RigPreset["objects"];
}

export interface HelloMessage {
  t: "hello";
  sender: string;
  role: "viewer";
  protocol: number;
  /** Scene version the viewer already holds, so the host can skip resending it. */
  sceneVersion: number;
}

export interface AnnounceMessage {
  t: "announce";
  sender: string;
  role: "host";
  protocol: number;
  host: string;
  sceneVersion: number;
}

export interface SceneMessage {
  t: "scene";
  sender: string;
  scene: OverlayScene;
}

export interface ConfigMessage {
  t: "config";
  sender: string;
  config: OverlayConfig;
}

export interface PoseMessage {
  t: "pose";
  sender: string;
  bases: Record<string, BasePose>;
}

export interface FrameMessage {
  t: "frame";
  sender: string;
  frame: RigFrame;
  sceneVersion: number;
}

export interface ByeMessage {
  t: "bye";
  sender: string;
  role: "viewer" | "host";
}

/** Sent by the optional WebSocket bridge so clients can report transport health. */
export interface BridgeMessage {
  t: "bridge";
  sender: "bridge";
  status: "ready" | "no-host";
}

export type WireMessage =
  | HelloMessage | AnnounceMessage | SceneMessage | ConfigMessage
  | PoseMessage | FrameMessage | ByeMessage | BridgeMessage;

const MESSAGE_TYPES = new Set([
  "hello", "announce", "scene", "config", "pose", "frame", "bye", "bridge",
]);

export function isWireMessage(value: unknown): value is WireMessage {
  if (!value || typeof value !== "object") return false;
  const type = (value as { t?: unknown }).t;
  return typeof type === "string" && MESSAGE_TYPES.has(type);
}

/**
 * Image data URLs are large, so scene signatures only carry a stable numeric
 * id per image instead of hashing megabytes on every keystroke.
 */
const imageIds = new Map<string, number>();
let nextImageId = 1;

function imageId(source: string | null): number {
  if (!source) return 0;
  const existing = imageIds.get(source);
  if (existing) return existing;
  if (imageIds.size > 512) imageIds.clear();
  const id = nextImageId++;
  imageIds.set(source, id);
  return id;
}

export function structureSignature(preset: RigPreset): string {
  return JSON.stringify({
    canvas: preset.canvas,
    name: preset.name,
    objects: preset.objects.map((object) => [
      object.id, object.kind, object.parentId, object.name,
      object.pivot.x, object.pivot.y, object.width, object.height,
      imageId(object.image),
    ]),
  });
}

export function poseSignature(preset: RigPreset): string {
  return JSON.stringify(preset.objects.map((object) => [object.id, object.base]));
}

export function configSignature(preset: RigPreset): string {
  return JSON.stringify(preset.overlay);
}

export function basesOf(preset: RigPreset): Record<string, BasePose> {
  return Object.fromEntries(preset.objects.map((object) => [object.id, object.base]));
}

export function toOverlayScene(preset: RigPreset, version: number): OverlayScene {
  return {
    version,
    name: preset.name,
    canvas: { ...preset.canvas },
    objects: preset.objects.map((object) => ({ ...object, script: "" })),
  };
}

/**
 * Combines the static scene with the latest base-pose patch into a drawable
 * preset. Called only when one of the inputs changes.
 */
export function scenePreset(
  scene: OverlayScene,
  bases: Record<string, BasePose> | null,
  config: OverlayConfig,
): RigPreset {
  return {
    version: 2,
    name: scene.name,
    canvas: scene.canvas,
    globals: "",
    runtime: { fpsMode: "limited", fpsLimit: 60 },
    overlay: config,
    objects: scene.objects.map((object) => ({
      ...object,
      base: bases?.[object.id] ? { ...object.base, ...bases[object.id] } : object.base,
    })),
  };
}

export function bridgeUrlFromLocation(search: string, location: Location | URL | null): string | null {
  const params = new URLSearchParams(search);
  const explicit = params.get("bridge");
  if (explicit) return explicit;
  const transport = params.get("transport");
  if (transport === "broadcast" || transport === "tauri") return null;
  if (!location) return null;
  const protocol = location.protocol;
  if (protocol !== "http:" && protocol !== "https:") return null;
  return `${protocol === "https:" ? "wss:" : "ws:"}//${location.host}/overlay-ws`;
}
