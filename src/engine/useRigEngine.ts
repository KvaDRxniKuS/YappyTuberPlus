import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { InputMark, InputValues, RigFrame, RigPreset } from "../types";
import { baseStructure, baseUpdates, engineStructure } from "./preset";
import { getEngineBackend, type EngineBackend, type EngineResponse } from "./backend";
import { startNativeSchedule, type NativeSchedule } from "./nativeSchedule";
import type { ScriptScope } from "./scripts";
import { neutralFrame, prepareFrame } from "./frame";
import { moduleConstants, presetGlobals } from "../modules/presets";
import { frameProduced } from "./frameSignal";
import { countArrival, countFrame } from "./meter";
import type { TextChannel } from "../render/text";

export type EngineStatus = "loading" | "ready" | "error";

export function useRigEngine(
  preset: RigPreset,
  inputsRef: RefObject<InputValues>,
  paused: boolean,
  frameSinkRef?: RefObject<((frame: RigFrame) => void) | null>,
  /** Текст модулей: подстановки в шаблонах текстовых объектов. */
  textsRef?: RefObject<TextChannel>,
  /**
   * Отметки активности входов: `count(с)`, `sum(с)`, `avg(с)` в скрипте.
   *
   * Возраст метки считается здесь, в момент кадра: если бы он лежал в состоянии
   * React, окно не обновлялось бы без новых сообщений.
   */
  marks?: () => Record<string, InputMark[]>,
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
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const pausedRef = useRef(paused);
  const resetClockRef = useRef(true);
  const structureKey = engineStructure(preset);
  const basesKey = baseStructure(preset);
  presetRef.current = preset;
  pausedRef.current = paused;

  // Нативный планировщик: в приложении кадры считает Rust, в браузере — rAF.
  const nativeRef = useRef<NativeSchedule | null>(null);
  const deliverRef = useRef<((response: EngineResponse, nowMs: number) => void) | null>(null);
  const framesRef = useRef(0);
  const fpsWindowRef = useRef(0);
  const lastSnapshotRef = useRef(0);
  const runtimeKey = `${preset.runtime.fpsMode}:${preset.runtime.fpsLimit}`;

  useEffect(() => {
    let active = true;
    getEngineBackend().then((value) => {
      if (active) setBackend(value);
    }).catch((reason: unknown) => {
      if (!active) return;
      setStatus("error");
      const message = reason instanceof Error ? reason.message : String(reason);
      // Старое ядро не знает новых видов объектов: подсказываем, что делать,
      // вместо загадочного «unknown variant media».
      setError(/unknown variant|media|text|invalid type/i.test(message) && /wasm/i.test(backend?.label ?? "")
        ? `${message} — пересоберите ядро: npm run build:wasm (или bat-файл сборки)`
        : message);
    });
    return () => { active = false; };
  }, []);

  /**
   * Стоп-кадр считает базовый текст в ядре.
   *
   * В паузе кадры не идут, поэтому это единственный «пустой» тик: он снимает
   * переопределения из событий (`reset_clock`) и пересчитывает формулы
   * `text = …` по текущим входам. Остальные значения стоп-кадра остаются за
   * редактором: нейтральную позу и видимость с последнего живого кадра собрал он.
   */
  const requestStopFrame = useCallback(async (handle: number, client: EngineBackend) => {
    const inputs = inputsRef.current;
    const response = await client.call({
      op: "tick",
      handle,
      now: (typeof performance === "undefined" ? Date.now() : performance.now()) / 1000,
      inputs: {
        values: inputs.values,
        signals: inputs.signals ?? {},
        texts: inputs.texts,
        meta: inputs.meta,
        marks: marksRef.current?.(),
      },
      paused: true,
      resetClock: true,
    }).catch(() => null);
    if (!response?.ok || !response.frame) return;
    const current = frameRef.current;
    if (!current) return;
    const stopped: RigFrame = { ...current, texts: response.frame.texts };
    frameRef.current = stopped;
    setSnapshot(stopped);
    frameSinkRef?.current?.(stopped);
    // Окна рисуют по сигналу: новый кадр — новая отрисовка.
    frameProduced();
  }, [frameSinkRef, inputsRef]);

  useEffect(() => {
    if (!backend) return;
    let active = true;
    let ownHandle: number | null = null;
    // Счётчик кадров, пришедших в паузе: повод повторно погасить планировщик.
    let strayFrames = 0;
    setStatus("loading");
    setError(null);
    const current = presetRef.current;
    // Скрипты уходят в ядро как есть: блоки `on event… { … }` и ссылки на
    // чужие объекты разбирает и исполняет сам движок.
    const config = {
      canvas: current.canvas,
      // Пресеты: к авторскому глобальному скрипту добавляются события модулей
      // («награда → пресет»). Пишет их модуль, в скрипте пользователя их нет.
      globals: presetGlobals(current.modules, current.globals),
      // Ядру не нужны ни картинка, ни файл медиа: оно считает числа. Ссылку на
      // файл в хранилище всё равно не разобрать в Rust, а base64 туда гонять
      // незачем — на больших видео это десятки мегабайт на каждую правку.
      objects: current.objects.map((object) => ({
        ...object,
        image: null,
        media: object.media ? { ...object.media, src: null } : undefined,
      })),
      // Состояния enum приходят в ядро числами: в скрипте `manual.value == walk`
      // читается по имени, а не по номеру.
      constants: moduleConstants(current.modules),
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
      // Движок пересоздали в паузе (например, сразу после «Стопа») — просим
      // стоп-кадр, чтобы текст показал базу из скрипта, а не прошлое событие.
      if (pausedRef.current) void requestStopFrame(response.handle, backend);
      // Нативное приложение: кадры считает Rust, поэтому поток не встаёт,
      // когда окно редактора свёрнуто. Браузер остаётся на requestAnimationFrame.
      if (backend.native && active) {
        const schedule = await startNativeSchedule({
          handle: response.handle,
          inputsRef,
          fpsMode: () => presetRef.current.runtime.fpsMode,
          fpsLimit: () => presetRef.current.runtime.fpsLimit,
          paused: () => pausedRef.current,
          onFrame: (frameResponse) => {
            countArrival();
            const deliver = deliverRef.current;
            if (!deliver) return;
            if (pausedRef.current) {
              // Кадр, пришедший в паузе, — признак того, что планировщик не
              // встал (например, его пересоздали в «Стопе»). Гасим его ещё раз:
              // иначе окно разбирает кадры, которые само же и отбрасывает, и
              // жжёт процессор при неподвижной картинке.
              if (strayFrames < 3) {
                strayFrames += 1;
                nativeRef.current?.pause(true);
              }
              return;
            }
            strayFrames = 0;
            deliver(frameResponse, performance.now());
          },
          onError: (message) => {
            // Планировщик не поднялся — молча возвращаемся к rAF, но причину
            // показываем в строке статуса.
            setError(`Планировщик Rust: ${message}`);
          },
        });
        if (!active) {
          // Окно уже пересоздало движок: поток, поднявшийся после этого, не нужен.
          schedule?.stop();
        } else if (schedule) {
          nativeRef.current = schedule;
          if (pausedRef.current) schedule.pause(true);
        }
      }
    }).catch((reason: unknown) => {
      if (!active) return;
      setStatus("error");
      const message = reason instanceof Error ? reason.message : String(reason);
      // Старое ядро не знает новых видов объектов: подсказываем, что делать,
      // вместо загадочного «unknown variant media».
      setError(/unknown variant|media|text|invalid type/i.test(message) && /wasm/i.test(backend?.label ?? "")
        ? `${message} — пересоберите ядро: npm run build:wasm (или bat-файл сборки)`
        : message);
    });
    return () => {
      active = false;
      const schedule = nativeRef.current;
      nativeRef.current = null;
      schedule?.stop();
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
    nativeRef.current?.pause(paused);
  }, [paused]);

  // Смена лимитера FPS: Rust пересчитывает интервал, поток не перезапускается.
  useEffect(() => {
    const schedule = nativeRef.current;
    if (!schedule) return;
    schedule.settings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeKey]);

  // Доставка кадра: одна и та же для Rust-планировщика и для rAF-цикла.
  deliverRef.current = (response: EngineResponse, nowMs: number) => {
    if (!response.ok || !response.frame) {
      setStatus("error");
      setError(response.error || "Ошибка кадра");
      return;
    }
    countFrame();
    const gated = prepareFrame(presetRef.current, response.frame, textsRef?.current);
    frameRef.current = gated;
    frameSinkRef?.current?.(gated);
    // Окна рисуют не по вечному rAF, а по этому сигналу: новый кадр — новый
    // кадр отрисовки, тишина — ни одного.
    frameProduced();
    framesRef.current += 1;
    if (nowMs - lastSnapshotRef.current > 120 || gated.diagnostics.length > 0) {
      lastSnapshotRef.current = nowMs;
      setSnapshot(gated);
    }
    if (fpsWindowRef.current === 0) fpsWindowRef.current = nowMs;
    if (nowMs - fpsWindowRef.current >= 1000) {
      setActualFps(Math.round(framesRef.current * 1000 / (nowMs - fpsWindowRef.current)));
      framesRef.current = 0;
      fpsWindowRef.current = nowMs;
    }
  };

  useEffect(() => {
    // В нативном приложении кадры считает Rust-планировщик: здесь rAF не нужен.
    // В паузе цикл не нужен тоже: пустой `requestAnimationFrame` заставляет
    // WebView собирать кадр 60 раз в секунду, хотя картинка не меняется — это и
    // была основная нагрузка «в простое». Цикл поднимается снова при
    // продолжении.
    if (!backend || backend.native || paused) return;
    let animation = 0;
    let nextDue = 0;
    let inFlight = false;
    let disposed = false;

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
        const inputs = inputsRef.current;
        backend.call({
          op: "tick",
          handle,
          now: nowMs / 1000,
          inputs: {
            values: inputs.values,
            signals: inputs.signals ?? {},
            texts: inputs.texts,
            meta: inputs.meta,
            marks: marksRef.current?.(),
          },
          paused: false,
          resetClock,
        }).then((response) => {
          if (disposed) return;
          deliverRef.current?.(response, nowMs);
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
    // `paused` в зависимостях: пауза гасит цикл, продолжение — поднимает.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, inputsRef, paused]);

  /**
   * Полный сброс таймлайна: новый движок, чистое состояние, время с нуля.
   * Кадр при этом не обнуляется, а становится нейтральным — иначе сцена теряет
   * иерархию видимости и выключенные группы снова показывались бы.
   */
  const resetTimeline = useCallback(() => {
    const neutral = neutralFrame(presetRef.current);
    // Видимость на стоп-кадре берём с последнего живого кадра: она посчитана по
    // текущим входам (рот в тишине, глаз на моргании). Сцена покажет такие
    // спрайты «призраками», а не уберёт их совсем — иначе при расстановке
    // непонятно, есть объект или его нет.
    const live = frameRef.current;
    if (live) {
      for (const object of presetRef.current.objects) {
        const values = live.objects[object.id];
        const target = neutral.objects[object.id];
        if (values && target) neutral.objects[object.id] = { ...target, visible: values.visible };
      }
      // Текст скрипта тоже замораживается вместе с кадром: иначе объект мигнул
      // бы шаблоном. Базовое значение вернёт «Продолжить» — ядро снимает
      // переопределение по reset_clock.
      neutral.texts = { ...live.texts };
    }
    frameRef.current = neutral;
    setSnapshot(neutral);
    resetClockRef.current = true;
    setEpoch((value) => value + 1);
    // Окна рисуют по сигналу «новый кадр»: нейтральная поза — тоже кадр, иначе
    // после «Стопа» на сцене осталась бы последняя живая картинка.
    frameProduced();
  }, []);

  /**
   * Проверка скрипта: возвращает места ошибок (пусто — всё в порядке).
   *
   * Рядом с текстом ядру отдают соседние области — только так видно конфликт
   * имён: «событие объявлено глобально» и «глобальное имя заняли в объекте».
   * Старое ядро не знает запрос `check` — тогда подсветки просто нет.
   */
  const checkScript = useCallback(async (source: string, scope?: ScriptScope) => {
    if (!backend) return [];
    try {
      const response = await backend.call({
        op: "check",
        source,
        globals: scope?.globals ?? "",
        scope: scope?.scope,
        objects: scope?.objects ?? [],
      });
      if (!response.ok) return [];
      // Старое ядро отвечает только `scriptError` — тогда подсветка одна, без
      // второго места. Новое — списком `scriptIssues`.
      if (response.scriptIssues) return response.scriptIssues;
      return response.scriptError ? [response.scriptError] : [];
    } catch {
      return [];
    }
  }, [backend]);

  return {
    frameRef,
    snapshot,
    status,
    error,
    actualFps,
    backendLabel: backend?.label || "Rust · загрузка",
    resetTimeline,
    checkScript,
  };
}
