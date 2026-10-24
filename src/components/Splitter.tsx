import { useRef } from "react";

interface SplitterProps {
  orientation: "vertical" | "horizontal";
  onDelta: (delta: number) => void;
  onReset: () => void;
  label: string;
}

export function Splitter({ orientation, onDelta, onReset, label }: SplitterProps) {
  const last = useRef(0);
  const dragging = useRef(false);

  return (
    <div
      className={`splitter splitter-${orientation}`}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true;
        last.current = orientation === "vertical" ? event.clientX : event.clientY;
        document.body.classList.add("is-resizing");
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        const current = orientation === "vertical" ? event.clientX : event.clientY;
        const delta = current - last.current;
        last.current = current;
        if (delta !== 0) onDelta(delta);
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        document.body.classList.remove("is-resizing");
      }}
      onPointerCancel={() => {
        dragging.current = false;
        document.body.classList.remove("is-resizing");
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const negative = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
        const positive = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
        if (event.key !== negative && event.key !== positive) return;
        event.preventDefault();
        const step = event.shiftKey ? 32 : 8;
        onDelta(event.key === positive ? step : -step);
      }}
    >
      <span />
    </div>
  );
}
