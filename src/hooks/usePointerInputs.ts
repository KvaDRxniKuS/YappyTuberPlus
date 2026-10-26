import { useCallback, useEffect, useRef, useState } from "react";
import {
  EMPTY_POINTER, PointerState, monitorLabel, mouseButtonFromIndex,
  type MonitorOption, type PointerFrame, type ScreenMonitor, type ScreenRect, type ScreenSpace,
} from "../modules/pointer";
import { isTauri } from "../engine/presetFile";

/** Кадр значений: 30 раз в секунду хватает, а React не перегружаем. */
const TICK = 33;
/** Позиция окна и мониторы нужны для координат и меняются редко. */
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

const EMPTY_RECT: ScreenRect = { x: 0, y: 0, width: 0, height: 0, scale: 1 };

/**
 * Клавиатура и мышь как входы модулей.
 *
 * Здесь же живёт геометрия экрана: положение окна, список мониторов и место
 * сцены. Модуль мыши сам выбирает, от чего считать курсор — от окна, от
 * выбранного монитора или от сцены, — но координаты всегда приходят
 * абсолютными пикселями экрана.
 *
 * В браузере события идут с `window` (работают, пока окно в фокусе). В нативном
 * окне их шлёт глобальный хук Rust (`rdev`) в физических пикселях монитора,
 * поэтому клавиши ловятся даже когда окно свёрнуто. Логика значений одна и та
 * же — `PointerState`.
 *
 * Пока фокус в поле ввода, клавиши игнорируются: иначе набор текста в скрипте
 * дёргал бы риг.
 */
export function usePointerInputs(active: boolean): {
  frame: PointerFrame;
  resetHits: () => void;
  /** Мониторы для настроек модуля: номер и подпись. */
  monitors: MonitorOption[];
} {
  const [frame, setFrame] = useState<PointerFrame>(EMPTY_POINTER);
  const [monitors, setMonitors] = useState<MonitorOption[]>([]);
  const stateRef = useRef(new PointerState());
  const screenRef = useRef<ScreenSpace>({ window: EMPTY_RECT, monitors: [], scene: null });

  /** Геометрия экрана на текущий момент: сцена пересчитывается из DOM. */
  const screenNow = useCallback((): ScreenSpace => {
    const base = screenRef.current;
    const element = document.querySelector<HTMLElement>("[data-scene]");
    let scene: ScreenRect | null = null;
    if (element) {
      const rect = element.getBoundingClientRect();
      const scale = base.window.scale || 1;
      // DOM живёт в CSS-пикселях, окно и мониторы — в пикселях экрана.
      scene = {
        x: base.window.x + rect.left * scale,
        y: base.window.y + rect.top * scale,
        width: rect.width * scale,
        height: rect.height * scale,
        scale,
      };
    }
    return { window: base.window, monitors: base.monitors, scene };
  }, []);

  // --- геометрия экрана: окно, мониторы, место сцены -------------------------
  useEffect(() => {
    let disposed = false;
    const apply = (window: ScreenRect, list: ScreenMonitor[]) => {
      if (disposed) return;
      screenRef.current = { window, monitors: list, scene: screenRef.current.scene };
      setMonitors((current) => {
        const next = list.map((monitor) => ({ id: String(monitor.index), label: monitorLabel(monitor) }));
        if (current.length === next.length && current.every((item, index) => item.id === next[index].id && item.label === next[index].label)) {
          return current;
        }
        return next;
      });
    };

    if (isTauri()) {
      const refresh = async () => {
        try {
          const api = await import("@tauri-apps/api/window");
          const win = api.getCurrentWindow();
          const [position, size, scale, list] = await Promise.all([
            win.innerPosition(), win.innerSize(), win.scaleFactor(), api.availableMonitors(),
          ]);
          // Основной монитор помечаем отдельно: по нему выбирается область,
          // если номер из настроек модуля больше не существует.
          let primary: { x: number; y: number } | null = null;
          try {
            const monitor = await api.primaryMonitor();
            primary = monitor ? { x: monitor.position.x, y: monitor.position.y } : null;
          } catch {
            primary = null;
          }
          apply(
            { x: position.x, y: position.y, width: size.width, height: size.height, scale: scale || 1 },
            list.map((monitor, index) => ({
              index,
              name: monitor.name || `Монитор ${index + 1}`,
              x: monitor.position.x,
              y: monitor.position.y,
              width: monitor.size.width,
              height: monitor.size.height,
              scale: monitor.scaleFactor || 1,
              primary: !!primary && primary.x === monitor.position.x && primary.y === monitor.position.y,
            })),
          );
        } catch {
          /* окно ещё не готово — попробуем на следующем тике */
        }
      };
      void refresh();
      const timer = window.setInterval(() => void refresh(), ORIGIN_REFRESH);
      window.addEventListener("focus", refresh);
      window.addEventListener("resize", refresh);
      return () => {
        disposed = true;
        window.clearInterval(timer);
        window.removeEventListener("focus", refresh);
        window.removeEventListener("resize", refresh);
      };
    }

    // Браузер: окно браузера и весь экран. Мониторов в браузере не перечислить,
    // поэтому экран один — для разработки этого достаточно.
    const refresh = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const border = Math.max(0, (window.outerWidth - width) / 2);
      const chrome = Math.max(0, window.outerHeight - height - border);
      apply(
        { x: window.screenX + border, y: window.screenY + chrome, width, height, scale: 1 },
        [{
          index: 0,
          name: "Экран",
          x: 0,
          y: 0,
          width: window.screen.width,
          height: window.screen.height,
          scale: 1,
          primary: true,
        }],
      );
    };
    refresh();
    window.addEventListener("resize", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("resize", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  // --- значения кадра --------------------------------------------------------
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
    let lastScreen = "";
    const timer = window.setInterval(() => {
      const next = state.snapshot();
      const screen = screenNow();
      const key = `${screen.window.x},${screen.window.y},${screen.window.width},${screen.window.height},${screen.scene?.x ?? 0},${screen.scene?.y ?? 0},${screen.scene?.width ?? 0},${screen.scene?.height ?? 0},${screen.monitors.length}`;
      const screenChanged = key !== lastScreen;
      lastScreen = key;
      setFrame((current) => {
        const merged: PointerFrame = { ...next, screen };
        if (!screenChanged && samePointer(current, merged)) return current;
        return merged;
      });
    }, TICK);
    return () => window.clearInterval(timer);
  }, [active, screenNow]);

  useEffect(() => {
    if (!active) return;
    const state = stateRef.current;

    const onKey = (code: string, down: boolean) => {
      if (!code) return;
      // Пока пишут скрипт или имя модуля, клавиши ригу не принадлежат.
      if (isTyping()) return;
      state.key(code, down);
    };
    const onButton = (button: string, down: boolean) => state.button(button, down);
    // Курсор приходит в пикселях экрана: область чтения выбирает модуль.
    const onMove = (x: number, y: number) => state.move(x, y);
    const onWheel = (delta: number) => state.wheel(delta);
    const onBlur = () => state.releaseAll();

    if (!isTauri()) {
      const keyDown = (event: KeyboardEvent) => onKey(event.code, true);
      const keyUp = (event: KeyboardEvent) => onKey(event.code, false);
      const mouseMove = (event: MouseEvent) => onMove(event.screenX, event.screenY);
      const mouseDown = (event: MouseEvent) => onButton(mouseButtonFromIndex(event.button), true);
      const mouseUp = (event: MouseEvent) => onButton(mouseButtonFromIndex(event.button), false);
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

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const stop = await listen<PointerPayload>(POINTER_EVENT, (event) => {
        const payload = event.payload;
        if (!payload || typeof payload.kind !== "string") return;
        if (payload.kind === "key" && typeof payload.code === "string") onKey(payload.code, payload.down === true);
        else if (payload.kind === "button" && typeof payload.button === "string") onButton(payload.button, payload.down === true);
        else if (payload.kind === "wheel" && typeof payload.dy === "number") onWheel(payload.dy);
        else if (payload.kind === "move" && typeof payload.x === "number" && typeof payload.y === "number") {
          // Хук уже даёт физические пиксели экрана — это то, что нужно модулю.
          onMove(payload.x, payload.y);
        }
      });
      if (disposed) stop();
      else unlisten = stop;
    })();

    window.addEventListener("blur", onBlur);

    return () => {
      disposed = true;
      if (unlisten) unlisten();
      window.removeEventListener("blur", onBlur);
    };
  }, [active]);

  /** Стоп анимации: счётчики нажатий обнуляются, состояние клавиш остаётся. */
  const resetHits = useCallback(() => {
    stateRef.current.resetHits();
    setFrame((current) => ({
      ...current,
      keys: Object.fromEntries(Object.entries(current.keys).map(([code, sample]) => [code, { ...sample, hits: 0 }])),
    }));
  }, []);

  return { frame, resetHits, monitors };
}

