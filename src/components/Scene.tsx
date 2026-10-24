import { useEffect, useRef, useState, type RefObject } from "react";
import {
  Crosshair, Focus, Grid3X3, Hand, LocateFixed, MousePointer2,
  ZoomIn, ZoomOut,
} from "lucide-react";
import type { BasePose, RigFrame, RigObject, RigPreset } from "../types";
import {
  drawRig, invertAffine, objectMatrix, orderedSprites, SpriteAssets, staticValues, transformPoint,
} from "../render/rigCanvas";

export type SceneTool = "move" | "pivot" | "pan";

interface SceneProps {
  preset: RigPreset;
  frameRef: RefObject<RigFrame | null>;
  selectedId: string | null;
  tool: SceneTool;
  showGrid: boolean;
  onTool: (tool: SceneTool) => void;
  onToggleGrid: () => void;
  onSelect: (id: string | null) => void;
  onDragStart: () => void;
  onDragObjects: (id: string, initial: Record<string, BasePose>, delta: { x: number; y: number }) => void;
  onPivot: (id: string, pivot: { x: number; y: number }) => void;
}

type Camera = { zoom: number; x: number; y: number };
type Interaction =
  | { type: "drag"; id: string; start: { x: number; y: number }; initial: Record<string, BasePose> }
  | { type: "pan"; startX: number; startY: number; camera: Camera }
  | null;

