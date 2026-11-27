import {mirrorStateKey,pasteStateKey,copyStateKey,heldStateKey} from "../engine/stateKeyActions";
import {artPosePoints} from "../engine/artMeshBlend";
import type {ArtOffsets,ArtDeformation} from "../engine/artDeformation";
import {artRecordFromBase} from "../engine/artMeshStates";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, RotateCcw, Trash2, Undo2 } from "lucide-react";
import type { BasePose, InputValues, ModuleInstance, RigFrame, RigObject, Vec2 } from "../types";
import { NumberField } from "./NumberField";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ParamPicker } from "./ParamPicker";
import { paramGroups as collectParams } from "../engine/paramNames";
import { useModuleLibrary } from "../hooks/useModuleLibrary";
import {
  addKey, addLayer, addPoints, cloneLayers, fromPosePoints, insertLayers, invertByInput, keyAt, keyUnderPoint,
  layerRange, makeLayer, mirrorLayer, moveKey, noPoints, patchLayer, poseAt, poseFromBase,
  readStates, removeKey, removeLayer, replacePose,
  removeLayers, resetStatesFor, reversePoses, sameBase, samePoints, scaleKeys, setPose, shiftPose, toPosePoints,
  withLiveMirrors, writeStates,
  liveName,
  SMOOTH_DEFAULT, SMOOTH_LIMIT,
  STATE_FIELDS, type Pose, type StateField, type StateLayer, type StatePreview, type States,
} from "../engine/states";

/**
 * Вкладка «Состояния».
 *
 * Слой — это список поз с весами. Привязка к параметру необязательна: есть
 * параметр — позы стоят на его значениях, и по шкале ездит **точка таймлайна**;
 * нет — у каждой позы своё выражение веса.
 *
 * Точка таймлайна — и есть предпросмотр. Она стоит на шкале параметра, а
 * вкладка показывает на сцене, что слой делает с объектом в этой точке: попали
 * на ключ — видно саму позу, встали между ключами — видно интерполяцию.
 * Параметр при этом не подменяется: предпросмотр накладывает дельту на базовую
 * позу объекта, поэтому работает и для входа трекера, который нельзя «покрутить»
 * руками.
 *
 * Запись позы тоже без кнопки: пока точка стоит на ключе, любое движение объекта
 * на сцене (или в инспекторе) сразу становится позой этого ключа. Забыть
 * нажать «записать» больше нельзя.
 */

const FIELD_LABEL: Record<StateField, string> = {
  x: "сдвиг по X",
  y: "сдвиг по Y",
  rotation: "поворот, °",
  skewX: "наклон X, °",
  skewY: "наклон Y, °",
  sizeX: "размер X",
  sizeY: "размер Y",
  opacity: "прозрачность",
  visible: "видимость",
};

/** Нейтраль поля: у множителей 1, у остальных 0. */
const FIELD_NEUTRAL: Partial<Record<StateField, number>> = {
  sizeX: 1, sizeY: 1, opacity: 1, visible: 1,
};

/** Какую долю отрезка занимает шаг перетаскивания ключа (пункт «привязка 5%»). */
const SNAP = 0.05;
/** Ближе этого к ключу точка таймлайна считается стоящей на нём. */
const HIT = 0.02;

interface StatesPanelProps {
  object: RigObject | null;
  frame: RigFrame | null;
  inputs: InputValues;
  modules: ModuleInstance[];
  /** Имена глобальных переменных: их тоже можно привязать к слою. */
  globals?: string[];
  onChange: (scripts: Record<string, string>) => void;
  /** Вернуть авторскую позу после записи: объектом двигает состояние, а не база. */
  onBase?: (base: Partial<BasePose>, objectId: string) => void;
  /**
   * Дописать в блок сгенерированные строки — без шага истории.
   *
   * Это не правка автора, а служебный текст: зеркала живого вклада дописываются
   * в блоки, записанные старой версией, один раз и молча.
   */
  onNormalize?: (scripts: Record<string, string>) => void;
  /**
   * Предпросмотр — только отрисовка: `null` снимает его.
   *
   * База объекта при этом не меняется, поэтому выход из вкладки сам возвращает
   * объект на место: ни истории, ни «отменить», ни двойной позы.
   */
  onPreviewState?: (preview: StatePreview | null, objectId: string) => void;
  /** Идёт перетаскивание на сцене: запись позы ждёт конца жеста. */
  dragging?: boolean;
  onArtPose?: (pose:ArtOffsets,objectId:string)=>void;
}

