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
  /** Пересчитать частоту без перезапуска потока (режим «Экран» — частота монитора). */
  settings: () => void;
  /** Сброс таймлайна: следующий кадр считается с `dt = 0`. */
  resetClock: () => void;
  /** Остановка потока и отписка от события кадра. */
  stop: () => void;
}

function reason(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * Частота отрисовки экрана.
 *
 * В режиме «Экран» движок должен тикать с частотой монитора, а не «как можно
 * чаще»: лишние кадры не видно, но каждый из них — это расчёт, JSON, IPC и
 * отрисовка, то есть прямая нагрузка на процессор. В браузере цикл и так идёт
 * по `requestAnimationFrame`, а в приложении частоту задаёт Rust — поэтому
 * частоту экрана измеряем здесь, за полсекунды, и отдаём планировщику.
 */
export async function measureDisplayHz(timeoutMs = 600): Promise<number> {
  if (typeof requestAnimationFrame !== "function") return 60;
  return new Promise((resolve) => {
    let first = 0;
    let count = 0;
    let settled = false;
    const clamp = (hz: number) => Math.min(240, Math.max(30, Math.round(hz)));
    const finish = (hz: number) => {
      if (settled) return;
      settled = true;
      resolve(clamp(hz));
    };
    // Свёрнутое окно не получает rAF — не ждём вечно, берём разумные 60 Гц.
    const timer = setTimeout(() => finish(count > 4 ? (count * 1000) / (performance.now() - first) : 60), timeoutMs);
    const step = (now: number) => {
      if (settled) return;
      if (!first) first = now;
      else count += 1;
      if (count >= 12) {
        clearTimeout(timer);
        finish((count * 1000) / (now - first));
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
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
    // Текст и паспорта входов: без них в нативном режиме не работали бы
    // `twitch.chat.message(-1)` и `twitch.reward.max`.
    texts: options.inputsRef.current.texts,
    meta: options.inputsRef.current.meta,
  });

  let disposed = false;
  let unlisten: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let paused = false;
  // Частота экрана для режима «Экран»: измеряем один раз на запуск.
  const displayHz = options.fpsMode() === "display" ? await measureDisplayHz() : 60;
  const rate = () => options.fpsMode() === "display"
    ? { limited: true, fpsLimit: displayHz }
    : { limited: true, fpsLimit: Math.min(480, Math.max(1, options.fpsLimit())) };

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
    const initial = rate();
    await invoke("rig_schedule_start", {
      handle: options.handle,
      inputs: snapshot(),
      limited: initial.limited,
      fpsLimit: initial.fpsLimit,
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
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // На паузе кадров нет, и отдавать входы некуда: интервал выключается
      // целиком, чтобы окно в простое не тратило процессор на IPC. Продолжение
      // начинается со свежих значений — их отправляет разовый `push`.
      if (!next) {
        push();
        timer = setInterval(push, INPUT_INTERVAL_MS);
      }
      void invoke("rig_schedule_pause", { paused: next }).catch((error: unknown) => options.onError(reason(error)));
    },
    settings() {
      if (disposed) return;
      const next = rate();
      void invoke("rig_schedule_start", {
        handle: options.handle,
        inputs: snapshot(),
        limited: next.limited,
        fpsLimit: next.fpsLimit,
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