/**
 * Ждём следующее нажатие кнопки мыши, пока `active`.
 *
 * В браузере это обычный `mousedown` (окно должно быть в фокусе), в нативном —
 * событие глобального хука, поэтому боковые кнопки видно даже когда окно
 * свёрнуто. Пустая строка — отмена (Esc).
 */
export function useMouseButtonCapture(active: boolean, onCapture: (button: string) => void): void {
  const handler = useRef(onCapture);
  handler.current = onCapture;
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const onDown = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      handler.current(mouseButtonFromIndex(event.button));
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      handler.current("");
    };
    window.addEventListener("mousedown", onDown, { capture: true });
    window.addEventListener("keydown", onKey, { capture: true });
    if (isTauri()) {
      void (async () => {
        const { listen } = await import("@tauri-apps/api/event");
        const stop = await listen<PointerPayload>(POINTER_EVENT, (event) => {
          const payload = event.payload;
          if (payload?.kind === "button" && payload.down === true && typeof payload.button === "string") {
            handler.current(payload.button);
          }
        });
        if (disposed) stop();
        else unlisten = stop;
      })();
    }
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("mousedown", onDown, { capture: true });
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [active]);
}

function isTyping(): boolean {
  const element = document.activeElement as HTMLElement | null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT";
}

function sameRect(left: ScreenRect | null, right: ScreenRect | null): boolean {
  if (!left || !right) return left === right;
  return left.x === right.x && left.y === right.y && left.width === right.width
    && left.height === right.height && left.scale === right.scale;
}

function samePointer(left: PointerFrame, right: PointerFrame): boolean {
  const mouse = left.mouse;
  const next = right.mouse;
  if (mouse.screenX !== next.screenX || mouse.screenY !== next.screenY) return false;
  if (mouse.dx !== next.dx || mouse.dy !== next.dy) return false;
  if (mouse.left !== next.left || mouse.right !== next.right || mouse.wheel !== next.wheel) return false;
  if (!sameRect(left.screen?.window ?? null, right.screen?.window ?? null)) return false;
  if (!sameRect(left.screen?.scene ?? null, right.screen?.scene ?? null)) return false;
  if ((left.screen?.monitors.length ?? 0) !== (right.screen?.monitors.length ?? 0)) return false;
  const leftKeys = Object.keys(left.keys);
  const rightKeys = Object.keys(right.keys);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((code) => {
    const a = left.keys[code];
    const b = right.keys[code];
    return !!b && a.down === b.down && a.hits === b.hits && a.hold === b.hold;
  });
}
