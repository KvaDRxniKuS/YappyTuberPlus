import type { MediaCue, MediaSpec, RigFrame, RigPreset } from "../types";
import { assetUrl } from "../engine/assets";

/** Настройки медиа по умолчанию: старые пресеты и новый объект без файла. */
export const DEFAULT_MEDIA: MediaSpec = {
  src: null,
  type: "image",
  fileName: "",
  loop: true,
  autoplay: false,
  muted: false,
  volume: 1,
  speed: 1,
  repeat: "restart",
  fade: 0.25,
  voices: 4,
};

export const MEDIA_REPEAT_LABEL: Record<MediaSpec["repeat"], string> = {
  restart: "Прервать и начать заново",
  fade: "Плавно убрать и начать заново",
  overlay: "Наложить второй источник",
  finish: "Доиграть до конца",
};

interface Voice {
  element: HTMLAudioElement;
  /** Таймер затухания: по нему видно, что источник плавно уходит. */
  timer: number | null;
}

interface Entry {
  spec: MediaSpec;
  /** Готовый URL файла: `asset:<id>` превращается в `blob:` хранилищем. */
  source: string | null;
  image: HTMLImageElement | null;
  video: HTMLVideoElement | null;
  voices: Voice[];
  /** Номер последней выполненной команды: по нему видно, что команда новая. */
  lastCue: number;
  /** Прошлое значение параметра `play`: по нему ловим нажатие «начать». */
  lastPlay: number;
  /** Что просит скрипт: играть или стоять. Видимость приостанавливает звук. */
  desired: boolean;
  visible: boolean;
  rate: number;
  volume: number;
}

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

/**
 * Воспроизведение медиа-объектов.
 *
 * Из ядра приходит готовый кадр: поза, `play/speed/volume` и команды с растущим
 * номером `cue`. Здесь — только исполнение: звук живёт в `HTMLAudioElement`
 * (у него есть громкость, скорость и позиция), видео — в `HTMLVideoElement`,
 * который рисуется прямо в канву, а картинка — обычный `Image`.
 *
 * Политика повтора (`repeat`) решает, что делать, когда событие просит начать
 * звук, пока он ещё играет: прервать, плавно убрать и начать, наложить второй
 * источник или доиграть текущий.
 */
export class MediaAssets {
  private entries = new Map<string, Entry>();

  /**
   * Каждый кадр: применяет команды и параметры, включает и выключает звук.
   * Вызывается из отрисовки — и в редакторе, и в оверлее.
   */
  sync(preset: RigPreset, frame: RigFrame | null): void {
    const alive = new Set<string>();
    for (const object of preset.objects) {
      if (object.kind !== "media") continue;
      alive.add(object.id);
      const spec = object.media ?? DEFAULT_MEDIA;
      const entry = this.entry(object.id, spec);
      const values = frame?.objects[object.id];
      const visible = object.enabled !== false && (values ? values.visible : object.base.visible) !== 0;
      // Кадра ещё нет — ничего не запускаем и не останавливаем: состоянием
      // управляют настройки объекта и скрипт, а не отсутствие кадра.
      const play = values ? (values.play > 0.5 ? 1 : 0) : entry.lastPlay;
      entry.visible = visible;
      entry.rate = clamp((spec.speed || 1) * (values?.speed ?? 1), 0.05, 8);
      entry.volume = clamp((spec.volume ?? 1) * (values?.volume ?? 1), 0, 1);

      const cue = frame?.media?.[object.id];
      if (cue && cue.cue !== entry.lastCue) {
        entry.lastCue = cue.cue;
        this.applyCue(entry, cue);
        // Перемотка и громкость не меняют состояние «играет/стоит»: иначе
        // следующий кадр считал бы это переключением и ставил паузу.
        if (cue.action === "play" || cue.action === "resume") entry.lastPlay = 1;
        else if (cue.action === "pause" || cue.action === "stop") entry.lastPlay = 0;
      } else if (play !== entry.lastPlay) {
        // Параметр `play` — это тоже запуск: так работает формула «играть,
        // когда говорю», без единой команды в скрипте.
        entry.lastPlay = play;
        if (play) this.begin(entry, true);
        else this.pause(entry);
      }

      // Файл мог догрузиться уже после команды «играть»: тогда источник
      // запускается здесь, иначе звук молчал бы до следующей команды.
      if (entry.source && entry.desired && spec.type === "audio" && !entry.voices.length) {
        this.startVoice(entry);
      }
      this.applySettings(entry);
      this.applyVisibility(entry);
    }
    for (const [id, entry] of this.entries) {
      if (alive.has(id)) continue;
      this.release(entry);
      this.entries.delete(id);
    }
  }

