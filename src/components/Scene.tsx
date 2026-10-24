import { useEffect, useRef, useState, type RefObject } from "react";
import {
  BoxSelect, CircleDot, Crosshair, Focus, Grid3X3, Hand, LassoSelect,
  LocateFixed, MousePointer2, Scan, ZoomIn, ZoomOut,
} from "lucide-react";
import type { BasePose, GuideMode, RigFrame, RigObject, RigPreset } from "../types";
import { GUIDE_LABEL } from "../types";
import {
  drawRig, invertAffine, objectMatrix, orderedSprites, SpriteAssets, staticValues,
  transformPoint, type Affine,
} from "../render/rigCanvas";
import {
  boxFromCorners, boxFromPoints, boxIntersects, polygonIntersectsBox, selectionRoots,
  type Box, type Point,
} from "../engine/selection";
import { formatCanvasSize, parseCanvasSize, sameCanvasSize } from "../engine/canvasSize";

export type SceneTool = "move" | "pivot" | "pan" | "marquee" | "lasso";

export type SelectMode = "replace" | "toggle" | "add";

interface SceneProps {
  preset: RigPreset;
  frameRef: RefObject<RigFrame | null>;
  selectedIds: string[];
  primaryId: string | null;
  tool: SceneTool;
  showGrid: boolean;
  bounds: GuideMode;
  pivots: GuideMode;
  onTool: (tool: SceneTool) => void;
  onToggleGrid: () => void;
  onCycleBounds: () => void;
  onCyclePivots: () => void;
  /** Правка размера холста из подписи у артборда. */
  onCanvasSize: (width: number, height: number) => void;
  onSelect: (id: string | null, mode: SelectMode) => void;
  onSelectMany: (ids: string[], mode: "replace" | "add") => void;
  onDragStart: () => void;
  onDragObjects: (ids: string[], initial: Record<string, BasePose>, delta: { x: number; y: number }) => void;
  onPivot: (id: string, pivot: { x: number; y: number }) => void;
}

type Camera = { zoom: number; x: number; y: number };
type Marquee = { shape: "rect" | "lasso"; start: Point; current: Point; points: Point[] };
type Interaction =
  | { type: "drag"; ids: string[]; start: Point; initial: Record<string, BasePose> }
  | { type: "pan"; startX: number; startY: number; camera: Camera }
  | { type: "marquee"; shape: "rect" | "lasso"; start: Point; points: Point[]; additive: boolean }
  | null;

/** Поля вокруг артборда под размытую тень. */
const ARTBOARD_PAD = 40;

