import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_OVERLAY, type RigPreset } from "../types";
import { drawRig, SpriteAssets, viewTransform } from "../render/rigCanvas";
import { createOverlayBus } from "./bus";
import { OverlayClient, type OverlayClientSnapshot } from "./client";
import { bridgeUrlFromLocation, scenePreset } from "./protocol";

function transportOptions(params: URLSearchParams) {
  const transport = params.get("transport");
  return {
    broadcast: transport !== "ws" && transport !== "tauri",
    tauri: transport !== "ws" && transport !== "broadcast",
    websocket: transport !== "tauri" && transport !== "broadcast",
    bridgeUrl: bridgeUrlFromLocation(params.toString(), window.location),
  };
}

const STATUS_LABEL: Record<OverlayClientSnapshot["status"], string> = {
  connecting: "Подключение…",
  waiting: "Ожидание кадров",
  live: "В эфире",
  stale: "Редактор не отвечает",
};

/**
 * OBS overlay: a transparent, chrome-free window that only draws the latest
 * prepared frames from the editor's runtime. It has no UI unless `?guide=1`.
 */
export function OverlayApp() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const guide = params.get("guide") === "1";
  const canvas = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<OverlayClient | null>(null);
  const presetRef = useRef<RigPreset | null>(null);
  const assets = useRef(new SpriteAssets());
  const dirty = useRef(true);
  const [snapshot, setSnapshot] = useState<OverlayClientSnapshot | null>(null);
  const [fps, setFps] = useState(0);

  useEffect(() => {
    let disposed = false;
    let client: OverlayClient | null = null;
    void createOverlayBus(transportOptions(params)).then((bus) => {
      if (disposed) { bus.close(); return; }
      client = new OverlayClient(bus, {});
      clientRef.current = client;
      client.subscribe(() => setSnapshot(client!.snapshot()));
      client.start();
      setSnapshot(client.snapshot());
    });
    const onUnload = () => client?.dispose();
    window.addEventListener("beforeunload", onUnload);
    return () => {
      disposed = true;
      window.removeEventListener("beforeunload", onUnload);
      clientRef.current = null;
      client?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const preset = useMemo(() => {
    if (!snapshot?.scene) return null;
    return scenePreset(snapshot.scene, snapshot.bases, snapshot.config ?? DEFAULT_OVERLAY);
  }, [snapshot?.scene, snapshot?.bases, snapshot?.config]);
  presetRef.current = preset;

  const config = snapshot?.config ?? null;
  const background = config?.background ?? "transparent";
  const backgroundColor = config?.background === "chroma" ? config.chromaColor : config?.color;

  useEffect(() => {
    assets.current.sync(preset?.objects ?? []);
    dirty.current = true;
  }, [preset]);

  useEffect(() => assets.current.onChange(() => { dirty.current = true; }), []);

  useEffect(() => {
    document.title = snapshot?.scene ? `${snapshot.scene.name} — оверлей` : "YappyTuberPlus — оверлей";
    document.body.classList.toggle("overlay-guide", guide);
  }, [guide, snapshot?.scene, background]);

  useEffect(() => {
    let animation = 0;
    let lastSeq = -1;
    let frames = 0;
    let windowStart = performance.now();
    let drawn = false;

    const render = () => {
      animation = requestAnimationFrame(render);
      const element = canvas.current;
      if (!element) return;
      const client = clientRef.current;
      const frame = client?.frame ?? null;
      const current = presetRef.current;
      const sequence = frame?.seq ?? -1;
      if (drawn && !dirty.current && sequence === lastSeq) return;
      dirty.current = false;
      drawn = true;
      if (sequence !== lastSeq) {
        if (sequence > lastSeq && lastSeq >= 0) frames += 1;
        lastSeq = sequence;
      }
      const width = window.innerWidth;
      const height = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      if (element.width !== pixelWidth || element.height !== pixelHeight) {
        element.width = pixelWidth;
        element.height = pixelHeight;
      }
      const ctx = element.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (background === "color" || background === "chroma") {
        ctx.fillStyle = backgroundColor || "#000";
        ctx.fillRect(0, 0, width, height);
      } else if (guide) {
        drawChecker(ctx, width, height);
      }
      if (!current) return;
      const transform = viewTransform(current.overlay.scaleMode, current.canvas, width, height);
      ctx.save();
      ctx.translate(transform.offsetX, transform.offsetY);
      ctx.scale(transform.scaleX, transform.scaleY);
      drawRig(ctx, current, frame, assets.current);
      ctx.restore();
      if (guide) {
        ctx.save();
        ctx.strokeStyle = "#82d5c1aa";
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 5]);
        ctx.strokeRect(transform.offsetX + 0.5, transform.offsetY + 0.5, current.canvas.width * transform.scaleX, current.canvas.height * transform.scaleY);
        ctx.restore();
      }

      const now = performance.now();
      if (guide && now - windowStart >= 1000) {
        setFps(Math.round(frames * 1000 / (now - windowStart)));
        frames = 0;
        windowStart = now;
      }
    };
    animation = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animation);
  }, [guide, background, backgroundColor]);

  return (
    <div className={`overlay-root ${guide ? "guide" : ""}`}>
      <canvas ref={canvas} className="overlay-canvas" />
      {guide && (
        <div className="overlay-hud">
          <div className={`overlay-pill ${snapshot?.status || "connecting"}`}>
            <span className="overlay-dot" />
            <b>{STATUS_LABEL[snapshot?.status || "connecting"]}</b>
            <span>{snapshot?.host ? `${snapshot.host} · ` : ""}#{snapshot?.scene?.version ?? 0}</span>
          </div>
          <div className="overlay-meta">
            <span>{snapshot?.scene ? `${snapshot.scene.canvas.width} × ${snapshot.scene.canvas.height}` : "нет сцены"}</span>
            <span>{fps} FPS рендера</span>
            <span>{snapshot?.config?.scaleMode ?? "contain"}</span>
            <span>транспорт: {snapshot?.transport || "…"}</span>
            <span>{snapshot?.frameCount ?? 0} кадров</span>
          </div>
          {!snapshot?.scene && (
            <div className="overlay-hint">
              <b>Оверлей ждёт редактор</b>
              <span>Откройте Rig Studio и нажмите «Открыть оверлей» в диалоге оверлея.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function drawChecker(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const size = 24;
  ctx.save();
  ctx.fillStyle = "#15181c";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#1b1f24";
  for (let y = 0; y < height; y += size) {
    for (let x = (y / size) % 2 === 0 ? 0 : size; x < width; x += size * 2) {
      ctx.fillRect(x, y, Math.min(size, width - x), Math.min(size, height - y));
    }
  }
  ctx.restore();
}