  /** Есть ли сейчас видео, которое надо перерисовывать кадр за кадром. */
  active(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.video && !entry.video.paused && !entry.video.ended) return true;
    }
    return false;
  }

  /** Элемент видео для отрисовки: спрайт показывает текущий кадр фильма. */
  video(id: string): HTMLVideoElement | null {
    const video = this.entries.get(id)?.video;
    return video && video.readyState >= 2 ? video : null;
  }

  /** Картинка медиа-объекта: PNG, GIF, WEBP — всё, что умеет браузер. */
  image(id: string): HTMLImageElement | null {
    const image = this.entries.get(id)?.image;
    return image && image.complete && image.naturalWidth > 0 ? image : null;
  }

  /** Останавливает всё: смена пресета, уход со страницы. */
  dispose(): void {
    for (const entry of this.entries.values()) this.release(entry);
    this.entries.clear();
  }

  private entry(id: string, spec: MediaSpec): Entry {
    const source = assetUrl(spec.src);
    const existing = this.entries.get(id);
    if (existing && existing.spec.src === spec.src && existing.spec.type === spec.type) {
      existing.spec = spec;
      // Ссылка на файл разрешилась позже — подключаем источник, не сбрасывая
      // состояние воспроизведения.
      if (!existing.source && source) {
        existing.source = source;
        this.attach(existing, spec, source);
      }
      return existing;
    }
    if (existing) {
      this.release(existing);
      this.entries.delete(id);
    }
    const entry: Entry = {
      spec,
      source,
      image: null,
      video: null,
      voices: [],
      lastCue: 0,
      lastPlay: spec.autoplay ? 1 : 0,
      desired: spec.autoplay,
      visible: true,
      rate: spec.speed || 1,
      volume: spec.volume ?? 1,
    };
    if (source) this.attach(entry, spec, source);
    this.entries.set(id, entry);
    // Автозапуск: пробуем сразу. Если браузер требует жест, повторные попытки
    // идут из `applyVisibility` на каждом кадре, пока воспроизведение не начнётся.
    if (spec.autoplay) this.begin(entry, false);
    return entry;
  }

  /** Создаёт элемент воспроизведения под готовый URL файла. */
  private attach(entry: Entry, spec: MediaSpec, source: string): void {
    if (spec.type === "video") {
      const video = document.createElement("video");
      video.src = source;
      video.loop = spec.loop;
      video.muted = spec.muted;
      video.playsInline = true;
      video.preload = "auto";
      video.volume = entry.volume;
      entry.video = video;
    } else if (spec.type === "image") {
      const image = new Image();
      image.decoding = "async";
      image.src = source;
      entry.image = image;
    }
  }

  private applyCue(entry: Entry, cue: MediaCue): void {
    switch (cue.action) {
      case "play":
        this.begin(entry, true);
        break;
      case "resume":
        this.begin(entry, false);
        break;
      case "pause":
        this.pause(entry);
        break;
      case "stop":
        this.stop(entry);
        break;
      case "seek":
        this.seek(entry, cue.arg);
        break;
      default:
        break;
    }
  }

  /**
   * Начать воспроизведение. `restart` — повторная активация события: политика
   * `repeat` решает, что делать с уже играющим звуком.
   */
  private begin(entry: Entry, restart: boolean): void {
    entry.desired = true;
    const spec = entry.spec;
    if (!entry.source || spec.type === "image") return;

    if (spec.type === "video") {
      const video = entry.video;
      if (!video) return;
      const playing = !video.paused && !video.ended;
      // «Доиграть» — единственная политика, которая отказывается от повтора.
      if (restart && spec.repeat === "finish" && playing) return;
      if (restart) {
        // У видео одна дорожка: накладывать второй источник нечего, поэтому
        // «наложить» и «прервать» для него означают одно — начать с начала.
        try { video.currentTime = 0; } catch { /* метаданные ещё не пришли */ }
      }
      void video.play().catch(() => { /* автозапуск без жеста запрещён */ });
      return;
    }

    const playing = entry.voices.filter((voice) => !voice.element.paused && !voice.element.ended);
    if (restart && spec.repeat === "finish" && playing.length) return;
    if (restart && playing.length) {
      if (spec.repeat === "fade") {
        this.stopVoices(entry, spec.fade);
      } else if (spec.repeat === "overlay") {
        const limit = Math.max(1, Math.floor(spec.voices) || 1);
        const active = entry.voices.filter((voice) => voice.timer === null);
        while (active.length >= limit) {
          const oldest = active.shift();
          if (!oldest) break;
          this.kill(entry, oldest);
        }
      } else {
        this.stopVoices(entry, 0);
      }
    }
    if (!restart && entry.voices.length) {
      for (const voice of entry.voices) {
        if (voice.element.paused) void voice.element.play().catch(() => {});
      }
      return;
    }
    this.startVoice(entry);
  }

  private startVoice(entry: Entry): void {
    const spec = entry.spec;
    if (!entry.source) return;
    const element = new Audio(entry.source);
    element.loop = spec.loop;
    element.volume = clamp(entry.volume, 0, 1);
    element.playbackRate = clamp(entry.rate, 0.05, 8);
    const voice: Voice = { element, timer: null };
    entry.voices.push(voice);
    void element.play().catch(() => { /* автозапуск без жеста запрещён */ });
  }

  private pause(entry: Entry): void {
    entry.desired = false;
    if (entry.video) entry.video.pause();
    for (const voice of entry.voices) voice.element.pause();
  }

  private stop(entry: Entry): void {
    entry.desired = false;
    if (entry.video) {
      entry.video.pause();
      try { entry.video.currentTime = 0; } catch { /* метаданные ещё не пришли */ }
    }
    this.stopVoices(entry, 0);
  }

  private seek(entry: Entry, seconds: number): void {
    const target = Math.max(0, seconds);
    if (entry.video) {
      try { entry.video.currentTime = target; } catch { /* метаданные ещё не пришли */ }
    }
    for (const voice of entry.voices) {
      try { voice.element.currentTime = target; } catch { /* метаданные ещё не пришли */ }
    }
  }

  /** Плавный уход: громкость снижается до нуля, затем источник освобождается. */
  private stopVoices(entry: Entry, fade: number): void {
    for (const voice of [...entry.voices]) {
      if (voice.timer !== null) {
        window.clearTimeout(voice.timer);
        voice.timer = null;
      }
      if (!(fade > 0)) {
        this.kill(entry, voice);
        continue;
      }
      const start = voice.element.volume;
      const started = performance.now();
      const step = () => {
        const progress = Math.min(1, (performance.now() - started) / (fade * 1000));
        voice.element.volume = clamp(start * (1 - progress), 0, 1);
        if (progress >= 1) {
          voice.timer = null;
          this.kill(entry, voice);
          return;
        }
        voice.timer = window.setTimeout(step, 30);
      };
      voice.timer = window.setTimeout(step, 30);
    }
  }

  private kill(entry: Entry, voice: Voice): void {
    if (voice.timer !== null) {
      window.clearTimeout(voice.timer);
      voice.timer = null;
    }
    voice.element.pause();
    voice.element.removeAttribute("src");
    voice.element.load();
    const index = entry.voices.indexOf(voice);
    if (index >= 0) entry.voices.splice(index, 1);
  }

  private applySettings(entry: Entry): void {
    const spec = entry.spec;
    if (entry.video) {
      entry.video.volume = clamp(entry.volume, 0, 1);
      entry.video.muted = spec.muted;
      entry.video.loop = spec.loop;
      entry.video.playbackRate = clamp(entry.rate, 0.05, 8);
    }
    for (const voice of entry.voices) {
      if (voice.timer !== null) continue;
      voice.element.loop = spec.loop;
      voice.element.volume = clamp(entry.volume, 0, 1);
      voice.element.playbackRate = clamp(entry.rate, 0.05, 8);
    }
  }

  /**
   * Невидимый объект молчит: глаз в структуре и `visible` из скрипта одинаково
   * останавливают звук, а когда объект снова виден — воспроизведение
   * продолжается с того же места.
   */
  private applyVisibility(entry: Entry): void {
    const elements: HTMLMediaElement[] = [];
    if (entry.video) elements.push(entry.video);
    for (const voice of entry.voices) elements.push(voice.element);
    for (const element of elements) {
      if (!entry.visible || !entry.desired) element.pause();
      else if (element.paused) void element.play().catch(() => { /* нужен жест */ });
    }
  }

  private release(entry: Entry): void {
    if (entry.video) {
      entry.video.pause();
      entry.video.removeAttribute("src");
      entry.video.load();
      entry.video = null;
    }
    entry.image = null;
    this.stopVoices(entry, 0);
    entry.voices = [];
  }
}
