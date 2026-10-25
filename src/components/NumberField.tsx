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
