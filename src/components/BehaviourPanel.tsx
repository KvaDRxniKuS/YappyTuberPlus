import { useMemo, useState } from "react";
import { RotateCw, Spline, Waves, Wind, X } from "lucide-react";
import type { RigObject } from "../types";
import {
  DEFAULT_BEHAVIOUR, heavyAngle, readBehaviour, resetBehaviourFor, writeBehaviourFor,
  type Behaviour, type VisibilityRule,
} from "../engine/behaviour";
import { Switch } from "./Switch";

interface BehaviourPanelProps {
  /** Основной объект: по нему показаны значения. */
  object: RigObject | null;
  /** Всё выделение: правка уходит каждому, у кого поле своё — сохраняется. */
  selection?: RigObject[];
  onChange: (scripts: Record<string, string>) => void;
}

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
export function BehaviourPanel({ object, selection, onChange }: BehaviourPanelProps) {
  const behaviour = useMemo(
    () => (object ? readBehaviour(object.script) : { ...DEFAULT_BEHAVIOUR }),
    [object?.script],
  );

  // Кому пишем правку: всё выделение. Значения в панели — по основному объекту,
  // у остальных меняется только то поле, которое тронули, остальное своё.
  const targets = useMemo(
    () => (selection && selection.length ? selection : object ? [object] : []),
    [selection, object],
  );

  if (!object || !targets.length) {
    return <div className="empty-state behaviour-empty"><Spline size={24} /><p>Выберите объект или несколько: пресет поведения пишется в скрипт каждого</p></div>;
  }

  const patch = (next: Partial<Behaviour>) => {
    onChange(writeBehaviourFor(targets, object, next));
  };

  const reset = () => onChange(resetBehaviourFor(targets));

  const heavy = heavyAngle(object.pivot);

  return (
    <div className="behaviour-panel">
      <div className="behaviour-head">
        <div>
          <span className="eyebrow">ПРЕСЕТ ПОВЕДЕНИЯ</span>
          <b>{object.name}{targets.length > 1 && <small> + ещё {targets.length - 1}</small>}</b>
        </div>
        <button
          className="icon-button"
          title={targets.length > 1
            ? `Сбросить поведение у всех выделенных (${targets.length}): блоки из скриптов удалятся`
            : "Сбросить поведение: блок из скрипта удалится"}
          onClick={reset}
        >
          <X size={16} />
        </button>
      </div>
      <p className="behaviour-note">
        Ползунки превращаются в формулы — они лежат блоком в начале скрипта на вкладке «Объект».
        Любое число можно вписать руками: клик по значению справа.
        {targets.length > 1 && <>
          {" "}<b>Правка применяется ко всем выделенным</b>: значения показаны по «{object.name}»,
          у остальных меняется только тронутое поле, их собственные настройки остаются.
        </>}
      </p>

      <section className="behaviour-section">
        <div className="section-title"><span><Waves size={13} /> Реакция</span></div>
        <p className="behaviour-hint">
          Фильтр стоит на итоговой цели, поэтому влияет на всё движение объекта: наследство
          родителя, покачивание, подпрыгивание, доворот. Сглаживание — тормоз: именно оно гасит
          силу пружины. Пружина — резкость: чем больше сила, тем резче тянет и качается. Угол
          фильтруется так же целиком; предел при этом ограничивает только доворот, а не угол
          родителя.
        </p>
        <Row label="Сглаживание" hint="drag: 0 — без фильтра" unit="" value={behaviour.smooth}
          min={0} max={1} step={0.01} onCommit={(smooth) => patch({ smooth })} />
        <Row label="Пружина" hint="сила: резче тянет и сильнее качается" unit="" value={behaviour.spring}
          min={0} max={1} step={0.01} onCommit={(spring) => patch({ spring })} />
        <Row label="Сглаживание поворота" unit="" value={behaviour.rotationSmooth}
          min={0} max={1} step={0.01} onCommit={(rotationSmooth) => patch({ rotationSmooth })} />
        <Row label="Пружина поворота" unit="" value={behaviour.rotationSpring}
          min={0} max={1} step={0.01} onCommit={(rotationSpring) => patch({ rotationSpring })} />
      </section>

      <section className="behaviour-section">
        <div className="section-title"><span><Wind size={13} /> Размер, деформация и подпрыгивание</span></div>
        <p className="behaviour-hint">
          «Размер X/Y» — скаляры к базовому размеру спрайта: цифра прямо в скрипте, поэтому высоту и
          ширину можно править здесь, не заходя в инспектор. Они умножаются на «Масштаб X/Y» из
          инспектора и работают вместе со сквошем: растянулись по одной оси — сжались по другой.
        </p>
        <Row label="Размер X" hint="скаляр к базовому размеру" unit="×" value={behaviour.scaleX}
          min={0.05} max={5} step={0.01} onCommit={(scaleX) => patch({ scaleX })} />
        <Row label="Размер Y" hint="скаляр к базовому размеру" unit="×" value={behaviour.scaleY}
          min={0.05} max={5} step={0.01} onCommit={(scaleY) => patch({ scaleY })} />
        <Row label="Сквош" hint="минус меняет оси местами" unit="" value={behaviour.squash}
          min={-1} max={1} step={0.01} onCommit={(squash) => patch({ squash })} />
        <Row label="Скорость деформации" unit="мс" value={behaviour.squashIn}
          min={20} max={600} step={10} onCommit={(squashIn) => patch({ squashIn })} />
        <Row label="Скорость возврата" unit="мс" value={behaviour.squashOut}
          min={20} max={600} step={10} onCommit={(squashOut) => patch({ squashOut })} />
        <Row label="Подпрыгивание при речи" hint="вверх, пиксели" unit="px" value={behaviour.bounce}
          min={0} max={400} step={1} onCommit={(bounce) => patch({ bounce })} />
        <Row label="Скорость подпрыгивания" hint="меньше — резче" unit="мс" value={behaviour.bounceSpeed}
          min={20} max={600} step={10} onCommit={(bounceSpeed) => patch({ bounceSpeed })} />
        <div className="behaviour-state">
          <span>Прыгать один раз<small>иначе — держится всю речь</small></span>
          <Switch
            checked={behaviour.bounceOnce}
            onChange={(bounceOnce) => patch({ bounceOnce })}
            title="Прыгнуть один раз и опуститься, даже если речь продолжается"
          />
        </div>
        {behaviour.bounceOnce && (
          <Row label="Длительность прыжка" hint="сколько держится вверху" unit="мс" value={behaviour.bounceHold}
            min={100} max={3000} step={50} onCommit={(bounceHold) => patch({ bounceHold })} />
        )}
      </section>

      <section className="behaviour-section">
        <div className="section-title"><span><RotateCw size={13} /> Доворот и пределы</span></div>
        <Row label="Поворот при речи" hint="максимум, 0 — выключено" unit="°" value={behaviour.dragAngle}
          min={0} max={180} step={1} onCommit={(dragAngle) => patch({ dragAngle })} />
        <div className="behaviour-state">
          <span>Направление<small>куда доворачивать</small></span>
          <div className="segmented small dense">
            {([
              { id: "right", text: "вправо", title: "Всегда в одну сторону — вправо" },
              { id: "left", text: "влево", title: "Всегда в одну сторону — влево" },
              { id: "random", text: "случайно", title: "Направление меняется случайно, плавно" },
              { id: "alternate", text: "поочерёдно", title: "Сперва в одну сторону, потом в другую, раз в 1.2 с" },
            ] as const).map((option) => (
              <button
                key={option.id}
                className={behaviour.dragMode === option.id ? "active" : ""}
                title={option.title}
                onClick={() => patch({ dragMode: option.id })}
              >
                {option.text}
              </button>
            ))}
          </div>
        </div>
        <div className="behaviour-state">
          <span>В диапазоне<small>угол — это максимум</small></span>
          <Switch
            checked={behaviour.dragInRange}
            onChange={(dragInRange) => patch({ dragInRange })}
            title="Угол — максимум: фактический поворот гуляет случайно от 0 до него"
          />
        </div>
        <Row label="Предел влево" hint="0 — не поворачивать влево" unit="°" value={behaviour.rotationalLimitLeft}
          min={0} max={180} step={1} onCommit={(rotationalLimitLeft) => patch({ rotationalLimitLeft })} />
        <Row label="Предел вправо" hint="0 — не поворачивать вправо" unit="°" value={behaviour.rotationalLimitRight}
          min={0} max={180} step={1} onCommit={(rotationalLimitRight) => patch({ rotationalLimitRight })} />
        <p className="behaviour-hint">
          Пределы — это диапазон сустава <b>вокруг положения покоя</b>: объект не вылетает из него,
          как бы ни качался — и с физикой, и без неё. Ноль с одной стороны — честный запрет в эту
          сторону; если оба нуля, предела нет.
        </p>
      </section>

      <section className="behaviour-section">
        <div className="section-title"><span><Waves size={13} /> Покачивание</span></div>
        <p className="behaviour-hint">
          Покачивание работает само по себе: «Поворот при речи» ему не нужен и ничего к нему
          не добавляет — это два независимых генератора. Заданная амплитуда включает его сразу
          (частота станет 1 Гц), а обнулить можно любым из двух полей. «Случайно» тоже не трогает
          частоту: качание остаётся ровным по ритму и размаху, просто не повторяется.
        </p>
        <div className="behaviour-state">
          <span>X · случайно<small>иначе — плавная синусоида</small></span>
          <Switch
            checked={behaviour.wiggleRandom}
            onChange={(wiggleRandom) => patch({ wiggleRandom })}
            title="Неповторяющееся покачивание по X: частота остаётся заданной, дрейфуют фаза и амплитуда"
          />
        </div>
        <Row label="X · частота" unit="Гц" value={behaviour.wiggleXFreq}
          min={0} max={8} step={0.1} onCommit={(wiggleXFreq) => patch({ wiggleXFreq })} />
        <Row label="X · амплитуда" unit="px" value={behaviour.wiggleXAmp}
          min={0} max={60} step={0.5} onCommit={(wiggleXAmp) => patch({ wiggleXAmp })} />
        <div className="behaviour-state">
          <span>Y · случайно<small>иначе — плавная синусоида</small></span>
          <Switch
            checked={behaviour.wiggleYRandom}
            onChange={(wiggleYRandom) => patch({ wiggleYRandom })}
            title="Неповторяющееся покачивание по Y — независимо от X, частота та же"
          />
        </div>
        <Row label="Y · частота" unit="Гц" value={behaviour.wiggleYFreq}
          min={0} max={8} step={0.1} onCommit={(wiggleYFreq) => patch({ wiggleYFreq })} />
        <Row label="Y · амплитуда" unit="px" value={behaviour.wiggleYAmp}
          min={0} max={60} step={0.5} onCommit={(wiggleYAmp) => patch({ wiggleYAmp })} />
        <div className="behaviour-state">
          <span>Случайно · поворот<small>иначе — плавная синусоида</small></span>
          <Switch
            checked={behaviour.wiggleRotRandom}
            onChange={(wiggleRotRandom) => patch({ wiggleRotRandom })}
            title="Неповторяющееся угловое покачивание: ритм тот же, фаза и амплитуда гуляют"
          />
        </div>
        <Row label="Поворот · частота" unit="Гц" value={behaviour.wiggleRotFreq}
          min={0} max={8} step={0.1} onCommit={(wiggleRotFreq) => patch({ wiggleRotFreq })} />
        <Row label="Поворот · амплитуда" unit="°" value={behaviour.wiggleRotAmp}
          min={0} max={90} step={0.5} onCommit={(wiggleRotAmp) => patch({ wiggleRotAmp })} />
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
        <div className="section-title"><span><RotateCw size={13} /> Физика поворота</span></div>
        <p className="behaviour-hint">
          Физика — это свободный маятник: пружина тянет «тяжёлую» сторону (ту, что дальше от
          пивота) к углу 0° — вниз, 90° — вправо, 180° — вверх. Речь не давит на угол постоянно,
          а толкает импульсом: тело получает удар и болтается само, пока его не остановит
          затухание мотора или упор предела. «Сила» — резкость (частота), «Плавность» — вязкость:
          при 0 мотор звонкий и качается долго, при 1 гаснет за пару качков. Пивот задаёт плечо.
          Мировая система держит угол в мире (подвеска, серьга, прядь), родительская — внутри
          тела (рука на плече).
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
                  <div className="behaviour-state">
                    <span>Координаты<small>где считается угол</small></span>
                    <div className="segmented small">
                      <button
                        className={behaviour.physSpace === "world" ? "active" : ""}
                        title="Мировая: спрайт держит угол в мире и не поворачивается вместе с телом — подвеска, серьга, прядь"
                        onClick={() => patch({ physSpace: "world" })}
                      >
                        мировая
                      </button>
                      <button
                        className={behaviour.physSpace === "parent" ? "active" : ""}
                        title="Родительская: угол считается внутри тела — тело подхватывает спрайт, пружина запаздывает и даёт качок — рука на плече"
                        onClick={() => patch({ physSpace: "parent" })}
                      >
                        родительская
                      </button>
                    </div>
                  </div>
                  {behaviour.physSpace === "parent" && !object.parentId && (
                    <p className="behaviour-hint">
                      У объекта нет родителя: родительская система совпадает с мировой, поворачивать
                      его не за кем. Привяжите объект к телу в дереве.
                    </p>
                  )}
                  <Row label={behaviour.physSpace === "parent" ? "Угол в теле" : "Мировой угол"} unit="°" value={behaviour.physRotation}
                    min={-180} max={180} step={1} onCommit={(physRotation) => patch({ physRotation })} />
                  <Row label="Сила" hint="резкость: больше — выше частота и злее бросок" unit="" value={behaviour.physForce}
                    min={0} max={1} step={0.01} onCommit={(physForce) => patch({ physForce })} />
                  <Row label="Плавность" hint="вязкость: 0 — качается долго, 1 — гаснет сразу" unit="" value={behaviour.physSmooth}
                    min={0} max={1} step={0.01} onCommit={(physSmooth) => patch({ physSmooth })} />
                  <Row label="Длительность импульса" hint="толчок от речи" unit="мс" value={behaviour.dragImpulse}
                    min={40} max={1500} step={10} onCommit={(dragImpulse) => patch({ dragImpulse })} />
                  <p className="behaviour-hint">
                    С физикой «Поворот при речи» — это толчок: угол и направление берутся из него,
                    но постоянной силы нет, объект после удара качается сам. «Длительность импульса»
                    — сколько длится толчок. «Сглаживание поворота» работает как трение,
                    «Пружина поворота» не участвует: два пружинных контура подряд гасят друг друга.
                  </p>
                </>
              )}
            </>
          )}
      </section>
    </div>
  );
}
