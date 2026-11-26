import {SceneToolOptions} from "./SceneToolOptions";
import {rebuildArtTriangles} from "../engine/artMeshQuality";
import {ArtMeshToolsPanel} from "./ArtMeshToolsPanel";
import {disabledIds} from "../engine/frame";
import {ArtMeshPasteDialog} from "./ArtMeshPasteDialog";
import {holdArtMesh,heldArtMesh,type ArtMeshClip,type ArtMeshPasteScale} from "../engine/artMeshClipboard";
import {captureArtAlpha} from "../render/artMeshAlphaSource";
import type {ArtMeshReplacement} from "../engine/artMeshBatch";
import {addArtFace} from "../engine/artMeshFaces";
import type {ArtTopologyCommand} from "../engine/artMeshTopology";
import {selectArtRegion,type ArtSelectionPoint} from "../engine/artMeshSelection";
import {artSymmetryPairs,mirrorArtDeltas,reflectArtVector} from "../engine/artMeshSymmetry";
import { artFramePoints, artStateOffsets } from "../engine/artMeshPlayback";
import {addArtOffsets} from "../engine/artMeshRuntime";
import {ArtMeshGenerator} from "./ArtMeshGenerator";
import {artEditorPoint,editArtVertices,artBrushWeight,drawArtEditor,inverseArtEditorPoint} from "../render/artMeshEditor";
import {bindArtPoint,artPosition,type ArtDeformation,type ArtOffsets} from "../engine/artDeformation";
import {enterRenderStage} from "../engine/renderProfile";
import { ShortcutGuide } from "./ShortcutGuide";
import { createParentMeshTransforms } from "../render/bend";
import { useEffect, useRef, useState, type RefObject } from "react";
import { BoxSelect, Brush, CircleDot, Crosshair, Focus, Frame, Ghost, Grid3X3, Hand, LassoSelect, LocateFixed, MousePointer2, Move3D, PenTool, Scan, FlipHorizontal2, SlidersHorizontal, ZoomIn, ZoomOut } from "lucide-react";
import type { BasePose, GuideMode, RigFrame, RigObject, RigPreset, Vec2 } from "../types";
import { GUIDE_LABEL } from "../types";
import { groupBounds, objectOutline } from "../render/bounds";
import { createCollector, disposeLighting, resetCollector, retainLightingSources } from "../render/lighting";
import { applyColors, type ColorField, type Rgba } from "../render/color";
import { sceneSampler } from "../render/sceneSample";
import {
  drawRig, prepareRigMeshes, invertAffine, objectMatrix, orderedObjects, scriptHidden, SpriteAssets, staticValues,
  transformPoint, type Affine,
} from "../render/rigCanvas";
import { MediaAssets, MaskMedia } from "../render/media";
import { previewFrame } from "../engine/structure";
import type { StatePreview } from "../engine/states";
import { onAssetsChanged } from "../engine/assets";
import type { TextChannel } from "../render/text";
import {
  boxFromCorners, boxFromPoints, boxIntersects, pointInPolygon, polygonIntersectsBox, selectionRoots,
  subtreeIds, type Box, type Point,
} from "../engine/selection";
import { formatCanvasSize, parseCanvasSize, sameCanvasSize } from "../engine/canvasSize";
import { createOnDemandLoop, onFrameProduced } from "../engine/frameSignal";
import { sameVisualFrame } from "../render/frameChanges";
import { countDraw, countSceneWake } from "../engine/meter";

import { penAction, shapeContentBounds, smoothingOf, traceItem } from "../render/shape";
import { meshSurfaceGeometry } from "../render/mesh";


