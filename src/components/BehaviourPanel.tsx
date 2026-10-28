import { useMemo, useState } from "react";
import { Lightbulb, MousePointer2, Palette, Plus, RotateCw, Shirt, Spline, Trash2, Waves, Wind, X } from "lucide-react";
import type { ColorLink, ModuleInstance, RigObject, TextSpec } from "../types";
import { normalizeText } from "../engine/preset";
import { hasQuotedPlaceholder, quotePlaceholders, unquotePlaceholders } from "../render/text";
import {
  DEFAULT_BEHAVIOUR, heavyAngle, readBehaviour, resetBehaviourFor, writeBehaviourFor,
  type Behaviour, type PresetRule, type VisibilityRule,
} from "../engine/behaviour";
import { presetEntries, presetModules, presetVariable } from "../modules/presets";
import { colorChannels } from "../modules/color";
import { ambientPoints } from "../modules/ambient";
import { moduleDefinition } from "../modules/registry";
import { COLOR_FIELD_LABEL, colorFieldsOf, ownColorOf, type ColorField } from "../render/color";
import { Switch } from "./Switch";
import { autoBlinkEyeInput, autoBlinkOutputs } from "../modules/autoblink";

interface BehaviourPanelProps {
  /** Основной объект: по нему показаны значения. */
  object: RigObject | null;
  /** Всё выделение: правка уходит каждому, у кого поле своё — сохраняется. */
  selection?: RigObject[];
  onChange: (scripts: Record<string, string>) => void;
  /** Правка свойств текста: шрифт, размер, оформление и источник строки. */
  onText?: (objects: RigObject[]) => void;
  /** Правка цвета: привязка «поле цвета → модуль и канал». */
  onColors?: (objects: RigObject[]) => void;
  /** Модули пресета: из них вкладка берёт список пресетов одежды и эмоций. */
  modules?: ModuleInstance[];
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

