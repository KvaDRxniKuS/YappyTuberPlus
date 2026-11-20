import { useEffect, useMemo, useRef, useState } from "react";
import type { ParamGroup, ParamItem } from "../engine/paramNames";

/**
 * Поле параметра со своим списком.
 *
 * Нативный `<datalist>` не подошёл: браузер показывает его по-своему и на
 * длинном списке (сотни входов трекера, глобальные и свои переменные) легко
 * теряет начало — видно одну подсказку, хотя список полон. Здесь список
 * рисуем сами: он сгруппирован, ищет и по имени, и по подписи, и всегда
 * показывает всё, пока поле пустое.
 *
 * Клавиши:
 * - стрелки — ходят по списку, поле не трогают;
 * - `Tab` — подставляет подсказку в поле и уходит к следующей: список остаётся
 *   открытым, повторное нажатие берёт следующий вариант (перебирать удобно,
 *   не отпуская клавиатуру). Фокус при этом никуда не уезжает;
 * - `Enter` — берёт подсказку и закрывает список;
 * - `Esc` — отмена, возвращается записанное значение.
 *
 * Значение правится черновиком: в скрипт уходит только готовое имя — иначе
 * каждая буква переписывала бы блок состояний недописанным выражением.
 */

interface ParamPickerProps {
  value: string;
  groups: ParamGroup[];
  placeholder?: string;
  title?: string;
  className?: string;
  /** Список открыт при появлении: нужно диалогу замены параметра. */
  autoFocus?: boolean;
  onChange: (value: string) => void;
}

export function ParamPicker(props: ParamPickerProps) {
  // Черновик живёт и в состоянии (перерисовка), и в ref (обработчики читают
  // актуальное значение, не дожидаясь перерисовки).
  const [draft, setDraft] = useState(props.value);
  const draftRef = useRef(props.value);
  const [open, setOpen] = useState(false);
  /** Что набрано для поиска: подсказки фильтруются по нему, а не по черновику. */
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  /** Значение уже отдано родителю: `blur` не должен отправлять старое. */
  const committed = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  const write = (value: string) => {
    draftRef.current = value;
    setDraft(value);
  };

  // Вне правки поле показывает то, что записано в блоке.
  useEffect(() => {
    if (open) return;
    write(props.value);
  }, [props.value, open]);

  useEffect(() => {
    if (!props.autoFocus) return;
    setOpen(true);
    setQuery("");
    input.current?.focus();
  }, [props.autoFocus]);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (item: ParamItem) => !needle
      || item.name.toLowerCase().includes(needle)
      || (item.note ?? "").toLowerCase().includes(needle);
    return props.groups
      .map((group) => ({ ...group, items: group.items.filter(matches) }))
      .filter((group) => group.items.length > 0);
  }, [props.groups, query]);
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const total = props.groups.reduce((sum, group) => sum + group.items.length, 0);

  const commit = (value: string) => {
    committed.current = true;
    if (value !== props.value) props.onChange(value);
  };
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  /** Взять подсказку: `stay` — оставить список открытым (Tab). */
  const take = (item: ParamItem, stay: boolean) => {
    write(item.name);
    if (stay) return;
    commit(item.name);
    close();
  };

  return (
    <div className={`pick ${props.className ?? ""}`}>
      <input
        ref={input}
        className="pick-input"
        value={draft}
        placeholder={props.placeholder}
        title={props.title}
        spellCheck={false}
        onChange={(event) => {
          write(event.target.value);
          setQuery(event.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onFocus={() => {
          setQuery("");
          setHighlight(0);
          setOpen(true);
        }}
        onBlur={() => {
          // Клик по варианту гасит фокус раньше, чем сработает выбор: отдаём
          // значение только если его ещё не отдали.
          window.setTimeout(() => {
            if (!committed.current) commit(draftRef.current.trim());
            committed.current = false;
            close();
          }, 0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            setHighlight((value) => {
              const next = event.key === "ArrowDown" ? value + 1 : value - 1;
              return Math.max(0, Math.min(Math.max(0, flat.length - 1), next));
            });
          } else if (event.key === "Tab") {
            // Tab — тот же перебор, что стрелками, но с подстановкой в поле.
            event.preventDefault();
            if (!open) {
              setQuery(draftRef.current);
              setHighlight(0);
              setOpen(true);
              return;
            }
            const item = flat[highlight];
            if (!item) return;
            take(item, true);
            setHighlight((value) => Math.min(flat.length - 1, value + 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const item = open ? flat[highlight] : undefined;
            if (item) take(item, false);
            else {
              commit(draftRef.current.trim());
              close();
            }
            input.current?.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            committed.current = true;
            write(props.value);
            close();
            input.current?.blur();
          }
        }}
      />
      {open && total > 0 && (
        <div className="pick-list">
          {flat.length === 0 ? (
            <div className="pick-empty">ничего не нашлось — имя можно вписать вручную</div>
          ) : groups.map((group) => (
            <div className="pick-group" key={group.title}>
              <div className="pick-title">{group.title}</div>
              {group.items.map((item) => {
                const index = flat.indexOf(item);
                return (
                  <button
                    type="button"
                    key={`${group.title}-${item.name}`}
                    className={`pick-item ${index === highlight ? "active" : ""}`}
                    // Не даём полю потерять фокус до выбора.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => take(item, false)}
                  >
                    <span>{item.name}</span>
                    {item.note && <small>{item.note}</small>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
