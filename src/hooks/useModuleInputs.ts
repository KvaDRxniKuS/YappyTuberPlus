import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InputMark, InputValues, ModuleConfig, ModuleInstance } from "../types";
import { AudioInputEngine, type AudioFrame, type CalibrationFrame, type DeviceOption } from "../modules/audio";
import { inputRange, moduleDefinition } from "../modules/registry";
import { composeValues, inputEnabled, inputKey, inputMeta, inputTexts, isPointerKind } from "../modules/values";
import { usePointerInputs } from "./usePointerInputs";
import type { MonitorOption } from "../modules/pointer";
import { useExternalSource } from "./useExternalSource";
import type { ExternalLogEntry, ExternalStatus, ExternalTextLine } from "../modules/sources";

export interface ModuleInputsApi {
  /** Готовый набор для ядра: `mic.talking`, `blink.blink`, `manual.value`. */
  inputs: InputValues;
  /**
   * Отметки активности для ядра — функция, а не поле: возраст метки считается
   * в момент кадра, иначе `count(5)` не уменьшался бы без новых сообщений.
   */
  marks: () => Record<string, InputMark[]>;
  audio: Record<string, AudioFrame>;
  manual: Record<string, number>;
  /** Значения авто-модулей (моргание по таймеру). */
  auto: Record<string, number>;
  devices: DeviceOption[];
  /** Мониторы для модуля мыши: номер и подпись. */
  monitors: MonitorOption[];
  /** Звук запущен: есть хотя бы один включённый микрофонный модуль. */
  active: boolean;
  error: string | null;
  contextState: string;
  start: () => Promise<void>;
  stop: () => void;
  setManual: (key: string, value: number) => void;
  refreshDevices: () => Promise<void>;
  /** Записать эталон виземы: 3 секунды, средний спектр. */
  calibrate: (settings: ModuleConfig, onFrame?: (frame: CalibrationFrame) => void) => Promise<number[] | null>;
  cancelCalibration: () => void;
  /** Стоп анимации: счётчики нажатий клавиш начинаются заново. */
  resetPointerHits: () => void;
  /** Состояние внешних источников по имени модуля: подключён, ждёт, ошибка. */
  externalStatuses: Record<string, ExternalStatus>;
  /** Вход в Twitch: кнопка в карточке модуля. */
  authorizeSource: (name: string) => void;
  /** Забыть токен Twitch. */
  signOutSource: (name: string) => void;
  /** Последние строки журнала источников: что пришло и что не разобралось. */
  externalLogs: Record<string, ExternalLogEntry[]>;
  /** Проверка источника по кнопке «Проверить». */
  probeSource: (name: string) => Promise<string>;
  /** Последние тексты источников (чат): показываются во «Входах». */
  externalTexts: Record<string, ExternalTextLine[]>;
}

/** Такт часов цвета, мс: 30 кадров в секунду хватает для плавности. */
const COLOR_TICK = 33;

const BLINK_TICK = 33;

/**
 * Связывает модули с ядром. Микрофонные модули берут значения из звука,
 * ручные — из ползунков, авто-модули (моргание) считаются по таймеру.
 *
 * Кнопки «включить микрофон» больше нет: звук поднимается сам, как только в
 * модели появляется включённый микрофонный модуль. Браузер требует жест, чтобы
 * `AudioContext` вышел из `suspended`, поэтому первое нажатие в приложении
 * дополнительно будит контекст.
 */
/**
 * @param capture — держать ли живой захват звука. В «Стопе» (расстановка)
 *   входы не нужны, а открытый микрофон тянет аудиотракт WebView и в простое:
 *   захват гасится до продолжения.
 */
