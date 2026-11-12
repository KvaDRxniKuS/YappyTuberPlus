import type { ModuleConfig } from "../types";
import { VISEME_BANDS, bandFrequency, bandWeight, spectrumShape, unitVector } from "./viseme";
import { setCapture } from "../engine/meter";

export interface DeviceOption {
  id: string;
  label: string;
}

/** Кадр звука одного модуля. Полосы есть только у микрофонных визем. */
export interface AudioFrame {
  speak: number;
  loudness: number;
  db: number;
  talking: number;
  /** 32 лог-полосы 80 Гц–8 кГц единичной длины: форма спектра, а не громкость. */
  bands?: number[];
}

/** Числовое поле кадра по имени входа: `speak`, `loudness`, `db`, `talking`. */
export function frameValue(frame: AudioFrame | undefined, key: string): number | undefined {
  if (!frame) return undefined;
  if (key === "speak") return frame.speak;
  if (key === "loudness") return frame.loudness;
  if (key === "db") return frame.db;
  if (key === "talking") return frame.talking;
  return undefined;
}

/** Один кадр калибровки: спектр, громкость и прогресс записи 0…1. */
export interface CalibrationFrame {
  bands: number[];
  /** Суммарная амплитуда до нормировки: по ней отсекается тишина. */
  level: number;
  progress: number;
}

interface StreamEntry {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  refs: number;
}

interface Analyser {
  analyser: AnalyserNode;
  /**
   * Источник этого анализатора. Системный микрофон может смениться на лету, и
   * тогда источник подменяется, а анализатор остаётся тем же — пересоздавать
   * его значило бы терять сглаживание и моргать значениями.
   */
  source: MediaStreamAudioSourceNode;
  samples: Float32Array<ArrayBuffer>;
  /** Отсчёты АЧХ для визем: заполняются только если модулю нужны полосы. */
  frequency: Float32Array<ArrayBuffer> | null;
  /** Прошлое сглаженное значение `speak`: без него сглаживание не работает. */
  lastSpeak: number;
  /** Момент прошлого расчёта: от него считается шаг сглаживания `speak`. */
  lastTick: number;
  /** Ключ потока: `default` или конкретный `deviceId`. */
  streamKey: string;
  settings: ModuleConfig;
}

/**
 * Что показывать в списке микрофонов.
 *
 * Идентификатор устройства лежит в пресете, а список устройств — в системе.
 * Пока приложение не получило разрешение на микрофон, подписи и идентификаторы
 * в `enumerateDevices` пустые, поэтому сохранённого устройства в списке нет —
 * и `<select>` молча показывал первый пункт «Системный по умолчанию», хотя в
 * пресете выбран другой микрофон. Выбор выглядел потерянным после каждого
 * запуска. Возвращаем правду: идентификатор свой и признак «его сейчас нет».
 */
export function deviceChoice(
  devices: DeviceOption[],
  stored: string | undefined,
): { value: string; missing: boolean } {
  const id = typeof stored === "string" ? stored : "";
  if (!id) return { value: "default", missing: false };
  return { value: id, missing: !devices.some((device) => device.id === id) };
}

/**
 * Ограничения захвата для ключа потока.
 *
 * «Системный по умолчанию» — это **пустой** `deviceId`: браузер берёт текущий
 * микрофон системы на момент открытия. Если вписать `deviceId: { exact:
 * "default" }`, выбор зафиксируется на том устройстве, что было при запуске.
 */
function streamConstraints(streamKey: string, settings: ModuleConfig): MediaStreamConstraints {
  const processing = settings.processing === true;
  return {
    audio: {
      ...(streamKey === "default" ? {} : { deviceId: { exact: streamKey } }),
      echoCancellation: processing,
      noiseSuppression: processing,
      autoGainControl: false,
    },
  };
}

/**
 * Живой звук для модулей. Один `AudioContext`, отдельный анализатор на модуль,
 * общий поток на устройство: два Loudness с одного микрофона не открывают его
 * дважды, а два разных микрофона работают независимо.
 *
 * Контекст создаётся и «пробуждается» только из обработчика клика — браузер
 * (и WebView2) иначе оставляет его в состоянии `suspended`, и анализатор
 * молча возвращает нули.
 */
