import type { ModuleConfig } from "../types";

export interface DeviceOption {
  id: string;
  label: string;
}

export type AudioFrame = Record<string, number>;

interface StreamEntry {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  refs: number;
}

interface Analyser {
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
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

  async attach(name: string, settings: ModuleConfig): Promise<void> {
    if (!this.context) throw new Error("Сначала включите звук");
    const streamKey = settings.deviceId || "default";
    const entry = await this.acquireStream(streamKey, settings);
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.35;
    entry.source.connect(analyser);
    const current = this.analysers.get(name);
    if (current) {
      current.analyser.disconnect();
      this.releaseStream(current.streamKey);
    }
    this.analysers.set(name, {
      analyser,
      samples: new Float32Array(analyser.fftSize),
      lastSpeak: 0,
      streamKey,
      settings,
    });
    this.startTimer();
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
      frame[name] = {
        speak,
        loudness: clamp(peak * gain, 0, 1),
        db,
        talking: db > (settings.threshold ?? -43) ? 1 : 0,
      };
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
  }
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
