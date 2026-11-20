import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Своё контекстное меню.
 *
 * В приложении ПКМ не должна открывать меню браузера: это редактор, а не
 * страница. Поэтому `contextmenu` гасится глобально (`App.tsx`), а меню
 * рисуем сами — тем же набором действий, что и кнопки панели.
 *
 * Меню живёт в портале на `body`: иначе панель со своей прокруткой обрезала бы
 * его по краю. Позиция прижимается к окну, чтобы у правого и нижнего края меню
 * не уезжало за экран.
 */

export interface ContextMenuItem {
  label: string;
  /** Сочетание клавиш или пояснение справа. */
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  /** Разделитель вместо пункта. */
  rule?: boolean;
  onSelect?: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu(props: ContextMenuProps) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: props.x, top: props.y });

  // Размер известен только после отрисовки: прижимаем к окну вторым шагом.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const left = Math.max(4, Math.min(props.x, window.innerWidth - rect.width - 4));
    const top = Math.max(4, Math.min(props.y, window.innerHeight - rect.height - 4));
    setPlace({ left, top });
  }, [props.x, props.y, props.items]);

  useEffect(() => {
    const close = (event: Event) => {
      if (event.target instanceof Node && box.current?.contains(event.target)) return;
      props.onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    // Ловим на погружении: выделение под меню не должно начаться.
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", props.onClose);
    window.addEventListener("wheel", close, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", props.onClose);
      window.removeEventListener("wheel", close, true);
    };
  }, [props]);

  return createPortal(
    <div
      ref={box}
      className="context-menu"
      style={{ left: place.left, top: place.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {props.items.map((item, index) => (
        item.rule ? <div key={`rule-${index}`} className="context-rule" /> : (
          <button
            key={`${item.label}-${index}`}
            className={`context-item ${item.danger ? "danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              props.onClose();
              item.onSelect?.();
            }}
          >
            <span>{item.label}</span>
            {item.hint && <small>{item.hint}</small>}
          </button>
        )
      ))}
    </div>,
    document.body,
  );
}
