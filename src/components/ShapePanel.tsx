import { useState } from "react";
import { PenTool, Trash2 } from "lucide-react";
import type { RigFrame, RigObject, ShapeItem, ShapeItemKind, ShapeSpec, Vec2 } from "../types";
import { defaultShape, makeItem, smoothingOf, uniqueItemId } from "../render/shape";
import { LabeledNumberField as NumberField } from "./NumberField";

/**
 * Вкладка «Фигура»: контуры объекта-фигуры.
 *
 * Раньше это жило в инспекторе рядом с позой и пивотом, и правка контура
 * требовала прокрутки через полпанели. Теперь настройки фигуры — своя вкладка:
 * она появляется, только когда выбран объект-фигура, а инспектор оставляет
 * себе позу и пивот.
 */

const SHAPE_KINDS: Array<{ kind: ShapeItemKind; label: string }> = [
  { kind: "rect", label: "Прямоугольник" },
  { kind: "ellipse", label: "Эллипс" },
  { kind: "path", label: "Перо" },
];

const SHAPE_KIND_LABEL: Record<ShapeItemKind, string> = {
  rect: "Прямоугольник",
  ellipse: "Эллипс",
  path: "Перо",
};

interface ShapePanelProps {
  object: RigObject | null;
  frame?: RigFrame | null;
  pen: { objectId: string; itemId: string } | null;
  onPen: (pen: { objectId: string; itemId: string } | null) => void;
  onChange: (object: RigObject) => void;
}

export function ShapePanel({ object, pen, onPen, onChange }: ShapePanelProps) {
  if (!object || object.kind !== "shape") {
    return (
      <div className="empty-state">
        <ShapesIcon />
        <p>Выберите объект-фигуру, чтобы править её контуры</p>
        <span className="behaviour-hint">
          Фигура создаётся кнопкой «Фигура» в структуре: её контуры и есть то, что
          видно на сцене и что берёт маска.
        </span>
      </div>
    );
  }
  return <ShapeEditor object={object} pen={pen} onPen={onPen} onChange={onChange} />;
}

function ShapesIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="12" height="12" rx="2" /><circle cx="16" cy="16" r="5" /></svg>;
}

