import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import type { BasePose, InputValues, ModuleInstance, RigFrame, RigObject } from "../types";
import { NumberField } from "./NumberField";
import {
  addKey, addLayer, layerRange, makeLayer, manualInputOf, moveKey, patchLayer, poseFromBase,
  readStates, removeKey, removeLayer, resetStatesFor, setPose, writeStates,
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

  if (!object) {
    return <div className="states-empty">Выберите объект: состояния принадлежат объекту и лежат в его скрипте.</div>;
  }

  const names = paramNames(props);
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
              className={`states-layer ${index === layerIndex ? "active" : ""}`}
              onClick={() => { setLayerIndex(index); setKeyIndex(0); }}
            >
              <input
                className="states-name"
                value={item.name}
                onChange={(event) => apply(patchLayer(states, index, { name: event.target.value }), index)}
                title="Имя слоя"
              />
              <input
                className="states-param"
                list="states-params"
                value={item.param ?? ""}
                placeholder="вес выражением"
                onChange={(event) => {
                  const value = event.target.value.trim();
                  const param = value ? value : null;
                  const next: StateLayer = { ...item, param };
                  // Переход между привязкой и свободными весами: позы без `at`
                  // некуда поставить на шкале, поэтому ключи получают значения.
                  if (param) {
                    next.poses = item.poses.map((pose, position) => (
                      pose.at === undefined
                        ? { ...pose, at: position === 0 ? range[0] : range[1] }
                        : pose
                    ));
                  } else {
                    next.poses = item.poses.map((pose) => (
                      pose.weight === undefined ? { ...pose, weight: "1" } : pose
                    ));
                  }
                  apply(patchLayer(states, index, next), index);
                }}
                title="Параметр: вход модуля, глобальная или локальная переменная"
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

      <datalist id="states-params">
        {names.map((name) => <option key={name} value={name} />)}
      </datalist>
    </div>
  );
}

/** Имена, которые можно привязать: входы модулей и глобальные переменные. */
function paramNames(props: StatesPanelProps): string[] {
  const names = new Set<string>();
  for (const instance of props.modules) {
    for (const input of moduleInputs(instance)) names.add(input.key);
  }
  for (const key of Object.keys(props.inputs.values)) names.add(key);
  for (const key of Object.keys(props.frame?.globals ?? {})) names.add(key);
  return [...names].sort();
}

/** Границы входа из паспорта — отрезок по умолчанию. */
function metaRange(props: StatesPanelProps, param: string | null): [number, number] | null {
  if (!param) return null;
  const meta = props.inputs.meta?.[param];
  if (!meta || !Number.isFinite(meta.min) || !Number.isFinite(meta.max)) return null;
  if (meta.max <= meta.min) return null;
  return [meta.min, meta.max];
}