export function Scene(props: SceneProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const camera = useRef<Camera>({ zoom: 0.8, x: 80, y: 40 });
  const [zoomLabel, setZoomLabel] = useState(80);
  const assets = useRef(new SpriteAssets());
  const dirty = useRef(true);
  const interaction = useRef<Interaction>(null);
  const spaceDown = useRef(false);
  const initialized = useRef(false);
  const presetRef = useRef(props.preset);
  presetRef.current = props.preset;

  const setCamera = (next: Camera) => {
    camera.current = next;
    setZoomLabel(Math.round(next.zoom * 100));
    dirty.current = true;
  };

  const fit = () => {
    const element = viewport.current;
    if (!element) return;
    const width = element.clientWidth;
    const height = element.clientHeight;
    const { canvas: scene } = presetRef.current;
    const zoom = Math.max(0.05, Math.min((width - 70) / scene.width, (height - 70) / scene.height, 2));
    setCamera({ zoom, x: (width - scene.width * zoom) / 2, y: (height - scene.height * zoom) / 2 });
  };

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (!initialized.current && element.clientWidth > 0) {
        initialized.current = true;
        fit();
      }
      dirty.current = true;
    });
    observer.observe(element);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const imageKey = props.preset.objects.map((object) => object.image).filter(Boolean).join("|");
  useEffect(() => {
    assets.current.sync(props.preset.objects);
    dirty.current = true;
  }, [imageKey, props.preset.objects]);

  useEffect(() => assets.current.onChange(() => { dirty.current = true; }), []);

  useEffect(() => { dirty.current = true; }, [props.preset, props.selectedId, props.showGrid, props.tool]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.code === "Space" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
        spaceDown.current = true;
      }
    };
    const keyUp = (event: KeyboardEvent) => { if (event.code === "Space") spaceDown.current = false; };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => { window.removeEventListener("keydown", keyDown); window.removeEventListener("keyup", keyUp); };
  }, []);

  useEffect(() => {
    let animation = 0;
    let lastSequence = -1;
    const render = () => {
      const sequence = props.frameRef.current?.seq ?? -1;
      if (dirty.current || sequence !== lastSequence) {
        dirty.current = false;
        lastSequence = sequence;
        draw();
      }
      animation = requestAnimationFrame(render);
    };
    animation = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const draw = () => {
    const element = canvas.current;
    const host = viewport.current;
    if (!element || !host) return;
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width < 1 || height < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (element.width !== pixelWidth || element.height !== pixelHeight) {
      element.width = pixelWidth;
      element.height = pixelHeight;
    }
    const ctx = element.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#14171b";
    ctx.fillRect(0, 0, width, height);

    const { zoom, x, y } = camera.current;
    const preset = presetRef.current;
    const frame = props.frameRef.current;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(zoom, zoom);
    ctx.shadowColor = "#00000055";
    ctx.shadowBlur = 24 / zoom;
    ctx.fillStyle = "#24292f";
    ctx.fillRect(0, 0, preset.canvas.width, preset.canvas.height);
    ctx.shadowColor = "transparent";
    drawTransparency(ctx, preset.canvas.width, preset.canvas.height);
    if (props.showGrid) drawGrid(ctx, preset.canvas.width, preset.canvas.height, zoom);

    drawRig(ctx, preset, frame, assets.current, { placeholders: true, lineScale: zoom });
    ctx.strokeStyle = "#454d57";
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(0, 0, preset.canvas.width, preset.canvas.height);

    const selected = preset.objects.find((object) => object.id === props.selectedId);
    if (selected) drawSelection(ctx, selected, frame, zoom, props.tool === "pivot");
    ctx.restore();

    ctx.fillStyle = "#77818c";
    ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.fillText(`${preset.canvas.width} × ${preset.canvas.height}`, Math.max(8, x + 2), Math.max(14, y - 10));
  };

  const drawSelection = (ctx: CanvasRenderingContext2D, object: RigObject, frame: RigFrame | null, zoom: number, pivotMode: boolean) => {
    const values = frame?.objects[object.id] || staticValues(object);
    const matrix = objectMatrix(object, values);
    ctx.save();
    ctx.strokeStyle = pivotMode ? "#e4bd7c" : "#81dbc5";
    ctx.fillStyle = pivotMode ? "#e4bd7c" : "#81dbc5";
    ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([5 / zoom, 4 / zoom]);
    if (object.kind === "sprite") {
      const px = object.pivot.x * object.width;
      const py = object.pivot.y * object.height;
      const points = [
        transformPoint(matrix, -px, -py),
        transformPoint(matrix, object.width - px, -py),
        transformPoint(matrix, object.width - px, object.height - py),
        transformPoint(matrix, -px, object.height - py),
      ];
      ctx.beginPath();
      points.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
      ctx.closePath();
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const pivot = transformPoint(matrix, 0, 0);
    const size = 7 / zoom;
    ctx.beginPath();
    ctx.moveTo(pivot.x - size, pivot.y); ctx.lineTo(pivot.x + size, pivot.y);
    ctx.moveTo(pivot.x, pivot.y - size); ctx.lineTo(pivot.x, pivot.y + size);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pivot.x, pivot.y, 2.4 / zoom, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const screenPoint = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const scenePoint = (event: { clientX: number; clientY: number }) => {
    const point = screenPoint(event);
    return {
      x: (point.x - camera.current.x) / camera.current.zoom,
      y: (point.y - camera.current.y) / camera.current.zoom,
    };
  };

  const hitTest = (point: { x: number; y: number }): RigObject | null => {
    const frame = props.frameRef.current;
    const ordered = orderedSprites(presetRef.current, frame);
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const object = ordered[index];
      const values = frame?.objects[object.id] || staticValues(object);
      if (values.visible === 0) continue;
      const local = transformPoint(invertAffine(objectMatrix(object, values)), point.x, point.y);
      const left = -object.pivot.x * object.width;
      const top = -object.pivot.y * object.height;
      if (local.x >= left && local.x <= left + object.width && local.y >= top && local.y <= top + object.height) return object;
    }
    return null;
  };

  return (
    <section className="scene-panel panel-surface">
      <div className="scene-toolbar">
        <div className="scene-title"><span className="eyebrow">ПРЕВЬЮ</span><h2>Сцена</h2></div>
        <div className="scene-tools">
          <button className={props.tool === "move" ? "active" : ""} title="Выделение и перемещение (V)" onClick={() => props.onTool("move")}><MousePointer2 size={15} /></button>
          <button className={props.tool === "pivot" ? "active" : ""} title="Пивот (P)" onClick={() => props.onTool("pivot")}><Crosshair size={15} /></button>
          <button className={props.tool === "pan" ? "active" : ""} title="Панорамирование (Space)" onClick={() => props.onTool("pan")}><Hand size={15} /></button>
          <span className="tool-separator" />
          <button className={props.showGrid ? "active" : ""} title="Сетка" onClick={props.onToggleGrid}><Grid3X3 size={15} /></button>
          <button title="Вписать сцену" onClick={fit}><Focus size={15} /></button>
        </div>
      </div>
      <div className={`scene-viewport tool-${props.tool}`} ref={viewport}>
        <canvas
          ref={canvas}
          onPointerDown={(event) => {
            if (event.button !== 0 && event.button !== 1) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const pan = props.tool === "pan" || event.button === 1 || spaceDown.current;
            if (pan) {
              const point = screenPoint(event);
              interaction.current = { type: "pan", startX: point.x, startY: point.y, camera: { ...camera.current } };
              return;
            }
            const point = scenePoint(event);
            if (props.tool === "pivot" && props.selectedId) {
              const object = presetRef.current.objects.find((item) => item.id === props.selectedId && item.kind === "sprite");
              if (object) {
                const values = props.frameRef.current?.objects[object.id] || staticValues(object);
                const local = transformPoint(invertAffine(objectMatrix(object, values)), point.x, point.y);
                props.onPivot(object.id, {
                  x: (local.x + object.pivot.x * object.width) / object.width,
                  y: (local.y + object.pivot.y * object.height) / object.height,
                });
                return;
              }
            }
            const hit = hitTest(point);
            if (!hit) { props.onSelect(null); return; }
            props.onSelect(hit.id);
            props.onDragStart();
            const initial = Object.fromEntries(presetRef.current.objects.map((object) => [object.id, { ...object.base }]));
            interaction.current = { type: "drag", id: hit.id, start: point, initial };
          }}
          onPointerMove={(event) => {
            const current = interaction.current;
            if (!current) return;
            if (current.type === "pan") {
              const point = screenPoint(event);
              setCamera({ ...current.camera, x: current.camera.x + point.x - current.startX, y: current.camera.y + point.y - current.startY });
              return;
            }
            const point = scenePoint(event);
            let delta = { x: point.x - current.start.x, y: point.y - current.start.y };
            if (event.shiftKey) {
              if (Math.abs(delta.x) >= Math.abs(delta.y)) delta = { x: delta.x, y: 0 };
              else delta = { x: 0, y: delta.y };
            }
            props.onDragObjects(current.id, current.initial, delta);
          }}
          onPointerUp={(event) => {
            interaction.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { interaction.current = null; }}
          onWheel={(event) => {
            event.preventDefault();
            const point = screenPoint(event);
            const scene = { x: (point.x - camera.current.x) / camera.current.zoom, y: (point.y - camera.current.y) / camera.current.zoom };
            const zoom = Math.min(4, Math.max(0.08, camera.current.zoom * Math.exp(-event.deltaY * 0.0012)));
            setCamera({ zoom, x: point.x - scene.x * zoom, y: point.y - scene.y * zoom });
          }}
        />
      </div>
      <div className="scene-statusbar">
        <span><LocateFixed size={12} /> {props.tool === "move" ? "Перемещение меняет базовую позу" : props.tool === "pivot" ? "Клик по спрайту задаёт пивот" : "Панорамирование"}</span>
        <div className="zoom-control">
          <button onClick={() => setCamera({ ...camera.current, zoom: Math.max(0.08, camera.current.zoom / 1.2) })}><ZoomOut size={13} /></button>
          <b>{zoomLabel}%</b>
          <button onClick={() => setCamera({ ...camera.current, zoom: Math.min(4, camera.current.zoom * 1.2) })}><ZoomIn size={13} /></button>
        </div>
      </div>
    </section>
  );
}

function drawTransparency(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const size = 24;
  ctx.save();
  ctx.fillStyle = "#292f35";
  for (let y = 0; y < height; y += size) {
    for (let x = (y / size) % 2 === 0 ? 0 : size; x < width; x += size * 2) {
      ctx.fillRect(x, y, Math.min(size, width - x), Math.min(size, height - y));
    }
  }
  ctx.restore();
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, zoom: number) {
  ctx.save();
  ctx.strokeStyle = "#b7c5d00d";
  ctx.lineWidth = 1 / zoom;
  ctx.beginPath();
  for (let x = 50; x < width; x += 50) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
  for (let y = 50; y < height; y += 50) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
  ctx.stroke();
  ctx.restore();
}
