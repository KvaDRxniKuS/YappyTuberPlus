import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, RotateCcw, Trash2, Undo2 } from "lucide-react";
import type { BasePose, InputValues, ModuleInstance, RigFrame, RigObject } from "../types";
import { NumberField } from "./NumberField";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ParamPicker } from "./ParamPicker";
import { paramGroups as collectParams } from "../engine/paramNames";
import { useModuleLibrary } from "../hooks/useModuleLibrary";
import {
  addKey, addLayer, applyPoseToBase, cloneLayers, insertLayers, invertByInput, layerRange, makeLayer,
  manualInputOf, mirrorLayer, moveKey, patchLayer, poseAt, poseFromBase, readStates, removeKey, removeLayer,
  removeLayers, resetStatesFor, reversePoses, sameBase, scaleKeys, setPose, writeStates,
  SMOOTH_DEFAULT, SMOOTH_LIMIT,
  STATE_FIELDS, type Pose, type StateField, type StateLayer, type States,
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
  /** Вернуть базовую позу после записи: объект остаётся там, где его поставили. */
  onBase?: (base: Partial<BasePose>) => void;
  /** Предпросмотр: двигает базу без шага истории. */
  onPreviewBase?: (base: Partial<BasePose>) => void;
  /** Предпросмотр входа `manual.*` — двигает то же значение, что и ползунок входов. */
  onManual?: (key: string, value: number) => void;
}