  // Пока печатают — только черновик: иначе «0.5» превращалось бы в «5»,
  // а промежуточное «1» в поле с максимумом 1 обрезало бы следующую цифру.
  const type = (text: string) => setDraft(text);
  const commit = () => {
    const parsed = Number((draft ?? "").trim().replace(",", "."));
    if ((draft ?? "").trim() !== "" && Number.isFinite(parsed)) onCommit(clamp(parsed));
    setDraft(null);
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
            onBlur={commit}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
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
 * Выбор модуля, когда их несколько.
 *
 * Пока в пресете один микрофон (или одно моргание), выбирать нечего — строки
 * нет. Второй модуль того же типа делает выбор осмысленным: поведение читает
 * ровно тот, чьё имя записано в блоке. Переименовали модуль — здесь видно,
 * что формулы смотрят в старое имя.
 */
function ModulePicker({ label, modules, value, onPick }: {
  label: string;
  modules: ModuleInstance[];
  value: string;
  onPick: (name: string) => void;
}) {
  if (modules.length < 2) return null;
  const known = modules.some((module) => module.name === value);
  return (
    <div className="behaviour-state">
      <span>{label}<small>какой модуль слушать</small></span>
      <select
        value={known ? value : modules[0].name}
        title="Модуль, чьи входы читает поведение"
        onChange={(event) => onPick(event.target.value)}
      >
        {!known && <option value={modules[0].name}>выберите модуль</option>}
        {modules.map((module) => <option key={module.name} value={module.name}>{module.name}</option>)}
      </select>
    </div>
  );
}

/** Компактное числовое поле: значение применяется по Enter или уходу фокуса. */
function TextNumber({ label, value, min, max, step, suffix, onCommit }: {
  label: string; value: number; min: number; max: number; step: number;
  suffix?: string; onCommit: (value: number) => void;
}) {
  return (
    <label className="number-field">
      <span className="number-label">{label}</span>
      <div>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number(value.toFixed(3))}
          onChange={(event) => {
            const parsed = Number(event.target.value.replace(",", "."));
            if (Number.isFinite(parsed)) onCommit(Math.min(max, Math.max(min, parsed)));
          }}
        />
        {suffix && <small>{suffix}</small>}
      </div>
    </label>
  );
}

/**
 * Текст объекта: источник строки и оформление.
 *
 * Источник — шаблон `{модуль.поле}`: по умолчанию ссылка читается (подставляется
 * сообщение из модуля). Если нужно показать саму ссылку текстом, её экранируют
 * одинарными кавычками — `'{twitch.chat.message}'`; кнопка делает это сама.
 */
function TextSettings({ spec, onPatch }: {
  spec: TextSpec;
  onPatch: (patch: Partial<TextSpec>) => void;
}) {
  const quoted = hasQuotedPlaceholder(spec.template);
  return (
    <>
      <div className="section-title"><span>Текст</span><small>ИСТОЧНИК И ОФОРМЛЕНИЕ</small></div>
      <p className="behaviour-hint">
        Свой текст пишется как есть. Ссылка вида <b>{"{twitch.chat.message}"}</b> читается из
        модуля: подставляется последнее сообщение, <b>{"{twitch.chat.user}"}</b> — автор.
        Чтобы ссылка была видна <b>текстом</b>, а не значением, оберните её в одинарные
        кавычки — <b>{"'{twitch.chat.message}'"}</b>. Скрипт объекта сильнее этой строки:
        <b> {'text = "…"'} </b> заменяет её целиком.
      </p>
      <label className="text-property">
        <span>{quoted ? "Текст (ссылка показана текстом)" : "Текст или ссылка"}</span>
        <textarea
          rows={3}
          value={spec.template}
          placeholder="{twitch.chat.user}: {twitch.chat.message}"
          onChange={(event) => onPatch({ template: event.target.value })}
        />
      </label>
      <button
        className="button secondary behaviour-text-source"
        title={quoted
          ? "Снять кавычки: ссылка снова будет читаться из модуля"
          : "Обернуть ссылки в кавычки: на экране будет сам текст {…}, а не значение"}
        onClick={() => onPatch({
          template: quoted ? unquotePlaceholders(spec.template) : quotePlaceholders(spec.template),
        })}
      >
        {quoted ? "Читать значение ссылки" : "Показать ссылку текстом"}
      </button>
      <div className="property-grid two-columns">
        <TextNumber label="Размер" value={spec.size} min={4} max={400} step={2} suffix="px"
          onCommit={(size) => onPatch({ size })} />
        <TextNumber label="Межстрочный" value={spec.lineHeight} min={0.5} max={3} step={0.1} suffix="×"
          onCommit={(lineHeight) => onPatch({ lineHeight })} />
      </div>
      <div className="property-grid two-columns">
        <label className="number-field">
          <span className="number-label">Шрифт</span>
          <div><input value={spec.font} onChange={(event) => onPatch({ font: event.target.value })} /></div>
        </label>
        <label className="number-field">
          <span className="number-label">Цвет</span>
          <div><input type="color" value={spec.color} onChange={(event) => onPatch({ color: event.target.value })} /></div>
        </label>
      </div>
      <label className="select-property">
        <span>Выравнивание</span>
        <select value={spec.align} onChange={(event) => onPatch({ align: event.target.value as TextSpec["align"] })}>
          <option value="left">по левому краю</option>
          <option value="center">по центру</option>
          <option value="right">по правому краю</option>
        </select>
      </label>
      <div className="behaviour-flags">
        <label className="check-line">
          <input type="checkbox" checked={spec.bold} onChange={(event) => onPatch({ bold: event.target.checked })} />
          <span>Полужирный</span>
        </label>
        <label className="check-line">
          <input type="checkbox" checked={spec.italic} onChange={(event) => onPatch({ italic: event.target.checked })} />
          <span>Курсив</span>
        </label>
      </div>
      <div className="property-grid two-columns">
        <TextNumber label="Обводка" value={spec.strokeWidth} min={0} max={24} step={1} suffix="px"
          onCommit={(strokeWidth) => onPatch({ strokeWidth })} />
        <label className="number-field">
          <span className="number-label">Цвет обводки</span>
          <div><input type="color" value={spec.strokeColor} onChange={(event) => onPatch({ strokeColor: event.target.value })} /></div>
        </label>
      </div>
    </>
  );
}

/**
 * Пресет поведения в духе PNGTuber: ползунки вместо формул. Каждое изменение
 * переписывает блок в скрипте объекта, поэтому вкладка «Объект» всегда
 * показывает, что именно считается.
 */
export function BehaviourPanel({ object, selection, onChange, onText, onColors, modules }: BehaviourPanelProps) {
  const behaviour = useMemo(
    () => (object ? readBehaviour(object.script) : { ...DEFAULT_BEHAVIOUR }),
    [object?.script],
  );

  // Предупреждение о пропавшем модуле можно закрыть: оно объясняет, почему
  // часть полей исчезла, но не должно висеть поверх работы, когда человек и
  // так всё понял.
  const [dismissed, setDismissed] = useState(false);

  // Кому пишем правку: всё выделение. Значения в панели — по основному объекту,
  // у остальных меняется только то поле, которое тронули, остальное своё.
  const targets = useMemo(
    () => (selection && selection.length ? selection : object ? [object] : []),
    [selection, object],
  );

  if (!object || !targets.length) {
    return <div className="empty-state behaviour-empty"><Spline size={24} /><p>Выберите объект или несколько: пресет поведения пишется в скрипт каждого</p></div>;
  }

  /**
   * Правка поведения.
   *
   * Заодно дописывается имя модуля, если его ещё нет: блок без имени не знает,
   * чей вход читать, а модуль в пресете уже есть. Пока блок не нужен, имя
   * никуда не сохраняется — `writeBehaviour` просто удаляет пустой блок.
   */
  const patch = (next: Partial<Behaviour>) => {
    const filled: Partial<Behaviour> = { ...next };
    if (voiceModules.length && behaviour.voiceModule === "") filled.voiceModule = voiceModules[0].name;
    if (eyeModules.length && behaviour.eyeModule === "") filled.eyeModule = eyeModules[0].name;
    onChange(writeBehaviourFor(targets, object, filled));
  };

  const reset = () => onChange(resetBehaviourFor(targets));

  const heavy = heavyAngle(object.pivot);

  /** Задаваемые цвета объекта: у света, фигуры, текста и материала они разные. */
  const colorFields = colorFieldsOf(object);
  /**
   * Все источники цвета: каналы модуля «Цвет» и точки «Света из экрана».
   *
   * Для света это одно и то же — «взять готовый цвет по имени», поэтому и
   * список общий: свет не должен знать, палитра это или кусок чужого окна.
   */
  const colourChannels = (modules ?? [])
    .filter((module) => module.enabled)
    .flatMap((module) => {
      const kind = moduleDefinition(module.type).kind;
      if (kind === "color") {
        return colorChannels(module).map((channel) => ({
          key: `${module.name}.${channel.name}`,
          label: `${module.name} → ${channel.label}`,
        }));
      }
      if (kind === "ambient") {
        return ambientPoints(module).map((point) => ({
          key: `${module.name}.${point.name}`,
          label: `${module.name} → ${point.label}`,
        }));
      }
      return [];
    });

  /**
   * Привязка цвета. Пустое значение — «свой цвет»: ключ удаляется, а не
   * записывается пустым, иначе в пресете остался бы мусор, а объект выглядел бы
   * привязанным к несуществующему каналу.
   */
  const setColour = (field: ColorField, value: string, alpha?: boolean) => {
    if (!onColors) return;
    const updates = targets
      .filter((item) => colorFieldsOf(item).includes(field))
      .map((item) => {
        const colors = { ...(item.colors ?? {}) };
        if (!value) delete colors[field];
        else {
          const [moduleName, channel] = value.split(".");
          const link: ColorLink = { module: moduleName, channel };
          if (alpha) link.alpha = true;
          colors[field] = link;
        }
        return { ...item, colors: Object.keys(colors).length ? colors : undefined };
      });
    if (updates.length) onColors(updates);
  };

  /**
   * Модули мыши пресета: из них берётся имя входа для формул.
   *
   * Следование включается именем модуля: без модуля в пресете входа `mouse.x`
   * нет, и ядро писало бы «неизвестное имя». Если модуль убрали после
   * включения, секция показывает предупреждение и выключает следование одним
   * нажатием — молча оставлять сломанную формулу нельзя.
   */
  const mouseModules = (modules ?? []).filter((module) => module.type === "mouse");
  const followModule = behaviour.followMouseModule;
  const followMissing = followModule !== "" && !mouseModules.some((module) => module.name === followModule);

  /**
   * Модули, без которых часть вкладки не имеет смысла.
   *
   * Правило одно для всей панели: **секция живёт, пока в пресете есть её
   * модуль**. Микрофон даёт речь (рот, сквош, подпрыгивание, доворот) и
   * моргание даёт глаз. Нет модуля — нет и полей: пустые ползунки, которые
   * ничего не двигают, только путают. Настройки при этом остаются в блоке
   * `@behaviour`, поэтому возврат модуля оживляет всё как было.
   *
   * Имена берутся не жёсткие: `mic` и `auto` — лишь имена по умолчанию в
   * новом пресете. Пересозданный микрофон получает имя `loudness`, и формулы
   * должны поехать за ним, а не сломаться.
   */
  const voiceModules = (modules ?? []).filter((module) => module.type === "loudness");
  const eyeModules = (modules ?? []).filter((module) => module.type === "autoblink");
  const hasVoice = voiceModules.length > 0;
  const hasEye = eyeModules.length > 0;
  /**
   * Вывод выбранного модуля моргания. У модуля их может быть несколько — «глаз»
   * не обязан быть первым, поэтому имя входа хранится в поведении, а панель
   * показывает выбор. Пропавшее имя не ломает формулу: берём то, что модуль
   * отдаёт по умолчанию.
   */
  const eyeModuleInstance = eyeModules.find((item) => item.name === (behaviour.eyeModule || eyeModules[0]?.name));
  const eyeOutputs = eyeModuleInstance ? autoBlinkOutputs(eyeModuleInstance) : [];
  const eyeInput = eyeOutputs.some((output) => output.name === behaviour.eyeInput)
    ? behaviour.eyeInput
    : eyeModuleInstance ? autoBlinkEyeInput(eyeModuleInstance) : "blink";

  /** Настройки речи и глаза, которые сейчас некуда приложить. */
  const speechSet = behaviour.squash !== 0 || behaviour.bounce > 0 || behaviour.dragAngle > 0;
  const missingVoice = hasVoice ? "" : speechSet ? "речь" : "";
  const missingEye = hasEye ? "" : behaviour.eye !== "none" ? "глаз" : "";
  const missingMouth = hasVoice ? "" : behaviour.mouth !== "none" ? "рот" : "";
  const missing = [missingMouth, missingVoice, missingEye].filter(Boolean);

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

      {missing.length > 0 && !dismissed && (
        <div className="behaviour-banner">
          <p>
            <b>Часть настроек сохранена, но не действует:</b>{" "}
            {missing.join(", ")} — в пресете нет нужного модуля, поэтому формулы не
            пишутся. Числа остались в блоке поведения и оживут, когда модуль вернётся:
            добавьте {missing.includes("глаз") ? "«AutoBlink»" : "«Loudness»"} во вкладке «Модули».
          </p>
          <button className="icon-button" title="Скрыть предупреждение" onClick={() => setDismissed(true)}>
            <X size={14} />
          </button>
        </div>
      )}

      {object.kind === "text" && (
        <section className="behaviour-section behaviour-text-section">
          <TextSettings
            spec={normalizeText(object.text)}
            onPatch={(patch) => {
              if (!onText) return;
              // Правка уходит всем выделенным текстовым объектам: у спрайтов
              // текста нет, их не трогаем.
              const updates = targets
                .filter((item) => item.kind === "text")
                .map((item) => ({ ...item, text: { ...normalizeText(item.text), ...patch } }));
              if (updates.length) onText(updates);
            }}
          />
        </section>
      )}

      {colorFields.length > 0 && (
        <section className="behaviour-section colour-section">
          <div className="section-title"><span><Palette size={13} /> Цвет</span><small>ИЗ МОДУЛЯ</small></div>
          <p className="behaviour-hint">
            Каждый цвет можно взять из модуля: «Цвет» даёт палитру и режим, «Свет из экрана» —
            средний цвет участка картинки. Объект только берёт готовый цвет, «свой цвет» — как раньше.
          </p>
          {!colourChannels.length && (
            <p className="behaviour-hint">
              Модулей с цветом в пресете нет: добавьте «Цвет» или «Свет из экрана» во вкладке
              «Модули», и здесь появятся их каналы и точки.
            </p>
          )}
          {colorFields.map((field) => {
            const link = object.colors?.[field];
            const key = link ? `${link.module}.${link.channel}` : "";
            const missing = !!link && !colourChannels.some((item) => item.key === key);
            return (
              <div className="colour-row" key={field}>
                <span className="colour-row-label">{COLOR_FIELD_LABEL[field]}</span>
                <span
                  className="colour-swatch"
                  title="Свой цвет объекта: он останется, если модуль пропадёт"
                  style={{ background: ownColorOf(object, field) ?? "transparent" }}
                />
                <select
                  value={key}
                  title="Откуда брать этот цвет"
                  onChange={(event) => setColour(field, event.target.value)}
                >
                  <option value="">свой цвет</option>
                  {colourChannels.map((channel) => (
                    <option key={channel.key} value={channel.key}>{channel.label}</option>
                  ))}
                </select>
                {link && (
                  <label className="check-line" title="Брать из канала и прозрачность. По умолчанию альфа своя: у света на ней держится мягкий край">
                    <input
                      type="checkbox"
                      checked={link.alpha === true}
                      onChange={(event) => setColour(field, key, event.target.checked)}
                    />
                    <span>α</span>
                  </label>
                )}
                {missing && <p className="inline-error">Модуль или канал пропал — рисуется свой цвет.</p>}
              </div>
            );
          })}
        </section>
      )}

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
        {hasVoice ? (
          <>
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
            <ModulePicker
              label="Микрофон"
              modules={voiceModules}
              value={behaviour.voiceModule}
              onPick={(voiceModule) => patch({ voiceModule })}
            />
          </>
        ) : null}
      </section>

      <section className="behaviour-section">
        <div className="section-title"><span><RotateCw size={13} /> Доворот и пределы</span></div>
        {hasVoice && (
          <>
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
          </>
        )}
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
        <div className="section-title">
          <span><MousePointer2 size={13} /> Следование за мышью</span>
          <Switch
            checked={followModule !== "" && !followMissing}
            onChange={(on) => patch({ followMouseModule: on ? (mouseModules[0]?.name ?? "") : "" })}
            title={mouseModules.length ? "Объект тянется за курсором" : "Сначала добавьте модуль «Mouse» во вкладке «Модули»"}
          />
        </div>
        <p className="behaviour-hint">
          Объект тянется к курсору и не уходит дальше заданного предела. Середина области —
          положение покоя: смещение считается от неё, поэтому «мёртвая зона» гасит дрожание
          мыши рядом с центром.
        </p>
        {mouseModules.length === 0 && (
          <p className="behaviour-hint behaviour-warning">
            Модуль мыши не добавлен: во вкладке «Модули» выберите «Mouse». Без него входов
            <code> mouse.x</code> и <code>mouse.y</code> в скрипте нет.
          </p>
        )}
        {followMissing && (
          <p className="behaviour-hint behaviour-warning">
            Модуль «{followModule}» больше не в пресете — формулы ссылаются на несуществующий вход.
            {" "}
            <button className="link-button" onClick={() => patch({ followMouseModule: "" })}>Выключить следование</button>
          </p>
        )}
        {followModule !== "" && !followMissing && (
          <>
            <div className="segmented small inline" title="Форма предела: эллипс или прямоугольник">
              <button
                className={behaviour.followMouseLimit === "ellipse" ? "active" : ""}
                title="Объект обходит эллипс: ширина и высота задают его размер целиком"
                onClick={() => patch({ followMouseLimit: "ellipse" })}
              >эллипс</button>
              <button
                className={behaviour.followMouseLimit === "rect" ? "active" : ""}
                title="Свой предел по каждой оси: можно разрешить движение только вбок"
                onClick={() => patch({ followMouseLimit: "rect" })}
              >прямоугольник</button>
            </div>
            <Row label="Сила" hint="доля пути к курсору" unit="%" value={Math.round(behaviour.followMouseStrength * 100)}
              min={0} max={100} step={1} onCommit={(value) => patch({ followMouseStrength: value / 100 })} />
            <Row
              label="Ширина"
              hint={`полный размер: ±${Math.round(behaviour.followMouseWidth / 2)} от покоя`}
              unit="px"
              value={behaviour.followMouseWidth}
              min={2} max={4000} step={1}
              onCommit={(followMouseWidth) => patch({ followMouseWidth })}
            />
            <Row
              label="Высота"
              hint={`полный размер: ±${Math.round(behaviour.followMouseHeight / 2)} от покоя`}
              unit="px"
              value={behaviour.followMouseHeight}
              min={2} max={4000} step={1}
              onCommit={(followMouseHeight) => patch({ followMouseHeight })}
            />
            <Row label="Мёртвая зона" hint="дрожание рядом с центром" unit="%" value={Math.round(behaviour.followMouseDead * 100)}
              min={0} max={90} step={1} onCommit={(value) => patch({ followMouseDead: value / 100 })} />
            <Row label="Сглаживание положения" hint="0 — мгновенно" unit="мс" value={behaviour.followMouseSmooth}
              min={0} max={1000} step={10} onCommit={(followMouseSmooth) => patch({ followMouseSmooth })} />
            <div className="behaviour-state">
              <span>Тянуться по X<small>выключите — движение останется только по Y</small></span>
              <Switch checked={behaviour.followMouseAxisX} onChange={(followMouseAxisX) => patch({ followMouseAxisX })} title="Следовать по горизонтали" />
            </div>
            <div className="behaviour-state">
              <span>Тянуться по Y<small>выключите — движение останется только по X</small></span>
              <Switch checked={behaviour.followMouseAxisY} onChange={(followMouseAxisY) => patch({ followMouseAxisY })} title="Следовать по вертикали" />
            </div>
            <div className="behaviour-state">
              <span>Инверсия<small>объект уходит от курсора</small></span>
              <Switch checked={behaviour.followMouseInvert} onChange={(followMouseInvert) => patch({ followMouseInvert })} title="Обратное следование: от курсора, а не за ним" />
            </div>

            <div className="section-title follow-subtitle"><span>Доворот за мышью</span><small>ГРАДУСЫ НА КРАЙ</small></div>
            <p className="behaviour-hint">
              Мышь по X поворачивает объект, по Y — наклоняет. Ноль — не поворачивать этой осью.
              Доворот ограничен пределами из секции «Поворот» и сглаживается отдельно от позиции.
            </p>
            <Row label="Поворот по X" hint="край области справа" unit="°" value={behaviour.followMouseRotX}
              min={-180} max={180} step={1} onCommit={(followMouseRotX) => patch({ followMouseRotX })} />
            <Row label="Наклон по Y" hint="край области снизу" unit="°" value={behaviour.followMouseRotY}
              min={-180} max={180} step={1} onCommit={(followMouseRotY) => patch({ followMouseRotY })} />
            <Row label="Сглаживание поворота" hint="0 — мгновенно" unit="мс" value={behaviour.followMouseRotSmooth}
              min={0} max={1000} step={10} onCommit={(followMouseRotSmooth) => patch({ followMouseRotSmooth })} />
            <p className="behaviour-hint">
              {behaviour.rotationalLimitLeft > 0 || behaviour.rotationalLimitRight > 0
                ? `Пределы сустава сейчас ${behaviour.rotationalLimitLeft}° влево и ${behaviour.rotationalLimitRight}° вправо — доворот не выходит за них.`
                : "Пределы сустава не заданы (оба нуля), поэтому доворот ничем не ограничен — задайте их в секции «Поворот»."}
            </p>
          </>
        )}
      </section>

      {object.kind === "light" && (
        <section className="behaviour-section">
          <div className="section-title"><span><Lightbulb size={13} /> Мерцание</span></div>
          <p className="behaviour-hint">
            Яркость пятна считается обычным `opacity`, поэтому мерцание — просто формула.
            Синус даёт ровное «дыхание» лампы, шум — неровное, как у свечи. Форма, радиус и
            цвета пятна остаются во вкладке «Объект».
          </p>
          <div className="segmented small inline" title="Форма волны мерцания">
            <button className={behaviour.flickerStyle === "sine" ? "active" : ""} onClick={() => patch({ flickerStyle: "sine" })}>синус</button>
            <button className={behaviour.flickerStyle === "noise" ? "active" : ""} onClick={() => patch({ flickerStyle: "noise" })}>шум</button>
          </div>
          <Row label="Глубина" hint="0 — ровный свет" unit="%" value={Math.round(behaviour.flickerAmplitude * 100)}
            min={0} max={100} step={1} onCommit={(value) => patch({ flickerAmplitude: value / 100 })} />
          <Row label="Частота" hint="1 Гц — раз в секунду" unit="Гц" value={behaviour.flickerSpeed}
            min={0} max={30} step={0.1} onCommit={(flickerSpeed) => patch({ flickerSpeed: Math.max(0.05, flickerSpeed) })} />
        </section>
      )}

      {(hasVoice || hasEye) && (
        <section className="behaviour-section">
          <div className="section-title"><span><X size={13} /> Видимость</span></div>
          {hasVoice && (
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
          )}
          {hasEye && (
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
          )}
          <ModulePicker
            label="Моргание"
            modules={eyeModules}
            value={behaviour.eyeModule}
            onPick={(eyeModule) => {
              const picked = eyeModules.find((item) => item.name === eyeModule);
              patch({ eyeModule, eyeInput: picked ? autoBlinkEyeInput(picked) : "blink" });
            }}
          />
          {hasEye && eyeOutputs.length > 1 && (
            <label className="module-field">
              <span
                className="module-field-label"
                title="У модуля моргания несколько выводов: какой из них открывает и закрывает глаз"
              >
                Какое моргание
              </span>
              <select value={eyeInput} onChange={(event) => patch({ eyeInput: event.target.value })}>
                {eyeOutputs.map((output) => (
                  <option key={output.name} value={output.name}>{output.label} ({output.name})</option>
                ))}
              </select>
            </label>
          )}
          <p className="behaviour-hint">
            Если заданы оба, условия перемножаются: слой виден, когда верно и то, и другое.
            Входы берутся из своих модулей: речь — из {hasVoice ? `«${behaviour.voiceModule || voiceModules[0].name}»` : "микрофона"},
            моргание — из {hasEye ? `«${behaviour.eyeModule || eyeModules[0].name}» (${eyeInput})` : "модуля моргания"}.
            Строки есть только у тех модулей, что добавлены в пресет.
          </p>
        </section>
      )}

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
                  {hasVoice && (
                    <Row label="Длительность импульса" hint="толчок от речи" unit="мс" value={behaviour.dragImpulse}
                      min={40} max={1500} step={10} onCommit={(dragImpulse) => patch({ dragImpulse })} />
                  )}
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

      <PresetSection behaviour={behaviour} modules={modules ?? []} onPatch={patch} />
    </div>
  );
}