export class AudioInputEngine {
  private context: AudioContext | null = null;
  private streams = new Map<string, StreamEntry>();
  private analysers = new Map<string, Analyser>();
  private timer: number | null = null;
  private onValues: ((values: Record<string, AudioFrame>) => void) | null = null;
  /** Прошлый кадр: в тишине значения не меняются и React не перерисовывается. */
  private lastFrame: Record<string, AudioFrame> | null = null;
  /** Номер текущей калибровки: старый цикл записи видит смену и выходит. */
  private calibration = 0;
  /**
   * Замечание к последнему захвату: почему открыт не тот микрофон, что в
   * пресете. Молчание в эфире хуже системного микрофона, но и молчать об этом
   * нельзя — иначе выбор снова выглядит потерянным.
   */
  private notice: string | null = null;

  get state(): AudioContextState | "closed" {
    return this.context?.state ?? "closed";
  }

  get hasInputs(): boolean {
    return this.analysers.size > 0;
  }

  /** Забрать замечание к захвату: возвращается один раз, чтобы не мигало. */
  takeNotice(): string | null {
    const notice = this.notice;
    this.notice = null;
    return notice;
  }

  /** Имена модулей, к которым уже подключён звук. */
  attachedNames(): string[] {
    return [...this.analysers.keys()];
  }

