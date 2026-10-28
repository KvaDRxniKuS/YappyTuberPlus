import type { BasePose, OverlayConfig, RigFrame, RigPreset } from "../types";
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
 * Ссылки `asset:<id>` разрешаются хранилищем webview, но страница оверлея может
 * жить на другом origin — источник браузера в OBS открывает её со встроенного
 * сервера приложения. В этом случае IndexedDB редактора недоступна, и файл
 * приходит по протоколу (один раз на файл, с кэшем на стороне оверлея).
 */
export interface AssetRequestMessage {
  t: "asset-request";
  sender: string;
  id: string;
}

/** Ответ редактора: файл в виде data URL. */
export interface AssetMessage {
  t: "asset";
  sender: string;
  id: string;
  data: string;
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
  | AssetRequestMessage | AssetMessage;

const MESSAGE_TYPES = new Set([
  "hello", "announce", "scene", "config", "pose", "frame", "bye", "bridge",
  "asset-request", "asset",
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
      // Медиа живёт в оверлее своим элементом, поэтому смена файла или настроек
      // воспроизведения — это новая сцена, а не только новый кадр.
      object.media ? [imageId(object.media.src), object.media.type, object.media.loop,
        object.media.autoplay, object.media.muted, object.media.volume, object.media.speed,
        object.media.repeat, object.media.fade, object.media.voices, object.media.fileName] : null,
      object.text ? [object.text.template, object.text.font, object.text.size, object.text.color,
        object.text.align, object.text.bold, object.text.italic, object.text.strokeColor,
        object.text.strokeWidth, object.text.lineHeight] : null,
      // Глаз в структуре: без этого оверлей держал бы старую видимость, пока
      // не изменится что-то ещё — «в редакторе слой есть, в OBS его нет».
      object.enabled !== false,
      // Фигуры, маски и деформация — тоже часть сцены. Раньше они в подпись не
      // попадали, и правка маски/контура до OBS не доезжала вовсе.
      object.shape ? [
        object.shape.draw, object.shape.fill, object.shape.stroke, object.shape.strokeWidth,
        object.shape.items,
      ] : null,
      object.mask ? [
        object.mask.kind, object.mask.shapeId, object.mask.points, imageId(object.mask.file),
        object.mask.invert, object.mask.feather,
      ] : null,
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