export function useModuleInputs(
  modules: ModuleInstance[],
  libraryVersion = 0,
  capture = true,
): ModuleInputsApi {
  const engineRef = useRef<AudioInputEngine | null>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audio, setAudio] = useState<Record<string, AudioFrame>>({});
  const [manual, setManualValues] = useState<Record<string, number>>({});
  const [auto, setAuto] = useState<Record<string, number>>({});
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [contextState, setContextState] = useState("closed");
  const starting = useRef(false);
  const schedules = useRef(new Map<string, { next: number; until: number }>());

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modules, libraryVersion],
  );
  const liveKey = JSON.stringify(liveModules.map((module) => [module.name, module.config.deviceId, module.config.processing]));
  const needsAudio = liveModules.length > 0;

  const start = useCallback(async () => {
    if (starting.current) return;
    starting.current = true;
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
    } finally {
      starting.current = false;
    }
  }, [engine, refreshDevices]);

  const stop = useCallback(() => {
    engineRef.current?.stop();
    setActive(false);
    setAudio({});
    setContextState(engineRef.current?.state ?? "closed");
  }, []);

  // Звук поднимается сам: модуль микрофона включён — значит, он нужен.
  useEffect(() => {
    if (!needsAudio) {
      if (active) stop();
      return;
    }
    if (!active && !starting.current) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsAudio]);

  // Первый жест пользователя в приложении — повод разбудить AudioContext,
  // если браузер не дал создать его «молча». Контекст может остаться
  // `suspended` уже после успешного start(), поэтому проверяем его состояние,
  // а не только флаг active.
  useEffect(() => {
    const wake = () => {
      if (!needsAudio) return;
      const current = engineRef.current;
      if (!current || current.state === "suspended") void start();
    };
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };
  }, [needsAudio, active, start]);

  /** Пересобирает подключения к микрофонам при смене модулей или устройств. */
  useEffect(() => {
    const current = engineRef.current;
    if (!current) return;
    if (!active || !capture) {
      // Захват не нужен: гасим потоки, микрофон перестаёт работать в системе.
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
          await current.attach(module.name, module.config, moduleDefinition(module.type).kind === "viseme");
        } catch (reason) {
          if (cancelled) return;
          setError(describe(reason));
        }
      }
      if (!cancelled) setContextState(current.state);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, liveKey, capture]);

  useEffect(() => {
    if (!active) return;
    const current = engineRef.current;
    if (current) for (const module of liveModules) current.setSettings(module.name, module.config);
  }, [active, liveModules]);

  // --- авто-модули: моргание по таймеру -------------------------------------
  const autoModules = useMemo(
    () => modules.filter((module) => module.enabled && moduleDefinition(module.type).kind === "autoblink"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modules, libraryVersion],
  );
  const autoKey = JSON.stringify(autoModules.map((module) => [
    module.name,
    module.config.period, module.config.hold, module.config.jitter, module.config.min, module.config.max,
    module.disabledInputs,
  ]));

  useEffect(() => {
    schedules.current.clear();
    if (autoModules.length === 0) {
      setAuto({});
      return;
    }
    const tick = () => {
      const now = performance.now();
      const next: Record<string, number> = {};
      for (const module of autoModules) {
        const definition = moduleDefinition(module.type);
        const spec = definition.inputs[0];
        if (!spec || !inputEnabled(module, spec.name)) continue;
        const range = inputRange(module, spec);
        const period = clamp(Number(module.config.period) || 4200, 500, 20000);
        const hold = clamp(Number(module.config.hold) || 140, 40, 2000);
        const jitter = clamp(Number(module.config.jitter) || 0, 0, 90) / 100;
        let schedule = schedules.current.get(module.name);
        if (!schedule) {
          // Первое моргание — не сразу, а через половину интервала: так не
          // выглядит, будто персонаж моргает при каждом запуске.
          schedule = { next: now + period * (0.5 + Math.random() * 0.5), until: 0 };
          schedules.current.set(module.name, schedule);
        }
        if (now >= schedule.next) {
          schedule.until = now + hold;
          schedule.next = now + Math.max(hold + 40, period * (1 + (Math.random() * 2 - 1) * jitter));
        }
        next[inputKey(module, spec.name)] = now < schedule.until ? range.max : range.min;
      }
      setAuto((current) => sameRecord(current, next) ? current : next);
    };
    tick();
    const timer = window.setInterval(tick, BLINK_TICK);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoKey]);

  useEffect(() => () => {
    engineRef.current?.dispose();
    engineRef.current = null;
  }, []);

  const setManual = useCallback((key: string, value: number) => {
    setManualValues((current) => ({ ...current, [key]: value }));
  }, []);

  const calibrate = useCallback(
    (settings: ModuleConfig, onFrame?: (frame: CalibrationFrame) => void) => engine().calibrate(settings, { onFrame }),
    [engine],
  );
  const cancelCalibration = useCallback(() => engineRef.current?.cancelCalibration(), []);

  // Клавиатура и мышь: значения считаются только пока есть включённый модуль.
  const pointerActive = useMemo(
    () => modules.some((module) => module.enabled && isPointerKind(moduleDefinition(module.type).kind)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modules, libraryVersion],
  );
  const pointerInputs = usePointerInputs(pointerActive);
  const pointer = pointerInputs.frame;
  // Внешние источники (WebSocket и будущие транспорты) живут рядом с указателем.
  const externalInputs = useExternalSource(modules, libraryVersion);

  // Цвет живёт по времени: значение канала — функция часов, а не события. Без
  // своего тика значения замирали бы, пока в сцене ничего не происходит (нет
  // звука, нет мыши), и «Дыхание» стояло бы на месте.
  const colorActive = useMemo(
    () => modules.some((module) => module.enabled && moduleDefinition(module.type).kind === "color"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modules, libraryVersion],
  );
  const [clock, setClock] = useState({ now: 0, dt: 0 });
  useEffect(() => {
    if (!colorActive) return undefined;
    // Часы идут в реальном времени: 30 тиков в секунду хватает, чтобы переход
    // выглядел плавным, а лишних перерисовок не было.
    let last = typeof performance === "undefined" ? Date.now() : performance.now();
    const timer = window.setInterval(() => {
      const now = typeof performance === "undefined" ? Date.now() : performance.now();
      const dt = Math.min(0.25, Math.max(0.001, (now - last) / 1000));
      last = now;
      setClock({ now, dt });
    }, COLOR_TICK);
    return () => window.clearInterval(timer);
  }, [colorActive]);

  const inputs = useMemo<InputValues>(() => ({
    values: composeValues(modules, {
      audio, manual, auto, pointer, external: externalInputs.values,
      now: clock.now, dt: clock.dt,
    }),
    signals: {},
    // Текст чата и паспорта входов едут вместе со значениями: в скрипте это
    // `twitch.chat.message(-1)` и `twitch.reward.max`.
    texts: inputTexts(modules, externalInputs.texts),
    meta: inputMeta(modules),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [modules, audio, manual, auto, pointer, clock, externalInputs.values, externalInputs.texts, libraryVersion]);

  return {
    inputs, marks: externalInputs.marks,
    audio, manual, auto, devices, monitors: pointerInputs.monitors, active, error, contextState,
    start, stop, setManual, refreshDevices, calibrate, cancelCalibration,
    // Стоп анимации: счётчики нажатий клавиш начинаются заново.
    resetPointerHits: pointerInputs.resetHits,
    externalStatuses: externalInputs.statuses,
    authorizeSource: externalInputs.authorize,
    signOutSource: externalInputs.signOut,
    externalLogs: externalInputs.logs,
    probeSource: externalInputs.probe,
    externalTexts: externalInputs.texts,
  };
}

function sameRecord(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
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
