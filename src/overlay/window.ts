import type { OverlayConfig } from "../types";

export const OVERLAY_LABEL = "rig-overlay";
const BROWSER_WINDOW_NAME = "yappytuberplus-overlay";

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
