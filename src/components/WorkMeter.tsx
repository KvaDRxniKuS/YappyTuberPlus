import { useEffect, useState } from "react";
import { takeWork, type WorkRates } from "../engine/meter";

/**
 * Живая работа окна в строке статуса: «рисунок/кадры/приходы» в секунду.
 *
 * Компонент обновляется сам, раз в секунду, и живёт отдельно от `App`:
 * диагностика не должна перерисовывать редактор. В паузе и в стопе все три
 * числа обязаны быть нулями — если это не так, процессор греет именно то, что
 * показывает счётчик.
 */
export function WorkMeter() {
  const [rates, setRates] = useState<WorkRates>({ draws: 0, frames: 0, arrivals: 0 });
  useEffect(() => {
    const timer = window.setInterval(() => setRates(takeWork()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const idle = rates.draws === 0 && rates.frames === 0 && rates.arrivals === 0;
  return (
    <span
      className={`work-meter ${idle ? "idle" : "busy"}`}
      title="Живая работа окна: отрисовки сцены · кадры движка · кадры, пришедшие от планировщика. В паузе и стопе — нули."
    >
      {rates.draws} рис · {rates.frames} кадр · {rates.arrivals} вход
    </span>
  );
}
