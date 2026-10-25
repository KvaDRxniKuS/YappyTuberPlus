import type { OverlayConfig } from "../types";

export const OVERLAY_LABEL = "rig-overlay";
/** Отдельное окно для программ записи: его выбирают как источник «Захват окна». */
export const CAPTURE_LABEL = "rig-capture";
const BROWSER_WINDOW_NAME = "yappytuberplus-overlay";
const BROWSER_CAPTURE_NAME = "yappytuberplus-capture";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface OverlayUrlOptions {
  guide?: boolean;
  transport?: string;
  bridge?: string;
}

/** Размер холста пресета: он же размер окна оверлея по умолчанию. */
export type CanvasSize = { width: number; height: number };

/**
 * Размер окна оверлея и окна захвата.
 *
 * По умолчанию окно равно холсту пресета: так риг виден 1:1, а изменение
 * размера холста тянет окно за собой. Ручной размер (`followCanvas: false`)
 * остаётся для тех, кому нужно окно другого размера — вписывание масштабирует
 * картинку.
 */
export function overlaySize(
  config: OverlayConfig,
  canvas?: CanvasSize | null,
): { width: number; height: number } {
  const follow = config.followCanvas !== false && canvas && canvas.width > 0 && canvas.height > 0;
  const width = follow ? canvas!.width : config.width;
  const height = follow ? canvas!.height : config.height;
  return {
    width: Math.max(120, Math.min(7680, Math.round(width))),
    height: Math.max(120, Math.min(4320, Math.round(height))),
  };
}

/** Absolute URL of the overlay page, valid in Vite dev and in the Tauri build. */
export function overlayUrl(config: OverlayConfig, options: OverlayUrlOptions = {}): string {
  const base = new URL(`${import.meta.env.BASE_URL || "/"}overlay.html`, window.location.href);
  base.searchParams.set("overlay", "1");
  if (options.guide ?? config.showGuide) base.searchParams.set("guide", "1");
  if (options.transport) base.searchParams.set("transport", options.transport);
  if (options.bridge) base.searchParams.set("bridge", options.bridge);
  return base.toString();
}

/**
 * Адрес встроенного сервера оверлея.
 *
 * В нативном приложении сервер поднимается сам: он отдаёт страницу оверлея и
 * релей `/overlay-ws`, поэтому источнику браузера в OBS больше не нужен
 * отдельный `npm run overlay:bridge`. В браузере сервера нет — вернётся `null`,
 * и диалог покажет прежнюю ссылку через мост.
 */
export async function overlayServerUrl(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const url = await invoke<string | null>("overlay_server_url");
    return url || null;
  } catch {
    return null;
  }
}

export interface OverlayWindowResult {
  ok: boolean;
  mode: "tauri" | "browser";
  error?: string;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Opens the overlay as a transparent native window (Tauri) or as a second
 * browser window (dev preview). In the browser the page is still fully
 * functional; only the transparency and click-through flags are unavailable.
 */
export async function openOverlayWindow(
  url: string,
  config: OverlayConfig,
  canvas?: CanvasSize | null,
): Promise<OverlayWindowResult> {
  if (isTauri()) {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const existing = await WebviewWindow.getByLabel(OVERLAY_LABEL);
      if (existing) {
        await existing.show();
        await existing.setFocus();
        await applyOverlayWindow(config, canvas);
        return { mode: "tauri", ok: true };
      }
      const size = overlaySize(config, canvas);
      const error = await new Promise<string | null>((resolve) => {
        const window_ = new WebviewWindow(OVERLAY_LABEL, {
          // Адрес только свой (страница приложения): у чужого origin
          // (например, http://127.0.0.1 встроенного сервера) нет доступа к IPC
          // Tauri, и окно осталось бы без кадров. Ссылка на встроенный сервер
          // нужна только для источника браузера в OBS.
          url,
          title: "YappyTuberPlus Overlay",
          width: size.width,
          height: size.height,
          transparent: true,
          decorations: false,
          shadow: false,
          resizable: true,
          skipTaskbar: true,
          alwaysOnTop: config.alwaysOnTop,
          focus: false,
          visible: true,
        });
        void window_.once("tauri://created", () => resolve(null));
        void window_.once("tauri://error", (event) => resolve(message(event.payload)));
      });
      if (error) return { mode: "tauri", ok: false, error };
      await applyOverlayWindow(config, canvas);
      return { mode: "tauri", ok: true };
    } catch (reason) {
      return { mode: "tauri", ok: false, error: message(reason) };
    }
  }

  const size = overlaySize(config, canvas);
  const features = [
    "popup=yes",
    `width=${Math.max(240, size.width)}`,
    `height=${Math.max(160, size.height)}`,
  ].join(",");
  const popup = window.open(url, BROWSER_WINDOW_NAME, features);
  if (!popup) {
    return { mode: "browser", ok: false, error: "Браузер заблокировал окно оверлея — разрешите всплывающие окна" };
  }
  popup.focus();
  return { mode: "browser", ok: true };
}

