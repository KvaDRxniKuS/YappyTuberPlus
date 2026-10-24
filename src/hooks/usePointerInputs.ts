import { useEffect, useRef, useState } from "react";
import { EMPTY_POINTER, PointerState, type PointerFrame } from "../modules/pointer";
import { isTauri } from "../engine/presetFile";

/** Кадр значений: 30 раз в секунду хватает, а React не перегружаем. */
const TICK = 33;
/** Позиция окна нужна для глобальных координат и меняется редко. */
const ORIGIN_REFRESH = 600;
const POINTER_EVENT = "yappy://pointer";

interface PointerPayload {
  kind: "key" | "button" | "move" | "wheel";
  code?: string;
  down?: boolean;
  button?: string;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
}

/**
 * Клавиатура и мышь как входы модулей.
 *
 * В браузере события приходят с `window` (работают, пока окно в фокусе). В
 * нативном окне их шлёт глобальный хук Rust (`rdev`), поэтому клавиши ловятся
 * даже когда окно свёрнуто. Логика значений одна и та же — `PointerState`.
 *
 * Пока фокус в поле ввода, клавиши игнорируются: иначе набор текста в скрипте
 * дёргал бы риг.
 */
export function usePointerInputs(active: boolean): PointerFrame {
  const [frame, setFrame] = useState<PointerFrame>(EMPTY_POINTER);
  const stateRef = useRef<PointerState>(new PointerState());
  const originRef = useRef({ x: 0, y: 0, scale: 1 });

  useEffect(() => {
    if (!active) return;
    const state = stateRef.current;
    // При выключении модулей состояние не должно «залипнуть» нажатым.
    return () => {
      state.releaseAll();
      setFrame((current) => (samePointer(current, EMPTY_POINTER) ? current : EMPTY_POINTER));
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const state = stateRef.current;
    const timer = window.setInterval(() => {
      const next = state.snapshot();
      setFrame((current) => (samePointer(current, next) ? current : next));
    }, TICK);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const state = stateRef.current;

    const onKey = (code: string, down: boolean) => {
      if (!code) return;
      // Пока пишут скрипт или имя модуля, клавиши ригу не принадлежат.
      if (isTyping()) return;
      state.key(code, down);
    };
    const onButton = (button: string, down: boolean) => {
      if (button === "left" || button === "right") state.button(button, down);
    };
    const onMove = (x: number, y: number) => {
      const point = scenePoint(x, y);
      state.move(point.x, point.y);
    };
    const onWheel = (delta: number) => state.wheel(delta);
    const onBlur = () => state.releaseAll();

    if (!isTauri()) {
      const keyDown = (event: KeyboardEvent) => onKey(event.code, true);
      const keyUp = (event: KeyboardEvent) => onKey(event.code, false);
      const mouseMove = (event: MouseEvent) => onMove(event.clientX, event.clientY);
      const mouseDown = (event: MouseEvent) => onButton(event.button === 2 ? "right" : event.button === 0 ? "left" : "other", true);
      const mouseUp = (event: MouseEvent) => onButton(event.button === 2 ? "right" : event.button === 0 ? "left" : "other", false);
      const wheel = (event: WheelEvent) => onWheel(event.deltaY);
      window.addEventListener("keydown", keyDown);
      window.addEventListener("keyup", keyUp);
      window.addEventListener("mousemove", mouseMove);
      window.addEventListener("mousedown", mouseDown);
      window.addEventListener("mouseup", mouseUp);
      window.addEventListener("wheel", wheel, { passive: true });
      window.addEventListener("blur", onBlur);
      return () => {
        window.removeEventListener("keydown", keyDown);
        window.removeEventListener("keyup", keyUp);
        window.removeEventListener("mousemove", mouseMove);
        window.removeEventListener("mousedown", mouseDown);
        window.removeEventListener("mouseup", mouseUp);
        window.removeEventListener("wheel", wheel);
        window.removeEventListener("blur", onBlur);
      };
    }

    // --- нативное окно: события от глобального хука -------------------------
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let originTimer = 0;

    const refreshOrigin = async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const [position, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
        if (!disposed) originRef.current = { x: position.x, y: position.y, scale: scale || 1 };
      } catch {
        /* окно ещё не готово — попробуем на следующем тике */
      }
    };

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const stop = await listen<PointerPayload>(POINTER_EVENT, (event) => {
        const payload = event.payload;
        if (!payload || typeof payload.kind !== "string") return;
        if (payload.kind === "key" && typeof payload.code === "string") onKey(payload.code, payload.down === true);
        else if (payload.kind === "button" && typeof payload.button === "string") onButton(payload.button, payload.down === true);
        else if (payload.kind === "wheel" && typeof payload.dy === "number") onWheel(payload.dy);
        else if (payload.kind === "move" && typeof payload.x === "number" && typeof payload.y === "number") {
          // Хук даёт физические пиксели экрана: переводим в CSS-координаты окна.
          const { x, y, scale } = originRef.current;
          onMove((payload.x - x) / scale, (payload.y - y) / scale);
        }
      });
      if (disposed) stop();
      else unlisten = stop;
    })();

    void refreshOrigin();
    originTimer = window.setInterval(() => void refreshOrigin(), ORIGIN_REFRESH);
    window.addEventListener("blur", onBlur);

    return () => {
      disposed = true;
      if (unlisten) unlisten();
      window.clearInterval(originTimer);
      window.removeEventListener("blur", onBlur);
    };
  }, [active]);

  return frame;
}

/** Курсор в долях сцены: 0…1 по видимой области сцены. */
function scenePoint(clientX: number, clientY: number): { x: number; y: number } {
  const rect = document.querySelector<HTMLElement>("[data-scene]")?.getBoundingClientRect();
  const left = rect?.left ?? 0;
  const top = rect?.top ?? 0;
  const width = rect?.width || window.innerWidth || 1;
  const height = rect?.height || window.innerHeight || 1;
  return { x: (clientX - left) / width, y: (clientY - top) / height };
}

function isTyping(): boolean {
  const element = document.activeElement as HTMLElement | null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT";
}

function samePointer(left: PointerFrame, right: PointerFrame): boolean {
  const mouse = left.mouse;
  const next = right.mouse;
  if (mouse.x !== next.x || mouse.y !== next.y) return false;
  if (mouse.dx !== next.dx || mouse.dy !== next.dy) return false;
  if (mouse.left !== next.left || mouse.right !== next.right || mouse.wheel !== next.wheel) return false;
  const leftKeys = Object.keys(left.keys);
  const rightKeys = Object.keys(right.keys);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((code) => {
    const a = left.keys[code];
    const b = right.keys[code];
    return !!b && a.down === b.down && a.hits === b.hits && a.hold === b.hold;
  });
}
