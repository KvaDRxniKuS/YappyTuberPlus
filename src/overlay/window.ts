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

/** Absolute URL of the overlay page, valid in Vite dev and in the Tauri build. */
export function overlayUrl(config: OverlayConfig, options: OverlayUrlOptions = {}): string {
  const base = new URL(`${import.meta.env.BASE_URL || "/"}overlay.html`, window.location.href);
  base.searchParams.set("overlay", "1");
  if (options.guide ?? config.showGuide) base.searchParams.set("guide", "1");
  if (options.transport) base.searchParams.set("transport", options.transport);
  if (options.bridge) base.searchParams.set("bridge", options.bridge);
  return base.toString();
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
export async function openOverlayWindow(url: string, config: OverlayConfig): Promise<OverlayWindowResult> {
  if (isTauri()) {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const existing = await WebviewWindow.getByLabel(OVERLAY_LABEL);
      if (existing) {
        await existing.show();
        await existing.setFocus();
        await applyOverlayWindow(config);
        return { mode: "tauri", ok: true };
      }
      const error = await new Promise<string | null>((resolve) => {
        const window_ = new WebviewWindow(OVERLAY_LABEL, {
          url,
          title: "YappyTuberPlus Overlay",
          width: Math.max(120, Math.round(config.width)),
          height: Math.max(120, Math.round(config.height)),
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
      await applyOverlayWindow(config);
      return { mode: "tauri", ok: true };
    } catch (reason) {
      return { mode: "tauri", ok: false, error: message(reason) };
    }
  }

  const features = [
    "popup=yes",
    `width=${Math.max(240, Math.round(config.width))}`,
    `height=${Math.max(160, Math.round(config.height))}`,
  ].join(",");
  const popup = window.open(url, BROWSER_WINDOW_NAME, features);
  if (!popup) {
    return { mode: "browser", ok: false, error: "Браузер заблокировал окно оверлея — разрешите всплывающие окна" };
  }
  popup.focus();
  return { mode: "browser", ok: true };
}

/** Applies live window flags (size, always-on-top, click-through) in Tauri. */
export async function applyOverlayWindow(config: OverlayConfig): Promise<void> {
  if (!isTauri()) return;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const window_ = await WebviewWindow.getByLabel(OVERLAY_LABEL);
    if (!window_) return;
    const { LogicalSize } = await import("@tauri-apps/api/dpi");
    await window_.setAlwaysOnTop(config.alwaysOnTop);
    await window_.setIgnoreCursorEvents(config.clickThrough);
    await window_.setSize(new LogicalSize(
      Math.max(120, Math.round(config.width)),
      Math.max(120, Math.round(config.height)),
    ));
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
export async function openCaptureWindow(config: OverlayConfig): Promise<OverlayWindowResult> {
  if (isTauri()) {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const existing = await WebviewWindow.getByLabel(CAPTURE_LABEL);
      if (existing) {
        await existing.show();
        await existing.setFocus();
        await applyCaptureWindow(config);
        return { mode: "tauri", ok: true };
      }
      const error = await new Promise<string | null>((resolve) => {
        const window_ = new WebviewWindow(CAPTURE_LABEL, {
          url: captureUrl(),
          title: "YappyTuberPlus — окно захвата",
          width: Math.max(160, Math.round(config.width)),
          height: Math.max(120, Math.round(config.height)),
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
      await applyCaptureWindow(config);
      return { mode: "tauri", ok: true };
    } catch (reason) {
      return { mode: "tauri", ok: false, error: message(reason) };
    }
  }

  const features = [
    "popup=yes",
    `width=${Math.max(160, Math.round(config.width))}`,
    `height=${Math.max(120, Math.round(config.height))}`,
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
export async function applyCaptureWindow(config: OverlayConfig): Promise<void> {
  if (!isTauri()) return;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const window_ = await WebviewWindow.getByLabel(CAPTURE_LABEL);
    if (!window_) return;
    const { LogicalSize } = await import("@tauri-apps/api/dpi");
    await window_.setSize(new LogicalSize(
      Math.max(160, Math.round(config.width)),
      Math.max(120, Math.round(config.height)),
    ));
  } catch {
    /* окно могли закрыть — не критично */
  }
}
