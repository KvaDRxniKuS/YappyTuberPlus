import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InputValues, ModuleInstance } from "../types";
import { AudioInputEngine, type AudioFrame, type DeviceOption } from "../modules/audio";
import { moduleDefinition } from "../modules/registry";
import { composeValues } from "../modules/values";

export interface ModuleInputsApi {
  /** Готовый набор для ядра: `mic.talking`, `manual.blink` и прочие входы. */
  inputs: InputValues;
  audio: Record<string, AudioFrame>;
  manual: Record<string, number>;
  devices: DeviceOption[];
  /** Звук включён пользователем (жест был, разрешение запрошено). */
  active: boolean;
  error: string | null;
  contextState: string;
  start: () => Promise<void>;
  stop: () => void;
  setManual: (key: string, value: number) => void;
  pulse: (key: string, durationMs?: number) => void;
  refreshDevices: () => Promise<void>;
}

/**
 * Связывает модули с ядром. Живые модули получают значения из аудио,
 * ручные — из ползунков; всё сводится в плоский словарь `<имя>.<вход>`.
 */
export function useModuleInputs(modules: ModuleInstance[]): ModuleInputsApi {
  const engineRef = useRef<AudioInputEngine | null>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audio, setAudio] = useState<Record<string, AudioFrame>>({});
  const [manual, setManualValues] = useState<Record<string, number>>({});
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [contextState, setContextState] = useState("closed");
  const pulseTimers = useRef(new Map<string, number>());

  const engine = useCallback(() => {
    if (!engineRef.current) engineRef.current = new AudioInputEngine();
    return engineRef.current;
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await engine().listDevices());
    } catch {
      setDevices([]);
    }
  }, [engine]);

  useEffect(() => {
    void refreshDevices();
    const handler = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", handler);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", handler);
  }, [refreshDevices]);

  const liveModules = useMemo(
    () => modules.filter((module) => module.enabled && module.source === "live" && moduleDefinition(module.type).audio),
    [modules],
  );
  const liveKey = JSON.stringify(liveModules.map((module) => [module.name, module.config.deviceId, module.config.processing]));

  /** Пересобирает подключения к микрофонам при смене модулей или устройств. */
  useEffect(() => {
    const current = engineRef.current;
    if (!current) return;
    if (!active) {
      current.stop();
      setContextState(current.state);
      setAudio({});
      return;
    }
    let cancelled = false;
    setError(null);
    void (async () => {
      const wanted = new Set(liveModules.map((module) => module.name));
      for (const name of current.attachedNames()) {
        if (!wanted.has(name)) current.detach(name);
      }
      for (const module of liveModules) {
        if (cancelled) return;
        try {
          await current.attach(module.name, module.config);
        } catch (reason) {
          if (cancelled) return;
          setError(describe(reason));
        }
      }
      if (!cancelled) setContextState(current.state);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, liveKey]);

  useEffect(() => {
    if (!active) return;
    const current = engineRef.current;
    if (current) for (const module of liveModules) current.setSettings(module.name, module.config);
  }, [active, liveModules]);

  useEffect(() => () => {
    for (const timer of pulseTimers.current.values()) window.clearTimeout(timer);
    pulseTimers.current.clear();
    engineRef.current?.dispose();
    engineRef.current = null;
  }, []);

  const start = useCallback(async () => {
    setError(null);
    const current = engine();
    try {
      await current.start((values) => setAudio(values));
      setActive(true);
      setContextState(current.state);
      await refreshDevices();
    } catch (reason) {
      setError(describe(reason));
      setActive(false);
      setContextState(current.state);
    }
  }, [engine, refreshDevices]);

  const stop = useCallback(() => {
    engineRef.current?.stop();
    setActive(false);
    setAudio({});
    setContextState(engineRef.current?.state ?? "closed");
  }, []);

  const setManual = useCallback((key: string, value: number) => {
    setManualValues((current) => ({ ...current, [key]: value }));
  }, []);

  const pulse = useCallback((key: string, durationMs = 160) => {
    setManualValues((current) => ({ ...current, [key]: 1 }));
    const existing = pulseTimers.current.get(key);
    if (existing) window.clearTimeout(existing);
    pulseTimers.current.set(key, window.setTimeout(() => {
      pulseTimers.current.delete(key);
      setManualValues((current) => ({ ...current, [key]: 0 }));
    }, durationMs));
  }, []);

  const inputs = useMemo<InputValues>(() => ({
    values: composeValues(modules, audio, manual),
    signals: {},
  }), [modules, audio, manual]);

  return {
    inputs, audio, manual, devices, active, error, contextState,
    start, stop, setManual, pulse, refreshDevices,
  };
}

function describe(reason: unknown): string {
  if (reason instanceof Error) {
    if (reason.name === "NotAllowedError") return "Доступ к микрофону запрещён: разрешите его в окне приложения и в настройках Windows.";
    if (reason.name === "NotFoundError") return "Микрофон не найден: подключите устройство или выберите другое.";
    if (reason.name === "NotReadableError") return "Микрофон занят другой программой.";
    return reason.message;
  }
  return String(reason);
}
