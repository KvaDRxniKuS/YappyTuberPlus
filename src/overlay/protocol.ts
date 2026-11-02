import type { BasePose, EnvironmentSpec, OverlayConfig, RigFrame, RigPreset } from "../types";
import { PRESET_FORMAT } from "../version";

/**
 * Wire protocol between the editor (single owner of the Rust runtime) and any
 * number of overlay windows (thin renderers).
 *
 * The overlay never advances simulation state. It receives the static scene
 * once, small base-pose and config patches when they change, and prepared
 * frames produced by the editor's runtime. That keeps exactly one active
 * driver per rig, as required by docs/DESIGN.md §13.3.
 */

export const OVERLAY_CHANNEL = "yappytuberplus.overlay.v2";
export const OVERLAY_EVENT = "yappytuberplus://overlay";
export const OVERLAY_PROTOCOL = 2;
export const OVERLAY_MARKER = "yappytuberplus-overlay";

/** Objects are sent without scripts: the overlay only draws. */
export interface OverlayScene {
  version: number;
  name: string;
  canvas: { width: number; height: number };
  /** Lighting environment is renderer state too (not an engine input). */
  environment?: EnvironmentSpec;
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

/**
 * Готовые цвета объектов из модулей: `{ "obj": { fill: { r, g, b, a } } }`.
 *
 * Ядро цвета не знает, поэтому они едут рядом с кадром, а не внутри него. Поле
 * необязательное: оверлей старой сборки его просто не читает, и протокол
 * остаётся прежним.
 */
export type FrameColors = Record<string, Partial<Record<string, { r: number; g: number; b: number; a: number }>>>;

export interface FrameMessage {
  t: "frame";
  sender: string;
  frame: RigFrame;
  sceneVersion: number;
  /** Цвета с этого кадра; нет — у объектов остаются свои. */
  colors?: FrameColors;
}

export interface ByeMessage {
  t: "bye";
  sender: string;
  role: "viewer" | "host";
}

/**
 * Файл объекта: оверлей просит его у редактора.
 *
 * Ссылки `asset:<id>` разрешаются хранилищем webview, но страница Browser Source
 * в OBS живёт на другом origin и не видит IndexedDB редактора. Поэтому она
 * запрашивает `Blob` у хоста, получает его фрагментами с ACK/retry и кэширует
 * только собранный файл.
 */
export interface AssetRequestMessage {
  t: "asset-request";
  sender: string;
  id: string;
  /** Absent only for a legacy v1 viewer using the single-message reply. */
  requestId?: string;
}

/** Начало передачи: размер позволяет проверить собранный Blob. */
export interface AssetStartMessage {
  t: "asset-start";
  sender: string;
  to: string;
  id: string;
  requestId: string;
  transferId: string;
  size: number;
  mime: string;
  chunkSize: number;
  chunks: number;
}

/** Один небольшой base64-фрагмент; каждое сообщение укладывается в лимит релея. */
export interface AssetChunkMessage {
  t: "asset-chunk";
  sender: string;
  to: string;
  id: string;
  transferId: string;
  index: number;
  data: string;
}

/** Подтверждение фрагмента; без него хост повторит отправку. */
export interface AssetAckMessage {
  t: "asset-ack";
  sender: string;
  to: string;
  transferId: string;
  index: number;
}

/** Ошибка запроса/передачи с объяснением для HUD оверлея. */
export interface AssetErrorMessage {
  t: "asset-error";
  sender: string;
  to: string;
  id: string;
  requestId: string;
  reason: string;
}

/** Ответ редактора одним сообщением оставлен для совместимости со старыми клиентами. */
export interface AssetMessage {
  t: "asset";
  sender: string;
  id: string;
  data: string;
}

/** Временная команда редактора: показать интерактивные элементы нативного окна. */
export interface WindowControlMessage {
  t: "window-control";
  sender: string;
  enabled: boolean;
}

/** Ручной размер нативного окна: редактор запишет его в настройки пресета. */
export interface WindowSizeMessage {
  t: "window-size";
  sender: string;
  width: number;
  height: number;
}

/** Sent by the optional WebSocket bridge so clients can report transport health. */
export interface BridgeMessage {
  t: "bridge";
  sender: "bridge";
  status: "ready" | "no-host";
}

export type WireMessage =
  | HelloMessage | AnnounceMessage | SceneMessage | ConfigMessage
  | PoseMessage | FrameMessage | ByeMessage | BridgeMessage
  | AssetRequestMessage | AssetStartMessage | AssetChunkMessage | AssetAckMessage
  | AssetErrorMessage | AssetMessage | WindowControlMessage | WindowSizeMessage;

const MESSAGE_TYPES = new Set([
  "hello", "announce", "scene", "config", "pose", "frame", "bye", "bridge",
  "asset-request", "asset-start", "asset-chunk", "asset-ack", "asset-error", "asset",
  "window-control", "window-size",
]);

export function isWireMessage(value: unknown): value is WireMessage {
  if (!value || typeof value !== "object") return false;
  const type = (value as { t?: unknown }).t;
  return typeof type === "string" && MESSAGE_TYPES.has(type);
}

/**
 * Короткий отпечаток источника без удержания целой data URL в глобальной Map.
 * Старые самодостаточные пресеты всё ещё могут принести большую data URL.
 */
function sourceKey(source: string | null | undefined): string | 0 {
  if (!source) return 0;
  if (!source.startsWith("data:")) return source;
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `data:${source.length}:${first >>> 0}:${second >>> 0}`;
}

function channelSignature(channel: NonNullable<RigPreset["objects"][number]["material"]>["roughness"]): unknown {
  return [channel.value, sourceKey(channel.file), channel.from, channel.packedChannel];
}

export function structureSignature(preset: RigPreset): string {
  return JSON.stringify({
    canvas: preset.canvas,
    name: preset.name,
    environment: preset.environment ?? null,
    objects: preset.objects.map((object) => [
      object.id, object.kind, object.parentId, object.name,
      object.pivot.x, object.pivot.y, object.width, object.height,
      sourceKey(object.image),
      // Базовая поза приходит отдельно (`pose`); скрипты исполняет только хост.
      object.enabled !== false,
      object.media ? [sourceKey(object.media.src), object.media.type, object.media.loop,
        object.media.autoplay, object.media.muted, object.media.volume, object.media.speed,
        object.media.repeat, object.media.fade, object.media.voices, object.media.fileName] : null,
      object.text ? [object.text.template, object.text.font, object.text.size, object.text.color,
        object.text.align, object.text.bold, object.text.italic, object.text.strokeColor,
        object.text.strokeWidth, object.text.lineHeight] : null,
      object.shape ? [object.shape.draw, object.shape.fill, object.shape.stroke, object.shape.strokeWidth,
        object.shape.items] : null,
      object.light ? [object.light.shape, object.light.angle, object.light.radius,
        object.light.colorStart, object.light.colorEnd, object.light.softness,
        object.light.brightness, object.light.blend, object.light.heightMode,
        object.light.height, object.light.specular] : null,
      object.normal ? [sourceKey(object.normal.src), object.normal.strength, object.normal.animate] : null,
      object.material ? [
        channelSignature(object.material.roughness), channelSignature(object.material.metallic),
        channelSignature(object.material.ao), object.material.emissive.color,
        object.material.emissive.strength, sourceKey(object.material.emissive.file),
        sourceKey(object.material.packed), object.material.specular, object.material.ior,
      ] : null,
      object.colors ?? null,
      object.mask ? [object.mask.kind, object.mask.shapeId, object.mask.points,
        sourceKey(object.mask.file), object.mask.origin, object.mask.invert, object.mask.feather] : null,
      object.warp ? [object.warp.enabled, object.warp.frame, object.warp.corners] : null,
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
    ...(preset.environment ? { environment: { ...preset.environment } } : {}),
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
    version: PRESET_FORMAT,
    name: scene.name,
    canvas: scene.canvas,
    ...(scene.environment ? { environment: scene.environment } : {}),
    globals: "",
    runtime: { fpsMode: "limited", fpsLimit: 60 },
    overlay: config,
    modules: [],
    objects: scene.objects.map((object) => ({
      ...object,
      base: bases?.[object.id] ? { ...object.base, ...bases[object.id] } : object.base,
    })),
  };
}

/**
 * Какой фон рисовать в окне оверлея или захвата.
 *
 * Прозрачность — основной режим для программ записи (как Spout2 в VTube Studio
 * или PNGTuber): нативное окно отдаёт альфу, и в запись попадает только риг.
 * Браузер прозрачных окон не умеет, поэтому в превью окна захвата подставляется
 * тёмный цвет — иначе на белом фоне ничего не видно.
 */
export function overlayBackground(
  config: OverlayConfig | null,
  options: { capture?: boolean; native?: boolean } = {},
): { mode: "transparent" | "color" | "chroma"; color: string | null } {
  const mode = config?.background ?? "transparent";
  if (mode === "chroma") return { mode, color: config?.chromaColor ?? "#00b140" };
  if (mode === "color") return { mode, color: config?.color ?? "#0f1215" };
  if (options.capture && !options.native) return { mode: "color", color: "#0f1215" };
  return { mode, color: null };
}

/**
 * Страница живёт внутри окна приложения (Tauri), а не на обычном сайте.
 *
 * На Windows нативная сборка отдаёт страницу с `http://tauri.localhost`, в
 * Linux/macOS — с `tauri://localhost`; адреса `ipc.localhost` и `asset.localhost`
 * тоже принадлежат приложению. Ни у одного из них нет моста `/overlay-ws`:
 * релей живёт на встроенном сервере (по умолчанию `127.0.0.1:17800`). Раньше
 * адрес моста угадывался из `location`, и редактор в приложении стучался в
 * `ws://tauri.localhost/overlay-ws` — отсюда «Оверлей не подключён» и
 * «WS-мост не отвечает» при живом встроенном сервере.
 */
export function isAppOrigin(location: Location | URL | null): boolean {
  if (!location) return false;
  const protocol = location.protocol;
  if (protocol !== "http:" && protocol !== "https:") return true;
  const host = location.hostname;
  return host === "tauri.localhost" || host === "tauri.local"
    || host === "ipc.localhost" || host === "asset.localhost";
}

/**
 * Адрес моста из параметров страницы.
 *
 * Явный `?bridge=` важнее всего. `transport=broadcast|tauri` выключает мост,
 * как и окно приложения: там мост берётся у встроенного сервера
 * (`overlayBridgeUrl` в `window.ts`), а не угадывается по адресу страницы.
 */
export function bridgeUrlFromLocation(search: string, location: Location | URL | null): string | null {
  const params = new URLSearchParams(search);
  const explicit = params.get("bridge");
  if (explicit) return explicit;
  const transport = params.get("transport");
  if (transport === "broadcast" || transport === "tauri") return null;
  if (!location) return null;
  const protocol = location.protocol;
  if (protocol !== "http:" && protocol !== "https:") return null;
  if (isAppOrigin(location)) return null;
  return `${protocol === "https:" ? "wss:" : "ws:"}//${location.host}/overlay-ws`;
}
