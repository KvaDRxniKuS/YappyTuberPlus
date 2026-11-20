import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import type { BasePose, InputValues, ModuleInstance, RigFrame, RigObject } from "../types";
import { NumberField } from "./NumberField";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ParamPicker } from "./ParamPicker";
import { paramGroups as collectParams } from "../engine/paramNames";
import { useModuleLibrary } from "../hooks/useModuleLibrary";
import {
  addKey, addLayer, cloneLayers, insertLayers, invertByInput, layerRange, makeLayer, manualInputOf,
  mirrorLayer, moveKey, patchLayer, poseFromBase, readStates, removeKey, removeLayer, removeLayers,
  resetStatesFor, reversePoses, scaleKeys, setPose, writeStates,
  STATE_FIELDS, type Pose, type StateField, type StateLayer, type States,
} from "../engine/states";
import { moduleInputs } from "../modules/values";

/**
 * Вкладка «Состояния».
 *
 * Слой — это список поз с весами. Привязка к параметру необязательна: есть
 * параметр — позы стоят на его значениях, и вкладка показывает таймлайн; нет —
 * у каждой позы своё выражение веса.
 *
 * Запись позы опирается на то, что человек действительно двигает руками, —
 * базовую позу объекта. Поэтому «Записать позу» берёт разницу «было → стало»
 * с момента выбора ключа, переводит её в дельты и возвращает объект на место:
 * дальше его двигает уже состояние.
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
  /** Предпросмотр входа `manual.*` — двигает то же значение, что и ползунок входов. */
  onManual?: (key: string, value: number) => void;
}

