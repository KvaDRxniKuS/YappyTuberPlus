import { useEffect, useRef, useState, type RefObject } from "react";
import {
  BoxSelect, CircleDot, Crosshair, Focus, Frame, Grid3X3, Hand, LassoSelect,
  LocateFixed, MousePointer2, Move3D, PenTool, RotateCw, Scan, ZoomIn, ZoomOut,
} from "lucide-react";
import type { BasePose, GuideMode, RigFrame, RigObject, RigPreset, Vec2, WarpCorner, WarpSpec } from "../types";
import { GUIDE_LABEL } from "../types";
import { groupBounds, objectOutline } from "../render/bounds";
import {
  drawRig, invertAffine, objectMatrix, orderedObjects, scriptHidden, SpriteAssets, staticValues,
  transformPoint, type Affine,
} from "../render/rigCanvas";
import { MediaAssets, MaskMedia } from "../render/media";
import { onAssetsChanged } from "../engine/assets";
import type { TextChannel } from "../render/text";
import {
  boxFromCorners, boxFromPoints, boxIntersects, polygonIntersectsBox, selectionRoots,
  type Box, type Point,
} from "../engine/selection";
import { formatCanvasSize, parseCanvasSize, sameCanvasSize } from "../engine/canvasSize";
import { createOnDemandLoop, onFrameProduced } from "../engine/frameSignal";
import { countDraw } from "../engine/meter";
import { penAction, smoothingOf, traceItem } from "../render/shape";
import {
  defaultWarp, moveWarpCorner, moveWarpFrame, pointInQuad, resizeWarpFrame, rotateWarpFrame,
  warpGrabAt, warpHandlesAt, warpQuad, warpEnabled,
} from "../render/warp";

export type SceneTool =
  | "move" | "pivot" | "pan" | "marquee" | "lasso"
  /** Зона деформации: прямоугольник, его стороны и поворот. */
  | "warp"
  /** Углы деформации: только четыре точки картинки. */
  | "deform"
  /** Перо: точки контура фигуры. */
  | "pen";

export type SelectMode = "replace" | "toggle" | "add";

interface SceneProps {
  preset: RigPreset;
  frameRef: RefObject<RigFrame | null>;
  selectedIds: string[];
  primaryId: string | null;
  tool: SceneTool;
  showGrid: boolean;
  /** Пауза или стоп: скрытое по входам рисуется полупрозрачным призраком. */
  ghosts: boolean;
  bounds: GuideMode;
  pivots: GuideMode;
  /** Текст из модулей: подстановки `{twitch.chat.message}` в текстовых объектах. */
  texts?: TextChannel;
  /**
   * Перо: контур, который сейчас рисуется. Клик по сцене ставит точку, готовая
   * точка хватается и переносится — как в графическом редакторе.
   */
  pen?: { objectId: string; itemId: string } | null;
  /**
   * Перо: точки контура; сглаживание идёт вместе с ними одним шагом истории.
   *
   * `live` — это движение мыши внутри одной тяги: запись в историю делается
   * один раз, на первом движении, а не на каждое событие.
   */
  onPenPoints?: (objectId: string, itemId: string, points: Vec2[], smoothPoints: number[], live?: boolean) => void;
  /** Перо: тяга точки закончилась (кнопка отпущена) — шаг истории закрыт. */
  onPenDragEnd?: () => void;
  /** Перо: сглаживание точки, 0…100 %. Alt+клик переключает угол и кривую. */
  onPenSmoothing?: (objectId: string, itemId: string, index: number, value: number) => void;
  /** Перо: замкнуть контур кликом по первой точке. */
  onPenClosed?: (objectId: string, itemId: string, closed: boolean) => void;
  /** Файлы, брошенные на сцену: тип объекта определится по файлу. */
  onDropFiles?: (files: FileList) => void;
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
  /**
   * Пивот ставится кликом в его новую точку: `base` — она же в мировых
   * координатах (пивот объекта и есть его `base`), картинка при этом не едет.
   */
  onPivot: (id: string, base: { x: number; y: number }, pivot: { x: number; y: number }) => void;
  /** Деформация из спецрежима: углы и зона правятся прямо в сцене. */
  onWarp: (id: string, warp: WarpSpec) => void;
}