const GRID_COLOR = "#8fa3ad2e";
const GRID_MAJOR = "#8fa3ad59";
const BOUNDS_COLOR = "#6fb4a3";
const BOUNDS_SELECTED = "#9be3d1";
const PIVOT_COLOR = "#e4bd7c";
const HIDDEN_COLOR = "#7d8790";

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
  const marqueeRef = useRef<Marquee | null>(null);
  // Размер холста правится прямо по подписи у артборда: подпись — HTML-кнопка
  // поверх канвы, а её положение обновляет draw() вместе с камерой.
  const sizeLabel = useRef<HTMLDivElement>(null);
  const [editingSize, setEditingSize] = useState(false);
  const [sizeDraft, setSizeDraft] = useState("");
  // Тень артборда — тяжёлый blur. Рисуем её один раз в отдельный холст и потом
  // просто растягиваем: размытие на каждом кадре заметно грузило процессор.
  const shadowRef = useRef<HTMLCanvasElement | null>(null);
  const shadowKey = useRef("");
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
    const board = artboard();
    ctx.drawImage(board.image, -ARTBOARD_PAD, -ARTBOARD_PAD);
    drawTransparency(ctx, preset.canvas.width, preset.canvas.height);
    if (current.showGrid) drawGrid(ctx, preset.canvas.width, preset.canvas.height, zoom);

    drawRig(ctx, preset, frame, assets.current, { placeholders: true, lineScale: zoom });
    drawGuides(ctx, preset, frame, zoom, current.bounds, current.pivots, current.selectedIds);
    drawSelection(ctx, preset, frame, zoom, current.selectedIds, current.primaryId, current.tool === "pivot");
    if (current.tool === "marquee" || current.tool === "lasso") drawHiddenOutlines(ctx, preset, zoom);

    ctx.strokeStyle = "#454d57";
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(0, 0, preset.canvas.width, preset.canvas.height);
    ctx.restore();

    const label = sizeLabel.current;
    if (label) {
      label.style.left = `${Math.max(6, x + 2)}px`;
      label.style.top = `${Math.max(2, y - 24)}px`;
    }
    drawMarquee(ctx, marqueeRef.current);
  };

  /** Артборд с тенью, нарисованный один раз на изменение размера сцены. */
  const artboard = (): { image: HTMLCanvasElement } => {
    const { width, height } = propsRef.current.preset.canvas;
    const key = `${width}x${height}`;
    if (shadowRef.current && shadowKey.current === key) return { image: shadowRef.current };
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width + ARTBOARD_PAD * 2));
    canvas.height = Math.max(1, Math.round(height + ARTBOARD_PAD * 2));
    const context = canvas.getContext("2d");
    if (context) {
      context.shadowColor = "#00000055";
      context.shadowBlur = 26;
      context.shadowOffsetY = 8;
      context.fillStyle = "#24292f";
      context.fillRect(ARTBOARD_PAD, ARTBOARD_PAD, width, height);
    }
    shadowRef.current = canvas;
    shadowKey.current = key;
    return { image: canvas };
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

  /** Принять введённый размер; мусор и значения вне диапазона просто отбрасываем. */
  const applyCanvasSize = () => {
    const size = parseCanvasSize(sizeDraft);
    setEditingSize(false);
    dirty.current = true;
    if (!size) return;
    const current = propsRef.current.preset.canvas;
    if (sameCanvasSize(size, { width: current.width, height: current.height })) return;
    propsRef.current.onCanvasSize(size.width, size.height);
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
      // Рисуем сразу в колбэке: ResizeObserver вызывается до paint, поэтому
      // браузер не успевает растянуть старый битмап под новую ширину.
      draw();
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
  }, [props.preset, props.selectedIds, props.primaryId, props.showGrid, props.tool, props.bounds, props.pivots]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.code === "Space" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
        spaceDown.current = true;
      }
      if (event.key === "Escape" && interaction.current?.type === "marquee") {
        interaction.current = null;
        marqueeRef.current = null;
        dirty.current = true;
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

  /**
   * Экранные рамки всех объектов по базовой позе (без анимационного кадра,
   * иначе выделение прыгало бы от кадра к кадру). Видимость намеренно не
   * учитывается: рамка и лассо выделяют и скрытые объекты.
   */
  const screenBoxes = (): { id: string; box: Box; corners: Point[] }[] => {
    const current = propsRef.current;
    const { zoom, x, y } = camera.current;
    const result: { id: string; box: Box; corners: Point[] }[] = [];
    for (const object of current.preset.objects) {
      const corners = object.kind === "sprite"
        ? spriteBounds(object, objectMatrix(object, staticValues(object)))
        : groupBounds(current.preset, object.id);
      if (!corners) continue;
      const screen = corners.map((point) => ({ x: x + point.x * zoom, y: y + point.y * zoom }));
      result.push({ id: object.id, corners: screen, box: boxFromCorners(screen) });
    }
    return result;
  };

  const finishMarquee = (current: Extract<Interaction, { type: "marquee" }>) => {
    const rect = boxFromPoints(current.start, current.points.at(-1) ?? current.start);
    const tiny = Math.abs(rect.maxX - rect.minX) < 3 && Math.abs(rect.maxY - rect.minY) < 3;
    if (tiny) {
      if (!current.additive) propsRef.current.onSelect(null, "replace");
      return;
    }
    const hits = screenBoxes()
      .filter((entry) => current.shape === "rect"
        ? boxIntersects(entry.box, rect)
        : polygonIntersectsBox(current.points, entry.box))
      .map((entry) => entry.id);
    if (!hits.length) {
      if (!current.additive) propsRef.current.onSelect(null, "replace");
      return;
    }
    propsRef.current.onSelectMany(hits, current.additive ? "add" : "replace");
  };

  return (
    <section className="scene-panel panel-surface">
      <div className="scene-toolbar">
        <div className="scene-title"><span className="eyebrow">ПРЕВЬЮ</span><h2>Сцена</h2></div>
        <div className="scene-tools">
          <button className={props.tool === "move" ? "active" : ""} title="Выделение и перемещение (V) · Ctrl+клик — добавить, Shift+клик — тоже добавить" onClick={() => props.onTool("move")}><MousePointer2 size={15} /></button>
          <button className={props.tool === "marquee" ? "active" : ""} title="Выделение рамкой (M) · Shift — добавить к выборке" onClick={() => props.onTool("marquee")}><BoxSelect size={15} /></button>
          <button className={props.tool === "lasso" ? "active" : ""} title="Выделение лассо (L) · Shift — добавить к выборке" onClick={() => props.onTool("lasso")}><LassoSelect size={15} /></button>
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
      <div className={`scene-viewport tool-${props.tool}`} ref={viewport} data-scene="viewport">
        <canvas
          ref={canvas}
          onPointerDown={(event) => {
            if (event.button !== 0 && event.button !== 1) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const current = propsRef.current;
            const pan = current.tool === "pan" || event.button === 1 || spaceDown.current;
            if (pan) {
              const point = screenPoint(event);
              interaction.current = { type: "pan", startX: point.x, startY: point.y, camera: { ...camera.current } };
              return;
            }
            const point = scenePoint(event);
            if (current.tool === "pivot" && current.primaryId) {
              const object = current.preset.objects.find((item) => item.id === current.primaryId && item.kind === "sprite");
              if (object) {
                const values = current.frameRef.current?.objects[object.id] || staticValues(object);
                const local = transformPoint(invertAffine(objectMatrix(object, values)), point.x, point.y);
                current.onPivot(object.id, {
                  x: (local.x + object.pivot.x * object.width) / object.width,
                  y: (local.y + object.pivot.y * object.height) / object.height,
                });
                return;
              }
            }
            if (current.tool === "marquee" || current.tool === "lasso") {
              const screen = screenPoint(event);
              const shape = current.tool === "lasso" ? "lasso" : "rect";
              interaction.current = {
                type: "marquee",
                shape,
                start: screen,
                points: [screen],
                additive: event.shiftKey || event.ctrlKey || event.metaKey,
              };
              marqueeRef.current = { shape, start: screen, current: screen, points: [screen] };
              dirty.current = true;
              return;
            }
            const hit = hitTest(point);
            if (!hit) {
              if (!event.shiftKey && !event.ctrlKey && !event.metaKey) current.onSelect(null, "replace");
              return;
            }
            if (event.ctrlKey || event.metaKey) { current.onSelect(hit.id, "toggle"); return; }
            if (event.shiftKey) { current.onSelect(hit.id, "add"); return; }
            // Клик по части выделенной группы не сбрасывает выборку: тащим группу целиком.
            const inside = isSelectedTree(current.preset, hit.id, current.selectedIds);
            if (!inside) current.onSelect(hit.id, "replace");
            const ids = inside ? selectionRoots(current.preset.objects, current.selectedIds) : [hit.id];
            current.onDragStart();
            const initial = Object.fromEntries(current.preset.objects.map((object) => [object.id, { ...object.base }]));
            interaction.current = { type: "drag", ids, start: point, initial };
          }}
          onPointerMove={(event) => {
            const current = interaction.current;
            if (!current) return;
            if (current.type === "pan") {
              const point = screenPoint(event);
              setCamera({ ...current.camera, x: current.camera.x + point.x - current.startX, y: current.camera.y + point.y - current.startY });
              return;
            }
            if (current.type === "marquee") {
              const point = screenPoint(event);
              const last = current.points.at(-1)!;
              if (Math.hypot(point.x - last.x, point.y - last.y) >= 2 || current.points.length === 1) {
                current.points.push(point);
              }
              marqueeRef.current = {
                shape: current.shape,
                start: current.start,
                current: point,
                points: current.shape === "lasso" ? [...current.points] : current.points,
              };
              dirty.current = true;
              return;
            }
            const point = scenePoint(event);
            let delta = { x: point.x - current.start.x, y: point.y - current.start.y };
            if (event.shiftKey) {
              if (Math.abs(delta.x) >= Math.abs(delta.y)) delta = { x: delta.x, y: 0 };
              else delta = { x: 0, y: delta.y };
            }
            propsRef.current.onDragObjects(current.ids, current.initial, delta);
          }}
          onPointerUp={(event) => {
            const current = interaction.current;
            interaction.current = null;
            if (current?.type === "marquee") {
              current.points.push(screenPoint(event));
              finishMarquee(current);
              marqueeRef.current = null;
              dirty.current = true;
            }
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            interaction.current = null;
            marqueeRef.current = null;
            dirty.current = true;
          }}
          onWheel={(event) => {
            event.preventDefault();
            const point = screenPoint(event);
            const scene = { x: (point.x - camera.current.x) / camera.current.zoom, y: (point.y - camera.current.y) / camera.current.zoom };
            const zoom = Math.min(4, Math.max(0.08, camera.current.zoom * Math.exp(-event.deltaY * 0.0012)));
            setCamera({ zoom, x: point.x - scene.x * zoom, y: point.y - scene.y * zoom });
          }}
        />
        <div className="scene-canvas-size" ref={sizeLabel}>
          {editingSize ? (
            <input
              className="scene-canvas-size-field"
              value={sizeDraft}
              autoFocus
              spellCheck={false}
              title="Ширина × высота холста, затем Enter"
              onChange={(event) => setSizeDraft(event.target.value)}
              onFocus={(event) => event.target.select()}
              onBlur={() => applyCanvasSize()}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyCanvasSize();
                else if (event.key === "Escape") { setEditingSize(false); dirty.current = true; }
              }}
            />
          ) : (
            <button
              className="scene-canvas-size-text"
              title="Размер холста — нажмите, чтобы изменить"
              onClick={() => {
                setSizeDraft(formatCanvasSize(propsRef.current.preset.canvas));
                setEditingSize(true);
              }}
            >
              {formatCanvasSize(props.preset.canvas)}
            </button>
          )}
        </div>
      </div>
      <div className="scene-statusbar">
        <span>
          <LocateFixed size={12} />
          {TOOL_HINT[props.tool]}
          {" · "}выделено: {props.selectedIds.length} · границы: {GUIDE_LABEL[props.bounds]} · пивоты: {GUIDE_LABEL[props.pivots]}
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