  async start(onValues: (values: Record<string, AudioFrame>) => void): Promise<void> {
    this.onValues = onValues;
    if (!this.context) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error("WebView не поддерживает Web Audio");
      this.context = new Ctor();
    }
    if (this.context.state === "suspended") await this.context.resume();
    this.startTimer();
  }

  /** Список микрофонов. До первого разрешения подписи устройств пустые. */
  async listDevices(): Promise<DeviceOption[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({
        id: device.deviceId,
        label: device.label || `Микрофон ${index + 1}`,
      }));
  }

  async attach(name: string, settings: ModuleConfig, bands = false): Promise<void> {
    // Отчёт после подключения: строка статуса покажет живой захват.
    if (!this.context) throw new Error("Сначала включите звук");
    const streamKey = settings.deviceId || "default";
    const entry = await this.acquireStream(streamKey, settings);
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.35;
    analyser.minDecibels = -100;
    entry.source.connect(analyser);
    const current = this.analysers.get(name);
    if (current) {
      current.analyser.disconnect();
      this.releaseStream(current.streamKey);
    }
    this.analysers.set(name, {
      analyser,
      source: entry.source,
      samples: new Float32Array(analyser.fftSize),
      frequency: bands ? new Float32Array(analyser.frequencyBinCount) : null,
      lastSpeak: 0,
      lastTick: performance.now(),
      streamKey,
      settings,
    });
    this.startTimer();
    this.report();
  }

  /**
   * Запись эталона виземы: фиксированные 3 секунды, средний спектр.
   *
   * Запись идёт на своём анализаторе и своём (общем) потоке, поэтому не мешает
   * рабочим модулям. Тишина отсекается по громкости: иначе шум микрофона
   * разбавил бы эталон и «похожесть» стала бы одинаковой для всех звуков.
   */
  async calibrate(
    settings: ModuleConfig,
    options: { durationMs?: number; onFrame?: (frame: CalibrationFrame) => void } = {},
  ): Promise<number[] | null> {
    const duration = clamp(options.durationMs ?? 3000, 500, 10000);
    if (!this.context) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error("WebView не поддерживает Web Audio");
      this.context = new Ctor();
    }
    if (this.context.state === "suspended") await this.context.resume();
    const streamKey = settings.deviceId || "default";
    const entry = await this.acquireStream(streamKey, { ...settings, processing: settings.processing ?? true });
    const token = ++this.calibration;
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    analyser.minDecibels = -100;
    entry.source.connect(analyser);
    const frequency = new Float32Array(analyser.frequencyBinCount);
    const frames: Array<{ bands: number[]; level: number }> = [];
    const started = performance.now();
    try {
      while (this.calibration === token) {
        const elapsed = performance.now() - started;
        const { bands, level } = readSpectrum(analyser, frequency);
        frames.push({ bands, level });
        options.onFrame?.({ bands, level, progress: Math.min(1, elapsed / duration) });
        if (elapsed >= duration) break;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
      }
    } finally {
      analyser.disconnect();
      this.releaseStream(streamKey);
    }
    if (this.calibration !== token) return null;
    return averageLevelSpectrum(frames);
  }

  /** Прерывает запись: пользователь закрыл панель или начал другую визему. */
  cancelCalibration(): void {
    this.calibration += 1;
  }

  setSettings(name: string, settings: ModuleConfig): void {
    const current = this.analysers.get(name);
    if (current) current.settings = settings;
  }

  detach(name: string): void {
    const current = this.analysers.get(name);
    if (!current) return;
    current.analyser.disconnect();
    this.releaseStream(current.streamKey);
    this.analysers.delete(name);
    if (this.analysers.size === 0) this.stopTimer();
    this.report();
  }

  /** Захват виден счётчику работы: по нему видно, что микрофон ещё жив. */
  private report(): void {
    setCapture(this.streams.size, this.context?.state ?? "closed");
  }

  /** Полная остановка: закрывает потоки, микрофон гаснет в системе. */
  stop(): void {
    for (const name of [...this.analysers.keys()]) this.detach(name);
    for (const [key, entry] of [...this.streams.entries()]) {
      entry.stream.getTracks().forEach((track) => track.stop());
      this.streams.delete(key);
    }
    this.stopTimer();
    this.report();
  }

  dispose(): void {
    this.stop();
    if (this.context) {
      void this.context.close();
      this.context = null;
    }
    this.onValues = null;
  }

  private async acquireStream(streamKey: string, settings: ModuleConfig): Promise<StreamEntry> {
    const existing = this.streams.get(streamKey);
    if (existing) {
      existing.refs += 1;
      return existing;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(streamConstraints(streamKey, settings));
    } catch (reason) {
      // Идентификатор устройства мог смениться между запусками (в WebView2 он
      // привязан к профилю и разрешению), а микрофон — исчезнуть из системы.
      // Системный микрофон лучше тишины: звук продолжает идти, а модуль честно
      // говорит, что открыт не тот вход, что записан в пресете.
      if (streamKey === "default") throw reason;
      stream = await navigator.mediaDevices.getUserMedia(streamConstraints("default", settings));
      this.notice = "Микрофон из пресета недоступен — взят системный по умолчанию.";
    }
    const entry: StreamEntry = {
      stream,
      source: this.context!.createMediaStreamSource(stream),
      refs: 1,
    };
    this.streams.set(streamKey, entry);
    return entry;
  }

  /**
   * Системный микрофон сменился — переключаемся на новый.
   *
   * Открытый поток сам за системой не ходит: `getUserMedia` без `deviceId` взял
   * устройство один раз при запуске, и до переоткрытия звук идёт со старого
   * микрофона. Поэтому на `devicechange` берём поток заново и подменяем
   * источник у анализаторов, живущих на «системном». Явно выбранный микрофон не
   * трогаем: его выбрали сознательно.
   *
   * Если микрофон по умолчанию остался тем же (в системе просто добавилось
   * устройство), новый поток сразу закрывается: переоткрытие дало бы щелчок на
   * ровном месте.
   */
  async followDefault(): Promise<boolean> {
    if (!this.context) return false;
    const targets = [...this.analysers.values()].filter((item) => item.streamKey === "default");
    if (targets.length === 0) return false;
    // Сначала дешёвая проверка без открытия микрофона: имя устройства по
    // умолчанию в списке против имени открытого потока. Она же делает вызов
    // безопасным на каждое возвращение в окно.
    if (!(await this.defaultChanged())) return false;
    const settings = targets[0].settings;
    const previous = this.streams.get("default");
    const previousId = previous?.stream.getAudioTracks()[0]?.getSettings().deviceId;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(streamConstraints("default", settings));
    } catch {
      // Микрофон мог не открыться: старое соединение лучше тишины.
      return false;
    }
    const nextId = stream.getAudioTracks()[0]?.getSettings().deviceId;
    if (previous && previousId && nextId && previousId === nextId) {
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }
    const source = this.context.createMediaStreamSource(stream);
    for (const item of targets) {
      try {
        item.source.disconnect(item.analyser);
      } catch {
        /* источник мог быть уже отключён */
      }
      source.connect(item.analyser);
      item.source = source;
    }
    if (previous) {
      try {
        previous.source.disconnect();
      } catch {
        /* уже отключён */
      }
      previous.stream.getTracks().forEach((track) => track.stop());
    }
    this.streams.set("default", { stream, source, refs: targets.length });
    this.notice = null;
    return true;
  }

  /**
   * Сменился ли системный микрофон — без открытия нового захвата.
   *
   * `enumerateDevices` отдаёт псевдоустройство `default` с именем текущего
   * микрофона системы, а открытый поток знает имя своего устройства в
   * `track.label`. Разные имена — пора переоткрывать. Проверка нужна, потому что
   * событие `devicechange` в WebView2 приходит не на всякую смену устройства по
   * умолчанию, а дёргать микрофон на каждое возвращение в окно нельзя.
   */
  private async defaultChanged(): Promise<boolean> {
    const track = this.streams.get("default")?.stream.getAudioTracks()[0];
    if (!track || !track.label) return false;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const pseudo = devices.find((device) => device.kind === "audioinput" && device.deviceId === "default");
      if (!pseudo?.label) return false;
      return pseudo.label !== track.label;
    } catch {
      return false;
    }
  }

  private releaseStream(streamKey: string): void {
    const entry = this.streams.get(streamKey);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    entry.source.disconnect();
    entry.stream.getTracks().forEach((track) => track.stop());
    this.streams.delete(streamKey);
  }

  private startTimer(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.tick(), 40);
  }

  private stopTimer(): void {
    this.lastFrame = null;
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (!this.onValues || this.analysers.size === 0) return;
    const frame: Record<string, AudioFrame> = {};
    for (const [name, item] of this.analysers) {
      const { analyser, samples, settings } = item;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      let peak = 0;
      for (const sample of samples) {
        sum += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
      }
      const gain = clamp(settings.gain ?? 1, 0.1, 8);
      const rms = Math.sqrt(sum / samples.length) * gain;
      const db = rms > 0.000001 ? Math.max(-80, 20 * Math.log10(rms)) : -80;
      const speakTarget = clamp((db + 52) / 34, 0, 1);
      // Сглаживание `speak` задаётся в миллисекундах и считается по настоящему
      // шагу таймера: таймер может просыпаться реже, и фиксированные 0.45/0.16
      // тогда означали бы разную скорость на разных машинах.
      const now = performance.now();
      const step = clamp((now - item.lastTick) / 1000, 0.005, 0.25);
      item.lastTick = now;
      const attack = readMillis(settings.attack, 70);
      const release = readMillis(settings.release, 220);
      const alpha = smoothingAlpha(step, speakTarget > item.lastSpeak ? attack : release);
      const speak = item.lastSpeak + (speakTarget - item.lastSpeak) * alpha;
      item.lastSpeak = speak;
      const current: AudioFrame = {
        speak,
        loudness: clamp(peak * gain, 0, 1),
        db,
        talking: db > (settings.threshold ?? -43) ? 1 : 0,
      };
      if (item.frequency) current.bands = readSpectrum(analyser, item.frequency).bands;
      frame[name] = current;
    }
    if (sameFrame(this.lastFrame, frame)) return;
    this.lastFrame = frame;
    this.onValues(frame);
  }
}