export function StatesPanel(props: StatesPanelProps) {
  const object = props.object;
  const states = useMemo(() => (object ? readStates(object.script) : { layers: [] }), [object]);
  const [layerIndex, setLayerIndex] = useState(0);
  const [keyIndex, setKeyIndex] = useState(0);
  /** Точка таймлайна. `null` — слой без привязки: там поза выбирается ключом. */
  const [at, setAt] = useState<number | null>(null);
  /** Какая строка редактирует имя: клик по названию, а не по всей строке. */
  const [editName, setEditName] = useState<number | null>(null);
  /** Выделенные строки: копирование и правки из меню идут по ним. */
  const [picked, setPicked] = useState<number[]>([]);
  /** Открытое контекстное меню: где и для какой строки. */
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  /** Замена параметра: диалог с поиском и картой «было → стало». */
  const [replaceFor, setReplaceFor] = useState<number[] | null>(null);
  const [replaceMap, setReplaceMap] = useState<Record<string, string>>({});
  /** Пересчитать ключи под диапазон нового входа (по умолчанию — нет). */
  const [replaceScale, setReplaceScale] = useState(false);
  /** Зеркало: точка оси в сцене и угол. */
  const [mirrorFor, setMirrorFor] = useState<number[] | null>(null);
  const [axis, setAxis] = useState({ x: 0, y: 0, angle: 90 });

  /** Авторская поза объекта: база без наложенного предпросмотра. */
  const [authorBase, setAuthorBase] = useState<BasePose | null>(null);
  /** Что мы сами записали в базу прошлым предпросмотром. */
  const applied = useRef<BasePose | null>(null);
  /**
   * Предпросмотр, который уже отправлен, но ещё не вернулся в `object.base`.
   *
   * Без этой отметки собственный предпросмотр выглядел бы как правка человека:
   * запись позы срабатывала бы на каждый шаг точки и плодила ключи.
   */
  const pending = useRef<BasePose | null>(null);
  /** Перетаскивание: ключ или точка таймлайна. */
  const drag = useRef<{ kind: "key"; index: number } | { kind: "head"; free: boolean } | null>(null);

  const layer: StateLayer | null = states.layers[layerIndex] ?? null;
  const range = layer ? layerRange(layer, metaRange(props, layer.param)) : [0, 1];
  /** Смена объекта: авторская поза и предпросмотр начинаются заново. */
  const objectId = object?.id ?? "";
  const objectRef = useRef(objectId);
  useEffect(() => {
    if (objectRef.current === objectId) return;
    objectRef.current = objectId;
    const base = object ? { ...object.base } : null;
    setAuthorBase(base);
    applied.current = base;
  }, [objectId, object]);
  // Первый показ: авторская база — текущая.
  useEffect(() => {
    if (authorBase || !object) return;
    setAuthorBase({ ...object.base });
    applied.current = { ...object.base };
  }, [object, authorBase]);
  /** Смена слоя: точка таймлайна встаёт на его первый ключ. */
  useEffect(() => {
    const target = states.layers[layerIndex] ?? null;
    // Предпросмотр нового слоя начинается с чистого листа: иначе база,
    // оставленная прошлым слоем, выглядела бы как движение руками.
    applied.current = null;
    pending.current = null;
    // Значение точки не переезжает со слоя на слой: у каждого слоя своя шкала.
    setAt(target?.param
      ? (target.poses[0]?.at ?? layerRange(target, metaRange(props, target.param))[0])
      : null);
    setKeyIndex(0);
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

  const apply = (next: States, index = layerIndex, key = keyIndex) => {
    if (!object) return;
    const written = writeStates(object.script, next, object).script;
    if (written !== object.script) props.onChange({ [object.id]: written });
    setLayerIndex(Math.min(index, Math.max(0, next.layers.length - 1)));
    const poses = next.layers[Math.min(index, next.layers.length - 1)]?.poses.length ?? 0;
    setKeyIndex(Math.min(key, Math.max(0, poses - 1)));
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
    setKeyIndex(0);
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
   * Дельта превью: что показывает сцена прямо сейчас.
   *
   * Привязанный слой считается по точке таймлайна (между ключами — интерполяция),
   * свободный — по выбранной позе: у него нет шкалы.
   */
  const previewDelta = (): Partial<Record<StateField, number>> => {
    if (!layer) return {};
    if (layer.param) return poseAt(layer, at ?? range[0]);
    const chosen = layer.poses[keyIndex];
    return chosen ? { ...chosen.pose } : {};
  };

  /**
   * Предпросмотр на сцене. Глаз видит дельту слоя, а не числа в полях.
   *
   * Если база уже не та, что мы поставили, — её правит человек, и перебивать
   * его нельзя: запись идёт отдельным эффектом ниже.
   */
  useEffect(() => {
    if (!object || !layer || !authorBase || !props.onPreviewBase) return;
    // База не наша — её двинул человек; перебивать нечего, запись идёт ниже.
    const ours = !applied.current
      || sameBase(object.base, applied.current)
      || (!!pending.current && sameBase(object.base, pending.current));
    if (!ours) return;
    const next = applyPoseToBase(authorBase, previewDelta()) as BasePose;
    if (sameBase(next, object.base)) {
      applied.current = next;
      pending.current = null;
      return;
    }
    pending.current = next;
    props.onPreviewBase(next);
  });

  /**
   * Запись позы без кнопки: человек подвинул объект — дельта от авторской позы
   * уходит в ключ под точкой таймлайна. Ключа там нет — он появляется: позу
   * ставят именно в той точке шкалы, где она нужна.
   */
  useEffect(() => {
    if (!object || !layer || !authorBase) return;
    // Пока тянут точку, база меняется предпросмотром — писать нечего.
    if (drag.current?.kind === "head") return;
    // Дождались собственного предпросмотра — это не правка человека.
    if (pending.current) {
      if (sameBase(object.base, pending.current)) {
        applied.current = pending.current;
        pending.current = null;
        return;
      }
      // База ещё прежняя — запись просто не дошла. Ждём, а не считаем это
      // движением: иначе каждый шаг точки ставил бы ключ.
      if (applied.current && sameBase(object.base, applied.current)) return;
      pending.current = null;
    }
    if (!applied.current) return;
    if (sameBase(object.base, applied.current)) return;
    const delta = poseFromBase(authorBase, object.base);
    applied.current = { ...object.base };
    if (!Object.keys(delta).length) return;
    if (layer.param) {
      const point = at ?? range[0];
      const existing = layer.poses.findIndex((item) => Math.abs((item.at ?? 0) - point) < 1e-6);
      const next = existing >= 0 ? setPose(layer, existing, delta) : addKey(layer, round3(point), delta);
      const index = next.poses.findIndex((item) => Math.abs((item.at ?? 0) - round3(point)) < 1e-6);
      apply(patchLayer(states, layerIndex, next), layerIndex, index);
      return;
    }
    if (!pose) return;
    apply(patchLayer(states, layerIndex, setPose(layer, keyIndex, delta)), layerIndex, keyIndex);
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
  const manual = manualInputOf(layer?.param ?? null);
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
    if (index >= 0) setKeyIndex(index);
  };

  const pointOf = (event: { clientX: number }, element: HTMLElement) => {
    const box = element.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - box.left) / Math.max(1, box.width)));
  };

  /** Слой под курсором: у привязанного шкала, у свободного её нет. */
  const addKeyAtHead = () => {
    if (!layer?.param) return;
    const point = round3(at ?? range[0]);
    const existing = layer.poses.findIndex((item) => Math.abs((item.at ?? 0) - point) < 1e-6);
    if (existing >= 0) {
      setKeyIndex(existing);
      return;
    }
    const next = addKey(layer, point);
    const index = next.poses.findIndex((item) => item.at === point);
    apply(patchLayer(states, layerIndex, next), layerIndex, index);
  };

  /** Пункты меню строки: копирование, правки формы и привязки, удаление. */
  const layerMenu = (index: number): ContextMenuItem[] => {
    const targets = picked.includes(index) && picked.length ? picked : [index];
    const names = targets.map((position) => states.layers[position]?.name).filter(Boolean);
    return [
      { label: "Копировать", hint: "Ctrl+C", disabled: !targets.length, onSelect: () => copy(targets) },
      { label: "Вставить", hint: "Ctrl+V", disabled: !readClipboard().length, onSelect: () => paste() },
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
            setKeyIndex(0);
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
                  value={item.name}
                  onChange={(event) => apply(patchLayer(states, index, { name: event.target.value }), index)}
                  onBlur={() => setEditName(null)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === "Escape") {
                      event.preventDefault();
                      setEditName(null);
                    }
                  }}
                  title="Имя слоя"
                />
              ) : (
                <span
                  className="states-name-text"
                  title="Клик — переименовать"
                  onClick={(event) => {
                    // Ctrl и Shift — выделение, а не переименование.
                    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
                    event.stopPropagation();
                    pickRow(index, { ctrlKey: false, metaKey: false, shiftKey: false });
                    setEditName(index);
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
          <div className="states-range">
            <span>отрезок</span>
            <NumberField
              value={range[0]}
              step={0.1}
              onCommit={(value) => applyLayer({ ...layer, range: [value, Math.max(value + 1e-6, range[1])] })}
            />
            <span>…</span>
            <NumberField
              value={range[1]}
              step={0.1}
              onCommit={(value) => applyLayer({ ...layer, range: [Math.min(range[0], value - 1e-6), value] })}
            />
          </div>

          <div className="states-smoothing" title="Сглаживание входа: значение параметра проходит через smooth() до расчёта весов — дрожание трекера не дёргает позу">
            <label>
              <input
                type="checkbox"
                checked={layer.smooth > 0}
                onChange={(event) => applyLayer({ ...layer, smooth: event.target.checked ? SMOOTH_DEFAULT : 0 })}
              />
              сглаживание
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

          {/* Значение точки — отдельное поле: цифры разной длины не должны
              сдвигать ключи, которые стоят рядом. */}
          <div className="states-point">
            <span>точка</span>
            <NumberField
              className="states-point-value"
              value={at ?? range[0]}
              step={Math.max(1e-6, span / 100)}
              title="Значение на шкале, где стоит точка таймлайна"
              onCommit={(value) => moveHead(Math.min(range[1], Math.max(range[0], value)), true)}
            />
            <span className="states-unit">на шкале</span>
          </div>

          {/* Линия таймлайна: ключи на ней, точка — предпросмотр. */}
          <div
            className="states-track"
            title="Клик — поставить точку · ключи тянутся мышью · + добавляет ключ в точке"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const element = event.currentTarget;
              element.setPointerCapture(event.pointerId);
              const target = event.target as HTMLElement;
              const key = target.closest("[data-key]");
              if (key) {
                const index = Number(key.getAttribute("data-key"));
                setKeyIndex(index);
                setAt(layer.poses[index]?.at ?? at);
                // Крайние ключи держат отрезок: тронешь — поплывёт вся шкала.
                const edge = layer.poses.length <= 1 || index === 0 || index === layer.poses.length - 1;
                drag.current = edge ? null : { kind: "key", index };
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
              // Ключ тянется по шагу 5% отрезка: ровные значения без возни с полем.
              const step = span * SNAP;
              const raw = range[0] + shareX * span;
              const value = round3(Math.round((raw - range[0]) / step) * step + range[0]);
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
                title={layer.poses.length <= 1 || index === 0 || index === layer.poses.length - 1
                  ? `Ключ ${item.at} · крайний ключ держит отрезок, поэтому не двигается`
                  : `Ключ ${item.at} · тяните, чтобы перенести`}
                onClick={(event) => {
                  event.stopPropagation();
                  setKeyIndex(index);
                  setAt(item.at ?? at);
                }}
              />
            ))}
            <div className="states-head" style={{ left: `${share(at ?? range[0]) * 100}%` }}>
              <div className="states-head-line" data-head="beam" title="Тяните за луч — точка прилипает к ключам" />
              <div className="states-head-dot" data-head="dot" title="Тяните за точку — плавный ход без привязки" />
            </div>
          </div>

          <div className="states-keys">
            {layer.poses.map((item, index) => (
              <span
                key={index}
                className={`states-key-chip ${index === keyIndex ? "active" : ""}`}
                onClick={() => { setKeyIndex(index); setAt(item.at ?? at); }}
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
            <div key={index} className={`states-weight ${index === keyIndex ? "active" : ""}`} onClick={() => setKeyIndex(index)}>
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
                onCommit={(value) => applyLayer(moveKey(layer, keyIndex, value))}
              />
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
                    if (!pose) return;
                    const neutral = FIELD_NEUTRAL[field] ?? 0;
                    const next = { ...pose.pose };
                    if (Math.abs(value - neutral) < 1e-6) delete next[field];
                    else next[field] = value;
                    applyLayer(setPose(layer, keyIndex, next));
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
                applyLayer(setPose(layer, keyIndex, {}));
              }}
              title="Убрать позу ключа: объект встанет в базовое положение"
            >
              <Undo2 size={12} /> Сбросить позу
            </button>
            <small>
              {bound
                ? "двиньте объект на сцене — поза запишется в ключ под точкой таймлайна"
                : "двиньте объект на сцене — поза запишется в выбранную позу"}
            </small>
          </div>
        </>
      )}

      {manual && bound && (
        <div className="states-manual">
          <span>вход {manual}</span>
          <input
            type="range"
            min={range[0]}
            max={range[1]}
            step={0.01}
            value={props.inputs.values[`manual.${manual}`] ?? range[0]}
            onChange={(event) => {
              const value = Number(event.target.value);
              props.onManual?.(manual, value);
              moveHead(value, true);
            }}
          />
          <small>{props.inputs.values[`manual.${manual}`]?.toFixed(2) ?? "—"}</small>
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={layerMenu(menu.index)} />
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
                    width: object.width,
                    height: object.height,
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
