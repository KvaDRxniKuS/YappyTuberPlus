import { useMemo, useState } from "react";
import { RotateCw, Spline, Waves, Wind, X } from "lucide-react";
import type { RigObject } from "../types";
import {
  DEFAULT_BEHAVIOUR, heavyAngle, readBehaviour, writeBehaviour, type Behaviour, type VisibilityRule,
} from "../engine/behaviour";
import { Switch } from "./Switch";

interface BehaviourPanelProps {
  object: RigObject | null;
  onChange: (script: string) => void;
}

/**
 * Строка ползунка со значением, которое можно вписать руками: клик по числу
 * открывает ввод. Пока поле в фокусе, показываем черновик — так можно набрать
 * «0.05» и не потерять точку.
 */
function Row({ label, hint, value, min, max, step, unit, onCommit }: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (input: number) => Math.min(max, Math.max(min, input));

  const type = (text: string) => {
    setDraft(text);
    const parsed = Number(text.replace(",", "."));
    if (text.trim() === "" || !Number.isFinite(parsed)) return;
    onCommit(clamp(parsed));
  };

  return (
    <div className="behaviour-row">
      <div className="behaviour-row-head">
        <span>{label}{hint && <small>{hint}</small>}</span>
        <span className="behaviour-value-wrap">
          <input
            className="behaviour-value"
            type="number"
            min={min}
            max={max}
            step={step}
            value={draft ?? value}
            onChange={(event) => type(event.target.value)}
            onBlur={() => setDraft(null)}
            title="Можно вписать число руками"
          />
          <small>{unit.trim()}</small>
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onCommit(clamp(Number(event.target.value)))}
      />
    </div>
  );
}

