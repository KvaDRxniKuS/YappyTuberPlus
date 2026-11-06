import { useEffect, useRef, useState } from "react";
import { readCapture, takeWork, type WorkRates } from "../engine/meter";
import {
  EMPTY_MEMORY, growthPerMinute, heapPressure, megabytes, memoryText,
  readMemory, type MemorySnapshot,
} from "../engine/memory";

interface Ambient {
  /** Запущенные анимации (CSS и Web Animations): каждая гонит кадры сама по себе. */
  animations: number;
  /** Играющие медиаэлементы: видео и звук занимают процессор и без единой отрисовки. */
  playing: number;
  /** Задачи главного потока дольше 50 мс за секунду. */
  longTasks: number;
  /** Сколько холстов в документе и сколько памяти занимают их битмапы. */
  canvases: number;
  canvasMb: number;
  /** Живой захват звука: микрофоны, которые сейчас слушаются. */
  mic: number;
  /** Замер памяти этого окна: куча, холсты, медиа и наша оценка ресурсов. */
  memory: MemorySnapshot;
  /** Рост «куча + ресурсы» за минуту, байты. `null` — истории ещё мало. */
  growth: number | null;
}

const EMPTY: WorkRates & Ambient = {
  draws: 0, frames: 0, arrivals: 0, animations: 0, playing: 0, longTasks: 0,
  canvases: 0, canvasMb: 0, mic: 0, memory: EMPTY_MEMORY, growth: null,
};

/** Сколько замеров держим для оценки роста: минута при шаге в секунду. */
const HISTORY = 60;

/**
 * Подсказка к счётчику памяти.
 *
 * Числа здесь честные, а значит неполные: объём процессов WebView2 и
 * видеопамять знает только ОС. Об этом сказано прямо, иначе «JS 300 МБ» при
 * четырёх гигабайтах в диспетчере выглядит как ошибка счётчика.
 */
function memoryHint(memory: MemorySnapshot, growth: number | null): string {
  const rows = ["Память окна:"];
  if (memory.heapLimit > 0) {
    const share = Math.round((heapPressure(memory) ?? 0) * 100);
    rows.push(`· V8-куча: ${Math.round(megabytes(memory.heapUsed))} МБ из предела `
      + `${Math.round(megabytes(memory.heapLimit))} МБ (${share} %) — объекты JS, не картинки;`);
  } else {
    rows.push("· V8-куча: браузер не сообщает (в нативном окне `performance.memory` может быть скрыт);");
  }
  rows.push(`· холсты: ${memory.canvases} шт., ${Math.round(megabytes(memory.canvasPixels * 4))} МБ битмапов;`);
  rows.push(`· медиа: ${memory.media} элем., кадры ${memory.mediaPixels} px;`);
  rows.push(`· наши ресурсы: ≈${Math.round(megabytes(memory.resourcesBytes))} МБ (картинки, текстуры, буферы);`);
  rows.push(`· DOM: ${memory.domNodes} узлов.`);
  if (growth !== null) {
    const perMinute = Math.round(growth / (1024 * 1024));
    rows.push(perMinute > 0
      ? `· рост «куча + ресурсы»: +${perMinute} МБ/мин — если не падает после простоя, это утечка.`
      : "· роста «куча + ресурсы» за минуту нет.");
  }
  rows.push("Это не вся память WebView: процессы browser/GPU/renderer и видеопамять");
  rows.push("считает только ОС. Числа ничего не ограничивают — предел V8 задаётся");
  rows.push("флагом `--js-flags=--max-old-space-size`, а холсты и текстуры живут вне кучи.");
  return rows.join("\n");
}

/**
 * Живая работа окна в строке статуса.
 *
 * Считает не только наши отрисовки и кадры движка, но и то, что греет WebView
 * мимо кода редактора: запущенные анимации и играющие медиаэлементы. В паузе и
 * в стопе все числа обязаны быть нулями — если это не так, процессор греет
 * именно то, что показывает счётчик.
 *
 * Компонент обновляется сам, раз в секунду, и живёт отдельно от `App`:
 * диагностика не должна перерисовывать редактор.
 */
export function WorkMeter() {
  const [work, setWork] = useState<WorkRates & Ambient>(EMPTY);
  const longTasks = useRef(0);
  /** История «куча + ресурсы»: по ней видно, растёт память или стоит. */
  const history = useRef<Array<{ at: number; bytes: number }>>([]);
  useEffect(() => {
    // Долгие задачи видны только через PerformanceObserver и не во всех движках.
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => { longTasks.current += list.getEntries().length; });
      observer.observe({ entryTypes: ["longtask"] });
    } catch { observer = null; }
    return () => observer?.disconnect();
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const rates = takeWork();
      let animations = 0;
      try {
        animations = document.getAnimations().filter((animation) => animation.playState === "running").length;
      } catch { animations = 0; }
      let playing = 0;
      for (const element of Array.from(document.querySelectorAll("audio, video"))) {
        if (!(element as HTMLMediaElement).paused) playing += 1;
      }
      const memory = readMemory();
      const samples = history.current;
      samples.push({ at: performance.now(), bytes: memory.heapUsed + memory.resourcesBytes });
      if (samples.length > HISTORY) samples.splice(0, samples.length - HISTORY);
      setWork({
        ...rates,
        animations,
        playing,
        longTasks: longTasks.current,
        canvases: memory.canvases,
        canvasMb: Math.round(megabytes(memory.canvasPixels * 4)),
        mic: readCapture().streams,
        memory,
        growth: growthPerMinute(samples),
      });
      longTasks.current = 0;
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  const idle = work.draws === 0 && work.frames === 0 && work.arrivals === 0
    && work.animations === 0 && work.playing === 0 && work.longTasks === 0 && work.mic === 0;
  const memory = work.memory;
  const growthMb = work.growth === null ? null : Math.round(work.growth / (1024 * 1024));
  return (
    <span
      className={`work-meter ${idle ? "idle" : "busy"}`}
      title={memoryHint(memory, work.growth)}
    >
      {work.draws} рис · {work.frames} кадр · {work.arrivals} вход · {work.animations} аним · {work.playing} медиа
      {work.mic > 0 ? ` · ${work.mic} мик` : ""}
      {memoryText(memory) ? ` · ${memoryText(memory)}` : ""}
      {growthMb !== null ? ` · ${growthMb > 0 ? "+" : ""}${growthMb} МБ/мин` : ""}
      {work.longTasks > 0 ? ` · ${work.longTasks} задерж` : ""}
    </span>
  );
}