/**
 * Видимость по пресетам: объект выбирает, при каких образах он нужен.
 *
 * Это не отдельный язык: генератор дописывает множитель в ту же строку
 * `visible`, что и рот с глазом, поэтому условия спокойно работают вместе.
 */
function PresetSection({ behaviour, modules, onPatch }: {
  behaviour: Behaviour;
  modules: ModuleInstance[];
  onPatch: (patch: Partial<Behaviour>) => void;
}) {
  const available = presetModules(modules);
  if (!available.length) return null;
  const rules = behaviour.presets;
  const write = (next: PresetRule[]) => onPatch({ presets: next });
  const entriesOf = (moduleName: string) => {
    const module = available.find((entry) => entry.name === moduleName);
    return module ? presetEntries(module) : [];
  };

  return (
    <section className="behaviour-section">
      <div className="section-title"><span><Shirt size={13} /> Пресеты</span></div>
      <p className="behaviour-hint">
        Отметьте пресеты, при которых объект нужен: «только при» показывает его на выбранных
        образах, «кроме» — на всех остальных. Пресеты заводятся во вкладке «Модули», там же
        их можно включить наградой Twitch.
      </p>

      {rules.map((rule, index) => {
        const entries = entriesOf(rule.module);
        const selected = new Set(rule.names);
        return (
          <div className="preset-rule" key={`${rule.module}-${index}`}>
            <div className="preset-rule-head">
              <select
                value={rule.module}
                title="Модуль пресетов"
                onChange={(event) => {
                  const module = available.find((entry) => entry.name === event.target.value);
                  if (!module) return;
                  write(rules.map((item, position) => position === index
                    ? { ...item, module: module.name, variable: presetVariable(module), names: [] }
                    : item));
                }}
              >
                {available.map((module) => <option key={module.name} value={module.name}>{module.name}</option>)}
              </select>
              <button
                className="icon-button danger"
                title="Убрать условие"
                onClick={() => write(rules.filter((_, position) => position !== index))}
              ><Trash2 size={13} /></button>
            </div>

            <div className="segmented small inline">
              <button
                className={rule.mode === "only" ? "active" : ""}
                title="Объект виден только на выбранных пресетах"
                onClick={() => write(rules.map((item, position) => position === index ? { ...item, mode: "only" } : item))}
              >только при</button>
              <button
                className={rule.mode === "except" ? "active" : ""}
                title="Объект виден на всех пресетах, кроме выбранных"
                onClick={() => write(rules.map((item, position) => position === index ? { ...item, mode: "except" } : item))}
              >кроме</button>
            </div>

            <div className="preset-rule-list">
              {entries.map((entry) => (
                <label className="check-line" key={entry.name}>
                  <input
                    type="checkbox"
                    checked={selected.has(entry.name)}
                    onChange={(event) => {
                      const names = event.target.checked
                        ? [...rule.names, entry.name]
                        : rule.names.filter((name) => name !== entry.name);
                      write(rules.map((item, position) => position === index ? { ...item, names } : item));
                    }}
                  />
                  <span>{entry.label}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}

      <button
        className="button secondary"
        title="Добавить условие видимости по пресетам"
        onClick={() => {
          const module = available[0];
          write([...rules, { module: module.name, variable: presetVariable(module), mode: "only", names: [] }]);
        }}
      >
        <Plus size={14} /> Условие по пресетам
      </button>
    </section>
  );
}