function ShapeEditor({ object, pen, onPen, onChange }: ShapePanelProps & { object: RigObject }) {
  const shape = object.shape ?? defaultShape(object.width, object.height);
  const [activeId, setActiveId] = useState<string | null>(null);
  const update = (patch: Partial<ShapeSpec>) => onChange({ ...object, shape: { ...shape, ...patch } });
  const active = shape.items.find((item) => item.id === activeId) ?? shape.items[0] ?? null;
  const updateItem = (id: string, patch: Partial<ShapeItem>) => update({
    items: shape.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  });
  const penHere = pen && pen.objectId === object.id && pen.itemId === active?.id ? pen : null;

  const add = (kind: ShapeItemKind) => {
    const item = makeItem(shape, kind, object.width, object.height);
    // Перо начинается пустым: точки появятся кликами по сцене.
    const fresh: ShapeItem = kind === "path"
      ? { ...item, id: uniqueItemId(shape, kind), points: [], smoothPoints: [], closed: false }
      : item;
    update({ items: [...shape.items, fresh] });
    setActiveId(fresh.id);
    if (kind === "path") onPen({ objectId: object.id, itemId: fresh.id });
  };

  const remove = (id: string) => {
    update({ items: shape.items.filter((item) => item.id !== id) });
    if (pen?.itemId === id) onPen(null);
  };

  /** Сглаживание точки: 0 — угол, 100 — полная кривая. */
  const setSmoothing = (item: ShapeItem, index: number, value: number) => {
    const next = item.points.map((_, at) => (at === index ? Math.min(100, Math.max(0, value)) : smoothingOf(item, at)));
    updateItem(item.id, { smoothPoints: next });
  };

  const removePoint = (item: ShapeItem, index: number) => {
    updateItem(item.id, {
      points: item.points.filter((_, at) => at !== index),
      smoothPoints: item.points.map((_, at) => smoothingOf(item, at)).filter((_, at) => at !== index),
    });
  };

  const movePoint = (item: ShapeItem, index: number, patch: Partial<Vec2>) => {
    updateItem(item.id, {
      points: item.points.map((point, at) => (at === index ? { ...point, ...patch } : point)),
      smoothPoints: item.points.map((_, at) => smoothingOf(item, at)),
    });
  };

  return (
    <div className="shape-panel">
      <div className="property-section compact-section">
        <div className="section-title"><span>Контуры</span><small>ФИГУРА</small></div>
        <div className="shape-list">
          {shape.items.length === 0 && <p className="behaviour-hint">Контуров нет: добавьте прямоугольник, эллипс или перо.</p>}
          {shape.items.map((item) => {
            const activeRow = active?.id === item.id;
            const drawing = pen?.objectId === object.id && pen.itemId === item.id;
            return (
              <div className={`shape-row ${activeRow ? "active" : ""}`} key={item.id}>
                <button className="shape-kind" title="Выбрать контур" onClick={() => setActiveId(item.id)}>
                  {SHAPE_KIND_LABEL[item.kind]}
                </button>
                <span className="shape-summary">
                  {item.kind === "path"
                    ? `${item.points.length} точек`
                    : `${Math.round(item.width)}×${Math.round(item.height)}`}
                </span>
                {item.kind === "path" && (
                  <button
                    className={`icon-button ${drawing ? "active" : ""}`}
                    title={drawing ? "Закончить рисовать" : "Рисовать контур на сцене: клик ставит точку, точка тянется мышью"}
                    onClick={() => onPen(drawing ? null : { objectId: object.id, itemId: item.id })}
                  >
                    <PenTool size={13} />
                  </button>
                )}
                <button className="icon-button danger" title="Удалить контур" onClick={() => remove(item.id)}>
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="image-actions">
          {SHAPE_KINDS.map((entry) => (
            <button key={entry.kind} className="button secondary" onClick={() => add(entry.kind)}>
              + {entry.label}
            </button>
          ))}
        </div>
      </div>

      {active && active.kind !== "path" && (
        <div className="property-section compact-section">
          <div className="section-title"><span>Рамка контура</span><small>{SHAPE_KIND_LABEL[active.kind].toUpperCase()}</small></div>
          <div className="property-grid">
            <NumberField label="X" value={active.x} step={1} onCommit={(x) => updateItem(active.id, { x })} />
            <NumberField label="Y" value={active.y} step={1} onCommit={(y) => updateItem(active.id, { y })} />
            <NumberField label="Ширина" value={active.width} step={1} onCommit={(width) => updateItem(active.id, { width })} />
            <NumberField label="Высота" value={active.height} step={1} onCommit={(height) => updateItem(active.id, { height })} />
          </div>
        </div>
      )}

      {active && active.kind === "path" && (
        <div className="property-section compact-section">
          <div className="section-title"><span>Точки</span><small>СГЛАЖИВАНИЕ 0…100 %</small></div>
          <div className="image-actions">
            <button className="button secondary" onClick={() => onPen(penHere ? null : { objectId: object.id, itemId: active.id })}>
              <PenTool size={13} /> {penHere ? "Закончить перо" : "Рисовать пером"}
            </button>
            <button
              className="button secondary"
              disabled={!active.points.length}
              title="Убрать последнюю точку"
              onClick={() => removePoint(active, active.points.length - 1)}
            >
              Убрать точку
            </button>
            <button
              className="button secondary"
              disabled={!active.points.length}
              title="Очистить контур целиком"
              onClick={() => updateItem(active.id, { points: [], smoothPoints: [] })}
            >
              Очистить
            </button>
          </div>
          <label className="check-line">
            <input type="checkbox" checked={active.closed} onChange={(event) => updateItem(active.id, { closed: event.target.checked })} />
            <span>Замкнуть контур</span>
          </label>

          {active.points.length === 0 && (
            <p className="behaviour-hint">
              Точек пока нет: включите перо и щёлкайте по сцене. Клик между двумя
              точками вставляет новую между ними, перетаскивание двигает, Alt+клик
              по точке переключает угол и кривую.
            </p>
          )}

          <div className="point-list">
            {active.points.map((point, index) => {
              const smoothing = smoothingOf(active, index);
              return (
                <div className="point-row" key={`${active.id}-${index}`}>
                  <span className="point-index">{index + 1}</span>
                  <NumberField label="X" value={point.x} step={1} onCommit={(x) => movePoint(active, index, { x })} />
                  <NumberField label="Y" value={point.y} step={1} onCommit={(y) => movePoint(active, index, { y })} />
                  <label className="point-smoothing" title="Сила сглаживания точки: 0 — угол, 100 — полная кривая">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={smoothing}
                      onChange={(event) => setSmoothing(active, index, Number(event.target.value))}
                    />
                    <b>{Math.round(smoothing)} %</b>
                  </label>
                  <button
                    className="icon-button"
                    title={smoothing > 0 ? "Сделать угол (0 %)" : "Сделать кривую (100 %)"}
                    onClick={() => setSmoothing(active, index, smoothing > 0 ? 0 : 100)}
                  >
                    {smoothing > 0 ? "⌒" : "∠"}
                  </button>
                  <button className="icon-button danger" title="Удалить точку" onClick={() => removePoint(active, index)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="property-section compact-section">
        <div className="section-title"><span>Вид</span><small>ЗАЛИВКА И ОБВОДКА</small></div>
        <label className="check-line">
          <input type="checkbox" checked={shape.draw} onChange={(event) => update({ draw: event.target.checked })} />
          <span>Рисовать фигуру в сцене</span>
        </label>
        <div className="color-row">
          <label>
            <span>Заливка</span>
            <input type="color" value={shape.fill} onChange={(event) => update({ fill: event.target.value })} />
          </label>
          <label>
            <span>Обводка</span>
            <input type="color" value={shape.stroke} onChange={(event) => update({ stroke: event.target.value })} />
          </label>
        </div>
        <NumberField label="Толщина обводки" value={shape.strokeWidth} step={1} onCommit={(strokeWidth) => update({ strokeWidth: Math.max(0, strokeWidth) })} />
        <p className="behaviour-hint">
          Фигура — обычный объект сцены: её можно двигать, масштабировать и анимировать
          скриптом. Маску берут контуры, поэтому саму фигуру можно спрятать глазом —
          вырезать она продолжит.
        </p>
      </div>
    </div>
  );
}
