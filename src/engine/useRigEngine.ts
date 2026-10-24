import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { InputValues, RigFrame, RigPreset } from "../types";
import { baseStructure, baseUpdates, engineStructure } from "./preset";
import { getEngineBackend, type EngineBackend } from "./backend";
import { neutralFrame, prepareFrame } from "./frame";

export type EngineStatus = "loading" | "ready" | "error";

export function useRigEngine(
  preset: RigPreset,
  inputsRef: RefObject<InputValues>,
  paused: boolean,
  frameSinkRef?: RefObject<((frame: RigFrame) => void) | null>,
) {
  const [backend, setBackend] = useState<EngineBackend | null>(null);
  const [status, setStatus] = useState<EngineStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  // Смена эпохи пересоздаёт движок: это сбрасывает состояние smooth/spring/autoblink.
  const [epoch, setEpoch] = useState(0);
  const [actualFps, setActualFps] = useState(0);
  const [snapshot, setSnapshot] = useState<RigFrame | null>(null);
  const frameRef = useRef<RigFrame | null>(null);
  const handleRef = useRef<number | null>(null);
  const presetRef = useRef(preset);
  const pausedRef = useRef(paused);
  const resetClockRef = useRef(true);
  const structureKey = engineStructure(preset);
  const basesKey = baseStructure(preset);
  presetRef.current = preset;
  pausedRef.current = paused;

  useEffect(() => {
    let active = true;
    getEngineBackend().then((value) => {
      if (active) setBackend(value);
    }).catch((reason: unknown) => {
      if (!active) return;
      setStatus("error");
      setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!backend) return;
    let active = true;
    let ownHandle: number | null = null;
    setStatus("loading");
    setError(null);
    const current = presetRef.current;
    const config = {
      canvas: current.canvas,
      globals: current.globals,
      objects: current.objects.map((object) => ({ ...object, image: null })),
    };
    backend.call({ op: "create", config }).then(async (response) => {
      if (!response.ok || response.handle === undefined) {
        throw new Error(response.error || "Не удалось создать движок");
      }
      ownHandle = response.handle;
      if (!active) {
        void backend.call({ op: "dispose", handle: response.handle });
        return;
      }
      const previous = handleRef.current;
      handleRef.current = response.handle;
      resetClockRef.current = true;
      await backend.call({ op: "updateBase", handle: response.handle, bases: baseUpdates(presetRef.current) });
      if (previous !== null && previous !== response.handle) {
        void backend.call({ op: "dispose", handle: previous });
      }
      setStatus("ready");
    }).catch((reason: unknown) => {
      if (!active) return;
      setStatus("error");
      setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      active = false;
      if (ownHandle !== null && handleRef.current === ownHandle) handleRef.current = null;
      if (ownHandle !== null) void backend.call({ op: "dispose", handle: ownHandle });
    };
    // structureKey intentionally controls recompilation; base-only edits preserve state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, structureKey, epoch]);

  useEffect(() => {
    if (!backend || handleRef.current === null) return;
    void backend.call({ op: "updateBase", handle: handleRef.current, bases: baseUpdates(preset) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, basesKey]);

  useEffect(() => {
    resetClockRef.current = true;
  }, [paused]);

  useEffect(() => {
    if (!backend) return;
    let animation = 0;
    let nextDue = 0;
    let inFlight = false;
    let disposed = false;
    let frames = 0;
    let fpsWindowStart = performance.now();
    let lastSnapshot = 0;

    const loop = (nowMs: number) => {
      const handle = handleRef.current;
      const limited = presetRef.current.runtime.fpsMode === "limited";
      const limit = presetRef.current.runtime.fpsLimit;
      const interval = 1000 / limit;
      if (nextDue === 0) nextDue = nowMs;
      const due = !limited || nowMs + 0.15 >= nextDue;
      if (!pausedRef.current && handle !== null && due && !inFlight) {
        if (limited) {
          nextDue += interval;
          if (nowMs - nextDue > interval) nextDue = nowMs + interval;
        } else {
          nextDue = nowMs;
        }
        inFlight = true;
        const resetClock = resetClockRef.current;
        resetClockRef.current = false;
        backend.call({
          op: "tick",
          handle,
          now: nowMs / 1000,
          inputs: inputsRef.current,
          paused: false,
          resetClock,
        }).then((response) => {
          if (disposed) return;
          if (!response.ok || !response.frame) {
            setStatus("error");
            setError(response.error || "Ошибка кадра");
            return;
          }
          const gated = prepareFrame(presetRef.current, response.frame);
          frameRef.current = gated;
          frameSinkRef?.current?.(gated);
          frames += 1;
          if (nowMs - lastSnapshot > 120 || gated.diagnostics.length > 0) {
            lastSnapshot = nowMs;
            setSnapshot(gated);
          }
          if (nowMs - fpsWindowStart >= 1000) {
            setActualFps(Math.round(frames * 1000 / (nowMs - fpsWindowStart)));
            frames = 0;
            fpsWindowStart = nowMs;
          }
        }).catch((reason: unknown) => {
          if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
        }).finally(() => { inFlight = false; });
      }
      if (limited && nowMs < nextDue - interval * 2) nextDue = nowMs;
      animation = requestAnimationFrame(loop);
    };
    animation = requestAnimationFrame(loop);
    return () => {
      disposed = true;
      cancelAnimationFrame(animation);
    };
  }, [backend, inputsRef]);

  /**
   * Полный сброс таймлайна: новый движок, чистое состояние, время с нуля.
   * Кадр при этом не обнуляется, а становится нейтральным — иначе сцена теряет
   * иерархию видимости и выключенные группы снова показывались бы.
   */
  const resetTimeline = useCallback(() => {
    const neutral = neutralFrame(presetRef.current);
    frameRef.current = neutral;
    setSnapshot(neutral);
    resetClockRef.current = true;
    setEpoch((value) => value + 1);
  }, []);

  return {
    frameRef,
    snapshot,
    status,
    error,
    actualFps,
    backendLabel: backend?.label || "Rust · загрузка",
    resetTimeline,
  };
}
