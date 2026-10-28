import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_OVERLAY, type RigPreset } from "../types";
import { drawRig, SpriteAssets, viewTransform } from "../render/rigCanvas";
import { applyColors } from "../render/color";
import { createCollector, resetCollector } from "../render/lighting";
import { MediaAssets, MaskMedia } from "../render/media";
import { assetIdsOfPreset, ensureAssetsOfPreset, onAssetsChanged, unresolvedAssetIds } from "../engine/assets";
import { createOverlayBus } from "./bus";
import { OverlayClient, type OverlayClientSnapshot } from "./client";
import { overlayBackground, scenePreset } from "./protocol";
import { isTauri, overlayBridgeUrl } from "./window";
import { createOnDemandLoop } from "../engine/frameSignal";

function transportOptions(params: URLSearchParams, bridgeUrl: string | null) {
  const transport = params.get("transport");
  return {
    broadcast: transport !== "ws" && transport !== "tauri",
    tauri: transport !== "ws" && transport !== "broadcast",
    websocket: transport !== "tauri" && transport !== "broadcast" && !!bridgeUrl,
    bridgeUrl,
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
  // Окно захвата — та же отрисовка, но непрозрачная и без служебных подсказок.
  const capture = params.get("capture") === "1";
  const canvas = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<OverlayClient | null>(null);
  const presetRef = useRef<RigPreset | null>(null);
  const assets = useRef(new SpriteAssets());
  const mediaAssets = useRef(new MediaAssets());
  /** Свет и нормали кадра: объём считается и в оверлее. */
  const lighting = createCollector();
  /** Видео-маски: маской бывает фильм, и тогда «окно» живёт вместе с ним. */
  const maskMedia = useRef(new MaskMedia());
  /**
   * Планировщик отрисовки. Цикла нет: холст перерисовывается только когда есть
   * новый кадр или изменились настройки, поэтому неподвижный риг не грузит
   * процессор (постоянный rAF заставлял WebView собирать кадр 60 раз в секунду).
   */
  const loop = useRef<{ request: () => void; stop: () => void } | null>(null);
  const markDirty = () => loop.current?.request();
  const [snapshot, setSnapshot] = useState<OverlayClientSnapshot | null>(null);
  const [fps, setFps] = useState(0);

  useEffect(() => {
    let disposed = false;
    let client: OverlayClient | null = null;
    void (async () => {
      // Страница из окна приложения не угадывает адрес релея: он у встроенного
      // сервера приложения. В браузере и в источнике OBS адрес выводится из
      // `location` — там мост живёт на том же хосте.
      const bridge = await overlayBridgeUrl(params.toString());
      if (disposed) return;
      const bus = await createOverlayBus(transportOptions(params, bridge));
      if (disposed) { bus.close(); return; }
      client = new OverlayClient(bus, {});
      clientRef.current = client;
      client.subscribe(() => setSnapshot(client!.snapshot()));
      // Кадры приходят чаще, чем меняется состояние, и React на них не нужен:
      // каждый кадр только будит отрисовку холста (через ref — планировщик
      // создаётся отдельным эффектом и может пересоздаваться).
      client.subscribeFrames(() => loop.current?.request());
      client.start();
      setSnapshot(client.snapshot());
    })();
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
  // Фон общий с оверлеем: прозрачность сохраняется, альфа уходит в запись.
  const { mode: background, color: backgroundColor } = overlayBackground(config, { capture, native: isTauri() });

  useEffect(() => {
    // Оверлей и окно захвата живут на том же origin, что и редактор, поэтому
    // файлы берутся из общего хранилища webview по ссылкам `asset:<id>`.
    if (preset) ensureAssetsOfPreset(preset);
    assets.current.sync(preset?.objects ?? []);
    markDirty();
  }, [preset]);

  useEffect(() => onAssetsChanged(() => {
    if (presetRef.current) assets.current.sync(presetRef.current.objects);
    loop.current?.request();
  }), []);

  /**
   * Файл, которого нет в локальном хранилище, оверлей просит у редактора.
   *
   * Так работает источник браузера в OBS: страница приходит со встроенного
   * сервера приложения, это другой origin, и IndexedDB редактора ей не видна.
   * Список запросов сбрасывается на новой версии сцены, чтобы потерянный
   * ответ можно было запросить заново.
   */
  const requestedAssets = useRef(new Set<string>());
  const sceneVersion = snapshot?.scene?.version ?? 0;
  useEffect(() => { requestedAssets.current.clear(); }, [sceneVersion]);
  useEffect(() => {
    if (!preset) return;
    for (const id of unresolvedAssetIds(assetIdsOfPreset(preset))) {
      if (requestedAssets.current.has(id)) continue;
      requestedAssets.current.add(id);
      clientRef.current?.requestAsset(id);
    }
  }, [preset, sceneVersion]);

  useEffect(() => assets.current.onChange(() => markDirty()), []);

  useEffect(() => {
    document.title = capture
      ? `YappyTuberPlus — окно захвата${snapshot?.scene ? ` · ${snapshot.scene.name}` : ""}`
      : snapshot?.scene ? `${snapshot.scene.name} — оверлей` : "YappyTuberPlus — оверлей";
    document.body.classList.toggle("overlay-guide", guide);
    document.body.classList.toggle("overlay-capture", capture);
  }, [capture, guide, snapshot?.scene, background]);

  useEffect(() => {
    let lastSeq = -1;
    let frames = 0;
    let windowStart = performance.now();

    /**
     * Отрисовка по требованию. Постоянный rAF здесь не нужен: пустой, но вечный
     * цикл заставляет WebView собирать композитный кадр 60 раз в секунду даже
     * при неподвижном риге — на прозрачном окне это чистый расход процессора.
     * Кадр рисуется только по новому кадру от редактора или по правке настроек.
     */
    const render = () => {
      const element = canvas.current;
      if (!element) return;
      const client = clientRef.current;
      const frame = client?.frame ?? null;
      const colors = client?.colors ?? null;
      const current = presetRef.current;
      const sequence = frame?.seq ?? -1;
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
      mediaAssets.current.sync(current, frame);
      maskMedia.current.sync(current.objects.flatMap((object) => (
        object.mask?.kind === "file" && object.mask.file ? [object.mask.file] : []
      )));
      resetCollector(lighting);
      // Цвета из модулей приходят рядом с кадром: ядро их не считает. Нет
      // цветов — у объектов остаются свои, как и было.
      const colored = colors ? applyColors(current, colors) : current;
      drawRig(ctx, colored, frame, assets.current, {
        media: mediaAssets.current, maskMedia: maskMedia.current, lighting,
        environment: current.environment,
      });
      ctx.restore();
      if (guide) {
        ctx.save();
        ctx.strokeStyle = "#82d5c1aa";
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 5]);
        ctx.strokeRect(transform.offsetX + 0.5, transform.offsetY + 0.5, current.canvas.width * transform.scaleX, current.canvas.height * transform.scaleY);
        ctx.restore();
      }

      // Видео меняется само: пока оно играет, просим следующий кадр.
      if (mediaAssets.current.active() || maskMedia.current.active()) loop.current?.request();

      const now = performance.now();
      if (guide && now - windowStart >= 1000) {
        setFps(Math.round(frames * 1000 / (now - windowStart)));
        frames = 0;
        windowStart = now;
      }
    };

    const scheduler = createOnDemandLoop(render);
    loop.current = scheduler;
    // Подписка на кадры живёт в эффекте клиента (он один на всё окно) и будит
    // именно текущий планировщик. Здесь — только размер окна: он меняется
    // редко, но без перерисовки холст остался бы растянутым.
    const onResize = () => scheduler.request();
    window.addEventListener("resize", onResize);
    scheduler.request();
    return () => {
      window.removeEventListener("resize", onResize);
      scheduler.stop();
      mediaAssets.current.dispose();
      maskMedia.current.dispose();
      if (loop.current === scheduler) loop.current = null;
    };
  }, [guide, background, backgroundColor]);

  const missingAssets = preset ? unresolvedAssetIds(assetIdsOfPreset(preset)).length : 0;

  return (
    <div className={`overlay-root ${guide ? "guide" : ""} ${capture ? "capture" : ""}`}>
      <canvas ref={canvas} className="overlay-canvas" />
      {capture && isTauri() && (
        <div className="capture-bar" data-tauri-drag-region>
          <span data-tauri-drag-region>YappyTuberPlus · окно захвата</span>
          <button
            type="button"
            title="Закрыть окно захвата"
            onClick={() => { void import("@tauri-apps/api/window").then((api) => api.getCurrentWindow().close()); }}
          >×</button>
        </div>
      )}
      {capture && snapshot?.status !== "live" && (
        <div className="capture-waiting">
          <b>Ожидание кадров</b>
          <span>Откройте её в Rig Studio: окно захвата получает кадры от редактора.</span>
        </div>
      )}
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
            {/* Невидимый слой чаще всего — картинка, которую оверлей ещё не
                получил: байты лежат в хранилище редактора, а у страницы в OBS
                своё хранилище. Строка говорит об этом прямо, вместо того чтобы
                оставлять пустое место в эфире. */}
            {missingAssets > 0 && (
              <span className="overlay-missing">картинок не получено: {missingAssets}</span>
            )}
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
