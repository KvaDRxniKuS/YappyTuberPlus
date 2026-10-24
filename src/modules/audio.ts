import type { ModuleConfig } from "../types";
import { VISEME_BANDS, bandFrequency, bandWeight, spectrumShape, unitVector } from "./viseme";

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
  samples: Float32Array<ArrayBuffer>;
  /** Отсчёты АЧХ для визем: заполняются только если модулю нужны полосы. */
  frequency: Float32Array<ArrayBuffer> | null;
  /** Прошлое сглаженное значение `speak`: без него сглаживание не работает. */
  lastSpeak: number;
  /** Ключ потока: `default` или конкретный `deviceId`. */
  streamKey: string;
  settings: ModuleConfig;
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

  get state(): AudioContextState | "closed" {
    return this.context?.state ?? "closed";
  }

  get hasInputs(): boolean {
    return this.analysers.size > 0;
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
      samples: new Float32Array(analyser.fftSize),
      frequency: bands ? new Float32Array(analyser.frequencyBinCount) : null,
      lastSpeak: 0,
      streamKey,
      settings,
    });
    this.startTimer();
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
  }

  /** Полная остановка: закрывает потоки, микрофон гаснет в системе. */
  stop(): void {
    for (const name of [...this.analysers.keys()]) this.detach(name);
    for (const [key, entry] of [...this.streams.entries()]) {
      entry.stream.getTracks().forEach((track) => track.stop());
      this.streams.delete(key);
    }
    this.stopTimer();
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
    const processing = settings.processing === true;
    const constraints: MediaStreamConstraints = {
      audio: {
        ...(streamKey === "default" ? {} : { deviceId: { exact: streamKey } }),
        echoCancellation: processing,
        noiseSuppression: processing,
        autoGainControl: false,
      },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const entry: StreamEntry = {
      stream,
      source: this.context!.createMediaStreamSource(stream),
      refs: 1,
    };
    this.streams.set(streamKey, entry);
    return entry;
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
      const speak = item.lastSpeak + (speakTarget - item.lastSpeak) * (speakTarget > item.lastSpeak ? 0.45 : 0.16);
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