export function StatesPanel(props: StatesPanelProps) {
  const object = props.object;
  const states = useMemo(() => (object ? readStates(object.script) : { layers: [] }), [object]);
  const [layerIndex, setLayerIndex] = useState(0);
  const [keyIndex, setKeyIndex] = useState(0);
  const [baseline, setBaseline] = useState<BasePose | null>(null);
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

  // Смена объекта или ключа начинает запись заново: сравнивать нужно с тем
  // положением, которое было в момент выбора.
  const anchor = `${object?.id ?? ""}|${layerIndex}|${keyIndex}`;
  const anchorRef = useRef(anchor);
  useEffect(() => {
    if (!object) return;
    if (anchorRef.current !== anchor) {
      anchorRef.current = anchor;
      setBaseline({ ...object.base });
    }
  }, [anchor, object]);

  const layer: StateLayer | null = states.layers[layerIndex] ?? null;
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
    const at = states.layers.length;
    apply(insertLayers(states, copies), at + copies.length - 1, 0);
    setPicked(copies.map((_, step) => at + step));
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
   * Замена параметра у выделения одним шагом истории: карта «было → стало»
   * собирается в диалоге, ключи переносятся как значения шкалы — и только по
   * галочке пересчитываются в границы нового входа.
   */
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

  // Ctrl+C / Ctrl+V по выделенным строкам. В полях ввода не мешаем: там
  // копируется текст, а не слои.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const key = event.key.toLowerCase();
      if (key === "c") {
        // Без выделения копируется активная строка — так же ведёт себя дерево.
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

  if (!object) {
    return <div className="states-empty">Выберите объект: состояния принадлежат объекту и лежат в его скрипте.</div>;
  }

  /** Пункты меню строки: копирование, правки формы и привязки, удаление. */
  const layerMenu = (index: number): ContextMenuItem[] => {
    const targets = picked.includes(index) && picked.length ? picked : [index];
    const names = targets.map((position) => states.layers[position]?.name).filter(Boolean);
    return [
      {
        label: "Копировать",
        hint: "Ctrl+C",
        disabled: !targets.length,
        onSelect: () => copy(targets),
      },
      {
        label: "Вставить",
        hint: "Ctrl+V",
        disabled: !readClipboard().length,
        onSelect: () => paste(),
      },
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

  // Шаблоны модулей читаются с диска во время работы приложения. Пока папка
  // `modules` не прочитана, входов у экземпляров нет — подписка на версию
  // библиотеки пересобирает список, иначе он остался бы пустым.
  const library = useModuleLibrary();
  const valuesKey = Object.keys(props.inputs.values).sort().join("|");
  const globalKey = Object.keys(props.frame?.globals ?? {}).sort().join("|");
  const groups = useMemo(() => collectParams({
    modules: props.modules,
    globals: props.globals,
    values: props.inputs.values,
    frameGlobals: props.frame?.globals,
    script: object.script,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [props.modules, props.globals, valuesKey, globalKey, object.script, library.version]);
  const names = groups.flatMap((group) => group.items.map((item) => item.name));
  const manual = manualInputOf(layer?.param ?? null);
  const range = layer ? layerRange(layer, metaRange(props, layer.param)) : [0, 1];

  return (
    <div className="states-panel">
      <div className="states-toolbar">
        <button
          className="states-add"
          onClick={() => {
            const layer = makeLayer(states.layers.length, names[0] ?? null);
            apply(addLayer(states, layer), states.layers.length, 0);
            setBaseline({ ...object.base });
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
              onClick={(event) => pickRow(index, event)}
              onContextMenu={(event) => {
                event.preventDefault();
                const targets = picked.includes(index) && picked.length ? picked : [index];
                if (!picked.includes(index)) pickRow(index, { ctrlKey: false, metaKey: false, shiftKey: false });
                setMenu({ x: event.clientX, y: event.clientY, index });
                setPicked(targets);
              }}
            >
              <input
                className="states-name"
                value={item.name}
                onChange={(event) => apply(patchLayer(states, index, { name: event.target.value }), index)}
                title="Имя слоя"
              />
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
                title="Что делать, когда включены несколько поз: сложить или смешать"
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
            </div>
          ))}
        </div>
      )}

      {layer && layer.param && (
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
            <label className="states-smooth" title="Плавный ход внутри участка вместо прямой">
              <input
                type="checkbox"
                checked={layer.smooth}
                onChange={(event) => applyLayer({ ...layer, smooth: event.target.checked })}
              />
              плавно
            </label>
          </div>

          <div
            className="states-track"
            title="Клик — добавить ключ в это значение"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              const share = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
              const at = Math.round((range[0] + share * (range[1] - range[0])) * 1000) / 1000;
              const next = addKey(layer, at);
              const index = next.poses.findIndex((item) => item.at === at);
              apply(patchLayer(states, layerIndex, next), layerIndex, index);
              setBaseline({ ...object.base });
            }}
          >
            {layer.poses.map((item, index) => (
              <button
                key={index}
                className={`states-key ${index === keyIndex ? "active" : ""}`}
                style={{ left: `${((item.at! - range[0]) / Math.max(1e-6, range[1] - range[0])) * 100}%` }}
                onClick={(event) => { event.stopPropagation(); setKeyIndex(index); }}
                title={`Ключ ${item.at}`}
              />
            ))}
          </div>

          <div className="states-keys">
            {layer.poses.map((item, index) => (
              <span
                key={index}
                className={`states-key-chip ${index === keyIndex ? "active" : ""}`}
                onClick={() => setKeyIndex(index)}
              >
                {item.at}
                <button
                  onClick={(event) => { event.stopPropagation(); apply(patchLayer(states, layerIndex, removeKey(layer, index)), layerIndex, index); }}
                  title="Удалить ключ"
                >
                  ×
                </button>
              </span>
            ))}
          </div>

          {manual && (
            <div className="states-preview">
              <span>предпросмотр</span>
              <input
                type="range"
                min={range[0]}
                max={range[1]}
                step={0.01}
                value={props.inputs.values[`manual.${manual}`] ?? range[0]}
                onChange={(event) => props.onManual?.(manual, Number(event.target.value))}
              />
              <small>{props.inputs.values[`manual.${manual}`]?.toFixed(2) ?? "—"}</small>
            </div>
          )}
        </>
      )}

      {layer && !layer.param && (
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
        </div>
      )}

      {layer && (
        <>
          {layer.param && pose && (
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
            {STATE_FIELDS.filter((field) => field !== "visible").map((field) => (
              <div key={field} className="states-field">
                <span>{FIELD_LABEL[field]}</span>
                <NumberField
                  value={pose?.pose[field] ?? FIELD_NEUTRAL[field] ?? 0}
                  step={field === "sizeX" || field === "sizeY" || field === "opacity" ? 0.01 : 0.5}
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
                const delta = poseFromBase(baseline ?? object.base, object.base);
                applyLayer(setPose(layer, keyIndex, delta));
                // Объект возвращается на место: дальше им двигает состояние,
                // а не базовая поза — иначе поза удвоилась бы.
                if (baseline) props.onBase?.(baseline);
              }}
              title="Взять текущее положение объекта и записать его в выбранный ключ"
            >
              Записать позу
            </button>
            <button
              onClick={() => setBaseline({ ...object.base })}
              title="Начать запись заново от текущего положения"
            >
              Заново
            </button>
            <small>
              подвиньте объект на сцене или в инспекторе — дельта к моменту выбора ключа и станет позой
            </small>
          </div>
        </>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={layerMenu(menu.index)}
        />
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
    // то, что похоже на слой, — правки через `patchLayer` иначе уронили бы вкладку.
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