function StateRow({ label, value, onChange, titles }: {
  label: string;
  value: VisibilityRule;
  onChange: (value: VisibilityRule) => void;
  titles: Record<VisibilityRule, string>;
}) {
  const options: Array<{ id: VisibilityRule; text: string }> = [
    { id: "none", text: "×" },
    { id: "open", text: "открыт" },
    { id: "closed", text: "закрыт" },
  ];
  return (
    <div className="behaviour-state">
      <span>{label}</span>
      <div className="segmented small">
        {options.map((option) => (
          <button
            key={option.id}
            className={value === option.id ? "active" : ""}
            title={titles[option.id]}
            onClick={() => onChange(option.id)}
          >
            {option.text}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Пресет поведения в духе PNGTuber: ползунки вместо формул. Каждое изменение
 * переписывает блок в скрипте объекта, поэтому вкладка «Объект» всегда
 * показывает, что именно считается.
 */
export function BehaviourPanel({ object, onChange }: BehaviourPanelProps) {
  const behaviour = useMemo(
    () => (object ? readBehaviour(object.script) : { ...DEFAULT_BEHAVIOUR }),
    [object?.script],
  );

  if (!object) {
    return <div className="empty-state behaviour-empty"><Spline size={24} /><p>Выберите объект: пресет поведения настраивается для каждого объекта отдельно</p></div>;
  }

  const patch = (next: Partial<Behaviour>) => {
    if (!object) return;
    const written = writeBehaviour(object.script, { ...behaviour, ...next }, object);
    onChange(written.script);
  };

  const heavy = heavyAngle(object.pivot);

  return (
    <div className="behaviour-panel">
      <div className="behaviour-head">
        <div>
          <span className="eyebrow">ПРЕСЕТ ПОВЕДЕНИЯ</span>
          <b>{object.name}</b>
        </div>
        <button
          className="icon-button"
          title="Сбросить поведение: блок из скрипта удалится"
          onClick={() => onChange(writeBehaviour(object.script, DEFAULT_BEHAVIOUR, object).script)}
        >
          <X size={16} />
        </button>
      </div>
      <p className="behaviour-note">
        Ползунки превращаются в формулы — они лежат блоком в начале скрипта на вкладке «Объект».
        Любое число можно вписать руками: клик по значению справа.
      </p>

      <section className="behaviour-section">
        <div className="section-title"><span><Waves size={13} /> Реакция</span></div>
        <p className="behaviour-hint">
          Фильтр стоит на итоговой цели, поэтому влияет на всё движение объекта: наследство
          родителя, покачивание, подпрыгивание. Сглаживание — демпфер, пружина — перелёт.
          У поворота фильтруются обе части угла — наследуемая и собственный доворот.
        </p>
        <Row label="Сглаживание" hint="drag: 0 — без фильтра" unit="" value={behaviour.smooth}
          min={0} max={1} step={0.01} onCommit={(smooth) => patch({ smooth })} />
        <Row label="Пружина" hint="догоняет с перелётом" unit="" value={behaviour.spring}
          min={0} max={1} step={0.01} onCommit={(spring) => patch({ spring })} />
        <Row label="Сглаживание поворота" unit="" value={behaviour.rotationSmooth}
          min={0} max={1} step={0.01} onCommit={(rotationSmooth) => patch({ rotationSmooth })} />
        <Row label="Пружина поворота" unit="" value={behaviour.rotationSpring}
          min={0} max={1} step={0.01} onCommit={(rotationSpring) => patch({ rotationSpring })} />
      </section>

      <section className="behaviour-section">
        <div className="section-title"><span><Wind size={13} /> Деформация и подпрыгивание</span></div>
        <Row label="Сквош" hint="минус меняет оси местами" unit="" value={behaviour.squash}
          min={-1} max={1} step={0.01} onCommit={(squash) => patch({ squash })} />
        <Row label="Скорость деформации" unit="мс" value={behaviour.squashIn}
          min={20} max={600} step={10} onCommit={(squashIn) => patch({ squashIn })} />
        <Row label="Скорость возврата" unit="мс" value={behaviour.squashOut}
          min={20} max={600} step={10} onCommit={(squashOut) => patch({ squashOut })} />
        <Row label="Подпрыгивание при речи" hint="вверх, пиксели" unit="px" value={behaviour.bounce}
          min={0} max={400} step={1} onCommit={(bounce) => patch({ bounce })} />
      </section>

      <section className="behaviour-section">
        <div className="section-title"><span><RotateCw size={13} /> Доворот и пределы</span></div>
        <Row label="Доворот при речи" hint="−180…180°" unit="°" value={behaviour.rotationalDrag}
          min={-180} max={180} step={1} onCommit={(rotationalDrag) => patch({ rotationalDrag })} />
        <Row label="Предел влево" hint="0 — не поворачивать влево" unit="°" value={behaviour.rotationalLimitLeft}
          min={0} max={180} step={1} onCommit={(rotationalLimitLeft) => patch({ rotationalLimitLeft })} />
        <Row label="Предел вправо" hint="0 — не поворачивать вправо" unit="°" value={behaviour.rotationalLimitRight}
          min={0} max={180} step={1} onCommit={(rotationalLimitRight) => patch({ rotationalLimitRight })} />
        <p className="behaviour-hint">
          Пределы действуют, только если задан хотя бы один из них: ноль с одной стороны — это
          честный запрет поворота в эту сторону, а не «без предела».
        </p>
      </section>

      <section className="behaviour-section">
        <div className="section-title"><span><Waves size={13} /> Покачивание</span></div>
        <div className="behaviour-state">
          <span>Случайно<small>иначе — плавная синусоида</small></span>
          <Switch
            checked={behaviour.wiggleRandom}
            onChange={(wiggleRandom) => patch({ wiggleRandom })}
            title="Шум вместо синусоиды: движение неповторяющееся"
          />
        </div>
        <Row label="X · частота" unit="Гц" value={behaviour.wiggleXFreq}
          min={0} max={8} step={0.1} onCommit={(wiggleXFreq) => patch({ wiggleXFreq })} />
        <Row label="X · амплитуда" unit="px" value={behaviour.wiggleXAmp}
          min={0} max={60} step={0.5} onCommit={(wiggleXAmp) => patch({ wiggleXAmp })} />
        <Row label="Y · частота" unit="Гц" value={behaviour.wiggleYFreq}
          min={0} max={8} step={0.1} onCommit={(wiggleYFreq) => patch({ wiggleYFreq })} />
        <Row label="Y · амплитуда" unit="px" value={behaviour.wiggleYAmp}
          min={0} max={60} step={0.5} onCommit={(wiggleYAmp) => patch({ wiggleYAmp })} />
      </section>

      <section className="behaviour-section">
        <div className="section-title"><span><X size={13} /> Видимость</span></div>
        <StateRow
          label="Рот"
          value={behaviour.mouth}
          onChange={(mouth) => patch({ mouth })}
          titles={{
            none: "не управлять видимостью",
            open: "виден, когда персонаж говорит",
            closed: "виден, когда персонаж молчит",
          }}
        />
        <StateRow
          label="Глаз"
          value={behaviour.eye}
          onChange={(eye) => patch({ eye })}
          titles={{
            none: "не управлять видимостью",
            open: "виден, когда глаза открыты",
            closed: "виден на моргании",
          }}
        />
        <p className="behaviour-hint">
          Если заданы оба, условия перемножаются: слой виден, когда верно и то, и другое.
          Имена входов — стандартные: речь из модуля `mic`, моргание из `auto`.
        </p>
      </section>

      <section className="behaviour-section">
        <div className="section-title"><span><RotateCw size={13} /> Мировая физика</span></div>
        <p className="behaviour-hint">
          Пружина ориентирует «тяжёлую» сторону (ту, что дальше от пивота) в мировой угол: 0° — вниз,
          90° — вправо, 180° — вверх. Пивот должен быть сдвинут к краю.
        </p>
        {heavy === null
          ? <p className="behaviour-hint">Пивот по центру: физике не за что тянуть. Сдвиньте пивот к краю спрайта в инспекторе.</p>
          : (
            <>
              <div className="behaviour-phys-head">
                <button
                  className={`button secondary ${behaviour.physRotation !== null ? "active" : ""}`}
                  onClick={() => patch({ physRotation: behaviour.physRotation === null ? 0 : null })}
                >
                  {behaviour.physRotation === null ? "Включить" : "Выключить"}
                </button>
                <small>угол тяжёлой стороны: {Math.round(heavy)}°</small>
              </div>
              {behaviour.physRotation !== null && (
                <>
                  <Row label="Мировой угол" unit="°" value={behaviour.physRotation}
                    min={-180} max={180} step={1} onCommit={(physRotation) => patch({ physRotation })} />
                  <Row label="Плавность" hint="0 — жёстко, 1 — вязко" unit="" value={behaviour.physSmooth}
                    min={0} max={1} step={0.01} onCommit={(physSmooth) => patch({ physSmooth })} />
                </>
              )}
            </>
          )}
      </section>
    </div>
  );
}
