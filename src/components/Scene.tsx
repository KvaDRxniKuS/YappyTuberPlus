import { useEffect, useRef, useState, type RefObject } from "react";
import {
  CircleDot, Crosshair, Focus, Grid3X3, Hand, LocateFixed, MousePointer2,
  Scan, ZoomIn, ZoomOut,
} from "lucide-react";
import type { BasePose, GuideMode, RigFrame, RigObject, RigPreset } from "../types";
import { GUIDE_LABEL } from "../types";
import {
  drawRig, invertAffine, objectMatrix, orderedSprites, SpriteAssets, staticValues,
  transformPoint, type Affine,
} from "../render/rigCanvas";

export type SceneTool = "move" | "pivot" | "pan";

interface SceneProps {
  preset: RigPreset;
  frameRef: RefObject<RigFrame | null>;
  selectedId: string | null;
  tool: SceneTool;
  showGrid: boolean;
  bounds: GuideMode;
  pivots: GuideMode;
  onTool: (tool: SceneTool) => void;
  onToggleGrid: () => void;
  onCycleBounds: () => void;
  onCyclePivots: () => void;
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

const GRID_COLOR = "#8fa3ad2e";
const GRID_MAJOR = "#8fa3ad59";
const BOUNDS_COLOR = "#6fb4a3";
const BOUNDS_SELECTED = "#9be3d1";
const PIVOT_COLOR = "#e4bd7c";

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
  // Отрисовка живёт в одном rAF-цикле, поэтому берём актуальные props через ref:
  // иначе замыкание навсегда сохраняет значения первого рендера (из-за этого
  // раньше не переключалась сетка и залипало выделение).
  const propsRef = useRef(props);
  propsRef.current = props;

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
    const { canvas: scene } = props.preset;
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

  useEffect(() => {
    dirty.current = true;
  }, [props.preset, props.selectedId, props.showGrid, props.tool, props.bounds, props.pivots]);

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
      const sequence = propsRef.current.frameRef.current?.seq ?? -1;
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
    const current = propsRef.current;
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
    const preset = current.preset;
    const frame = current.frameRef.current;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(zoom, zoom);
    ctx.shadowColor = "#00000055";
    ctx.shadowBlur = 24 / zoom;
    ctx.fillStyle = "#24292f";
    ctx.fillRect(0, 0, preset.canvas.width, preset.canvas.height);
    ctx.shadowColor = "transparent";
    drawTransparency(ctx, preset.canvas.width, preset.canvas.height);
    if (current.showGrid) drawGrid(ctx, preset.canvas.width, preset.canvas.height, zoom);

    drawRig(ctx, preset, frame, assets.current, { placeholders: true, lineScale: zoom });
    drawGuides(ctx, preset, frame, zoom, current.bounds, current.pivots, current.selectedId);
    drawSelection(ctx, preset, frame, zoom, current.selectedId, current.tool === "pivot");

    ctx.strokeStyle = "#454d57";
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(0, 0, preset.canvas.width, preset.canvas.height);
    ctx.restore();