export type SceneTool =
  | "move" | "pivot" | "pan" | "marquee" | "lasso"
  /** Деформация существующих вершин артмеша. */
  | "warp"
  /** Базовая геометрия и топология того же артмеша. */
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
  artSelectionTool?:"move"|"marquee"|"lasso";
  showGrid: boolean;
  /** Пауза или стоп: скрытое по входам рисуется полупрозрачным призраком. */
  ghosts: boolean;
  /**
   * Настройка «скрытые призраками» — привычка редактора, а не свойство сцены.
   *
   * Рисуются призраки всё равно только в паузе и стопе (`ghosts`), но галка
   * помнит выбор человека: включил один раз — и в следующей паузе картинка
   * показывает скрытое, а не притворяется кадром.
   */
  ghostPref: boolean;
  /** Переключить призраков. */
  onToggleGhosts: () => void;
  /** Снять/вернуть видимость с призрака: тот же путь, что у глаза в дереве. */
  onToggleGhost?: (id: string) => void;
  bounds: GuideMode;
  pivots: GuideMode;
  /** Текст из модулей: подстановки `{twitch.chat.message}` в текстовых объектах. */
  texts?: TextChannel;
  /**
   * Готовые цвета из модулей: `{ obj: { fill: { r, g, b } } }`. Ядро их не
   * считает, поэтому они приходят сюда и подставляются в пресет перед кадром.
   */
  colors?: Record<string, Partial<Record<ColorField, Rgba>>>;
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
  /**
   * Жест закончился. Вкладке «Состояния» нужно знать конец: пока объект тянут,
   * поза не пишется (иначе дельта от начала жеста копилась бы каждый кадр).
   */
  onDragEnd?: () => void;
  /**
   * Предпросмотр состояний: поправка к кадру объекта, пресет не меняет.
   *
   * Перекрывается только вклад слоя вкладки — `inherit`, поведение, другие слои
   * и видимость остаются кадровыми.
   */
  preview?: StatePreview | null;
  onDragObjects: (ids: string[], initial: Record<string, BasePose>, delta: { x: number; y: number }) => void;
  /**
   * Пивот ставится кликом в его новую точку: `base` — она же в мировых
   * координатах (пивот объекта и есть его `base`), картинка при этом не едет.
   */
  onPivot: (id: string, base: { x: number; y: number }, pivot: { x: number; y: number }) => void;
  onArtPaste:(id:string,clip:ArtMeshClip,scale:ArtMeshPasteScale,pose:boolean)=>void;
  onArtBatch:(meshes:ArtMeshReplacement[],inherit:boolean)=>void;
  onArtTopology:(id:string,command:ArtTopologyCommand)=>void;
  onArtMesh:(id:string,mesh:ArtDeformation,pose:ArtOffsets,regenerate?:boolean,dimensions?:{width:number;height:number})=>void;
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
      /** Ось, выбранная Shift: фиксируется один раз за жест, иначе дрожит. */
      axis?: "x" | "y" | null;
    }
  | { type: "pan"; startX: number; startY: number; camera: Camera }
  | { type: "marquee"; shape: "rect" | "lasso"; start: Point; points: Point[]; additive: boolean }
  /** Перо: тянем точку контура с номером `index`. */
  | { type: "pen"; objectId: string; itemId: string; index: number }
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
  /** Свет и нормали текущего кадра для прохода объёма. */
  const lighting = useRef(createCollector());
  const mediaAssets = useRef(new MediaAssets());
  /** Видео-маски: маской может быть фильм, тогда видно его текущий кадр. */
  const maskMedia = useRef(new MaskMedia());
  const dirty = useRef(true);
  const interaction = useRef<Interaction>(null);
  const [artPanelOpen,setArtPanelOpen]=useState(true);
  const [artGenerator,setArtGenerator]=useState<false|"single"|"descendants">(false);
  const [artTopologyError,setArtTopologyError]=useState("");
  const [artPaste,setArtPaste]=useState<ArtMeshClip|null>(null);
  useEffect(()=>setArtPaste(null),[props.primaryId]);
  const [artReference,setArtReference]=useState(true);
  const [artBrushEnabled,setArtBrush]=useState(false);
  const artBrush=props.tool==="warp"&&artBrushEnabled;
  useEffect(()=>setArtBrush(false),[props.artSelectionTool]);
  const artPickMode=artBrush?"move":props.artSelectionTool==="marquee"?"rect":props.artSelectionTool??"move";
  const artArea=useRef<{objectId:string;shape:"rect"|"lasso";path:Vec2[];points:ArtSelectionPoint[];previous:Set<string>;mode:"replace"|"add"|"subtract"}|null>(null);
  const [artHardness,setArtHardness]=useState(.5);
  const [artDynamic,setArtDynamic]=useState(false);
  const [artRadius,setArtRadius]=useState(80);
  const [artSymmetry,setArtSymmetry]=useState(false);
  const [artSymmetryAngle,setArtSymmetryAngle]=useState(0);
  const artToolRef=useRef({brush:artBrush,radius:artRadius,symmetry:artSymmetry,angle:artSymmetryAngle,reference:artReference});
  artToolRef.current={brush:artBrush,radius:artRadius,symmetry:artSymmetry,angle:artSymmetryAngle,reference:artReference};
  const artSelection=useRef<{objectId:string;ids:Set<string>}>({objectId:"",ids:new Set()});
  const artDrag=useRef<{object:RigObject;matrix:Affine;mode:"rest"|"pose";deform?:((point:Vec2)=>Vec2);vertices:Array<{id:string;start:Vec2;seed:Vec2;weight:number;mirrored?:boolean}>;cursor:Vec2;brush?:{dynamic:boolean;radius:number;hardness:number;angle?:number;last:Vec2;deltas:ArtOffsets};symmetry?:{axis:number;pairs:Map<string,string>}}|null>(null);
  /** Курсор в мировых координатах: по нему кисть показывает свой радиус. */
  const hover = useRef<Point | null>(null);
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
  useEffect(()=>{
    const finish=()=>{artArea.current=null;markDirty();if(artDrag.current){artDrag.current=null;propsRef.current.onDragEnd?.();}};
    window.addEventListener("blur",finish);
    return ()=>{window.removeEventListener("blur",finish);finish();};
  },[]);

  useEffect(()=>{
    const cancel=(event:KeyboardEvent)=>{if(event.key==="Escape"&&artArea.current){artArea.current=null;markDirty();event.preventDefault();event.stopImmediatePropagation();}};
    window.addEventListener("keydown",cancel,true);return ()=>window.removeEventListener("keydown",cancel,true);
  },[]);

  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      const current=propsRef.current;
      if(current.tool!=="deform"&&current.tool!=="warp")return;
      if((event.target as HTMLElement)?.closest("input,textarea,select,[contenteditable=true]"))return;
      if(event.code==="KeyB"&&!event.ctrlKey&&!event.metaKey){if(current.tool!=="warp")current.onTool("warp");setArtBrush(true);event.preventDefault();return;}
      if(["KeyV","KeyM","KeyL"].includes(event.code))setArtBrush(false);
      if(event.code!=="Delete"&&event.code!=="Backspace")return;
      event.preventDefault();event.stopImmediatePropagation();
      const selection=artSelection.current;
      if(current.tool==="deform"&&selection.objectId===current.primaryId&&selection.ids.size){current.onArtTopology(selection.objectId,{type:"remove",rebuild:true,ids:[...selection.ids]});selection.ids.clear();markDirty();}
    };
    window.addEventListener("keydown",key,true);return()=>window.removeEventListener("keydown",key,true);
  },[]);
  useEffect(()=>{artArea.current=null;markDirty();},[props.primaryId,props.tool,artPickMode]);

  // Отрисовка по требованию: постоянного rAF-цикла больше нет (он грузил
  // процессор в простое), но любая правка или новый кадр планирует ровно один
  // кадр отрисовки.
  const loop = useRef<{ request: () => void; stop: () => void } | null>(null);
  const markDirty = (reason="interaction") => {
    countSceneWake(reason);
    dirty.current = true;
    loop.current?.request();
  };

  /**
   * Кадр для хит-тестов и ручек — с тем же изгибом детей, что и отрисовка.
   *
   * Иначе ребёнок, которого гнёт родитель, рисовался бы в одном месте, а
   * ловился мышью в другом.
   */
  const liveFrame = (preset: RigPreset): RigFrame | null =>
    previewFrame(propsRef.current.frameRef.current, preset.objects, propsRef.current.preview);

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
    // Свёрнутое или скрытое окно не рисуем вовсе: кадры всё равно не видны, а
    // каждый из них — работа процессора и память под композитный кадр. Кадры
    // движка при этом продолжают идти, поэтому сцену разбудим на возвращении.
    if (typeof document !== "undefined" && document.hidden) {
      dirty.current = true;
      return;
    }
    const endRenderProfile=enterRenderStage("scene");
    try {
    const drawStarted=performance.now();
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
    // Предпросмотр состояний живёт только в кадре: пресет не меняется, поэтому
    // сцена и вкладка не спорят, а объект остаётся на своём месте в данных.
    const previewed = current.tool==="deform"?{...preset,objects:preset.objects.map(o=>o.id===current.primaryId?{...o,artPose:{}}:o)}:preset;
    // Веса из кадра плюс замена только выбранного слоя предпросмотра.
    const meshPoints = artFramePoints(preset,current.frameRef.current,undefined,current.preview);
    if(current.tool==="deform"&&current.primaryId)meshPoints.set(current.primaryId,{});
    // Кадр с изгибом детей: сетка родителя двигает и то, что на ней висит.
    const frame = previewFrame(current.frameRef.current, preset.objects, current.preview);
    const colors = current.colors;
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
    resetCollector(lighting.current);
    // Цвета из модулей подставляются в копию пресета: свет, фигуры, текст и
    // материал уже читают цвет из объекта, поэтому менять их код не нужно.
    const shown = colors ? applyColors(previewed, colors) : previewed;
    const preparedMeshes=prepareRigMeshes(previewed,frame,meshPoints);
    const reference=shown.objects.find(o=>o.id===current.primaryId);
    if(current.tool==="deform"&&artToolRef.current.reference&&reference?.artMesh&&!disabledIds(shown.objects).has(reference.id)){
      // Editor tracing reference only; never sent to overlay or ambient sampler.
      ctx.save();ctx.globalAlpha=.25;
      const source={...reference,parentId:null,mask:undefined,artMesh:undefined,artPose:undefined,base:{...reference.base,opacity:1,visible:1}};
      const sourceValues={...(frame?.objects[reference.id]??staticValues(reference)),visible:1,opacity:1};
      drawRig(ctx,{...shown,objects:[source]},frame?{...frame,objects:{...frame.objects,[reference.id]:sourceValues}}:null,assets.current,{lineScale:zoom,media:mediaAssets.current,placeholders:true});
      ctx.restore();
    }
    drawRig(ctx, shown, frame, assets.current, {
      preparedMeshes,
      placeholders: true, lineScale: zoom, ghosts: current.ghosts,
      media: mediaAssets.current, texts: current.texts, maskMedia: maskMedia.current,
      lighting: lighting.current,
      environment: preset.environment,
      meshPoints,
    });
    // Объём от карт нормалей считается внутри drawRig: каждый объект получает
    // свой объём в своём слое, поэтому верхние слои его перекрывают.
    //
    // Замер для ambient — второй проход по тому же кадру, но маленький и без
    // интерфейса: сетка, выделение и серый фон вокруг артборда в средний цвет
    // попасть не должны. Просим его только пока включён модуль «Свет из экрана».
    const probe = sceneSampler.prepare(preset.canvas.width, preset.canvas.height);
    if (probe) {
      drawRig(probe.ctx, shown, frame, assets.current, {
        preparedMeshes,
        placeholders: false, lineScale: 1,
        media: mediaAssets.current, texts: current.texts, maskMedia: maskMedia.current,
        environment: preset.environment,
      });
      sceneSampler.commit();
    }
    drawGuides(ctx, previewed, frame, zoom, current.bounds, current.pivots, current.selectedIds);
    drawSelection(ctx, previewed, frame, zoom, current.selectedIds, current.primaryId, current.tool === "pivot");
    // Одна топология: показ базы либо деформированных вершин.
    const showPose = current.tool === "warp";
    const showRest = current.tool === "deform";
    const artTarget=previewed.objects.find(o=>o.id===current.primaryId);
    if(artTarget?.artMesh&&(showPose||showRest))drawArtEditor(ctx,{...artTarget,artPose:addArtOffsets(artTarget.artPose,meshPoints.get(artTarget.id))},frame?.objects[artTarget.id]??staticValues(artTarget),zoom,showRest,createParentMeshTransforms(previewed,frame,meshPoints)?.(artTarget),artSelection.current.objectId===artTarget.id?artSelection.current.ids:undefined);
    const area=artArea.current;
    if(area&&area.path.length>1){
      ctx.save();ctx.strokeStyle="#f0d77a";ctx.fillStyle="#f0d77a18";ctx.lineWidth=1/zoom;ctx.setLineDash([5/zoom,3/zoom]);ctx.beginPath();
      if(area.shape==="rect"){
        const first=area.path[0],last=area.path[area.path.length-1];ctx.rect(first.x,first.y,last.x-first.x,last.y-first.y);
      }else{area.path.forEach((p,i)=>{if(i)ctx.lineTo(p.x,p.y);else ctx.moveTo(p.x,p.y);});ctx.closePath();}
      ctx.fill();ctx.stroke();ctx.restore();
    }
    if(artTarget?.artMesh&&(showPose||showRest)&&artToolRef.current.symmetry){
      const radians=artToolRef.current.angle*Math.PI/180;
      const matrix=objectMatrix(artTarget,frame?.objects[artTarget.id]??staticValues(artTarget));
      const deform=createParentMeshTransforms(previewed,frame,meshPoints)?.(artTarget);
      ctx.save();ctx.strokeStyle="#d6a2ed";ctx.lineWidth=1/zoom;ctx.setLineDash([5/zoom,4/zoom]);ctx.beginPath();
      for(let i=0;i<=32;i++){
        const length=Math.hypot(artTarget.width,artTarget.height)*(i/32-.5);
        const source={x:artTarget.width/2-Math.sin(radians)*length,y:artTarget.height/2+Math.cos(radians)*length};
        const p=deform?deform(source):source;
        const world=transformPoint(matrix,p.x-artTarget.pivot.x*artTarget.width,p.y-artTarget.pivot.y*artTarget.height);
        if(i)ctx.lineTo(world.x,world.y);else ctx.moveTo(world.x,world.y);
      }ctx.stroke();ctx.restore();
    }
    if(artTarget?.artMesh&&(showPose||showRest)&&artToolRef.current.brush&&hover.current){
      ctx.save();ctx.strokeStyle="#b3e5db";ctx.lineWidth=1/zoom;ctx.beginPath();ctx.arc(hover.current.x,hover.current.y,artToolRef.current.radius,0,Math.PI*2);ctx.stroke();
      if(artToolRef.current.symmetry){
        const matrix=objectMatrix(artTarget,frame?.objects[artTarget.id]??staticValues(artTarget)),p=artEditorPoint(artTarget,hover.current,matrix);
        const reflected=reflectArtVector({x:p.x-artTarget.width/2,y:p.y-artTarget.height/2},artToolRef.current.angle);
        const world=transformPoint(matrix,reflected.x+artTarget.width/2-artTarget.pivot.x*artTarget.width,reflected.y+artTarget.height/2-artTarget.pivot.y*artTarget.height);
        ctx.setLineDash([4/zoom,3/zoom]);ctx.beginPath();ctx.arc(world.x,world.y,artToolRef.current.radius,0,Math.PI*2);ctx.stroke();
      }
      ctx.restore();
    }
    drawShapeOutlines(ctx, previewed, frame, zoom, current.selectedIds);
    if (current.pen) drawPen(ctx, previewed, frame, current.pen, zoom, true);
    if (current.tool === "marquee" || current.tool === "lasso") drawHiddenOutlines(ctx, previewed, zoom);

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
    countDraw(performance.now()-drawStarted);
    // Видео меняется само по себе: пока оно играет, просим следующий кадр.
    // Видео-маска тоже живая — иначе «окно» застыло бы на первом кадре.
    if (mediaAssets.current.active() || maskMedia.current.active()) markDirty();
    } finally { endRenderProfile?.(); }
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



  // Цвет из модуля меняется по времени (30 раз в секунду), поэтому каждый его
  // новый набор — это новый кадр. Правка самого пресета перерисовку уже зовёт.
  useEffect(() => {
    markDirty("colors");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.colors]);

  const imageKey = props.preset.objects.map((object) => object.image).filter(Boolean).join("|");
  useEffect(() => {
    assets.current.sync(props.preset.objects);
    retainLightingSources(props.preset);
    markDirty();
  }, [imageKey, props.preset, props.preset.objects]);

  useEffect(() => assets.current.onChange(() => { markDirty("assets"); }), []);
  // Замер для ambient нужен и в простое (стоп, расстановка), когда кадров нет:
  // просьба о замере сама будит отрисовку, иначе свет замирал бы до движения мыши.
  useEffect(() => sceneSampler.onRequest(() => { markDirty("sampler"); }), []);
  // Файлы из хранилища читаются асинхронно: когда картинка появилась,
  // спрайт нужно поставить в очередь декодирования и перерисовать сцену.
  useEffect(() => onAssetsChanged(() => {
    assets.current.sync(propsRef.current.preset.objects);
    markDirty();
  }), []);
  useEffect(() => () => {
    assets.current.dispose();
    mediaAssets.current.dispose();
    maskMedia.current.dispose();
    sceneSampler.reset();
    if (shadowRef.current) {
      shadowRef.current.width = 0;
      shadowRef.current.height = 0;
      shadowRef.current = null;
    }
    disposeLighting();
  }, []);

  useEffect(() => {
    markDirty("scene-props");
  }, [props.preset, props.selectedIds, props.primaryId, props.showGrid, props.tool, props.bounds, props.pivots, props.ghosts, props.pen, props.preview, artBrush, artRadius, artSymmetry, artSymmetryAngle, artReference]);

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
    const wake = () => { if (!document.hidden) markDirty(); };
    document.addEventListener("visibilitychange", wake);
    return () => document.removeEventListener("visibilitychange", wake);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const render = createOnDemandLoop(() => {
      dirty.current = false;
      draw();
    });
    loop.current = render;
    // Новый кадр от движка — повод перерисовать; нет кадров — цикл спит.
    let previousFrame: RigFrame | null = null;
    const unsubscribe = onFrameProduced(() => {
      const frame = propsRef.current.frameRef.current;
      // The engine can keep ticking (audio, scripts, OBS) without making this
      // window repaint identical pixels. Video/mask playback must still advance.
      const changed = !sameVisualFrame(previousFrame, frame);
      previousFrame = frame;
      if (changed || mediaAssets.current.active() || maskMedia.current.active()) {
        countSceneWake(changed?"frame-changed":"media");render.request();
      }
    });
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

  /**
   * Выделенная группа, внутри чьей рамки оказалась точка.
   *
   * Группа не рисуется, поэтому по пикселям её не поймать: рамка считается по
   * детям (`groupBounds`). Нужна ровно для перетаскивания — клик по пустому
   * месту внутри группы выделение не меняет.
   */
  const groupAt = (point: { x: number; y: number }): string | null => {
    const current = propsRef.current;
    const shown = current.preset;
    const order = orderedObjects(shown, previewFrame(current.frameRef.current, shown.objects, current.preview));
    const position = new Map(order.map((object, index) => [object.id, index]));
    // Верх группы — самый верхний её потомок: он и есть её «пиксель».
    const top = (id: string) => Math.max(-1, ...subtreeIds(shown.objects, [id]).map((child) => position.get(child) ?? -1));
    let best: string | null = null;
    let bestTop = -1;
    for (const object of shown.objects) {
      if (object.kind !== "group" || object.enabled === false) continue;
      const box = groupBounds(shown, object.id);
      if (!box || box.length < 3 || !pointInPolygon(point, box)) continue;
      const height = top(object.id);
      if (height > bestTop) { best = object.id; bestTop = height; }
    }
    return best;
  };

  /**
   * Кто отвечает за нажатие: группа-контейнер или спрайт.
   *
   * Группа ловит мышь своим габаритом, поэтому объект, который лежит **за ней**,
   * внутри габарита больше не тянется — его выбирают кликом вне группы или в
   * дереве. Свои дети и то, что рисуется выше группы, остаются важнее: это её
   * картинка и то, что лежит перед ней.
   */
  const containerAt = (point: { x: number; y: number }, hit: RigObject | null): string | null => {
    const group = groupAt(point);
    if (!group) return null;
    const current = propsRef.current;
    if (hit) {
      // Спрайт — потомок группы: это её пиксель, он и отвечает.
      if (subtreeIds(current.preset.objects, [group]).includes(hit.id)) return null;
      const shown = current.preset;
      const order = orderedObjects(shown, previewFrame(current.frameRef.current, shown.objects, current.preview));
      const position = new Map(order.map((object, index) => [object.id, index]));
      const top = Math.max(-1, ...subtreeIds(shown.objects, [group]).map((child) => position.get(child) ?? -1));
      // Спрайт рисуется выше группы — он и впереди.
      if ((position.get(hit.id) ?? -1) > top) return null;
    }
    return group;
  };

  const hitTest = (point: { x: number; y: number }, accept?: (object: RigObject) => boolean): RigObject | null => {
    const current = propsRef.current;
    const frame = previewFrame(current.frameRef.current, current.preset.objects, current.preview);
    const shown = current.preset;
    const inheritedFor=createParentMeshTransforms(shown,frame,artFramePoints(shown,frame,undefined,current.preview));
    const disabled=disabledIds(shown.objects);
    const selected = shown.objects.find((item) => item.id === current.primaryId);
    if (selected?.kind === "shape" && !disabled.has(selected.id) && (!accept || accept(selected))) {
      const values = frame?.objects[selected.id] || staticValues(selected);
      const box=selected.shape?shapeContentBounds(selected.shape):null;
      const center = transformPoint(objectMatrix(selected, values),box?box.x+box.width/2-selected.pivot.x*selected.width:0,box?box.y+box.height/2-selected.pivot.y*selected.height:0);
      if (box && values.visible !== 0 && Math.hypot(point.x - center.x, point.y - center.y) <= 10 / camera.current.zoom) return selected;
    }
    const ordered = orderedObjects(shown, frame);
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const object = ordered[index];
      if (accept && !accept(object)) continue;
      // Невидимая фигура-маска не должна перехватывать клики у спрайтов под
      // собой: её видно в дереве, там же она и выбирается.
      if (object.kind === "shape" && object.shape?.draw === false) continue;
      if(disabled.has(object.id))continue;
      const values = frame?.objects[object.id] || staticValues(object);
      // Призрак виден на сцене, значит по нему можно и щёлкнуть: иначе
      // полупрозрачный спрайт выглядел бы некликабельным.
      if (values.visible === 0 && !(current.ghosts && scriptHidden(object, values))) continue;
      const local = transformPoint(invertAffine(objectMatrix(object, values)), point.x, point.y);
      const left = -object.pivot.x * object.width;
      const top = -object.pivot.y * object.height;
      const inherited = inheritedFor?.(object);
      if (object.artMesh) {
        const surface = object;
        const geometry = meshSurfaceGeometry(surface, object.width, object.height, values, stateOffsets(object.id),inherited);
        if (geometry) {
          const bent = geometry;
          const content = { x: local.x - left, y: local.y - top };
          for (let i = 0; i < bent.triangles.length; i += 3) {
            if (pointInPolygon(content, bent.triangles.slice(i, i + 3).map((id) => bent.targets[id]))) return object;
          }
        }
        continue;
      }
      const contentBounds=object.kind==="shape"&&object.shape?shapeContentBounds(object.shape):null;
      if(object.kind==="shape" && !contentBounds) continue;
      const hitLeft=left+(contentBounds?.x??0),hitTop=top+(contentBounds?.y??0);
      if (local.x >= hitLeft && local.x <= hitLeft + (contentBounds?.width??object.width) && local.y >= hitTop && local.y <= hitTop + (contentBounds?.height??object.height)) return object;
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
      if (!corners?.length) continue;
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

  /*
   * Настройки сетки живут здесь, а не в параметрах объекта: кисть, симметрия и
   * автосетка — это инструменты, которыми работают на сцене, и держать их
   * галками в инспекторе значит искать ручку не там, где ею машут.
   */
  const meshTarget = props.preset.objects.find((item) => item.id === props.primaryId);
  /**
   * Вклад состояний для объекта — то, что видно на сцене.
   *
   * Ручки сетки и нарезки рисуются и ловятся по **той же** форме, что и картинка:
   * авторская сетка плюс смещения предпросмотра. Иначе записанный ключ гнул бы
   * изображение, а узлы стояли бы на старой форме — и правка выглядела бы
   * потерянной.
   */
  const stateOffsets = (objectId: string): Record<string, Vec2> | undefined => {
    const preview = propsRef.current.preview;
    const object=propsRef.current.preset.objects.find(o=>o.id===objectId);
    return object?.artMesh?artStateOffsets(object,propsRef.current.frameRef.current,preview):undefined;
  };
  useEffect(() => {
    if (props.tool === "pen" && props.preset.objects.find((item) => item.id === props.primaryId)?.kind !== "shape") props.onTool("move");
  }, [props.primaryId, props.tool, props.preset.objects]);

  return (
    <section className="scene-panel panel-surface">
      <div className="scene-toolbar">
        <div className="scene-title"><div><span className="eyebrow">ПРЕВЬЮ</span><h2>Сцена</h2></div><ShortcutGuide /></div>
        <div className="scene-tools">
          <button className={(props.tool === "move" || ((props.tool==="deform"||props.tool==="warp") && !artBrush && (props.artSelectionTool??"move")==="move")) ? "active" : ""} title="Выделение и перемещение (V) · Ctrl+клик — добавить, Shift+клик — тоже добавить" onClick={() => {setArtBrush(false);props.onTool("move");}}><MousePointer2 size={15} /></button>
          <button className={(props.tool === "marquee" || ((props.tool==="deform"||props.tool==="warp") && !artBrush && (props.artSelectionTool??"move")==="marquee")) ? "active" : ""} title="Выделение рамкой (M) · Shift — добавить к выборке" onClick={() => {setArtBrush(false);props.onTool("marquee");}}><BoxSelect size={15} /></button>
          <button className={(props.tool === "lasso" || ((props.tool==="deform"||props.tool==="warp") && !artBrush && (props.artSelectionTool??"move")==="lasso")) ? "active" : ""} title="Выделение лассо (L) · Shift — добавить к выборке" onClick={() => {setArtBrush(false);props.onTool("lasso");}}><LassoSelect size={15} /></button>
          <button className={props.tool === "pivot" ? "active" : ""} title="Пивот (P)" onClick={() => props.onTool("pivot")}><Crosshair size={15} /></button>
          {props.preset.objects.find((item) => item.id === props.primaryId)?.kind === "shape" && <button
            className={props.tool === "pen" ? "active" : ""}
            title="Перо (N) · клик ставит точку между ближайшими, Alt+клик меняет сглаживание точки"
            onClick={() => props.onTool("pen")}
          ><PenTool size={15} /></button>}
          <button className={props.tool === "pan" ? "active" : ""} title="Панорамирование (Space)" onClick={() => props.onTool("pan")}><Hand size={15} /></button>
          {/* Деформация — отдельной группой: зона и углы это разные правки,
              и в работе они не должны пересекаться. */}
          <span className="tool-separator" />
          <button
            className={props.tool === "warp" ? "active" : ""}
            title="Деформация артмеша (T)"
            disabled={!props.primaryId}
            onClick={() => props.onTool("warp")}
          ><Frame size={15} /></button>
          <button
            className={props.tool === "deform" ? "active" : ""}
            title="Правка базы и топологии артмеша (R)"
            disabled={!props.primaryId}
            onClick={() => props.onTool("deform")}
          ><Move3D size={15} /></button>
          {(props.tool==="warp"||props.tool==="deform")&&meshTarget&&<button className={artPanelOpen?"active":""} aria-label="Панель артмеша" title="Панель артмеша" aria-expanded={artPanelOpen} onClick={()=>setArtPanelOpen(v=>!v)}><SlidersHorizontal size={16}/></button>}
          {(props.tool==="warp"||props.tool==="deform")&&<>
           <SceneToolOptions label="Кисть артмеша" active={artBrush} icon={<Brush size={15}/>} onClick={()=>{if(props.tool!=="warp")props.onTool("warp");setArtBrush(true);}}>
            <label>Радиус<input aria-label="Радиус кисти артмеша" type="number" min={1} max={1000} value={artRadius} onChange={e=>setArtRadius(Math.max(1,Math.min(1000,Number(e.target.value)||1)))}/></label>
            <label>Жёсткость<input aria-label="Жёсткость кисти артмеша" type="range" min={0} max={1} step={.01} value={artHardness} onChange={e=>setArtHardness(Number(e.target.value))}/></label>
            <label>Режим<select aria-label="Режим кисти артмеша" value={artDynamic?"dynamic":"static"} onChange={e=>setArtDynamic(e.target.value==="dynamic")}><option value="static">Статичная</option><option value="dynamic">Динамичная</option></select></label>
           </SceneToolOptions>
           <SceneToolOptions label="Симметрия артмеша" active={artSymmetry} icon={<FlipHorizontal2 size={15}/>} onClick={()=>setArtSymmetry(v=>!v)}>
            <label>Угол оси, °<input aria-label="Угол симметрии артмеша" type="number" value={artSymmetryAngle} onChange={e=>setArtSymmetryAngle(Number(e.target.value)||0)}/></label>
           </SceneToolOptions>
          </>}
          <span className="tool-separator" />
          <button className={props.showGrid ? "active" : ""} title={`Сетка: ${props.showGrid ? "вкл" : "выкл"}`} onClick={props.onToggleGrid}><Grid3X3 size={15} /></button>
          <button
            className={props.ghostPref ? "active" : ""}
            title={`Отображать скрытые слои в паузе и стопе: ${props.ghostPref ? "вкл" : "выкл"}`
              + (props.ghosts ? " · Alt+клик по призраку возвращает объект в кадр" : "")}
            onClick={props.onToggleGhosts}
          >
            <Ghost size={15} />
          </button>
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
      {artPaste&&meshTarget&&<ArtMeshPasteDialog object={meshTarget} clip={artPaste} onClose={()=>setArtPaste(null)} onApply={(scale,pose)=>{
        props.onArtPaste(meshTarget.id,artPaste,scale,pose);setArtPaste(null);artSelection.current={objectId:meshTarget.id,ids:new Set()};
      }}/>}
      {artGenerator&&meshTarget&&<ArtMeshGenerator key={`${meshTarget.id}-${artGenerator}`}
        object={meshTarget} captureAlpha={object=>captureArtAlpha(object,object.kind==="media"?(mediaAssets.current.video(object.id)??mediaAssets.current.image(object.id)):assets.current.get(object.image))}
        batch={artGenerator==="descendants"?{root:meshTarget.id,objects:props.preset.objects,onApply:(meshes,inherit)=>{props.onArtBatch(meshes,inherit);setArtGenerator(false);}}:undefined} width={meshTarget.width} height={meshTarget.height} nextId={meshTarget.artMesh?.nextId??0}
        onClose={()=>setArtGenerator(false)} onApply={(mesh,dimensions)=>{props.onArtMesh(meshTarget.id,mesh,{},true,dimensions);setArtGenerator(false);if(props.tool!=="deform")props.onTool("deform");}}/>}
      <div className="scene-workarea">
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
            const artObject=current.preset.objects.find(o=>o.id===current.primaryId);
            if(artObject?.artMesh&&(current.tool==="warp"||current.tool==="deform")){
              hover.current=point;
              const frame=liveFrame(current.preset);
              const values=frame?.objects[artObject.id]??staticValues(artObject);
              const points=artFramePoints(current.preset,frame,undefined,current.preview);
              const deform=createParentMeshTransforms(current.preset,frame,points)?.(artObject);
              const pose=addArtOffsets(artObject.artPose,points.get(artObject.id));
              const matrix=objectMatrix(artObject,values),rest=current.tool==="deform";
              let nearest:string|null=null,distance=10/camera.current.zoom;
              const pointerLocal=artEditorPoint(artObject,point,matrix);
              const center={x:artObject.width/2,y:artObject.height/2};
              const reflected=reflectArtVector({x:pointerLocal.x-center.x,y:pointerLocal.y-center.y},artSymmetryAngle);
              const reflectedLocal={x:reflected.x+center.x,y:reflected.y+center.y};
              const reflectedWorld=transformPoint(matrix,reflectedLocal.x-artObject.pivot.x*artObject.width,reflectedLocal.y-artObject.pivot.y*artObject.height);
              const candidates=artObject.artMesh.vertices.map(v=>{
                const source=rest?v.rest:artPosition(v,pose),p=deform?deform(source):source;
                const world=transformPoint(matrix,p.x-artObject.pivot.x*artObject.width,p.y-artObject.pivot.y*artObject.height);
                const d=Math.hypot(world.x-point.x,world.y-point.y);
                if(d<distance){distance=d;nearest=v.id;}
                const mirroredDistance=artSymmetry?Math.hypot(world.x-reflectedWorld.x,world.y-reflectedWorld.y):Infinity;
                return {id:v.id,world,start:source,seed:source,mirrored:mirroredDistance<d,weight:artBrushWeight(Math.min(d,mirroredDistance),artRadius,artHardness)};
              });
              if(artSelection.current.objectId!==artObject.id)artSelection.current={objectId:artObject.id,ids:new Set()};
              const selected=artSelection.current.ids;
              if(rest&&event.altKey&&artPickMode==="move"){
                const cursor=artEditorPoint(artObject,point,matrix);
                const local=inverseArtEditorPoint(cursor,candidates.find(v=>v.id===nearest)?.start??cursor,deform);
                try{
                  if(nearest){current.onArtTopology(artObject.id,{type:"remove",rebuild:true,ids:[nearest]});selected.delete(nearest);}
                  else if(local){
                    const byId=new Map(candidates.map(v=>[v.id,v.world]));
                    let edge:string[]|undefined,edgeDistance=6/camera.current.zoom;
                    for(const face of artObject.artMesh.triangles)for(let i=0;i<3;i++){
                      const a=byId.get(face[i])!,b=byId.get(face[(i+1)%3])!,dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;
                      if(!length)continue;
                      const t=Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/length));
                      const d=Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy);
                      if(d<edgeDistance){edgeDistance=d;edge=[face[i],face[(i+1)%3]];}
                    }
                    if(edge)current.onArtTopology(artObject.id,{type:"removeEdge",rebuild:true,ids:edge});
                    else{const face=bindArtPoint(artObject.artMesh,local);if(face)current.onArtTopology(artObject.id,{type:"removeFace",rebuild:true,ids:face.ids});}
                  }
                  setArtTopologyError("");
                }catch(error){setArtTopologyError(error instanceof Error?error.message:"Не удалось удалить элемент.");}
                markDirty();return;
              }
              if(artPickMode!=="move"){
                artArea.current={objectId:artObject.id,shape:artPickMode,path:[point],points:candidates,previous:new Set(selected),mode:event.altKey?"subtract":event.shiftKey?"add":"replace"};
                markDirty();return;
              }
              if(!artBrush&&event.shiftKey){
                if(nearest){if(selected.has(nearest))selected.delete(nearest);else selected.add(nearest);}
                if(rest&&selected.size===3){try{addArtFace({...artObject.artMesh,triangles:artObject.artMesh.manualFaces??[]},[...selected]);current.onArtTopology(artObject.id,{type:"addFace",ids:[...selected]});setArtTopologyError("");}catch(error){setArtTopologyError(error instanceof Error?error.message:"Не удалось закрепить грань.");}}
                markDirty();return;
              }
              if(!artBrush&&nearest&&!selected.has(nearest)){selected.clear();selected.add(nearest);}
              if(!artBrush&&!nearest){
                selected.clear();
                if(rest){
                  const cursor=artEditorPoint(artObject,point,matrix),seed=candidates.reduce<typeof candidates[number]|undefined>((best,v)=>!best||Math.hypot(v.world.x-point.x,v.world.y-point.y)<Math.hypot(best.world.x-point.x,best.world.y-point.y)?v:best,undefined);
                  const local=inverseArtEditorPoint(cursor,seed?.start??cursor,deform);
                  if(local)try{current.onArtTopology(artObject.id,{type:"create",point:local,connect:true});setArtTopologyError("");}catch(error){setArtTopologyError(error instanceof Error?error.message:"Не удалось создать точку.");}
                }
                markDirty();return;
              }
              const vertices=candidates.filter(v=>artBrush?(artDynamic||v.weight>0):selected.has(v.id)).map(v=>({...v,weight:artBrush?v.weight:1}));
              if(vertices.length){
                const symmetry=!artSymmetry?undefined:{axis:artSymmetryAngle,pairs:artSymmetryPairs(artObject.artMesh,{angle:artSymmetryAngle,center:{x:artObject.width/2,y:artObject.height/2}})};
                current.onDragStart();artDrag.current={object:artObject,matrix,mode:rest?"rest":"pose",deform,vertices,cursor:artEditorPoint(artObject,point,matrix),symmetry:artBrush?undefined:symmetry,brush:artBrush?{dynamic:artDynamic,radius:artRadius,hardness:artHardness,angle:artSymmetry?artSymmetryAngle:undefined,last:point,deltas:{}}:undefined};markDirty();}
              return;
            }
            if(current.tool==="warp"||current.tool==="deform")return;
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
                const values = liveFrame(current.preset)?.objects[object.id] || staticValues(object);
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
            // Alt+клик по призраку возвращает объект в кадр или прячет его
            // снова. Скрипт не переписывается: гасится только `enabled` —
            // ровно как глаз в дереве.
            if (hit && event.altKey && current.onToggleGhost) {
              const values = current.frameRef.current?.objects[hit.id] || staticValues(hit);
              if (values.visible === 0 && scriptHidden(hit, values)) {
                current.onToggleGhost(hit.id);
                return;
              }
            }
            // Группа своих пикселей не имеет, но её габарит — такой же хитбокс:
            // пустое место внутри группы хватает саму группу, а не объект за ней.
            const container = hit?.kind === "shape" && hit.id === current.primaryId ? null : containerAt(point, hit);
            const targetObject = container
              ? current.preset.objects.find((object) => object.id === container) ?? hit
              : hit;
            if (!targetObject) {
              if (!event.shiftKey && !event.ctrlKey && !event.metaKey) current.onSelect(null, "replace");
              return;
            }
            if (event.ctrlKey || event.metaKey) { current.onSelect(targetObject.id, "toggle"); return; }
            if (event.shiftKey) { current.onSelect(targetObject.id, "add"); return; }
            // Выделение в структуре важнее того, кто оказался сверху: если точка
            // попала в выделенный объект (или его потомка), тащим выборку, а
            // верхний объект выбирается только кликом без перетаскивания.
            const inSelection = (object: RigObject) => isSelectedTree(current.preset, object.id, current.selectedIds);
            const inside = inSelection(targetObject);
            // Нажатие внутрь выделения (в том числе в габарит выделенной
            // группы) тянет всю выборку. Группа-контейнер, которая не в
            // выделении, тянется сама и никому не уступает: иначе её пустой
            // габарит хватал бы объект за ней.
            const under = inside ? targetObject : (container ? null : hitTest(point, inSelection));
            const initial = Object.fromEntries(current.preset.objects.map((object) => [object.id, { ...object.base }]));
            if (under) {
              current.onDragStart();
              interaction.current = {
                type: "drag",
                ids: selectionRoots(current.preset.objects, current.selectedIds),
                start: point,
                initial,
                pending: inside ? null : targetObject.id,
                moved: false,
              };
              return;
            }
            // Клик по пустому месту габарита группы меняет выбор на саму группу,
            // и она же тянется — «объект за ней» больше не перехватывает жест.
            current.onSelect(targetObject.id, "replace");
            current.onDragStart();
            interaction.current = { type: "drag", ids: [targetObject.id], start: point, initial, pending: null, moved: false };
          }}
          onPointerMove={(event) => {
            const area=artArea.current;
            if(area){
              const point=scenePoint(event),last=area.path[area.path.length-1];
              if(area.shape==="rect")area.path=[area.path[0],point];
              else if(Math.hypot(last.x-point.x,last.y-point.y)>2/camera.current.zoom&&area.path.length<4096)area.path.push(point);
              markDirty();return;
            }
            const drag=artDrag.current;
            if(drag){
              const cursor=artEditorPoint(drag.object,scenePoint(event),drag.matrix);
              const deltas:ArtOffsets={};
              const brush=drag.brush;
              if(brush?.dynamic){
                const world=scenePoint(event),last=artEditorPoint(drag.object,brush.last,drag.matrix);
                const step={x:cursor.x-last.x,y:cursor.y-last.y};
                const center={x:drag.object.width/2,y:drag.object.height/2};
                const reflect=reflectArtVector({x:cursor.x-center.x,y:cursor.y-center.y},brush.angle??0);
                const mirror=transformPoint(drag.matrix,reflect.x+center.x-drag.object.pivot.x*drag.object.width,reflect.y+center.y-drag.object.pivot.y*drag.object.height);
                for(const vertex of drag.vertices){
                  const before=brush.deltas[vertex.id]??{x:0,y:0},source={x:vertex.start.x+before.x,y:vertex.start.y+before.y},shown=drag.deform?drag.deform(source):source;
                  const p=transformPoint(drag.matrix,shown.x-drag.object.pivot.x*drag.object.width,shown.y-drag.object.pivot.y*drag.object.height);
                  const a=Math.hypot(p.x-world.x,p.y-world.y),b=brush.angle===undefined?Infinity:Math.hypot(p.x-mirror.x,p.y-mirror.y);
                  const weight=artBrushWeight(Math.min(a,b),brush.radius,brush.hardness),movement=b<a?reflectArtVector(step,brush.angle!):step;
                  const target={x:shown.x+movement.x*weight,y:shown.y+movement.y*weight},local=inverseArtEditorPoint(target,source,drag.deform);
                  if(local)brush.deltas[vertex.id]={x:local.x-vertex.start.x,y:local.y-vertex.start.y};
                }
                brush.last=world;
                const next=editArtVertices(drag.object.artMesh!,drag.object.artPose??{},brush.deltas,drag.mode,{width:drag.object.width,height:drag.object.height});
                propsRef.current.onArtMesh(drag.object.id,next.mesh,next.pose);return;
              }
              for(const vertex of drag.vertices){
                const origin=drag.deform?drag.deform(vertex.start):vertex.start;
                const delta={x:cursor.x-drag.cursor.x,y:cursor.y-drag.cursor.y};
                const movement=brush&&vertex.mirrored&&brush.angle!==undefined?reflectArtVector(delta,brush.angle):delta;
                const target={x:origin.x+movement.x*vertex.weight,y:origin.y+movement.y*vertex.weight};
                const local=inverseArtEditorPoint(target,vertex.seed,drag.deform);
                if(local)vertex.seed=local;
                deltas[vertex.id]={x:vertex.seed.x-vertex.start.x,y:vertex.seed.y-vertex.start.y};
              }
              const mirrored=drag.symmetry?mirrorArtDeltas(deltas,drag.symmetry.pairs,drag.symmetry.axis):deltas;
              const next=editArtVertices(drag.object.artMesh!,drag.object.artPose??{},mirrored,drag.mode,{width:drag.object.width,height:drag.object.height});
              try{propsRef.current.onArtMesh(drag.object.id,drag.mode==="rest"?rebuildArtTriangles(next.mesh):next.mesh,next.pose);setArtTopologyError("");}
              catch(error){setArtTopologyError(error instanceof Error?error.message:"Невозможно перестроить сетку.");}return;
            }
            // Курсор помним всегда: кисть показывает свой радиус, даже когда не
            // ведёт, а ось симметрии видно сразу. Перерисовка — только когда
            // курсор действительно сдвинулся, иначе мышь с высоким поллингом
            // гоняла бы кадры впустую.
            const tool = propsRef.current.tool;
            if (tool === "warp" || tool === "deform") {
              const world = scenePoint(event);
              const previous = hover.current;
              if (!previous || Math.hypot(world.x - previous.x, world.y - previous.y) > 1) {
                hover.current = world;
                markDirty();
              }
            } else if (hover.current) {
              hover.current = null;
              markDirty();
            }
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
            if (current.type !== "drag") return;
            const point = scenePoint(event);
            if (Math.hypot(point.x - current.start.x, point.y - current.start.y) > 2) current.moved = true;
            let delta = { x: point.x - current.start.x, y: point.y - current.start.y };
            if (event.shiftKey) {
              // Ось выбирается один раз — по первому движению за порогом. Раньше
              // она пересчитывалась каждый кадр, и у диагонали объект дёргался
              // между осями.
              if (!current.axis && Math.hypot(delta.x, delta.y) > 3) {
                current.axis = Math.abs(delta.x) >= Math.abs(delta.y) ? "x" : "y";
              }
              delta = current.axis === "y"
                ? { x: 0, y: delta.y }
                : current.axis === "x"
                  ? { x: delta.x, y: 0 }
                  : { x: 0, y: 0 };
            } else {
              current.axis = null;
            }
            const { ids, initial } = current;
            queueLive(() => propsRef.current.onDragObjects(ids, initial, delta));
          }}
          onPointerUp={(event) => {
            const area=artArea.current;
            if(area){
              artArea.current=null;area.path.push(scenePoint(event));
              if(propsRef.current.primaryId===area.objectId)artSelection.current={objectId:area.objectId,ids:selectArtRegion(area.points,area.path,area.shape,area.previous,area.mode)};
              if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
              markDirty();return;
            }
            if(artDrag.current){artDrag.current=null;propsRef.current.onDragEnd?.();markDirty();
              if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);return;}
            const current = interaction.current;
            interaction.current = null;
            // Отложенная правка могла ещё не примениться: применяем до того,
            // как закрыть тягу, иначе последнее положение курсора потеряется.
            flushLive();
            if (isDragInteraction(current)) propsRef.current.onDragEnd?.();
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
            artArea.current=null;
            if(artDrag.current){artDrag.current=null;propsRef.current.onDragEnd?.();}
            const current = interaction.current;
            interaction.current = null;
            marqueeRef.current = null;
            flushLive();
            if (isDragInteraction(current)) propsRef.current.onDragEnd?.();
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
      {artPanelOpen&&(props.tool==="warp"||props.tool==="deform")&&meshTarget&&["sprite","media","shape","group"].includes(meshTarget.kind??"sprite")&&<ArtMeshToolsPanel name={meshTarget.name||meshTarget.id} onClose={()=>setArtPanelOpen(false)} tools={<><button onClick={()=>props.onTool(props.tool)}>Выйти из артмеша (Esc)</button>
{!meshTarget.artMesh&&<div className="artmesh-empty"><p>У объекта пока нет артмеша. Начните с точек вручную или сгенерируйте сетку во вкладке «Сетка».</p><button className="primary" onClick={()=>{props.onArtTopology(meshTarget.id,{type:"start"});if(props.tool!=="deform")props.onTool("deform");}}>Создать вручную</button></div>}
            {meshTarget.artMesh&&<>
              <button title="Выделить все вершины; Shift+клик — добавить/убрать вершину" onClick={()=>{artSelection.current={objectId:meshTarget.id,ids:new Set(meshTarget.artMesh!.vertices.map(v=>v.id))};markDirty();}}>Все вершины</button>
              {props.tool==="deform"&&<button title="Удалить выбранные вершины и прилегающие грани; образуются отверстия" onClick={()=>{
                const selection=artSelection.current;
                if(selection.objectId!==meshTarget.id||!selection.ids.size)return;
                props.onArtTopology(meshTarget.id,{type:"remove",rebuild:true,ids:[...selection.ids]});selection.ids.clear();markDirty();
              }}>Удалить вершины</button>}
              {props.tool==="deform"&&<>
                <label className="artmesh-check"><input type="checkbox" checked={artReference} onChange={e=>setArtReference(e.target.checked)}/>Показывать исходник для обводки</label>
              </>}
              {artTopologyError&&<span role="status">{artTopologyError}</span>}
              <button title="Снять выделение вершин" onClick={()=>{artSelection.current={objectId:meshTarget.id,ids:new Set()};markDirty();}}>Снять</button>
            </>}
{props.tool==="deform"&&meshTarget.artMesh&&<p className="artmesh-hint">ЛКМ по пустому месту — точка; по вершине и потянуть — перемещение без деформации текстуры. Сетка автоматически перестраивается по текущим точкам. Alt + ЛКМ — удалить вершину или перестроить грани у ребра. Shift + клик — выделение; три вершины закрепляют ручную грань вопреки автоматической диагонали. Alt + клик по грани — вырезать её, без автозаполнения. V / M / L — курсор, рамка, лассо без выхода из артмеша.</p>}</>} mesh={<><p className="artmesh-hint">Генерация, замена и перенос топологии. Изменения отменяются одним шагом истории.</p>            <button title="Сгенерировать артмеш" aria-label="Сгенерировать артмеш" onClick={()=>setArtGenerator("single")}><Grid3X3 size={15}/>Сгенерировать артмеш</button>
            <button title="Подготовить потомков к деформации…" onClick={()=>setArtGenerator("descendants")}>Подготовить потомков…</button>
            <button disabled={!meshTarget.artMesh} title="Скопировать новый артмеш и авторскую деформацию" onClick={()=>{
              try{holdArtMesh(meshTarget);setArtTopologyError("");}catch(error){setArtTopologyError(error instanceof Error?error.message:"Ошибка копирования.");}
            }}>Копировать артмеш</button>
            <button title="Вставить новый артмеш с подтверждением замены" onClick={()=>{
              const clip=heldArtMesh();if(clip)setArtPaste(clip);else setArtTopologyError("Буфер артмеша пуст.");
            }}>Вставить артмеш…</button>
            {!meshTarget.artMesh&&artTopologyError&&<span role="status">{artTopologyError}</span>}
</>}/>}
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
  warp: "Деформация артмеша: перемещение вершин, кисть, симметрия; Shift+клик — выбор нескольких вершин",
  deform: "База артмеша: перемещение rest-вершин без изменения UV и поз; вставка/удаление вершин и граней — отдельными кнопками",
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

/** Жест, который начался со снимка истории: его и надо закрыть на отпускании. */
function isDragInteraction(current: Interaction | null): boolean {
  return current?.type === "drag";
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
    if (!corners?.length) continue;
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
      if (!corners?.length) continue;
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
    if (!corners?.length) continue;
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
    const box=!pivotMode&&object.kind==="shape"&&object.shape?shapeContentBounds(object.shape):null;
    const pivot = transformPoint(objectMatrix(object, values),box?box.x+box.width/2-object.pivot.x*object.width:0,box?box.y+box.height/2-object.pivot.y*object.height:0);
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

/**
 * Шахматка прозрачности: плитка 48×48, залитая одним прямоугольником.
 *
 * Раньше клетки рисовались поштучно — на холст 1920×1080 это около 1800
 * `fillRect` на каждый кадр, то есть сотня тысяч вызовов в секунду при живой
 * анимации. Плитка и узор кешируются на контекст: кадр стоит одного `fillRect`.
 */
let transparencyTile: HTMLCanvasElement | null = null;
const transparencyPatterns = new WeakMap<CanvasRenderingContext2D, CanvasPattern>();

function transparencyPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const cached = transparencyPatterns.get(ctx);
  if (cached) return cached;
  if (typeof document === "undefined") return null;
  if (!transparencyTile) {
    const tile = document.createElement("canvas");
    tile.width = 48;
    tile.height = 48;
    const paint = tile.getContext("2d");
    if (!paint) return null;
    paint.fillStyle = "#292f35";
    paint.fillRect(0, 0, 24, 24);
    paint.fillRect(24, 24, 24, 24);
    transparencyTile = tile;
  }
  const pattern = ctx.createPattern(transparencyTile, "repeat");
  if (pattern) transparencyPatterns.set(ctx, pattern);
  return pattern;
}

function drawTransparency(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const pattern = transparencyPattern(ctx);
  ctx.save();
  ctx.fillStyle = pattern ?? "#292f35";
  ctx.fillRect(0, 0, width, height);
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