/** Applies live window flags (size, always-on-top, click-through) in Tauri. */
export async function applyOverlayWindow(
  config: OverlayConfig,
  canvas?: CanvasSize | null,
): Promise<void> {
  if (!isTauri()) return;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const window_ = await WebviewWindow.getByLabel(OVERLAY_LABEL);
    if (!window_) return;
    const { LogicalSize } = await import("@tauri-apps/api/dpi");
    await window_.setAlwaysOnTop(config.alwaysOnTop);
    await window_.setIgnoreCursorEvents(config.clickThrough);
    const size = overlaySize(config, canvas);
    await window_.setSize(new LogicalSize(size.width, size.height));
  } catch {
    /* Window may be closed or a permission may be missing — not fatal. */
  }
}

export async function closeOverlayWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const window_ = await WebviewWindow.getByLabel(OVERLAY_LABEL);
    await window_?.close();
  } catch {
    /* ignore */
  }
}

/**
 * Адрес страницы окна захвата. Это та же страница оверлея, но с флагом
 * `capture=1`: у неё есть полоса перетаскивания, подсказка «ожидание кадров»
 * и нет служебной рамки. Настройки окна и фон общие с оверлеем.
 */
export function captureUrl(): string {
  const base = new URL(`${import.meta.env.BASE_URL || "/"}overlay.html`, window.location.href);
  base.searchParams.set("capture", "1");
  return base.toString();
}

let browserCapture: Window | null = null;

/**
 * Открывает окно захвата. В приложении это отдельное нативное окно без рамки и
 * прозрачности — его видно в списке окон OBS, а перетаскивается оно за верхнюю
 * полосу. В браузере (режим разработки) открывается обычное всплывающее окно.
 */
export async function openCaptureWindow(
  config: OverlayConfig,
  canvas?: CanvasSize | null,
): Promise<OverlayWindowResult> {
  if (isTauri()) {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const existing = await WebviewWindow.getByLabel(CAPTURE_LABEL);
      if (existing) {
        await existing.show();
        await existing.setFocus();
        await applyCaptureWindow(config, canvas);
        return { mode: "tauri", ok: true };
      }
      const captureSize = overlaySize(config, canvas);
      const error = await new Promise<string | null>((resolve) => {
        const window_ = new WebviewWindow(CAPTURE_LABEL, {
          url: captureUrl(),
          title: "YappyTuberPlus — окно захвата",
          width: Math.max(160, captureSize.width),
          height: Math.max(120, captureSize.height),
          // Прозрачность сохраняем: так альфа уходит в «Захват окна» с
          // включённой опцией прозрачности, как у Spout2/PNGTuber.
          transparent: true,
          decorations: false,
          shadow: false,
          resizable: true,
          skipTaskbar: false,
          alwaysOnTop: false,
          focus: true,
          visible: true,
        });
        void window_.once("tauri://created", () => resolve(null));
        void window_.once("tauri://error", (event) => resolve(message(event.payload)));
      });
      if (error) return { mode: "tauri", ok: false, error };
      await applyCaptureWindow(config, canvas);
      return { mode: "tauri", ok: true };
    } catch (reason) {
      return { mode: "tauri", ok: false, error: message(reason) };
    }
  }

  const popupSize = overlaySize(config, canvas);
  const features = [
    "popup=yes",
    `width=${Math.max(160, popupSize.width)}`,
    `height=${Math.max(120, popupSize.height)}`,
    "menubar=no",
    "toolbar=no",
  ].join(",");
  const popup = window.open(captureUrl(), BROWSER_CAPTURE_NAME, features);
  if (!popup) {
    return { mode: "browser", ok: false, error: "Браузер заблокировал окно захвата — разрешите всплывающие окна" };
  }
  browserCapture = popup;
  popup.focus();
  return { mode: "browser", ok: true };
}

export async function captureWindowOpen(): Promise<boolean> {
  if (!isTauri()) return !!browserCapture && !browserCapture.closed;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    return !!(await WebviewWindow.getByLabel(CAPTURE_LABEL));
  } catch {
    return false;
  }
}

export async function closeCaptureWindow(): Promise<void> {
  if (!isTauri()) {
    browserCapture?.close();
    browserCapture = null;
    return;
  }
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const window_ = await WebviewWindow.getByLabel(CAPTURE_LABEL);
    await window_?.close();
  } catch {
    /* ignore */
  }
}

/** Размер окна захвата повторяет настройку оверлея. */
export async function applyCaptureWindow(
  config: OverlayConfig,
  canvas?: CanvasSize | null,
): Promise<void> {
  if (!isTauri()) return;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const window_ = await WebviewWindow.getByLabel(CAPTURE_LABEL);
    if (!window_) return;
    const { LogicalSize } = await import("@tauri-apps/api/dpi");
    const size = overlaySize(config, canvas);
    await window_.setSize(new LogicalSize(
      Math.max(160, size.width),
      Math.max(120, size.height),
    ));
  } catch {
    /* окно могли закрыть — не критично */
  }
}