    ctx.fillStyle = "#77818c";
    ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.fillText(`${preset.canvas.width} × ${preset.canvas.height}`, Math.max(8, x + 2), Math.max(14, y - 10));
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
    const current = propsRef.current;
    const frame = current.frameRef.current;
    const ordered = orderedSprites(current.preset, frame);
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
          <button className={props.showGrid ? "active" : ""} title={`Сетка: ${props.showGrid ? "вкл" : "выкл"}`} onClick={props.onToggleGrid}><Grid3X3 size={15} /></button>
          <button
            className={props.bounds !== "off" ? "active" : ""}
            title={`Границы спрайтов и групп: ${GUIDE_LABEL[props.bounds]}`}
            onClick={props.onCycleBounds}
          >
            <Scan size={15} />
            {props.bounds !== "off" && <span className="tool-state">{props.bounds === "all" ? "все" : "выд."}</span>}
          </button>
          <button
            className={props.pivots !== "off" ? "active" : ""}
            title={`Пивоты: ${GUIDE_LABEL[props.pivots]}`}
            onClick={props.onCyclePivots}
          >
            <CircleDot size={15} />
            {props.pivots !== "off" && <span className="tool-state">{props.pivots === "all" ? "все" : "выд."}</span>}
          </button>
          <span className="tool-separator" />
          <button title="Вписать сцену" onClick={fit}><Focus size={15} /></button>
        </div>
      </div>
      <div className={`scene-viewport tool-${props.tool}`} ref={viewport}>
        <canvas
          ref={canvas}
          onPointerDown={(event) => {
            if (event.button !== 0 && event.button !== 1) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const pan = propsRef.current.tool === "pan" || event.button === 1 || spaceDown.current;
            if (pan) {
              const point = screenPoint(event);
              interaction.current = { type: "pan", startX: point.x, startY: point.y, camera: { ...camera.current } };
              return;
            }
            const point = scenePoint(event);
            if (propsRef.current.tool === "pivot" && propsRef.current.selectedId) {
              const object = propsRef.current.preset.objects.find((item) => item.id === propsRef.current.selectedId && item.kind === "sprite");
              if (object) {
                const values = propsRef.current.frameRef.current?.objects[object.id] || staticValues(object);
                const local = transformPoint(invertAffine(objectMatrix(object, values)), point.x, point.y);
                propsRef.current.onPivot(object.id, {
                  x: (local.x + object.pivot.x * object.width) / object.width,
                  y: (local.y + object.pivot.y * object.height) / object.height,
                });
                return;
              }
            }
            const hit = hitTest(point);
            if (!hit) { propsRef.current.onSelect(null); return; }
            propsRef.current.onSelect(hit.id);
            propsRef.current.onDragStart();
            const initial = Object.fromEntries(propsRef.current.preset.objects.map((object) => [object.id, { ...object.base }]));
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
            propsRef.current.onDragObjects(current.id, current.initial, delta);
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
        <span>
          <LocateFixed size={12} />
          {props.tool === "move" ? "Перемещение меняет базовую позу" : props.tool === "pivot" ? "Клик по спрайту задаёт пивот" : "Панорамирование"}
          {" · "}границы: {GUIDE_LABEL[props.bounds]} · пивоты: {GUIDE_LABEL[props.pivots]}
        </span>
        <div className="zoom-control">
          <button onClick={() => setCamera({ ...camera.current, zoom: Math.max(0.08, camera.current.zoom / 1.2) })}><ZoomOut size={13} /></button>
          <b>{zoomLabel}%</b>
          <button onClick={() => setCamera({ ...camera.current, zoom: Math.min(4, camera.current.zoom * 1.2) })}><ZoomIn size={13} /></button>
        </div>
      </div>
    </section>
  );
}

/** Квадрат границ объекта в координатах сцены по его текущей матрице. */
function spriteBounds(object: RigObject, matrix: Affine): { x: number; y: number }[] {
  const left = -object.pivot.x * object.width;
  const top = -object.pivot.y * object.height;
  return [
    transformPoint(matrix, left, top),
    transformPoint(matrix, left + object.width, top),
    transformPoint(matrix, left + object.width, top + object.height),
    transformPoint(matrix, left, top + object.height),
  ];
}

/** Базовые границы группы: объединение базовых рамок всех её потомков-спрайтов. */
function groupBounds(preset: RigPreset, groupId: string): { x: number; y: number }[] | null {
  const ids = new Set<string>([groupId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const object of preset.objects) {
      if (object.parentId && ids.has(object.parentId) && !ids.has(object.id)) {
        ids.add(object.id);
        changed = true;
      }
    }
  }
  const points: { x: number; y: number }[] = [];
  for (const object of preset.objects) {
    if (object.kind !== "sprite" || !ids.has(object.id)) continue;
    points.push(...spriteBounds(object, objectMatrix(object, staticValues(object))));
  }
  if (points.length === 0) {
    const group = preset.objects.find((object) => object.id === groupId);
    if (!group) return null;
    return [
      { x: group.base.x - 14, y: group.base.y - 14 },
      { x: group.base.x + 14, y: group.base.y - 14 },
      { x: group.base.x + 14, y: group.base.y + 14 },
      { x: group.base.x - 14, y: group.base.y + 14 },
    ];
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return [
    { x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY },
  ];
}

function isSelectedTree(preset: RigPreset, objectId: string, selectedId: string | null): boolean {
  if (!selectedId) return false;
  if (objectId === selectedId) return true;
  let current = preset.objects.find((object) => object.id === objectId)?.parentId ?? null;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    if (current === selectedId) return true;
    visited.add(current);
    current = preset.objects.find((object) => object.id === current)?.parentId ?? null;
  }
  return false;
}

function drawGuides(
  ctx: CanvasRenderingContext2D,
  preset: RigPreset,
  frame: RigFrame | null,
  zoom: number,
  bounds: GuideMode,
  pivots: GuideMode,
  selectedId: string | null,
) {
  if (bounds === "off" && pivots === "off") return;
  const objects = preset.objects;
  const visible = (id: string) => (frame?.objects[id] || staticValues(preset.objects.find((object) => object.id === id)!)).visible !== 0;

  if (bounds !== "off") {
    ctx.save();
    ctx.lineWidth = 1 / zoom;
    for (const object of objects) {
      const selected = isSelectedTree(preset, object.id, selectedId);
      if (bounds === "selected" && !selected) continue;
      if (bounds === "all" && !visible(object.id)) continue;
      const values = frame?.objects[object.id] || staticValues(object);
      const corners = object.kind === "sprite"
        ? spriteBounds(object, objectMatrix(object, values))
        : groupBounds(preset, object.id);
      if (!corners) continue;
      ctx.strokeStyle = selected ? BOUNDS_SELECTED : BOUNDS_COLOR;
      ctx.globalAlpha = selected ? 0.9 : 0.45;
      ctx.setLineDash(object.kind === "group" ? [4 / zoom, 3 / zoom] : []);
      ctx.beginPath();
      corners.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  }

  if (pivots !== "off") {
    ctx.save();
    for (const object of objects) {
      const selected = isSelectedTree(preset, object.id, selectedId);
      if (pivots === "selected" && !selected) continue;
      if (pivots === "all" && !visible(object.id)) continue;
      const values = frame?.objects[object.id] || staticValues(object);
      const center = transformPoint(objectMatrix(object, values), 0, 0);
      const size = (selected ? 6 : 4) / zoom;
      ctx.globalAlpha = selected ? 0.95 : 0.55;
      ctx.strokeStyle = PIVOT_COLOR;
      ctx.lineWidth = 1.2 / zoom;
      ctx.beginPath();
      ctx.moveTo(center.x - size, center.y);
      ctx.lineTo(center.x + size, center.y);
      ctx.moveTo(center.x, center.y - size);
      ctx.lineTo(center.x, center.y + size);
      ctx.stroke();
      if (object.kind === "group") {
        ctx.beginPath();
        ctx.arc(center.x, center.y, size * 0.7, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

function drawSelection(
  ctx: CanvasRenderingContext2D,
  preset: RigPreset,
  frame: RigFrame | null,
  zoom: number,
  selectedId: string | null,
  pivotMode: boolean,
) {
  const object = preset.objects.find((item) => item.id === selectedId);
  if (!object) return;
  const values = frame?.objects[object.id] || staticValues(object);
  const matrix = objectMatrix(object, values);
  ctx.save();
  ctx.strokeStyle = pivotMode ? "#e4bd7c" : "#81dbc5";
  ctx.fillStyle = pivotMode ? "#e4bd7c" : "#81dbc5";
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([5 / zoom, 4 / zoom]);
  if (object.kind === "sprite") {
    const corners = spriteBounds(object, matrix);
    ctx.beginPath();
    corners.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
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
  const line = (step: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (let x = step; x < width; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
    for (let y = step; y < height; y += step) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
    ctx.stroke();
  };
  ctx.save();
  ctx.lineWidth = 1 / zoom;
  line(50, GRID_COLOR);
  line(200, GRID_MAJOR);
  ctx.restore();
}
