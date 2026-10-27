import { useEffect, useRef, useState } from "react";
import { takeWork, type WorkRates } from "../engine/meter";

interface Ambient {
  /** Запущенные анимации (CSS и Web Animations): каждая гонит кадры сама по себе. */
  animations: number;
  /** Играющие медиаэлементы: видео и звук занимают процессор и без единой отрисовки. */
  playing: number;
  /** Задачи главного потока дольше 50 мс за секунду. */
  longTasks: number;
}

const EMPTY: WorkRates & Ambient = { draws: 0, frames: 0, arrivals: 0, animations: 0, playing: 0, longTasks: 0 };

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
      setWork({ ...rates, animations, playing, longTasks: longTasks.current });
      longTasks.current = 0;
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  const idle = work.draws === 0 && work.frames === 0 && work.arrivals === 0
    && work.animations === 0 && work.playing === 0 && work.longTasks === 0;
  return (
    <span
      className={`work-meter ${idle ? "idle" : "busy"}`}
      title="Живая работа окна в секунду: отрисовки сцены · кадры движка · кадры от планировщика · запущенные анимации · играющие видео и звук · долгие задачи главного потока. В паузе и стопе — нули."
    >
      {work.draws} рис · {work.frames} кадр · {work.arrivals} вход · {work.animations} аним · {work.playing} медиа
      {work.longTasks > 0 ? ` · ${work.longTasks} задерж` : ""}
    </span>
  );
}