export function StatesPanel(props: StatesPanelProps) {
  const object = props.object;
  const states = useMemo(() => (object ? readStates(object.script) : { layers: [] }), [object]);
  const [layerIndex, setLayerIndex] = useState(0);
  /**
   * Выбранный ключ свободного слоя. У привязанного слоя выбор не хранится:
   * ключ — это тот, что стоит под точкой таймлайна, поэтому правка поля,
   * уход фокуса или перерисовка его не сбрасывают.
   */
  const [pickedKey, setPickedKey] = useState(0);
  /** Черновик имени слоя: в скрипт уходит по Enter или уходу фокуса. */
  const [nameDraft, setNameDraft] = useState("");
  /** Точка таймлайна. `null` — слой без привязки: там поза выбирается ключом. */
  const [at, setAt] = useState<number | null>(null);
  /** Какая строка редактирует имя: клик по названию, а не по всей строке. */
  const [editName, setEditName] = useState<number | null>(null);
  /** Выделенные строки: копирование и правки из меню идут по ним. */
  const [picked, setPicked] = useState<number[]>([]);
  /** Открытое контекстное меню: где и для какой строки. */
  const [keyMenu,setKeyMenu]=useState<{x:number;y:number;index:number;at:number}|null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  /** Замена параметра: диалог с поиском и картой «было → стало». */
  const [replaceFor, setReplaceFor] = useState<number[] | null>(null);
  const [replaceMap, setReplaceMap] = useState<Record<string, string>>({});
  /** Диалог нового ключа: «+» на занятой позиции спрашивает, куда ставить. */
  const [newKey, setNewKey] = useState<{ value: number; error: string } | null>(null);
  /** Пересчитать ключи под диапазон нового входа (по умолчанию — нет). */
  const [replaceScale, setReplaceScale] = useState(false);
  /** Зеркало: точка оси в сцене и угол. */
  const [mirrorFor, setMirrorFor] = useState<number[] | null>(null);
  const [axis, setAxis] = useState({ x: 0, y: 0, angle: 90 });

  /** Авторская поза объекта: база, снятая при открытии вкладки. */
  const [authorBase, setAuthorBase] = useState<BasePose | null>(null);
  /** База в прошлом кадре: по её изменению видно движение руками. */
  const lastBase = useRef<BasePose | null>(null);
  /** Что уже отправлено в предпросмотр: без этого эффект крутился бы вечно. */
  const sent = useRef<string | null>(null);
  /** Вклад, посчитанный по входам: помним, к какому кадру он относится. */
  const liveCache = useRef<{ key: string; live: Partial<Record<StateField, number>> } | null>(null);
  /** Колбэки в ref: уборка при закрытии вкладки видит актуальные. */
  const previewApi = useRef(props.onPreviewState);
  previewApi.current = props.onPreviewState;
  const restoreApi = useRef(props.onBase);
  restoreApi.current = props.onBase;
  const artCapture=useRef<{id:string;mesh:ArtDeformation;author:ArtOffsets;previous:ArtOffsets}|null>(null);
  /** Перетаскивание: ключ или точка таймлайна. */
  const drag = useRef<
    | { kind: "key"; index: number; scale: [number, number] }
    | { kind: "head"; free: boolean }
    | null
  >(null);

  const layer: StateLayer | null = states.layers[layerIndex] ?? null;
  const range = layer ? layerRange(layer, metaRange(props, layer.param)) : [0, 1];
  /**
   * Ключ под точкой таймлайна: ближайший в пределах попадания, иначе — первый
   * из тех, что ближе. Так поле «ключ» и поля позы всегда говорят об одном и
   * том же ключе, и правка ничего не «переключает».
   */
  const keyIndex = useMemo(() => {
    const poses = layer?.poses ?? [];
    if (!poses.length) return 0;
    if (!layer?.param) return Math.min(Math.max(0, pickedKey), poses.length - 1);
    return keyUnderPoint(layer, at ?? range[0]);
  }, [layer, pickedKey, at, range[0]]);

  /** Смена объекта: авторская поза и предпросмотр начинаются заново. */
  const objectId = object?.id ?? "";
  const objectRef = useRef(objectId);
  useEffect(() => {
    if (objectRef.current === objectId) return;
    objectRef.current = objectId;
    artCapture.current=null;
    const base = object ? { ...object.base } : null;
    setAuthorBase(base);
    lastBase.current = base;
    sent.current = null;
  }, [objectId, object]);
  /**
   * Блок старой версии: дописываем в него зеркала живого вклада.
   *
   * Без них `vars` пуст, и предпросмотр считал бы вклад по входам — то есть
   * дёргался бы. Пишем молча: это сгенерированный текст, а не правка автора.
   */
  useEffect(() => {
    if (!object) return;
    const next = withLiveMirrors(object.script);
    if (next === object.script) return;
    props.onNormalize?.({ [object.id]: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectId]);

  // Первый показ: авторская база — текущая.
  useEffect(() => {
    if (authorBase || !object) return;
    setAuthorBase({ ...object.base });
    lastBase.current = { ...object.base };
    sent.current = null;
  }, [object, authorBase]);
  /** Смена слоя: точка таймлайна встаёт на его первый ключ. */
  useEffect(() => {
    const target = states.layers[layerIndex] ?? null;
    // Предпросмотр нового слоя начинается с чистого листа.
    sent.current = null;
    // Значение точки не переезжает со слоя на слой: у каждого слоя своя шкала.
    setAt(target?.param
      ? (target.poses[0]?.at ?? layerRange(target, metaRange(props, target.param))[0])
      : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerIndex, objectId]);
  /** Привязку поменяли: у свободного слоя шкалы нет, у привязанного точка нужна. */
  useEffect(() => {
    if (!layer) return;
    if (!layer.param) {
      setAt(null);
      return;
    }
    setAt((current) => current ?? layer.poses[0]?.at ?? layerRange(layer, metaRange(props, layer.param))[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer?.param, layer?.poses.length]);

  const pose: Pose | null = layer?.poses[keyIndex] ?? null;

  const apply = (next: States, index = layerIndex, key = keyIndex, record = true) => {
    if (!object) return;
    const written = writeStates(object.script, next, object).script;
    if (written !== object.script) (record?props.onChange:props.onNormalize??props.onChange)({ [object.id]: written });
    setLayerIndex(Math.min(index, Math.max(0, next.layers.length - 1)));
    // Выбор ключа не переставляем: у привязанного слоя он вычисляется из точки,
    // у свободного хранится отдельно. Иначе любая правка поля откатывала выбор
    // на первый ключ.
    const poses = next.layers[Math.min(index, next.layers.length - 1)]?.poses.length ?? 0;
    setPickedKey(Math.min(key, Math.max(0, poses - 1)));
  };

  const applyLayer = (next: StateLayer) => apply(patchLayer(states, layerIndex, next));

  /**
   * Правка сразу нескольких слоёв: выделение важнее активной строки, но если
   * ничего не выделено, правится текущий слой.
   */
  const each = (indexes: number[], change: (layer: StateLayer, index: number) => StateLayer) => {
    let next = states;
    for (const index of indexes) {
      const layer = states.layers[index];
      if (layer) next = patchLayer(next, index, change(layer, index));
    }
    apply(next, indexes[0] ?? layerIndex, keyIndex);
  };

  /** Выбор строки: обычный клик, Ctrl — добавить, Shift — диапазон. */
  const pickRow = (index: number, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    setLayerIndex(index);
    setPicked((current) => {
      if (event.shiftKey) {
        const from = Math.min(layerIndex, index);
        const to = Math.max(layerIndex, index);
        return Array.from({ length: to - from + 1 }, (_, step) => from + step);
      }
      if (event.ctrlKey || event.metaKey) {
        return current.includes(index) ? current.filter((item) => item !== index) : [...current, index];
      }
      return [index];
    });
  };

  const copy = (indexes: number[]) => {
    const layers = indexes.map((index) => states.layers[index]).filter(Boolean);
    if (layers.length) writeClipboard(layers);
  };

  /** Вставка — в конец списка: буфер общий для всех объектов и вкладок. */
  const paste = () => {
    const copies = cloneLayers(readClipboard(), states.layers.map((item) => item.name));
    if (!copies.length) return;
    const start = states.layers.length;
    apply(insertLayers(states, copies), start + copies.length - 1, 0);
    setPicked(copies.map((_, step) => start + step));
  };

  /**
   * Переименование слоя.
   *
   * Имя правится в черновике: в скрипт оно уходит один раз — по Enter или
   * уходу фокуса. Раньше каждая буква переписывала блок состояний, и поле
   * теряло и текст, и фокус.
   */
  const startRename = (index: number) => {
    const target = states.layers[index];
    if (!target) return;
    setNameDraft(target.name);
    setEditName(index);
  };

  const commitRename = () => {
    const index = editName;
    if (index === null) return;
    setEditName(null);
    const target = states.layers[index];
    if (!target) return;
    const name = nameDraft.trim();
    if (!name || name === target.name) return;
    apply(patchLayer(states, index, { ...target, name }), index);
  };

  /** Привязка слоя к параметру и обратно: позы получают `at` или `weight`. */
  const rebind = (index: number, param: string | null) => {
    const source = states.layers[index];
    if (!source) return;
    const [from, to] = layerRange(source, metaRange(props, source.param));
    const next: StateLayer = { ...source, param };
    next.poses = param
      ? source.poses.map((pose, position) => (
        pose.at === undefined ? { ...pose, at: position === 0 ? from : to } : pose
      ))
      : source.poses.map((pose) => (pose.weight === undefined ? { ...pose, weight: "1" } : pose));
    apply(patchLayer(states, index, next), index);
  };

  /**
   * Поза предпросмотра: что вкладка показывает в точке таймлайна.
   *
   * Привязанный слой считается по точке (между ключами — интерполяция),
   * свободный — по выбранной позе: у него нет шкалы.
   */
  const previewPose = (): Partial<Record<StateField, number>> => {
    if (!layer) return {};
    if (layer.param) return poseAt(layer, at ?? range[0]);
    const chosen = layer.poses[keyIndex];
    return chosen ? { ...chosen.pose } : {};
  };

  /** Что параметр слоя даёт сейчас: вход модуля, глобальная или локальная. */
  const liveValue = (param: string): number | undefined => {
    const fromInputs = props.inputs.values[param];
    if (Number.isFinite(fromInputs)) return fromInputs;
    const fromGlobals = props.frame?.globals?.[param];
    if (Number.isFinite(fromGlobals)) return fromGlobals;
    const fromVars = object ? props.frame?.vars?.[object.id]?.[param] : undefined;
    return Number.isFinite(fromVars) ? fromVars : undefined;
  };

  /**
   * Точки деформера в точке таймлайна: что слой делает с нарезкой.
   *
   * Считаются той же линейной смесью, что и поля позы, но живут отдельной
   * картой: ядро про артмеш не знает, поэтому рендереру их отдаёт вкладка.
   */
  const previewPoints = (): Record<string, Vec2> => {
    if (!layer) return {};
    if (layer.param) return object?.artMesh ? artPosePoints(layer, at ?? range[0]) : {};
    const chosen = layer.poses[keyIndex];
    return fromPosePoints(chosen?.points) ?? {};
  };

  /** Точки текущего ключа — для счётчика и кнопки сброса формы. */
  const meshPoints = layer ? fromPosePoints(layer.poses[keyIndex]?.points) : undefined;

  /**
   * Живой вклад этого же слоя — ровно то, что предпросмотр перекрывает.
   *
   * Сцена вычитает его из кадра и прибавляет позу, поэтому `inherit`, поведение,
   * другие слои и видимость остаются кадровыми. У свободного слоя вес — чужое
   * выражение: его здесь не посчитать, и поза показывается поверх скрипта.
   */
  const previewLive = (): Partial<Record<StateField, number>> => {
    if (!layer?.param) return {};
    // Вклад слоя берём из **того же кадра**, что нарисовала сцена: блок зеркалит
    // каналы в переменные `states_<поле>`, и ядро отдаёт их в `vars`.
    //
    // Считать вклад заново по входам нельзя. Кадр приходит на тик позже входа, а
    // со `smooth` — заметно позже, поэтому «поза − вклад» гуляла вместе с мышью:
    // объект стоял на месте и мелко дёргался, будто пытался сдвинуться.
    const vars = object ? props.frame?.vars?.[object.id] : undefined;
    if (vars) {
      const live: Partial<Record<StateField, number>> = {};
      for (const field of STATE_FIELDS) {
        const value = vars[liveName(field)];
        if (typeof value === "number" && Number.isFinite(value)) live[field] = value;
      }
      if (Object.keys(live).length) return live;
    }
    // Ядро старое или кадр ещё не пришёл — считаем по входам, как раньше, но
    // только когда кадр сменился.
    //
    // В паузе кадр стоит, а вход продолжает меняться. Считая вклад по текущему
    // входу, вкладка тянула бы объект за мышью, хотя на сцене ничего не
    // происходит. Вклад относится к кадру — значит и пересчитывается вместе с
    // ним: новый кадр (или другой слой) — новый вклад, иначе прежний.
    const key = `${objectId}|${props.frame?.seq ?? -1}|${layerIndex}|${layer.param}|${object?.script}`;
    if (liveCache.current?.key === key) return liveCache.current.live;
    const value = liveValue(layer.param);
    const live = value === undefined ? {} : poseAt(layer, value);
    liveCache.current = { key, live };
    return live;
  };

  /**
   * Предпросмотр на сцене: поправка к кадру, а не подмена базы.
   *
   * В пресете и в базе объекта ничего не меняется, поэтому уход из вкладки сам
   * возвращает объект на место — без истории и без «двойного применения».
   */
  useEffect(() => {
    if (!object || !layer) {
      // Удаление последнего слоя не размонтирует панель. Нельзя оставлять
      // предпросмотр удалённого слоя в сцене и у наследующих его детей.
      if (sent.current !== null) {
        sent.current = null;
        previewApi.current?.(null, objectId);
      }
      liveCache.current = null;
      return;
    }
    if (!props.onPreviewState) return;
    // Пока объект в руке, предпросмотр заморожен.
    //
    // Поправка предпросмотра считается по живому входу слоя. Если вход связан с
    // самим объектом (своя переменная, значение кадра, `inherit` родителя), то,
    // пока объект тащат, вход едет вместе с ним — и поправка каждый кадр тянет
    // объект обратно к курсору. Жест должен двигать только базу: сцена рисует
    // кадр плюс неподвижную поправку, поэтому объект идёт за рукой один к одному.
    // По отпусканию эффект срабатывает заново — уже с новой позой ключа.
    if (props.dragging) return;
    const pose = previewPose();
    const live = previewLive();
    const points = previewPoints();
    const pointLayer=states.layers.slice(0,layerIndex).filter(l=>l.poses.length>0).length;
    const stamp = JSON.stringify({ pose, live, points, pointLayer });
    if (sent.current === stamp) return;
    sent.current = stamp;
    // Id передаём явно: предпросмотр — про объект вкладки, а не про последний
    // в выделении. Иначе при мультивыделении поза уезжала чужому объекту.
    props.onPreviewState(
      { id: object.id, pose, live, points: noPoints(points) ? undefined : points, pointLayer },
      object.id,
    );
  });

  /** Вышли из вкладки — предпросмотр снят, объект сразу на своём месте. */
  useEffect(() => {
    const api = previewApi;
    return () => { api.current?.(null, ""); };
  }, []);

  /**
   * Запись позы без кнопки: человек подвинул объект — поправка уходит в ключ под
   * точкой таймлайна. Ключа там нет — он появляется: позу ставят именно в той
   * точке шкалы, где она нужна.
   *
   * Пока идёт перетаскивание, записи нет: жест считает смещение от начала
   * движения, поэтому писать его каждый кадр значило бы накапливать одно и то же
   * и дёргать объект. Поза прибавляется **один раз**, когда жест закончился.
   */
  useEffect(() => {
    if (!object || !layer || !authorBase) return;
    // Жест ещё идёт — база пусть двигается, поза подождёт.
    if (props.dragging) return;
    const previous = lastBase.current;
    lastBase.current = { ...object.base };
    // Первый кадр вкладки и предпросмотр базу не меняют — писать нечего.
    if (!previous || sameBase(previous, object.base)) return;
    if (drag.current?.kind === "head") return;
    const shift = poseFromBase(authorBase, object.base);
    // База возвращается на место: объектом двигает поза, а не база. Возврат
    // идёт без шага истории — жест уже записан началом перетаскивания.
    restoreApi.current?.(authorBase, object.id);
    lastBase.current = { ...authorBase };
    if (!Object.keys(shift).length) return;
    if (layer.param) {
      const point = at ?? range[0];
      const existing = layer.poses.findIndex((item) => Math.abs((item.at ?? 0) - point) < 1e-6);
      // Прибавка к тому, что уже показывает ключ (или интерполяция в этой точке):
      // иначе объект прыгнул бы назад к базе.
      const delta = shiftPose(poseAt(layer, round3(point)), shift);
      const next = existing >= 0 ? setPose(layer, existing, delta) : addKey(layer, round3(point), delta);
      const index = next.poses.findIndex((item) => Math.abs((item.at ?? 0) - round3(point)) < 1e-6);
      apply(patchLayer(states, layerIndex, next), layerIndex, index);
      return;
    }
    if (!pose) return;
    apply(patchLayer(states, layerIndex, setPose(layer, keyIndex, shiftPose(pose.pose, shift))), layerIndex, keyIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  /**
   * Запись точек деформера — тем же правилом, что и позы.
   *
   * Человек тянет узлы сетки на сцене, то есть двигает базу. Вкладка замечает
   * разницу с базой при открытии и уносит её в ключ под точкой таймлайна, а базу
   * возвращает: формой двигает состояние, а не сама сетка. Пока идёт жест,
   * записи нет — иначе одна и та же поправка прибавлялась бы каждый кадр.
   */
  useEffect(() => {
    if (!object || !layer) return;
    let delta:Record<string,Vec2>|null=null;
    if(object.artMesh){
      if(!props.onArtPose)return;
      const current=object.artPose??{},capture=artCapture.current;
      const ids=object.artMesh.vertices.map(v=>v.id).join(",");
      if(!capture||capture.id!==object.id||capture.mesh.vertices.map(v=>v.id).join(",")!==ids){
        artCapture.current={id:object.id,mesh:object.artMesh,author:current,previous:current};return;
      }
      if(props.dragging)return;
      delta=artRecordFromBase(object.artMesh,capture.author,capture.previous,current);
      capture.mesh=object.artMesh;capture.previous=current;
      if(!delta)return;
      props.onArtPose?.(capture.author,object.id);capture.previous=capture.author;
    }else{artCapture.current=null;return;}
    if (noPoints(delta)) return;
    const point = round3(at ?? range[0]);
    const index = layer.param
      ? layer.poses.findIndex((item) => Math.abs((item.at ?? 0) - point) < 1e-6)
      : keyIndex;
    // Прибавка к тому, что ключ уже показывает: иначе форма прыгнет назад.
    const shown = layer.param
      ? (index >= 0 ? fromPosePoints(layer.poses[index].points) : artPosePoints(layer,point))
      : fromPosePoints(layer.poses[keyIndex]?.points);
    const points = toPosePoints(addPoints(shown ?? {}, delta));
    if (layer.param && index < 0) {
      const next = addKey(layer, point, {});
      const created = next.poses.findIndex((item) => Math.abs((item.at ?? 0) - point) < 1e-6);
      const withPoints = {
        ...next,
        poses: next.poses.map((item, at2) => (at2 === created ? { ...item, points } : item)),
      };
      apply(patchLayer(states, layerIndex, withPoints), layerIndex, created, false);
      return;
    }
    const nextLayer = {
      ...layer,
      poses: layer.poses.map((item, at2) => (at2 === index ? { ...item, points } : item)),
    };
    apply(patchLayer(states, layerIndex, nextLayer), layerIndex, index, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  // Ctrl+C / Ctrl+V по выделенным строкам. В полях ввода не мешаем: там
  // копируется текст, а не слои.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const key = event.key.toLowerCase();
      if (key === "c") {
        const targets = picked.length ? picked : [layerIndex];
        if (!targets.length) return;
        event.preventDefault();
        copy(targets);
      } else if (key === "v") {
        event.preventDefault();
        paste();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** Замена параметра у выделения одним шагом истории. */
  const applyReplace = () => {
    const targets = replaceFor ?? [];
    let next = states;
    for (const index of targets) {
      const source = states.layers[index];
      if (!source?.param) continue;
      const param = replaceMap[source.param]?.trim();
      if (!param || param === source.param) continue;
      let layer: StateLayer = { ...source, param };
      if (replaceScale) {
        const from = metaRange(props, source.param) ?? layerRange(source, null);
        const to = metaRange(props, param);
        if (to) layer = scaleKeys(layer, from, to);
      }
      next = patchLayer(next, index, layer);
    }
    apply(next, targets[0] ?? layerIndex, keyIndex);
    setReplaceFor(null);
    setPicked(targets);
  };

  if (!object) {
    return <div className="states-empty">Выберите объект: состояния принадлежат объекту и лежат в его скрипте.</div>;
  }

  const groups = collectParams({
    modules: props.modules,
    globals: props.globals,
    values: props.inputs.values,
    frameGlobals: props.frame?.globals,
    script: object.script,
  });
  const names = groups.flatMap((group) => group.items.map((item) => item.name));
  const span = Math.max(1e-9, range[1] - range[0]);
  const share = (value: number) => Math.min(1, Math.max(0, (value - range[0]) / span));

  /** Значение шкалы по доле ширины линии. */
  const valueAt = (shareX: number) => round3(range[0] + shareX * span);

  /** Ключ под значением: ближайший, если точка стоит на нём. */
  const keyNear = (value: number) => {
    if (!layer) return -1;
    const tolerance = span * HIT;
    return layer.poses.findIndex((item) => Math.abs((item.at ?? 0) - value) <= tolerance);
  };

  /** Двинуть точку таймлайна; у ключа она прилипает и этот ключ выбирается. */
  const moveHead = (value: number, exact = false) => {
    if (!layer?.param) return;
    const index = keyNear(value);
    const snapped = !exact && index >= 0 ? (layer.poses[index].at as number) : round3(value);
    setAt(snapped);
  };

  /**
   * Значение ключа из поля: двигает сам ключ.
   *
   * Позиция занята другим ключом — правка игнорируется: два ключа на одном
   * значении молча слились бы. Точка встаёт на ключ, поэтому и поле «точка»,
   * и поле «ключ» показывают одно и то же значение.
   */
  const editKey = (index: number, value: number) => {
    if (!layer) return;
    const point = round3(value);
    const busy = keyAt(layer, point);
    if (busy >= 0 && busy !== index) return;
    const moved = moveKey(layer, index, point);
    applyLayer(moved);
    setAt(point);
  };

  /** Ключ в этой точке уже есть? */
  const keyAtPoint = () => (layer ? keyAt(layer, round3(at ?? range[0])) : -1);

  /** Свободное место рядом с точкой: середина до соседа или шаг в 10 % шкалы. */
  const freeSpot = (point: number) => {
    const step = Math.max(1e-6, span * 0.1);
    if (!layer) return round3(point + step);
    const values = layer.poses.map((item) => item.at ?? 0);
    const right = values.filter((value) => value > point).sort((a, b) => a - b)[0];
    const left = values.filter((value) => value < point).sort((a, b) => b - a)[0];
    const middle = (a: number, b: number) => round3((a + b) / 2);
    const candidates = [
      right !== undefined && Math.abs(right - point) > step / 2 ? middle(point, right) : undefined,
      left !== undefined && Math.abs(point - left) > step / 2 ? middle(left, point) : undefined,
      round3(point + step),
      round3(point - step),
    ];
    return candidates.find((value) => value !== undefined && keyAt(layer, value) < 0) ?? round3(point + step);
  };

  const pointOf = (event: { clientX: number }, element: HTMLElement) => {
    const box = element.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - box.left) / Math.max(1, box.width)));
  };

  /** Поставить ключ в свободное значение и встать на него точкой. */
  const createKey = (value: number) => {
    if (!layer?.param) return false;
    const point = round3(value);
    if (keyAt(layer, point) >= 0) return false;
    const next = addKey(layer, point);
    const index = next.poses.findIndex((item) => item.at === point);
    apply(patchLayer(states, layerIndex, next), layerIndex, index);
    setAt(point);
    return true;
  };

  /**
   * «+»: ключ в точке таймлайна.
   *
   * Позиция свободна — ключ появляется сразу. Позиция занята — второй ключ туда
   * не лезет: открывается диалог, где указывают **другое** значение нового
   * ключа. Значение существующего ключа здесь не правится.
   */
  const addKeyAtHead = () => {
    if (!layer?.param) return;
    const point = round3(at ?? range[0]);
    if (keyAt(layer, point) < 0) {
      createKey(point);
      return;
    }
    setNewKey({ value: freeSpot(point), error: "" });
  };

  /** Пункты меню строки: копирование, правки формы и привязки, удаление. */
  const layerMenu = (index: number): ContextMenuItem[] => {
    const targets = picked.includes(index) && picked.length ? picked : [index];
    const names = targets.map((position) => states.layers[position]?.name).filter(Boolean);
    return [
      { label: "Копировать", hint: "Ctrl+C", disabled: !targets.length, onSelect: () => copy(targets) },
      { label: "Вставить", hint: "Ctrl+V", disabled: !readClipboard().length, onSelect: () => paste() },
      { label: "Переименовать", hint: "двойной клик", disabled: targets.length !== 1, onSelect: () => startRename(index) },
      { label: "", rule: true },
      {
        label: "Инвертировать по входу",
        hint: "at → от + до − at",
        disabled: !states.layers[index]?.param,
        onSelect: () => each(targets, (source) => invertByInput(source, metaRange(props, source.param))),
      },
      {
        label: "Развернуть по таймлайну",
        hint: "позы в обратном порядке",
        disabled: !states.layers[index]?.param,
        onSelect: () => each(targets, (source) => reversePoses(source)),
      },
      { label: "", rule: true },
      {
        label: "Заменить параметр…",
        hint: "список с поиском",
        onSelect: () => {
          const map: Record<string, string> = {};
          for (const position of targets) {
            const param = states.layers[position]?.param;
            if (param) map[param] = param;
          }
          setReplaceMap(map);
          setReplaceScale(false);
          setReplaceFor(targets);
        },
      },
      {
        label: "Зеркало…",
        hint: "точка + угол",
        onSelect: () => {
          setAxis({ x: object.base.x, y: object.base.y, angle: 90 });
          setMirrorFor(targets);
        },
      },
      { label: "", rule: true },
      {
        label: "Удалить",
        hint: names.length > 1 ? `слоёв: ${names.length}` : names[0],
        danger: true,
        onSelect: () => {
          apply(removeLayers(states, targets), Math.min(...targets), 0);
          setPicked([]);
        },
      },
    ];
  };

  const bound = !!layer?.param;

  return (
    <div className="states-panel">
      <div className="states-toolbar">
        <button
          className="states-add"
          onClick={() => {
            const created = makeLayer(states.layers.length, names[0] ?? null);
            apply(addLayer(states, created), states.layers.length, 0);
          }}
          title="Новый слой состояний"
        >
          <Plus size={13} /> Слой
        </button>
        <button
          className="states-reset"
          onClick={() => {
            if (!states.layers.length) return;
            props.onChange(resetStatesFor([object]));
            setLayerIndex(0);
            setPickedKey(0);
            setAt(null);
          }}
          title="Убрать блок состояний из скрипта"
        >
          <RotateCcw size={13} /> Сброс
        </button>
      </div>

      {!states.layers.length ? (
        <p className="states-hint">
          Состояний пока нет. Слой — это позы с весами: либо точки на шкале параметра,
          либо свободные веса выражениями.
        </p>
      ) : (
        <div className="states-layers">
          {states.layers.map((item, index) => (
            <div
              key={index}
              className={`states-layer ${index === layerIndex ? "active" : ""} ${picked.includes(index) ? "picked" : ""}`}
              onClick={(event) => {
                if (editName === index) return;
                pickRow(index, event);
              }}
              onContextMenu={(event) => {
                // Меню строки своё: дальше события не пускаем, иначе поверх
                // него открылось бы ещё и меню поля ввода.
                event.preventDefault();
                event.stopPropagation();
                const targets = picked.includes(index) && picked.length ? picked : [index];
                if (!picked.includes(index)) pickRow(index, { ctrlKey: false, metaKey: false, shiftKey: false });
                setMenu({ x: event.clientX, y: event.clientY, index });
                setPicked(targets);
              }}
            >
              {editName === index ? (
                <input
                  className="states-name"
                  autoFocus
                  value={nameDraft}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onBlur={() => commitRename()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitRename();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setEditName(null);
                    }
                  }}
                  title="Имя слоя"
                />
              ) : (
                <span
                  className="states-name-text"
                  title="Двойной клик — переименовать"
                  onClick={(event) => {
                    event.stopPropagation();
                    pickRow(index, event);
                  }}
                  onDoubleClick={(event) => {
                    // Имя правится намеренно, двойным кликом: обычный клик
                    // только выделяет слой, иначе выделить его без правки имени
                    // было невозможно.
                    event.stopPropagation();
                    startRename(index);
                  }}
                >
                  {item.name}
                </span>
              )}
              <ParamPicker
                className="states-param"
                value={item.param ?? ""}
                groups={groups}
                placeholder="вес выражением"
                title="Параметр: вход модуля, глобальная или локальная переменная"
                onChange={(value) => rebind(index, value.trim() ? value.trim() : null)}
              />
              <select
                className="states-normalize"
                value={item.normalize}
                onChange={(event) => apply(patchLayer(states, index, {
                  normalize: event.target.value === "average" ? "average" : "sum",
                }), index)}
                title="Смешивание внутри слоя: sum — наложение, avg — среднее по весам слоя"
              >
                <option value="sum">sum</option>
                <option value="average">avg</option>
              </select>
              <button
                className="states-remove"
                onClick={(event) => { event.stopPropagation(); apply(removeLayer(states, index), index, 0); }}
                title="Удалить слой"
              >
                <Trash2 size={13} />
              </button>
              {/* Пустая зона строки: клик по ней — обычное выделение слоя. */}
              <span className="states-blank" aria-hidden="true" />
            </div>
          ))}
        </div>
      )}

      {layer && bound && (
        <>
          <div className="states-smoothing" title="Сглаживание входа: значение параметра проходит через smooth() до расчёта весов — дрожание трекера не дёргает позу">
            <label>
              <input
                type="checkbox"
                checked={layer.smooth > 0}
                onChange={(event) => applyLayer({ ...layer, smooth: event.target.checked ? SMOOTH_DEFAULT : 0 })}
              />
              сглаживание ввода
            </label>
            {layer.smooth > 0 && (
              <>
                <NumberField
                  value={layer.smooth}
                  step={10}
                  onCommit={(value) => applyLayer({ ...layer, smooth: Math.min(SMOOTH_LIMIT, Math.max(1, Math.round(value))) })}
                />
                <span className="states-unit">мс</span>
              </>
            )}
          </div>

          {/* Значение точки — такое же поле, как остальные: одна подпись,
              одно число, постоянная ширина. */}
          <div className="states-field states-point">
            <span>точка на шкале</span>
            <NumberField
              value={at ?? range[0]}
              step={Math.max(1e-6, span / 100)}
              title={keyAtPoint() >= 0
                ? "Точка стоит на ключе: значение правит этот ключ"
                : "Значение на шкале, где стоит точка таймлайна"}
              onCommit={(value) => {
                const clamped = Math.min(range[1], Math.max(range[0], value));
                // Точка на ключе — введённое значение и есть значение ключа:
                // иначе поле «точка» выглядело бы как поле «ключ», но ничего
                // не меняло в позах.
                const index = keyAtPoint();
                if (index >= 0) {
                  editKey(index, clamped);
                  return;
                }
                moveHead(clamped, true);
              }}
            />
          </div>

          {/* Линия таймлайна: ключи на ней, точка — предпросмотр. */}
          <div
            className="states-track"
            onContextMenu={event=>{event.preventDefault();event.stopPropagation();const hit=(event.target as HTMLElement).closest("[data-key]");const index=hit?Number(hit.getAttribute("data-key")):-1;setKeyMenu({x:event.clientX,y:event.clientY,index,at:index>=0?layer.poses[index].at??0:valueAt(pointOf(event,event.currentTarget))});}}
            title="Клик — поставить точку · ключи тянутся мышью · + добавляет ключ в точке"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const element = event.currentTarget;
              element.setPointerCapture(event.pointerId);
              const target = event.target as HTMLElement;
              const key = target.closest("[data-key]");
              if (key) {
                const index = Number(key.getAttribute("data-key"));
                setPickedKey(index);
                setAt(layer.poses[index]?.at ?? at);
                // Крайние ключи (и единственный) не тянутся: они задают границы
                // шкалы. Длину отрезка меняет **значение** ключа в поле «ключ»,
                // а не перетаскивание — иначе поехала бы вся шкала.
                const edge = layer.poses.length <= 1
                  || index === 0
                  || index === layer.poses.length - 1;
                // Шкала на время жеста замораживается: если средний ключ утащат
                // за край, границы пересчитаются прямо в жесте.
                drag.current = edge ? null : { kind: "key", index, scale: [range[0], range[1]] };
                return;
              }
              // За луч точка прилипает к ключам, за сам кружок — идёт плавно.
              const head = target.closest("[data-head]");
              const free = head ? head.getAttribute("data-head") === "dot" : false;
              drag.current = { kind: "head", free };
              moveHead(valueAt(pointOf(event, element)), free);
            }}
            onPointerMove={(event) => {
              const element = event.currentTarget;
              if (!drag.current) return;
              const shareX = pointOf(event, element);
              if (drag.current.kind === "head") {
                moveHead(valueAt(shareX), drag.current.free);
                return;
              }
              // Ключ тянется по шагу 5% шкалы: ровные значения без возни с полем.
              const [from, to] = drag.current.scale;
              const scaleSpan = Math.max(1e-9, to - from);
              const step = scaleSpan * SNAP;
              const raw = from + shareX * scaleSpan;
              const value = round3(Math.round((raw - from) / step) * step + from);
              const index = drag.current.index;
              const next = moveKey(layer, index, value);
              const moved = next.poses.findIndex((item) => item.at === value);
              setAt(value);
              apply(patchLayer(states, layerIndex, next), layerIndex, moved >= 0 ? moved : index);
            }}
            onPointerUp={(event) => {
              drag.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => { drag.current = null; }}
          >
            <div className="states-track-line" />
            {layer.poses.map((item, index) => (
              <button
                key={index}
                data-key={index}
                className={`states-key ${index === keyIndex ? "active" : ""} ${
                  layer.poses.length <= 1 || index === 0 || index === layer.poses.length - 1 ? "edge" : ""
                }`}
                style={{ left: `${share(item.at ?? range[0]) * 100}%` }}
                title={layer.poses.length <= 1
                  ? `Ключ ${item.at} · единственный ключ: отрезка ещё нет, значение правится полем «ключ»`
                  : index === 0 || index === layer.poses.length - 1
                    ? `Ключ ${item.at} · крайний: он задаёт границу шкалы — правьте значение полем «ключ»`
                    : `Ключ ${item.at} · тяните, чтобы перенести`}
                onClick={(event) => {
                  event.stopPropagation();
                  setAt(item.at ?? at);
                  setPickedKey(index);
                }}
              />
            ))}
            <div className="states-head" style={{ left: `${share(at ?? range[0]) * 100}%` }}>
              <div className="states-head-line" data-head="beam" title="Тяните за луч — точка прилипает к ключам" />
              <div className="states-head-dot" data-head="dot" title="Тяните за точку — плавный ход без привязки" />
            </div>
          </div>

          {/* Шкала неявная: её границы — крайние ключи, начало и конец линии. */}
          <div className="states-scale">
            <span>{fmt(range[0])}</span>
            <span>{layer.poses.length >= 2 ? "крайние ключи" : "паспорт входа"}</span>
            <span>{fmt(range[1])}</span>
          </div>

          <div className="states-keys">
            {layer.poses.map((item, index) => (
              <span
                key={index}
                onContextMenu={event=>{event.preventDefault();event.stopPropagation();setKeyMenu({x:event.clientX,y:event.clientY,index,at:item.at??0});}}
                className={`states-key-chip ${index === keyIndex ? "active" : ""}`}
                onClick={() => { setAt(item.at ?? at); setPickedKey(index); }}
              >
                {fmt(item.at ?? 0)}
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    apply(patchLayer(states, layerIndex, removeKey(layer, index)), layerIndex, index);
                  }}
                  title="Удалить ключ"
                >
                  ×
                </button>
              </span>
            ))}
            <button className="states-key-add" onClick={addKeyAtHead} title="Добавить ключ в точке таймлайна">
              <Plus size={12} />
            </button>
          </div>
        </>
      )}

      {layer && !bound && (
        <div className="states-weights">
          {layer.poses.map((item, index) => (
            <div key={index} onContextMenu={event=>{event.preventDefault();event.stopPropagation();setKeyMenu({x:event.clientX,y:event.clientY,index,at:0});}} className={`states-weight ${index === keyIndex ? "active" : ""}`} onClick={() => setPickedKey(index)}>
              <span>вес</span>
              <input
                value={item.weight ?? ""}
                placeholder="например smooth(mood, 240)"
                onChange={(event) => apply(patchLayer(states, layerIndex, {
                  poses: layer.poses.map((pose, position) => (
                    position === index ? { ...pose, weight: event.target.value } : pose
                  )),
                }), layerIndex, index)}
              />
              <button
                onClick={(event) => { event.stopPropagation(); apply(patchLayer(states, layerIndex, removeKey(layer, index)), layerIndex, index); }}
                title="Удалить позу"
              >
                ×
              </button>
            </div>
          ))}
          <button className="states-key-add" onClick={() => {
            const next = { ...layer, poses: [...layer.poses, { weight: "1", pose: {} }] };
            apply(patchLayer(states, layerIndex, next), layerIndex, next.poses.length - 1);
          }} title="Добавить позу">
            <Plus size={12} />
          </button>
        </div>
      )}

      {layer && (
        <>
          {bound && pose && (
            <div className="states-key-head">
              <span>ключ</span>
              <NumberField
                value={pose.at ?? range[0]}
                step={0.01}
                title={layer.poses.length <= 1 || keyIndex === 0 || keyIndex === layer.poses.length - 1
                  ? "Крайний ключ: его значение задаёт границу отрезка"
                  : "Значение на шкале, где стоит ключ"}
                onCommit={(value) => editKey(keyIndex, value)}
              />
              {(layer.poses.length <= 1 || keyIndex === 0 || keyIndex === layer.poses.length - 1) && (
                <small className="states-key-edge-note">задаёт границу отрезка</small>
              )}
            </div>
          )}
          <div className="states-fields">
            {STATE_FIELDS.map((field) => (
              <div key={field} className="states-field">
                <span>{FIELD_LABEL[field]}</span>
                <NumberField
                  value={pose?.pose[field] ?? FIELD_NEUTRAL[field] ?? 0}
                  step={field === "sizeX" || field === "sizeY" || field === "opacity" || field === "visible" ? 0.01 : 0.5}
                  onCommit={(value) => {
                    const neutral = FIELD_NEUTRAL[field] ?? 0;
                    const next = { ...(pose?.pose ?? {}) };
                    // Нейтральное значение убирает поле из позы, а не пишет его
                    // числом: иначе «вернул 0» осталось бы в ключе навсегда.
                    if (Math.abs(value - neutral) < 1e-6) delete next[field];
                    else next[field] = value;
                    // Ключа под точкой нет — он появляется: правка позы и есть
                    // повод его завести. Раньше значение молча пропадало.
                    const point = round3(at ?? range[0]);
                    if (bound && keyAt(layer, point) < 0) {
                      const created = addKey(layer, point, next);
                      const index = created.poses.findIndex((item) => item.at === point);
                      apply(patchLayer(states, layerIndex, created), layerIndex, index);
                      setAt(point);
                      return;
                    }
                    if (!pose) return;
                    applyLayer(replacePose(layer, keyIndex, next));
                  }}
                />
              </div>
            ))}
          </div>

          <div className="states-record">
            <button
              onClick={() => {
                if (!pose) return;
                // Сброс позы: ключ перестаёт двигать объект — видно базу.
                applyLayer(replacePose(layer, keyIndex, {}));
              }}
              title="Убрать позу ключа: объект встанет в базовое положение"
            >
              <Undo2 size={12} /> Сбросить позу
            </button>
            <button
              onClick={() => {
                if (!layer) return;
                // Ключ перестаёт двигать сетку: видна авторская форма.
                const next = {
                  ...layer,
                  poses: layer.poses.map((item, index) => (
                    index === keyIndex ? { ...item, points: undefined } : item
                  )),
                };
                apply(patchLayer(states, layerIndex, next), layerIndex, keyIndex);
              }}
              disabled={!meshPoints}
              title="Убрать точки деформера из ключа: сетка вернётся к авторской форме"
            >
              <Undo2 size={12} /> Сбросить сетку
            </button>
            <small>
              {bound
                ? "двиньте объект или узлы сетки на сцене — попадёт в ключ под точкой таймлайна"
                : "двиньте объект или узлы сетки на сцене — попадёт в выбранную позу"}
              {meshPoints ? ` · сетка: ${Object.keys(meshPoints).length} узлов в ключе` : ""}
            </small>
          </div>
        </>
      )}

      {keyMenu&&layer&&<ContextMenu x={keyMenu.x} y={keyMenu.y} onClose={()=>setKeyMenu(null)} items={[
        {label:"Копировать ключ",disabled:keyMenu.index<0,onSelect:()=>copyStateKey(layer.poses[keyMenu.index])},
        ...[{label:"Отразить ключ: вертикаль",angle:0},{label:"Отразить ключ: горизонталь",angle:90}].map(({label,angle})=>({label,disabled:keyMenu.index<0,onSelect:()=>{
          const poses=layer.poses.map((p,i)=>i===keyMenu.index?mirrorStateKey(p,object.artMesh,object.width,object.height,angle):p);applyLayer({...layer,poses});
        }})),
        {label:keyMenu.index>=0?"Вставить ключ (заменить)":"Вставить ключ сюда",disabled:!heldStateKey()||Object.keys(heldStateKey()?.points??{}).some(id=>!object.artMesh?.vertices.some(v=>v.id===id)),onSelect:()=>{
          const copied=heldStateKey();if(!copied)return;
          const at=round3(keyMenu.at),index=keyMenu.index>=0?keyMenu.index:keyAt(layer,at);
          const next=index>=0?{...layer,poses:layer.poses.map((p,i)=>i===index?pasteStateKey(copied,p):p)}:addKey(layer,at,{});
          if(index<0){const created=keyAt(next,at);next.poses=next.poses.map((p,i)=>i===created?pasteStateKey(copied,p):p);}
          applyLayer(next);setAt(at);
        }},
      ]}/>}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={layerMenu(menu.index)} />
      )}

      {newKey && (
        <div className="states-dialog-back" onClick={() => setNewKey(null)}>
          <div className="states-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="states-dialog-head">
              Новый ключ
              <small>{layer?.name}</small>
            </div>
            <p className="states-dialog-note">
              На позиции {fmt(round3(at ?? range[0]))} уже стоит ключ — здесь его значение не меняется.
              Укажите, где встать новому.
            </p>
            <div className="states-dialog-field">
              <span>позиция ключа</span>
              <NumberField
                value={newKey.value}
                step={Math.max(1e-6, round3(span / 100))}
                autoFocus
                title="Значение на шкале, где встанет новый ключ"
                onConfirm={(value) => {
                  if (!layer) return;
                  const at = round3(value);
                  if (keyAt(layer, at) >= 0) {
                    setNewKey({ value: at, error: "здесь уже есть ключ — выберите другое значение" });
                    return;
                  }
                  createKey(at);
                  setNewKey(null);
                }}
                onCommit={(value) => setNewKey((current) => (current ? { ...current, value: round3(value), error: "" } : current))}
              />
            </div>
            {newKey.error && <small className="states-dialog-error">{newKey.error}</small>}
            <div className="states-dialog-foot">
              <button
                className="primary"
                onClick={() => {
                  if (!layer) return;
                  if (keyAt(layer, newKey.value) >= 0) {
                    setNewKey((current) => (current ? { ...current, error: "здесь уже есть ключ — выберите другое значение" } : current));
                    return;
                  }
                  createKey(newKey.value);
                  setNewKey(null);
                }}
              >
                Создать
              </button>
              <button onClick={() => setNewKey(null)}>Отмена</button>
            </div>
          </div>
        </div>
      )}

      {replaceFor && (
        <div className="states-dialog-back" onClick={() => setReplaceFor(null)}>
          <div className="states-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="states-dialog-head">
              Заменить параметр
              <small>{replaceFor.length > 1 ? `слоёв: ${replaceFor.length}` : states.layers[replaceFor[0]]?.name}</small>
            </div>
            {Object.keys(replaceMap).map((param) => (
              <div className="states-dialog-param" key={param}>
                <span title="Сейчас в слоях">{param}</span>
                <ParamPicker
                  value={replaceMap[param]}
                  groups={groups}
                  autoFocus={Object.keys(replaceMap).length === 1}
                  placeholder="начните вписывать имя"
                  onChange={(value) => setReplaceMap((current) => ({ ...current, [param]: value.trim() }))}
                />
              </div>
            ))}
            <label className="states-dialog-scale" title="Перенести ключи в границы нового входа пропорционально">
              <input
                type="checkbox"
                checked={replaceScale}
                onChange={(event) => setReplaceScale(event.target.checked)}
              />
              масштабировать ключи под новый диапазон
            </label>
            <div className="states-dialog-foot">
              <button className="primary" onClick={() => applyReplace()}>Заменить</button>
              <button onClick={() => setReplaceFor(null)}>Отмена</button>
            </div>
          </div>
        </div>
      )}

      {mirrorFor && (
        <div className="states-dialog-back" onClick={() => setMirrorFor(null)}>
          <div className="states-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="states-dialog-head">
              Зеркало
              <small>ось: точка в сцене и угол</small>
            </div>
            <div className="states-dialog-grid">
              <span>точка X</span>
              <NumberField value={axis.x} step={1} onCommit={(value) => setAxis((current) => ({ ...current, x: value }))} />
              <span>точка Y</span>
              <NumberField value={axis.y} step={1} onCommit={(value) => setAxis((current) => ({ ...current, y: value }))} />
              <span>угол, °</span>
              <NumberField value={axis.angle} step={5} onCommit={(value) => setAxis((current) => ({ ...current, angle: value }))} />
            </div>
            <div className="states-dialog-axes">
              <button onClick={() => setAxis((current) => ({ ...current, angle: 90 }))}>вертикальная ось</button>
              <button onClick={() => setAxis((current) => ({ ...current, angle: 0 }))}>горизонтальная</button>
              <button onClick={() => setAxis((current) => ({ ...current, x: object.base.x, y: object.base.y }))}>через объект</button>
            </div>
            <div className="states-dialog-foot">
              <button
                className="primary"
                onClick={() => {
                  const targets = mirrorFor;
                  each(targets, (source) => mirrorLayer(source, axis, {
                    x: object.base.x,
                    y: object.base.y,
                    width: object.artMesh ? 1 : object.width,
                    height: object.artMesh ? 1 : object.height,
                  }));
                  setMirrorFor(null);
                }}
              >
                Отразить
              </button>
              <button onClick={() => setMirrorFor(null)}>Отмена</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Округление значения шкалы: три знака хватает любому входу. */
function round3(value: number): number {
  const result = Math.round(value * 1000) / 1000;
  return Object.is(result, -0) ? 0 : result;
}

/** Число шкалы без хвостовых нулей. */
function fmt(value: number): string {
  return String(round3(value));
}

/* ── буфер обмена слоёв ─────────────────────────────────────────────── */

/**
 * Буфер живёт в профиле приложения, а не в состоянии вкладки: скопировали слои,
 * переключились на другой объект — вставка всё ещё работает.
 */
const CLIP_KEY = "yappytuberplus.states.clip.v1";

function writeClipboard(layers: StateLayer[]) {
  try { localStorage.setItem(CLIP_KEY, JSON.stringify(layers)); } catch { /* профиль недоступен */ }
}

function readClipboard(): StateLayer[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CLIP_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    // Свой же формат, но профиль мог остаться от старой версии: берём только
    // то, что похоже на слой.
    return parsed.filter((item): item is StateLayer => (
      !!item && typeof item === "object"
      && typeof (item as StateLayer).name === "string"
      && Array.isArray((item as StateLayer).poses)
    ));
  } catch { return []; }
}

/** Границы входа из паспорта — отрезок по умолчанию. */
function metaRange(props: StatesPanelProps, param: string | null): [number, number] | null {
  if (!param) return null;
  const meta = props.inputs.meta?.[param];
  if (!meta || !Number.isFinite(meta.min) || !Number.isFinite(meta.max)) return null;
  if (meta.max <= meta.min) return null;
  return [meta.min, meta.max];
}