/**
 * Сравнение кадров звука с допусками: пока микрофон молчит, значения стоят на
 * месте, и незачем 25 раз в секунду перерисовывать весь редактор.
 */
function sameFrame(previous: Record<string, AudioFrame> | null, next: Record<string, AudioFrame>): boolean {
  if (!previous) return false;
  const names = Object.keys(next);
  if (names.length !== Object.keys(previous).length) return false;
  for (const name of names) {
    const left = previous[name];
    const right = next[name];
    if (!left) return false;
    if (left.talking !== right.talking) return false;
    if (Math.abs(left.speak - right.speak) > 0.004) return false;
    if (Math.abs(left.loudness - right.loudness) > 0.004) return false;
    if (Math.abs(left.db - right.db) > 0.25) return false;
    // Полосы у визем меняются от формы рта при той же громкости: сравниваем их
    // отдельно, иначе «а» и «о» на одной громкости считались бы одним кадром.
    const leftBands = left.bands;
    const rightBands = right.bands;
    if (leftBands || rightBands) {
      if (!leftBands || !rightBands || leftBands.length !== rightBands.length) return false;
      let delta = 0;
      for (let index = 0; index < leftBands.length; index += 1) delta += Math.abs(leftBands[index] - rightBands[index]);
      if (delta > 0.05) return false;
    }
  }
  return true;
}