const TOOL_HINT: Record<SceneTool, string> = {
  move: "Перемещение меняет базовую позу",
  marquee: "Тяните рамку; Shift — добавить к выборке",
  lasso: "Обведите объекты; Shift — добавить к выборке",
  pivot: "Клик по спрайту задаёт пивот",
  pan: "Панорамирование",
};

/** Квадрат границ объекта в координатах сцены по его текущей матрице. */
function spriteBounds(object: RigObject, matrix: Affine): Point[] {
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
function groupBounds(preset: RigPreset, groupId: string): Point[] | null {
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
  const points: Point[] = [];
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

/** Объект считается выделенным, если выделен он сам или любой его предок. */
function isSelectedTree(preset: RigPreset, objectId: string, selectedIds: string[]): boolean {
  if (!selectedIds.length) return false;
  const selected = new Set(selectedIds);
  if (selected.has(objectId)) return true;
  let current = preset.objects.find((object) => object.id === objectId)?.parentId ?? null;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    if (selected.has(current)) return true;
    visited.add(current);
    current = preset.objects.find((object) => object.id === current)?.parentId ?? null;
  }
  return false;
}

/** Скрытые объекты по базовой позе с учётом скрытых родителей. */
function hiddenIds(preset: RigPreset): Set<string> {
  const byId = new Map(preset.objects.map((object) => [object.id, object]));
  const cache = new Map<string, boolean>();
  const isHidden = (id: string): boolean => {
    if (cache.has(id)) return cache.get(id)!;
    const chain: string[] = [];
    const seen = new Set<string>();
    let pointer: string | null = id;
    while (pointer && !seen.has(pointer) && !cache.has(pointer)) {
      seen.add(pointer);
      chain.push(pointer);
      pointer = byId.get(pointer)?.parentId ?? null;
    }
    let value = pointer ? cache.get(pointer) ?? false : false;
    for (const item of chain.reverse()) {
      const object = byId.get(item);
      value = object?.enabled === false || object?.base.visible === 0 || value;
      cache.set(item, value);
    }
    return cache.get(id) ?? true;
  };
  return new Set(preset.objects.filter((object) => isHidden(object.id)).map((object) => object.id));
}

/** Пунктирные рамки скрытых объектов, пока активен инструмент выделения. */
function drawHiddenOutlines(ctx: CanvasRenderingContext2D, preset: RigPreset, zoom: number) {
  const hidden = hiddenIds(preset);
  if (!hidden.size) return;
  ctx.save();
  ctx.strokeStyle = HIDDEN_COLOR;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1 / zoom;
  ctx.setLineDash([3 / zoom, 3 / zoom]);
  for (const id of hidden) {
    const object = preset.objects.find((item) => item.id === id);
    if (!object) continue;
    const corners = object.kind === "sprite"
      ? spriteBounds(object, objectMatrix(object, staticValues(object)))
      : groupBounds(preset, object.id);
    if (!corners) continue;
    ctx.beginPath();
    corners.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

function drawGuides(
  ctx: CanvasRenderingContext2D,
  preset: RigPreset,
  frame: RigFrame | null,
  zoom: number,
  bounds: GuideMode,
  pivots: GuideMode,
  selectedIds: string[],
) {
  if (bounds === "off" && pivots === "off") return;
  const objects = preset.objects;
  const visible = (id: string) => (frame?.objects[id] || staticValues(preset.objects.find((object) => object.id === id)!)).visible !== 0;

  if (bounds !== "off") {
    ctx.save();
    ctx.lineWidth = 1 / zoom;
    for (const object of objects) {
      const selected = isSelectedTree(preset, object.id, selectedIds);
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
      const selected = isSelectedTree(preset, object.id, selectedIds);
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

/** Подсветка всей выборки; у основного объекта дополнительно пивот и маркеры. */
function drawSelection(
  ctx: CanvasRenderingContext2D,
  preset: RigPreset,
  frame: RigFrame | null,
  zoom: number,
  selectedIds: string[],
  primaryId: string | null,
  pivotMode: boolean,
) {
  if (!selectedIds.length) return;
  const selected = new Set(selectedIds);
  ctx.save();
  ctx.strokeStyle = pivotMode ? "#e4bd7c" : "#81dbc5";
  ctx.fillStyle = pivotMode ? "#e4bd7c" : "#81dbc5";
  for (const id of selected) {
    const object = preset.objects.find((item) => item.id === id);
    if (!object) continue;
    const values = frame?.objects[object.id] || staticValues(object);
    const corners = object.kind === "sprite"
      ? spriteBounds(object, objectMatrix(object, values))
      : groupBounds(preset, object.id);
    if (!corners) continue;
    const primary = object.id === primaryId;
    ctx.globalAlpha = primary ? 1 : 0.7;
    ctx.lineWidth = (primary ? 1.5 : 1) / zoom;
    ctx.setLineDash([5 / zoom, 4 / zoom]);
    ctx.beginPath();
    corners.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
    ctx.closePath();
    ctx.stroke();
    if (!primary) continue;
    ctx.setLineDash([]);
    const pivot = transformPoint(objectMatrix(object, values), 0, 0);
    const size = 7 / zoom;
    ctx.beginPath();
    ctx.moveTo(pivot.x - size, pivot.y); ctx.lineTo(pivot.x + size, pivot.y);
    ctx.moveTo(pivot.x, pivot.y - size); ctx.lineTo(pivot.x, pivot.y + size);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pivot.x, pivot.y, 2.4 / zoom, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Рамка или лассо поверх сцены — рисуется в экранных координатах. */
function drawMarquee(ctx: CanvasRenderingContext2D, marquee: Marquee | null) {
  if (!marquee) return;
  ctx.save();
  ctx.strokeStyle = "#9be3d1";
  ctx.fillStyle = "#82d5c12e";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  if (marquee.shape === "rect") {
    const rect = boxFromPoints(marquee.start, marquee.current);
    ctx.fillRect(rect.minX, rect.minY, rect.maxX - rect.minX, rect.maxY - rect.minY);
    ctx.strokeRect(rect.minX, rect.minY, rect.maxX - rect.minX, rect.maxY - rect.minY);
  } else if (marquee.points.length >= 2) {
    ctx.beginPath();
    marquee.points.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
    ctx.stroke();
  }
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
