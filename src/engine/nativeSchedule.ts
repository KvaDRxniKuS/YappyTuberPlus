import type { InputValues } from "../types";
import type { EngineResponse } from "./backend";

/**
 * Кадры считает Rust-планировщик (нативное приложение).
 *
 * Раньше цикл жил в окне редактора: `requestAnimationFrame` останавливается,
 * когда окно свёрнуто или вкладка скрыта, и оверлей замирал вместе с ним. Здесь
 * поток кадров запускается в Rust и от видимости окна не зависит, а окно только
 * присылает свежие входы и принимает готовые кадры событием `rig://frame`.
 *
 * Входы по-прежнему собирает фронтенд (микрофон, клавиатура, мышь) — нативный
 * аудиозахват это отдельный шаг. Если команда недоступна (старая сборка,
 * браузер), `start` возвращает `null`, и вызывающий код остаётся на
 * `requestAnimationFrame`.
 */

export const FRAME_EVENT = "rig://frame";
/** Входы уходят пачкой: чаще кадра всё равно не меняются. */
const INPUT_INTERVAL_MS = 33;
const INPUT_INTERVAL_PAUSED_MS = 120;

export interface NativeScheduleOptions {
  handle: number;
  inputsRef: { current: InputValues };
  fpsMode: () => "limited" | "display";
  fpsLimit: () => number;
  onFrame: (response: EngineResponse) => void;
  onError: (message: string) => void;
}

export interface NativeSchedule {
  /** Пауза: поток перестаёт считать кадры, время после неё начинается заново. */
  pause: (paused: boolean) => void;
  /** Смена лимитера FPS без перезапуска потока. */
  settings: (limited: boolean, fpsLimit: number) => void;
  /** Сброс таймлайна: следующий кадр считается с `dt = 0`. */
  resetClock: () => void;
  /** Остановка потока и отписка от события кадра. */
  stop: () => void;
}

function reason(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export async function startNativeSchedule(options: NativeScheduleOptions): Promise<NativeSchedule | null> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  let invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  let listen: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
  try {
    const core = await import("@tauri-apps/api/core");
    const events = await import("@tauri-apps/api/event");
    invoke = core.invoke;
    listen = events.listen as unknown as typeof listen;
  } catch (error) {
    options.onError(reason(error));
    return null;
  }

  const snapshot = () => ({
    values: { ...options.inputsRef.current.values },
    signals: { ...(options.inputsRef.current.signals ?? {}) },
  });

  let disposed = false;
  let unlisten: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let paused = false;

  try {
    unlisten = await listen<string | EngineResponse>(FRAME_EVENT, (event) => {
      if (disposed) return;
      const payload = event.payload;
      if (typeof payload === "string") {
        try {
          options.onFrame(JSON.parse(payload) as EngineResponse);
        } catch {
          options.onError("планировщик вернул некорректный кадр");
        }
        return;
      }
      options.onFrame(payload);
    });
    await invoke("rig_schedule_start", {
      handle: options.handle,
      inputs: snapshot(),
      limited: options.fpsMode() === "limited",
      fpsLimit: options.fpsLimit(),
    });
  } catch (error) {
    unlisten?.();
    options.onError(reason(error));
    return null;
  }

  const push = () => {
    if (disposed) return;
    void invoke("rig_schedule_inputs", { inputs: snapshot() }).catch(() => undefined);
  };
  timer = setInterval(push, INPUT_INTERVAL_MS);

  return {
    pause(next: boolean) {
      if (disposed || paused === next) return;
      paused = next;
      if (timer) clearInterval(timer);
      // На паузе входы всё равно обновляем, чтобы продолжение началось с живых
      // значений, но реже: кадров нет, спешить некуда.
      timer = setInterval(push, next ? INPUT_INTERVAL_PAUSED_MS : INPUT_INTERVAL_MS);
      void invoke("rig_schedule_pause", { paused: next }).catch((error: unknown) => options.onError(reason(error)));
    },
    settings(limited: boolean, fpsLimit: number) {
      if (disposed) return;
      void invoke("rig_schedule_start", {
        handle: options.handle,
        inputs: snapshot(),
        limited,
        fpsLimit,
      }).catch((error: unknown) => options.onError(reason(error)));
    },
    resetClock() {
      void invoke("rig_schedule_reset_clock").catch(() => undefined);
    },
    stop() {
      if (disposed) return;
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
      unlisten?.();
      unlisten = null;
      // Ручка в остановке: при смене структуры новый движок может подняться
      // раньше, чем долетит остановка старого.
      void invoke("rig_schedule_stop", { handle: options.handle }).catch(() => undefined);
    },
  };
}
