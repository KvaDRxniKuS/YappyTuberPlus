import { useEffect, useRef, useState } from "react";

interface NumberFieldProps {
  value: number;
  /** Применить значение: вызывается по Enter, по уходу фокуса и стрелками. */
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  placeholder?: string;
  title?: string;
  /** Разрешить дробные значения (по умолчанию да, но с запятой тоже). */
  integer?: boolean;
  disabled?: boolean;
}

/**
 * Числовое поле, которое не мешает печатать.
 *
 * Обычный `input` с ограничением на каждом нажатии ломает ввод: в поле с
 * максимумом 1 двойка не набирается («1» уже обрезается до «1»), а «0.5»
 * превращается в «5», потому что запятая и точка теряются. Поэтому здесь
 * хранится черновик строки, а число применяется, когда человек закончил:
 * Enter или уход фокуса. Ограничения (минимум, максимум, шаг) применяются
 * ровно в этот момент.
 */
export function NumberField(props: NumberFieldProps) {
  const { value, onCommit, min, max, step, integer } = props;
  const [draft, setDraft] = useState(() => format(value));
  const focused = useRef(false);

  // Пока в поле печатают, внешние изменения не должны перебивать ввод.
  useEffect(() => {
    if (!focused.current) setDraft(format(value));
  }, [value]);

  const commit = () => {
    const parsed = parse(draft, integer);
    if (parsed === null) {
      setDraft(format(value));
      return;
    }
    const clamped = clamp(parsed, min, max);
    // Возвращаем к формату текущего значения: «12.» превращается в «12».
    setDraft(format(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  const nudge = (direction: 1 | -1) => {
    const base = parse(draft, integer) ?? value;
    const size = step && Number.isFinite(step) && step > 0 ? step : 1;
    const next = clamp(base + direction * size, min, max);
    setDraft(format(next));
    if (next !== value) onCommit(next);
  };

  return (
    <input
      className={props.className ?? "module-field-number"}
      type="number"
      inputMode={integer ? "numeric" : "decimal"}
      min={min}
      max={max}
      step={step ?? (integer ? 1 : "any")}
      value={draft}
      placeholder={props.placeholder}
      title={props.title}
      disabled={props.disabled}
      onFocus={() => { focused.current = true; }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => { focused.current = false; commit(); }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(format(value));
          event.currentTarget.blur();
        }
        // Стрелки остаются нативными, но применяем сразу: иначе браузер
        // поменяет черновик, а значение уедет только после Enter.
        if (event.key === "ArrowUp") { event.preventDefault(); nudge(1); }
        if (event.key === "ArrowDown") { event.preventDefault(); nudge(-1); }
      }}
    />
  );
}

/** Число из текста: понимает и запятую, и точку, и пустую строку. */
function parse(text: string, integer?: boolean): number | null {
  const normalized = text.trim().replace(",", ".");
  if (normalized === "") return 0;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return integer ? Math.round(parsed) : parsed;
}

function clamp(value: number, min?: number, max?: number): number {
  let result = value;
  if (min !== undefined) result = Math.max(min, result);
  if (max !== undefined) result = Math.min(max, result);
  return result;
}

/** Показываем аккуратно: без «0.30000000000000004» и без лишнего нуля. */
function format(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Number(value.toFixed(6)));
}

/**
 * Числовое поле с подписью и шагом.
 *
 * Шаг запоминается по подписи: один раз выставили «0.1» для угла — и он
 * остаётся таким при следующем открытии. Компонент живёт здесь, а не в
 * инспекторе, потому что им пользуются уже несколько вкладок (объект, фигура).
 */
const STEP_KEY = "yappytuber.inspector-steps";

function readSteps(): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STEP_KEY) || "{}");
    return raw && typeof raw === "object" ? raw as Record<string, number> : {};
  } catch {
    return {};
  }
}

function savedStep(label: string, fallback: number): number {
  const value = readSteps()[label];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function saveStep(label: string, value: number): void {
  try {
    localStorage.setItem(STEP_KEY, JSON.stringify({ ...readSteps(), [label]: value }));
  } catch {
    // Приватный режим: шаг просто не запомнится.
  }
}

/** `0.1` вместо `0.10000000000000001`. */
const formatStep = (value: number) => String(Number(value.toFixed(4)));

export function LabeledNumberField({ label, value, step = 1, onCommit, suffix, className }: {
  label: string; value: number; step?: number; suffix?: string; onCommit: (value: number) => void;
  /** Дополнительный класс: им поле ставится на нужное место в сетке. */
  className?: string;
}) {
  const [draft, setDraft] = useState(String(Number(value.toFixed(4))));
  const [focused, setFocused] = useState(false);
  // Шаг правки: по умолчанию из разметки, но его можно вписать руками —
  // иначе угол приходилось бы доводить по 0.1° сотнями кликов.
  const [unit, setUnit] = useState(() => savedStep(label, step));
  const [stepDraft, setStepDraft] = useState<string | null>(null);
  useEffect(() => { if (!focused) setDraft(String(Number(value.toFixed(4)))); }, [value, focused]);
  const commit = () => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) onCommit(parsed);
    else setDraft(String(value));
  };
  // Стрелки горизонтальные и свои: нативные спиннеры мелкие и стоят столбиком.
  const nudge = (direction: -1 | 1) => {
    const next = Number((value + direction * unit).toFixed(4));
    setDraft(String(Number(next.toFixed(4))));
    onCommit(next);
  };
  const commitStep = () => {
    const parsed = Number((stepDraft ?? "").replace(",", "."));
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1000) {
      setUnit(parsed);
      saveStep(label, parsed);
    }
    setStepDraft(null);
  };
  return (
    <label className={`number-field ${className ?? ""}`.trim()}>
      <span className="number-label">{label}</span>
      <div className="number-stepper">
        <input
          type="number" value={draft} step={unit}
          onFocus={() => setFocused(true)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => { setFocused(false); commit(); }}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        />{suffix && <em>{suffix}</em>}
        <button
          type="button" className="step-button" title={`${label}: −${formatStep(unit)}`}
          onClick={(event) => { event.preventDefault(); nudge(-1); }}
        >−</button>
        {/* Шаг стоит между кнопками: видно, на сколько сдвинет каждое нажатие. */}
        {stepDraft === null ? (
          <button
            type="button" className="step-chip"
            title={`Шаг изменения: ${formatStep(unit)}. Нажмите и введите своё число`}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); setStepDraft(formatStep(unit)); }}
          >
            {formatStep(unit)}
          </button>
        ) : (
          <input
            className="step-input" type="number" min="0.001" max="1000" step="any" autoFocus
            value={stepDraft} title="Шаг изменения: Enter — применить, Escape — отменить"
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setStepDraft(event.target.value)}
            onBlur={commitStep}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setStepDraft(null);
            }}
          />
        )}
        <button
          type="button" className="step-button" title={`${label}: +${formatStep(unit)}`}
          onClick={(event) => { event.preventDefault(); nudge(1); }}
        >+</button>
      </div>
    </label>
  );
}