/**
 * АЧХ → 32 лог-полосы 80 Гц–8 кГц → признак формы (см. `spectrumShape`).
 * Внутри полосы берём среднюю амплитуду, иначе верхние полосы (там в разы
 * больше бинов) забирали бы весь вес.
 */
function readSpectrum(analyser: AnalyserNode, frequency: Float32Array<ArrayBuffer>): { bands: number[]; level: number } {
  analyser.getFloatFrequencyData(frequency);
  const nyquist = analyser.context.sampleRate / 2;
  const binHz = nyquist / frequency.length;
  const low = 80;
  const high = 8000;
  const ratio = Math.log(high / low);
  const sums = new Array(VISEME_BANDS).fill(0);
  const counts = new Array(VISEME_BANDS).fill(0);
  let level = 0;
  for (let bin = 1; bin < frequency.length; bin += 1) {
    const hz = bin * binHz;
    if (hz < low || hz >= high) continue;
    const index = Math.min(VISEME_BANDS - 1, Math.floor((Math.log(hz / low) / ratio) * VISEME_BANDS));
    const amplitude = Math.pow(10, frequency[bin] / 20);
    sums[index] += amplitude;
    counts[index] += 1;
    level += amplitude;
  }
  const means = sums.map((sum, index) => (counts[index] > 0 ? sum / counts[index] : 0));
  return { bands: spectrumShape(means), level };
}

/**
 * Средний спектр записи. Кадры тише 45 % от самого громкого отбрасываются:
 * паузы между слогами не должны разбавлять эталон.
 */
function averageLevelSpectrum(frames: Array<{ bands: number[]; level: number }>): number[] | null {
  if (frames.length === 0) return null;
  const loudest = Math.max(...frames.map((frame) => frame.level));
  if (!(loudest > 1e-6)) return null;
  const usable = frames.filter((frame) => frame.level >= loudest * 0.45);
  const source = usable.length >= 3 ? usable : frames.filter((frame) => frame.level > 1e-6).slice(-Math.max(3, Math.floor(frames.length * 0.3)));
  if (source.length === 0) return null;
  const sum = new Array(VISEME_BANDS).fill(0);
  for (const frame of source) {
    for (let index = 0; index < sum.length; index += 1) sum[index] += frame.bands[index] ?? 0;
  }
  return unitVector(sum.map((value) => value / source.length));
}

/**
 * Доля пути до цели за шаг `dt` секунд при постоянной времени `milliseconds`.
 * `0` — не двигаться вовсе, `1` — прыгнуть сразу: так «Атака = 0 мс» означает
 * мгновенную реакцию без особых случаев.
 */
export function smoothingAlpha(dtSeconds: number, milliseconds: number): number {
  const tau = Math.max(0, milliseconds) / 1000;
  if (!(tau > 0)) return 1;
  if (!(dtSeconds > 0)) return 0;
  return 1 - Math.exp(-dtSeconds / tau);
}

/** Миллисекунды из настроек: битое значение заменяется запасным. */
function readMillis(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 2000) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
