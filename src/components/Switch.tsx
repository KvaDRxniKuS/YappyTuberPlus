import type { MouseEvent } from "react";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
  /** `tiny` — для чипов входов, `small` — по умолчанию. */
  size?: "tiny" | "small";
  disabled?: boolean;
}

/**
 * Тумблер вместо чекбокса: у него больше площадь нажатия и он читается как
 * состояние, а не как «галочка в форме».
 */
export function Switch(props: SwitchProps) {
  const click = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!props.disabled) props.onChange(!props.checked);
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      className={`switch ${props.size === "tiny" ? "tiny" : "small"} ${props.checked ? "on" : ""}`}
      title={props.title}
      disabled={props.disabled}
      onClick={click}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span />
    </button>
  );
}
