import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { RigFrame, RigPreset } from "../types";
import { createOverlayBus, type CompositeBus } from "../overlay/bus";
import { OverlayHost } from "../overlay/host";
import { overlayBridgeUrl } from "../overlay/window";

export interface OverlayHostState {
  /** Frame sink that the engine loop calls after every produced frame. */
  sinkRef: RefObject<((frame: RigFrame) => void) | null>;
  viewers: string[];
  transport: string;
  bridgeUrl: string | null;
  bridgeReady: boolean;
  /** «Стоп»: оверлей показывает нейтральную позу вместо живых кадров. */
  setFrozen: (frozen: boolean, preset?: RigPreset) => void;
}

/**
 * Какие транспорты поднимать. Адрес релея приходит снаружи: в окне приложения
 * его знает встроенный сервер, а не `location` (см. `overlayBridgeUrl`).
 */
function transportOptions(bridgeUrl: string | null) {
  const params = new URLSearchParams(window.location.search);
  const transport = params.get("transport");
  const allowed = transport !== "tauri" && transport !== "broadcast";
  return {
    broadcast: transport !== "ws" && transport !== "tauri",
    tauri: transport !== "ws" && transport !== "broadcast",
    websocket: allowed && !!bridgeUrl,
    bridgeUrl,
  };
}

/**
 * Publishes the editor's prepared frames to overlay windows.
 *
 * The editor keeps ownership of the runtime: overlays only subscribe. This is
 * the MVP form of docs/DESIGN.md §13.3 — one active driver, no double
 * advancement of stateful formulas.
 */
export function useOverlayHost(preset: RigPreset): OverlayHostState {
  const [viewers, setViewers] = useState<string[]>([]);
  const [transport, setTransport] = useState("подключение…");
  const [bridgeReady, setBridgeReady] = useState(false);
  const [bridgeUrl, setBridgeUrl] = useState<string | null>(null);
  const sinkRef = useRef<((frame: RigFrame) => void) | null>(null);
  const frozenRef = useRef(false);
  const hostRef = useRef<OverlayHost | null>(null);
  const busRef = useRef<CompositeBus | null>(null);
  const presetRef = useRef(preset);
  presetRef.current = preset;

  useEffect(() => {
    let disposed = false;
    void (async () => {
      // В приложении адрес релея отдаёт встроенный сервер, поэтому порядок
      // такой: сначала адрес, потом транспорт. Угаданный `tauri.localhost`
      // давал вечное «мост не отвечает» и ноль оверлеев.
      const bridge = await overlayBridgeUrl();
      if (disposed) return;
      setBridgeUrl(bridge);
      const bus = await createOverlayBus(transportOptions(bridge));
      if (disposed) {
        bus.close();
        return;
      }
      busRef.current = bus;
      const host = new OverlayHost(bus, {
        hostName: presetRef.current.name,
        onViewers: (ids) => { if (!disposed) setViewers(ids); },
      });
      host.start();
      host.setPreset(presetRef.current);
      host.setFrozen(frozenRef.current, presetRef.current);
      hostRef.current = host;
      sinkRef.current = (frame) => host.pushFrame(frame);
      setTransport(bus.label);
      setBridgeReady(bus.parts.some((part) => part.kind === "websocket" && part.ready));
    })();

    const poll = window.setInterval(() => {
      const bus = busRef.current;
      if (!bus) return;
      const socket = bus.parts.find((part) => part.kind === "websocket");
      setBridgeReady(!!socket?.ready);
    }, 2000);

    return () => {
      disposed = true;
      window.clearInterval(poll);
      sinkRef.current = null;
      hostRef.current?.dispose();
      hostRef.current = null;
      busRef.current?.close();
      busRef.current = null;
    };
  }, []);

  useEffect(() => {
    hostRef.current?.setPreset(preset);
  }, [preset]);

  const setFrozen = useCallback((frozen: boolean, preset?: RigPreset) => {
    frozenRef.current = frozen;
    hostRef.current?.setFrozen(frozen, preset ?? presetRef.current);
  }, []);

  return { sinkRef, viewers, transport, bridgeUrl, bridgeReady, setFrozen };
}
