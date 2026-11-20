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
  const [draft, setDraft] = useState(props.value);
  const [open, setOpen] = useState(false);
  /** Что введено для поиска; `null` — поиск пуст, показываем всё. */
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // Вне правки поле показывает то, что записано в блоке.
  useEffect(() => {
    if (!open) setDraft(props.value);
  }, [props.value, open]);

  useEffect(() => {
    if (!props.autoFocus) return;
    setOpen(true);
    setQuery(null);
    input.current?.focus();
  }, [props.autoFocus]);

  const groups = useMemo(() => {
    const needle = (query ?? "").trim().toLowerCase();
    const matches = (item: ParamItem) => !needle
      || item.name.toLowerCase().includes(needle)
      || (item.note ?? "").toLowerCase().includes(needle);
    return props.groups
      .map((group) => ({ ...group, items: group.items.filter(matches) }))
      .filter((group) => group.items.length > 0);
  }, [props.groups, query]);
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const total = props.groups.reduce((sum, group) => sum + group.items.length, 0);

  useEffect(() => { setHighlight(0); }, [query]);

  const commit = (value: string) => {
    if (value !== props.value) props.onChange(value);
  };
  const pick = (name: string) => {
    setDraft(name);
    setOpen(false);
    setQuery(null);
    commit(name);
  };
  const close = () => {
    setOpen(false);
    setQuery(null);
    setDraft(props.value);
  };

  return (
    <div className={`pick ${props.className ?? ""}`} ref={box}>
      <input
        ref={input}
        className="pick-input"
        value={draft}
        placeholder={props.placeholder}
        title={props.title}
        onChange={(event) => {
          setDraft(event.target.value);
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          setQuery(null);
        }}
        onBlur={() => {
          // Клик по варианту гасит фокус раньше, чем сработает выбор.
          window.setTimeout(() => {
            if (!box.current?.contains(document.activeElement)) {
              commit(draft.trim());
              close();
            }
          }, 0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setHighlight((value) => Math.min(flat.length - 1, value + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setHighlight((value) => Math.max(0, value - 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (open && flat[highlight]) pick(flat[highlight].name);
            else {
              commit(draft.trim());
              close();
            }
            input.current?.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
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
                    onClick={() => pick(item.name)}
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
