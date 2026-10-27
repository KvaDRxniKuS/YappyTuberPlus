import { test, expect } from "@playwright/test";
import { countArrival, countDraw, countFrame, resetMeter, takeWork } from "../../src/engine/meter";

test("счётчик работы окна считает частоты и обнуляется на каждом замере", () => {
  resetMeter();
  for (let index = 0; index < 30; index += 1) countDraw();
  for (let index = 0; index < 10; index += 1) countFrame();
  countArrival();
  const rates = takeWork();
  // Окно замера очень короткое, поэтому сравниваем не абсолютные значения, а
  // соотношение: отрисовок втрое больше кадров, приходов — один.
  expect(rates.draws).toBeGreaterThan(0);
  expect(rates.frames).toBeGreaterThan(0);
  expect(rates.draws / rates.frames).toBeGreaterThan(2);
  expect(rates.draws / rates.frames).toBeLessThan(4);
  // Второй замер без работы — честные нули: иначе «простое» врало бы.
  const idle = takeWork();
  expect(idle).toEqual({ draws: 0, frames: 0, arrivals: 0 });
});