type Camera = { zoom: number; x: number; y: number };
type Marquee = { shape: "rect" | "lasso"; start: Point; current: Point; points: Point[] };
type Interaction =
  | {
      type: "drag";
      ids: string[];
      start: Point;
      initial: Record<string, BasePose>;
      /** Кого выбрать, если это окажется клик без перетаскивания. */
      pending: string | null;
      moved: boolean;
    }
  | { type: "pan"; startX: number; startY: number; camera: Camera }
  | { type: "marquee"; shape: "rect" | "lasso"; start: Point; points: Point[]; additive: boolean }
  /** Перо: тянем точку контура с номером `index`. */
  | { type: "pen"; objectId: string; itemId: string; index: number }
  /** Деформация: тянем ручку зоны (`tl`, `top`, `move`…) или угол картинки. */
  | { type: "warpFrame"; objectId: string; handle: string; start: Point; initial: WarpSpec }
  | { type: "warpCorner"; objectId: string; corner: WarpCorner; start: Point; initial: WarpSpec }
  | { type: "warpRotate"; objectId: string; center: Point; start: number; initial: WarpSpec }
  | null;

/** Мировые координаты → координаты рамки объекта: там живут контуры фигуры. */
function shapePoint(object: RigObject, frame: RigFrame | null, point: Point): Point {
  const values = frame?.objects[object.id] || staticValues(object);
  const local = transformPoint(invertAffine(objectMatrix(object, values)), point.x, point.y);
  return { x: local.x + object.pivot.x * object.width, y: local.y + object.pivot.y * object.height };
}

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
  const mediaAssets = useRef(new MediaAssets());
  /** Видео-маски: маской может быть фильм, тогда видно его текущий кадр. */
  const maskMedia = useRef(new MaskMedia());
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

  // Отрисовка по требованию: постоянного rAF-цикла больше нет (он грузил
  // процессор в простое), но любая правка или новый кадр планирует ровно один
  // кадр отрисовки.
  const loop = useRef<{ request: () => void; stop: () => void } | null>(null);
  const markDirty = () => {
    dirty.current = true;
    loop.current?.request();
  };

  /**
   * Живые правки мышью (точка пера, угол деформации, перенос объектов).
   *
   * Мышь с высоким поллингом шлёт события чаще кадров, а каждая правка — это
   * новый пресет и перерисовка всего дерева React. Поэтому пачка движений
   * склеивается в одну правку на кадр: берётся последнее положение курсора.
   */
  const live = useRef<{ task: (() => void) | null; frame: number }>({ task: null, frame: 0 });
  const queueLive = (task: () => void) => {
    const slot = live.current;
    slot.task = task;
    if (slot.frame) return;
    slot.frame = requestAnimationFrame(() => {
      slot.frame = 0;
      const pending = slot.task;
      slot.task = null;
      pending?.();
    });
  };
  /** Выполнить отложенную правку сразу: отпускание кнопки не должно её терять. */
  const flushLive = () => {
    const slot = live.current;
    if (slot.frame) {
      cancelAnimationFrame(slot.frame);
      slot.frame = 0;
    }
    const pending = slot.task;
    slot.task = null;
    pending?.();
  };

  const setCamera = (next: Camera) => {
    camera.current = next;
    setZoomLabel(Math.round(next.zoom * 100));
    markDirty();
  };

  const draw = () => {
    countDraw();
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

    // Медиа живёт по кадру: команды, громкость, пауза. Синхронизация идёт до
    // отрисовки, чтобы видео показало именно текущий кадр.
    mediaAssets.current.sync(preset, frame);
    maskMedia.current.sync(maskSources(preset));
    drawRig(ctx, preset, frame, assets.current, {
      placeholders: true, lineScale: zoom, ghosts: current.ghosts,
      media: mediaAssets.current, texts: current.texts, maskMedia: maskMedia.current,
    });
    drawGuides(ctx, preset, frame, zoom, current.bounds, current.pivots, current.selectedIds);
    drawSelection(ctx, preset, frame, zoom, current.selectedIds, current.primaryId, current.tool === "pivot");
    if (current.tool === "warp") drawWarpOverlay(ctx, preset, frame, zoom, current.primaryId, "frame");
    if (current.tool === "deform") drawWarpOverlay(ctx, preset, frame, zoom, current.primaryId, "corners");
    drawShapeOutlines(ctx, preset, frame, zoom, current.selectedIds);
    if (current.pen) drawPen(ctx, preset, frame, current.pen, zoom, true);
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
    // Видео меняется само по себе: пока оно играет, просим следующий кадр.
    // Видео-маска тоже живая — иначе «окно» застыло бы на первом кадре.
    if (mediaAssets.current.active() || maskMedia.current.active()) markDirty();
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
    markDirty();
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
      markDirty();
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
    markDirty();
  }, [imageKey, props.preset.objects]);

  useEffect(() => assets.current.onChange(() => { markDirty(); }), []);
  // Файлы из хранилища читаются асинхронно: когда картинка появилась,
  // спрайт нужно поставить в очередь декодирования и перерисовать сцену.
  useEffect(() => onAssetsChanged(() => {
    assets.current.sync(propsRef.current.preset.objects);
    markDirty();
  }), []);
  useEffect(() => () => {
    mediaAssets.current.dispose();
    maskMedia.current.dispose();
  }, []);

  useEffect(() => {
    markDirty();
  }, [props.preset, props.selectedIds, props.primaryId, props.showGrid, props.tool, props.bounds, props.pivots, props.ghosts, props.pen]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.code === "Space" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
        spaceDown.current = true;
      }
      if (event.key === "Escape" && interaction.current?.type === "marquee") {
        interaction.current = null;
        marqueeRef.current = null;
        markDirty();
      }
    };
    const keyUp = (event: KeyboardEvent) => { if (event.code === "Space") spaceDown.current = false; };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => { window.removeEventListener("keydown", keyDown); window.removeEventListener("keyup", keyUp); };
  }, []);

  useEffect(() => {
    const render = createOnDemandLoop(() => {
      dirty.current = false;
      draw();
    });
    loop.current = render;
    // Новый кадр от движка — повод перерисовать; нет кадров — цикл спит.
    const unsubscribe = onFrameProduced(() => { render.request(); });
    if (dirty.current) render.request();
    return () => {
      unsubscribe();
      render.stop();
      loop.current = null;
    };
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

  const hitTest = (point: { x: number; y: number }, accept?: (object: RigObject) => boolean): RigObject | null => {
    const current = propsRef.current;
    const frame = current.frameRef.current;
    const ordered = orderedObjects(current.preset, frame);
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const object = ordered[index];
      if (accept && !accept(object)) continue;
      // Невидимая фигура-маска не должна перехватывать клики у спрайтов под
      // собой: её видно в дереве, там же она и выбирается.
      if (object.kind === "shape" && object.shape?.draw === false) continue;
      const values = frame?.objects[object.id] || staticValues(object);
      // Призрак виден на сцене, значит по нему можно и щёлкнуть: иначе
      // полупрозрачный спрайт выглядел бы некликабельным.
      if (values.visible === 0 && !(current.ghosts && scriptHidden(object, values))) continue;
      const local = transformPoint(invertAffine(objectMatrix(object, values)), point.x, point.y);
      const left = -object.pivot.x * object.width;
      const top = -object.pivot.y * object.height;
      if (warpEnabled(object)) {
        // Деформированный спрайт — четырёхугольник: угол, который уехал,
        // больше не должен ловить мышь, а вытянутый — наоборот.
        const content = { x: local.x - left, y: local.y - top };
        if (pointInQuad(content, warpQuad(object, values))) return object;
        continue;
      }
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
      const corners = object.kind !== "group"
        ? objectOutline(object, staticValues(object))
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
          <button
            className={props.tool === "pen" ? "active" : ""}
            title="Перо (N) · клик ставит точку между ближайшими, Alt+клик меняет сглаживание точки"
            onClick={() => props.onTool("pen")}
          ><PenTool size={15} /></button>
          <button className={props.tool === "pan" ? "active" : ""} title="Панорамирование (Space)" onClick={() => props.onTool("pan")}><Hand size={15} /></button>
          {/* Деформация — отдельной группой: зона и углы это разные правки,
              и в работе они не должны пересекаться. */}
          <span className="tool-separator" />
          <button
            className={props.tool === "warp" ? "active" : ""}
            title="Зона деформации (T) · прямоугольник, его стороны и поворот"
            disabled={!props.primaryId}
            onClick={() => props.onTool("warp")}
          ><Frame size={15} /></button>
          <button
            className={props.tool === "deform" ? "active" : ""}
            title="Углы деформации (R) · тяните углы картинки, не задевая зону"
            disabled={!props.primaryId}
            onClick={() => props.onTool("deform")}
          ><Move3D size={15} /></button>
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
      <div
        className={`scene-viewport tool-${props.tool}`}
        ref={viewport}
        data-scene="viewport"
        onDragOver={(event) => {
          if (!propsRef.current.onDropFiles || !Array.from(event.dataTransfer.types).includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          const drop = propsRef.current.onDropFiles;
          if (!drop || !event.dataTransfer.files.length) return;
          event.preventDefault();
          drop(event.dataTransfer.files);
        }}
      >
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
            // Инструмент пера, но контур не выбран: клик не должен выделять
            // чужие объекты, иначе перо «переключает фокус» вместо рисования.
            if (current.tool === "pen" && !current.pen) return;
            const point = scenePoint(event);
            if (current.pen) {
              const object = current.preset.objects.find((item) => item.id === current.pen!.objectId);
              const item = object?.shape?.items.find((entry) => entry.id === current.pen!.itemId);
              if (object && item) {
                const local = shapePoint(object, current.frameRef.current, point);
                const action = penAction(item, local, 12 / camera.current.zoom, event.altKey);
                if (action.type === "toggle-smoothing") {
                  current.onPenSmoothing?.(object.id, item.id, action.index, action.value);
                  return;
                }
                // Клик по первой точке замыкает контур — так перо и должно
                // работать, иначе «замкнуть» можно только галочкой во вкладке.
                if (action.type === "close") {
                  current.onPenClosed?.(object.id, item.id, true);
                  return;
                }
                if (action.type === "drag") {
                  interaction.current = { type: "pen", objectId: object.id, itemId: item.id, index: action.index };
                  return;
                }
                // Новая точка встаёт между двумя ближайшими, а не в конец: так
                // контур не «перескакивает» через всю фигуру.
                const points = [...item.points];
                points.splice(action.index, 0, { x: roundPoint(local.x), y: roundPoint(local.y) });
                const smoothing = item.points.map((_, index) => smoothingOf(item, index));
                smoothing.splice(action.index, 0, action.smoothing);
                current.onPenPoints?.(object.id, item.id, points, smoothing);
                interaction.current = { type: "pen", objectId: object.id, itemId: item.id, index: action.index };
                return;
              }
            }
            if (current.tool === "pivot" && current.primaryId) {
              const object = current.preset.objects.find((item) => item.id === current.primaryId);
              // Пивот объекта — это его база: точка переезжает под курсор, а
              // картинка остаётся на месте (смещение базы компенсирует сдвиг
              // пивота), дети спрайта и группы тоже не дёргаются.
              if (object) {
                const values = current.frameRef.current?.objects[object.id] || staticValues(object);
                const pivot = object.kind !== "group"
                  ? (() => {
                    const local = transformPoint(invertAffine(objectMatrix(object, values)), point.x, point.y);
                    return {
                      x: (local.x + object.pivot.x * object.width) / object.width,
                      y: (local.y + object.pivot.y * object.height) / object.height,
                    };
                  })()
                  : (() => {
                    // У группы картинки нет, её «картинка» — дети. В pivot
                    // пишется UV точки в габаритах группы — по нему физика
                    // понимает «тяжёлую» сторону.
                    const bounds = groupBounds(current.preset, object.id);
                    if (!bounds) return object.pivot;
                    const xs = bounds.map((corner) => corner.x);
                    const ys = bounds.map((corner) => corner.y);
                    const width = Math.max(...xs) - Math.min(...xs);
                    const height = Math.max(...ys) - Math.min(...ys);
                    const unit = (value: number) => Math.min(1, Math.max(0, value));
                    return {
                      x: width > 0 ? unit((point.x - Math.min(...xs)) / width) : object.pivot.x,
                      y: height > 0 ? unit((point.y - Math.min(...ys)) / height) : object.pivot.y,
                    };
                  })();
                current.onPivot(object.id, { x: point.x, y: point.y }, pivot);
                return;
              }
            }
            if ((current.tool === "warp" || current.tool === "deform") && current.primaryId) {
              const object = current.preset.objects.find((item) => item.id === current.primaryId);
              if (object && object.kind !== "group" && object.kind !== "text") {
                const values = current.frameRef.current?.objects[object.id] || staticValues(object);
                const matrix = objectMatrix(object, values);
                const left = -object.pivot.x * object.width;
                const top = -object.pivot.y * object.height;
                // Инструменты разделены: «Зона» не ловит углы, «Углы» не ловит
                // рамку — прямоугольники больше не пересекаются в работе.
                const grab = warpGrabAt(
                  object, values, left, top, matrix, camera.current.zoom, point,
                  current.tool === "deform" ? "corners" : "frame",
                );
                if (grab) {
                  // Первое движение в режиме включает деформацию: иначе ручки
                  // не меняли бы картинку, и это выглядело бы поломкой.
                  const initial = { ...(object.warp ?? defaultWarp()), enabled: true };
                  current.onDragStart();
                  if (grab.kind === "corner") {
                    interaction.current = { type: "warpCorner", objectId: object.id, corner: grab.corner, start: point, initial };
                  } else if (grab.kind === "handle") {
                    interaction.current = { type: "warpFrame", objectId: object.id, handle: grab.handle, start: point, initial };
                  } else if (grab.kind === "rotation") {
                    interaction.current = { type: "warpRotate", objectId: object.id, center: grab.center, start: grab.angle, initial };
                  } else {
                    interaction.current = { type: "warpFrame", objectId: object.id, handle: "move", start: point, initial };
                  }
                  return;
                }
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
              markDirty();
              return;
            }
            const hit = hitTest(point);
            if (!hit) {
              if (!event.shiftKey && !event.ctrlKey && !event.metaKey) current.onSelect(null, "replace");
              return;
            }
            if (event.ctrlKey || event.metaKey) { current.onSelect(hit.id, "toggle"); return; }
            if (event.shiftKey) { current.onSelect(hit.id, "add"); return; }
            // Выделение в структуре важнее того, кто оказался сверху: если точка
            // попала в выделенный объект (или его потомка), тащим выборку, а
            // верхний объект выбирается только кликом без перетаскивания.
            const inSelection = (object: RigObject) => isSelectedTree(current.preset, object.id, current.selectedIds);
            const inside = inSelection(hit);
            const under = inside ? hit : hitTest(point, inSelection);
            const initial = Object.fromEntries(current.preset.objects.map((object) => [object.id, { ...object.base }]));
            if (under) {
              current.onDragStart();
              interaction.current = {
                type: "drag",
                ids: selectionRoots(current.preset.objects, current.selectedIds),
                start: point,
                initial,
                pending: inside ? null : hit.id,
                moved: false,
              };
              return;
            }
            current.onSelect(hit.id, "replace");
            current.onDragStart();
            interaction.current = { type: "drag", ids: [hit.id], start: point, initial, pending: null, moved: false };
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
              markDirty();
              return;
            }
            if (current.type === "pen") {
              // Курсор снимаем сразу (событие живёт до конца обработчика), а
              // считаем — в ближайшем кадре: возьмёт самое свежее положение.
              const target = scenePoint(event);
              const { objectId, itemId, index } = current;
              queueLive(() => {
                const object = propsRef.current.preset.objects.find((item) => item.id === objectId);
                const item = object?.shape?.items.find((entry) => entry.id === itemId);
                if (!object || !item) return;
                const local = shapePoint(object, propsRef.current.frameRef.current, target);
                propsRef.current.onPenPoints?.(
                  object.id, item.id,
                  item.points.map((point, at) => (
                    at === index ? { x: roundPoint(local.x), y: roundPoint(local.y) } : point
                  )),
                  item.points.map((_, at) => smoothingOf(item, at)),
                  true,
                );
              });
              return;
            }
            if (current.type === "warpCorner" || current.type === "warpFrame" || current.type === "warpRotate") {
              const object = propsRef.current.preset.objects.find((item) => item.id === current.objectId);
              if (!object) return;
              const values = propsRef.current.frameRef.current?.objects[object.id] || staticValues(object);
              const point = scenePoint(event);
              if (current.type === "warpRotate") {
                const angle = Math.atan2(point.y - current.center.y, point.x - current.center.x);
                const degrees = ((angle - current.start) * 180) / Math.PI;
                const next = rotateWarpFrame(current.initial, event.shiftKey ? Math.round(degrees / 15) * 15 : degrees);
                const id = object.id;
                queueLive(() => propsRef.current.onWarp(id, next));
                return;
              }
              // Экранное смещение переводим в координаты картинки: объект может
              // быть повёрнут и отмасштабирован, а ручки живут в его осях.
              const matrix = objectMatrix(object, values);
              const left = -object.pivot.x * object.width;
              const top = -object.pivot.y * object.height;
              const toContent = (at: Point) => {
                const local = transformPoint(invertAffine(matrix), at.x, at.y);
                return { x: local.x - left, y: local.y - top };
              };
              const from = toContent(current.start);
              const to = toContent(point);
              const dx = to.x - from.x;
              const dy = to.y - from.y;
              const next = current.type === "warpCorner"
                ? moveWarpCorner(current.initial, current.corner, object, dx, dy)
                : current.handle === "move"
                  ? moveWarpFrame(current.initial, object, dx, dy)
                  : resizeWarpFrame(current.initial, current.handle, object, dx, dy);
              const id = object.id;
              queueLive(() => propsRef.current.onWarp(id, next));
              return;
            }
            const point = scenePoint(event);
            if (Math.hypot(point.x - current.start.x, point.y - current.start.y) > 2) current.moved = true;
            let delta = { x: point.x - current.start.x, y: point.y - current.start.y };
            if (event.shiftKey) {
              if (Math.abs(delta.x) >= Math.abs(delta.y)) delta = { x: delta.x, y: 0 };
              else delta = { x: 0, y: delta.y };
            }
            const { ids, initial } = current;
            queueLive(() => propsRef.current.onDragObjects(ids, initial, delta));
          }}
          onPointerUp={(event) => {
            const current = interaction.current;
            interaction.current = null;
            // Отложенная правка могла ещё не примениться: применяем до того,
            // как закрыть тягу, иначе последнее положение курсора потеряется.
            flushLive();
            if (current?.type === "pen") propsRef.current.onPenDragEnd?.();
            if (current?.type === "marquee") {
              current.points.push(screenPoint(event));
              finishMarquee(current);
              marqueeRef.current = null;
              markDirty();
            }
            // Верхний объект выбирается только настоящим кликом: короткое
            // нажатие без движения, а не перетаскивание поверх выделения.
            if (current?.type === "drag" && !current.moved && current.pending) {
              propsRef.current.onSelect(current.pending, "replace");
            }
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            const current = interaction.current;
            interaction.current = null;
            marqueeRef.current = null;
            if (current?.type === "pen") propsRef.current.onPenDragEnd?.();
            markDirty();
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
                else if (event.key === "Escape") { setEditingSize(false); markDirty(); }
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
          {/* Перо без контура — это не поломка, а подсказка: где его взять. */}
          {props.tool === "pen" && !props.pen
            ? "Перо: выберите объект-фигуру с контуром «Перо» во вкладке «Фигура»"
            : TOOL_HINT[props.tool]}
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
  pivot: "Клик по спрайту задаёт пивот, по группе — точку вращения",
  pan: "Панорамирование",
  warp: "Зона деформации: тяните стороны и поворот; Shift на повороте — шаг 15°",
  deform: "Углы деформации: тяните углы картинки; Shift на повороте — шаг 15°",
  pen: "Клик ставит точку между ближайшими; первая точка замыкает контур; Alt+клик — угол ⇄ кривая",
};

/** Объект считается выделенным, если выделен он сам или любой его предок. */
/**
 * Точки контура, который правит перо.
 *
 * Без них непонятно, где кончается линия и что можно потянуть: сама фигура
 * рисуется обычной заливкой.
 */
function drawPen(
  ctx: CanvasRenderingContext2D,
  preset: RigPreset,
  frame: RigFrame | null,
  pen: { objectId: string; itemId: string },
  zoom: number,
  handles: boolean,
): void {
  const object = preset.objects.find((item) => item.id === pen.objectId);
  const item = object?.shape?.items.find((entry) => entry.id === pen.itemId);
  if (!object || !item) return;
  const values = frame?.objects[object.id] || staticValues(object);
  const matrix = objectMatrix(object, values);
  const left = -object.pivot.x * object.width;
  const top = -object.pivot.y * object.height;
  ctx.save();
  ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
  ctx.translate(left, top);
  // Линия контура поверх фигуры: без неё не видно, где именно проходит кривая.
  ctx.beginPath();
  traceItem(ctx, item);
  ctx.lineWidth = 1.4 / zoom;
  ctx.strokeStyle = PEN_LINE_COLOR;
  ctx.setLineDash([]);
  ctx.stroke();
  // Точки — только когда перо действительно правит: в других инструментах они
  // мешали бы смотреть на картинку.
  if (handles) {
    const radius = 4 / zoom;
    for (const [index, point] of item.points.entries()) {
      const smoothing = smoothingOf(item, index);
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      // Угол и кривая различаются цветом: тип точки видно без наведения.
      ctx.fillStyle = smoothing > 0 ? "#14171b" : "#e4bd7c";
      ctx.fill();
      ctx.lineWidth = 1.5 / zoom;
      ctx.strokeStyle = "#e4bd7c";
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Тонкая обводка контуров выбранных фигур.
 *
 * Фигура рисуется заливкой, и на плоском цвете не видно, где кончается контур.
 * Обводка появляется при выделении и исчезает при снятии выбора — на сцене в
 * ролике её нет, это только подсказка редактора.
 */
function drawShapeOutlines(
  ctx: CanvasRenderingContext2D,
  preset: RigPreset,
  frame: RigFrame | null,
  zoom: number,
  selectedIds: string[],
): void {
  if (!selectedIds.length) return;
  ctx.save();
  ctx.strokeStyle = PEN_LINE_COLOR;
  ctx.lineWidth = 1 / zoom;
  ctx.setLineDash([5 / zoom, 4 / zoom]);
  for (const id of selectedIds) {
    const object = preset.objects.find((item) => item.id === id);
    if (!object || object.kind !== "shape") continue;
    const values = frame?.objects[object.id] || staticValues(object);
    const matrix = objectMatrix(object, values);
    ctx.save();
    ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    ctx.translate(-object.pivot.x * object.width, -object.pivot.y * object.height);
    for (const item of object.shape?.items ?? []) {
      ctx.beginPath();
      traceItem(ctx, item);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

function roundPoint(value: number): number {
  return Number(value.toFixed(1));
}

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
/** Цвет контура пера: та же тёплая гамма, что у ручек. */
const PEN_LINE_COLOR = "#e4bd7c";

/** Цвет спецрежима «Границы текстуры»: зона и её углы. */
const WARP_COLOR = "#e0834a";
const WARP_CORNER_COLOR = "#f0c36b";

/** Отрисовка спецрежима: зона деформации и её углы. */
function drawWarpOverlay(
  ctx: CanvasRenderingContext2D,
  preset: RigPreset,
  frame: RigFrame | null,
  zoom: number,
  primaryId: string | null,
  mode: "frame" | "corners" = "frame",
) {
  if (!primaryId) return;
  const object = preset.objects.find((item) => item.id === primaryId);
  if (!object || object.kind === "group") return;
  if (object.kind === "text") return;
  const values = frame?.objects[object.id] || staticValues(object);
  const matrix = objectMatrix(object, values);
  const left = -object.pivot.x * object.width;
  const top = -object.pivot.y * object.height;
  const handles = warpHandlesAt(object, values, left, top, matrix, zoom);
  const size = 5 / zoom;

  ctx.save();
  // Четырёхугольник картинки: видно, что именно получилось. В режиме зоны его
  // не рисуем — он принадлежит инструменту углов.
  ctx.strokeStyle = WARP_COLOR;
  ctx.lineWidth = 1.4 / zoom;
  ctx.setLineDash([]);
  if (mode === "corners") {
    ctx.beginPath();
    handles.corners.forEach((handle, index) => (index === 0 ? ctx.moveTo(handle.point.x, handle.point.y) : ctx.lineTo(handle.point.x, handle.point.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = WARP_CORNER_COLOR;
    for (const handle of handles.corners) {
      ctx.beginPath();
      ctx.arc(handle.point.x, handle.point.y, size + 1 / zoom, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  // Зона, которую гнём: пунктир плюс лёгкая заливка, чтобы отличать её от углов.
  ctx.fillStyle = "rgba(224, 131, 74, 0.10)";
  ctx.beginPath();
  handles.zone.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
  ctx.closePath();
  ctx.fill();
  ctx.setLineDash([6 / zoom, 4 / zoom]);
  ctx.lineWidth = 1 / zoom;
  ctx.stroke();

  // Стороны зоны: квадратные ручки размера.
  ctx.setLineDash([]);
  ctx.fillStyle = "#1b2026";
  for (const handle of handles.frameHandles) {
    ctx.beginPath();
    ctx.rect(handle.point.x - size, handle.point.y - size, size * 2, size * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Поворот зоны: кружок с точкой на ножке.
  ctx.beginPath();
  ctx.moveTo(handles.zone[0].x, handles.zone[0].y);
  ctx.lineTo(handles.zone[1].x, handles.zone[1].y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo((handles.zone[0].x + handles.zone[1].x) / 2, (handles.zone[0].y + handles.zone[1].y) / 2);
  ctx.lineTo(handles.rotation.x, handles.rotation.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(handles.rotation.x, handles.rotation.y, size + 1 / zoom, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

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
    const corners = object.kind !== "group"
      ? objectOutline(object, staticValues(object))
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
      const corners = object.kind !== "group"
        ? objectOutline(object, values)
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
    const corners = object.kind !== "group"
      ? objectOutline(object, values)
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

/** Файлы масок пресета: их отдаёт `MaskMedia`, чтобы видео-маска играла. */
function maskSources(preset: RigPreset): string[] {
  const sources: string[] = [];
  for (const object of preset.objects) {
    if (object.mask?.kind === "file" && object.mask.file) sources.push(object.mask.file);
  }
  return sources;
}
