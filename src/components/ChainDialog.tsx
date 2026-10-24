import { useState } from "react";
import { Spline, X } from "lucide-react";
import type { RigObject } from "../types";
import { DEFAULT_CHAIN, type ChainSettings } from "../engine/chain";
import { Switch } from "./Switch";

interface ChainDialogProps {
  objects: RigObject[];
  /** Порядок выделения: первый объект — корень цепочки. */
  ids: string[];
  onApply: (settings: ChainSettings) => void;
  onClose: () => void;
}

function ChainField({ label, unit, value, min, max, step, onCommit }: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (value: number) => void;
}) {
  return (
    <label className="chain-field">
      <span>{label}</span>
      <div>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (!Number.isFinite(parsed)) return;
            onCommit(Math.min(max, Math.max(min, parsed)));
          }}
        />
        <small>{unit}</small>
      </div>
    </label>
  );
}

/**
 * Связывание выделенных объектов в пружинную цепочку: хвост, лента, усы —
 * всё, что должно догонять движение с отставанием.
 */
export function ChainDialog({ objects, ids, onApply, onClose }: ChainDialogProps) {
  const [settings, setSettings] = useState<ChainSettings>(DEFAULT_CHAIN);
  const chain = ids
    .map((id) => objects.find((object) => object.id === id))
    .filter((object): object is RigObject => Boolean(object));
  const root = chain[0];
  const patch = (next: Partial<ChainSettings>) => setSettings((current) => ({ ...current, ...next }));

  return (
    <div className="dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="overlay-dialog" role="dialog" aria-label="Пружинная цепочка">
        <header className="dialog-head">
          <div className="dialog-title">
            <div className="dialog-icon"><Spline size={17} /></div>
            <div><span className="eyebrow">ФИЗИКА ИЗ СКРИПТОВ</span><h2>Пружинная цепочка</h2></div>
          </div>
          <button className="icon-button" title="Закрыть" onClick={onClose}><X size={15} /></button>
        </header>

        <div className="dialog-body">
          <section className="dialog-section">
            <div className="section-title"><span>Порядок цепочки</span><small>{chain.length} объекта</small></div>
            <p className="dialog-note">
              Объекты связываются в порядке выделения: каждый следующий становится ребёнком предыдущего.
              Скрипты и пивоты выбранных объектов будут заменены — Ctrl+Z вернёт как было.
            </p>
            <ol className="chain-list">
              {chain.map((object, index) => (
                <li key={object.id}>
                  <b>{index + 1}</b>
                  <span>{object.name}</span>
                  <small>{index === 0
                    ? (object.parentId ? "корень цепочки" : "корень рига — не трогаем")
                    : `ребёнок «${chain[index - 1].name}»`}</small>
                </li>
              ))}
            </ol>
            {root && !root.parentId && (
              <p className="dialog-note small">
                У «{root.name}» нет родителя, поэтому его движение остаётся как есть: пружина начнётся
                со следующего объекта. Чтобы качался и он, сначала вложите его в группу.
              </p>
            )}
          </section>

          <section className="dialog-section">
            <div className="section-title"><span>Пружина</span><small>ПО ВСЕМУ ХВОСТУ</small></div>
            <div className="chain-fields">
              <ChainField
                label="Частота" unit="Гц" value={settings.frequency} min={0.4} max={12} step={0.1}
                onCommit={(frequency) => patch({ frequency })}
              />
              <ChainField
                label="Затухание" unit="0..1" value={settings.damping} min={0.02} max={0.95} step={0.02}
                onCommit={(damping) => patch({ damping })}
              />
              <ChainField
                label="Изгиб покоя" unit="°" value={settings.bend} min={-45} max={45} step={0.5}
                onCommit={(bend) => patch({ bend })}
              />
              <ChainField
                label="Покачивание" unit="°" value={settings.sway} min={0} max={30} step={0.5}
                onCommit={(sway) => patch({ sway })}
              />
            </div>
            <div className="overlay-toggles">
              <Switch
                checked={settings.hinge}
                onChange={(hinge) => patch({ hinge })}
                title="Пивот на верхнюю кромку: сегменты вращаются вокруг стыка, а не вокруг центра"
              />
              <span className="chain-hinge-note">
                Шарнир в верхней кромке: сегменты вращаются вокруг стыка, спрайты при этом не съезжают.
              </span>
            </div>
            <p className="dialog-note small">
              Частота падает, а затухание растёт к кончику — так волна доходит до конца и не дребезжит.
              Меньше частота — тяжелее хвост; меньше затухание — дольше качается. Отрицательный изгиб
              закрутит хвост в другую сторону.
            </p>
          </section>

          <div className="dialog-actions">
            <button className="button primary" disabled={chain.length < 2} onClick={() => onApply(settings)}>
              <Spline size={14} /> Связать
            </button>
            <button className="button secondary" onClick={onClose}>Отмена</button>
          </div>
        </div>
      </div>
    </div>
  );
}
