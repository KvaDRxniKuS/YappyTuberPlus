import { expect, test } from "@playwright/test";
import {
  EMPTY_MEMORY, growthPerMinute, heapPressure, megabytes, megapixels, memoryText,
  readMemory, summarizeCanvases, summarizeMedia,
} from "../../src/engine/memory";

/*
 * Память окна: только те числа, у которых понятно происхождение.
 *
 * Тесты держат две вещи, на которых легко соврать в диагностике:
 * 1. **Пустой ответ — не ноль.** Пока истории мало, роста «нет» сказать нельзя:
 *    `null` значит «не измерено», а ноль значил бы «проверено, роста нет».
 * 2. **Куча — не память приложения.** Предел V8 печатается рядом с занятым, а
 *    холсты и ресурсы считаются отдельно: у них своя память вне кучи.
 */

test("память: холсты и медиа считают площадь и пропускают пустые размеры", () => {
  expect(summarizeCanvases([{ width: 1920, height: 1080 }, { width: 100, height: 50 }]))
    .toEqual({ canvases: 2, canvasPixels: 1920 * 1080 + 5000 });
  // Медиа без кадра (`videoWidth` = 0), битые и отрицательные размеры не в счёте
  // пикселей, но сам элемент остаётся: он всё равно занимает ресурсы.
  expect(summarizeMedia([
    { width: 0, height: 0 },
    { width: 1280, height: 720 },
    { width: Number.NaN, height: 10 },
    { width: -4, height: 10 },
  ])).toEqual({ media: 4, mediaPixels: 1280 * 720 });
  expect(summarizeCanvases([])).toEqual({ canvases: 0, canvasPixels: 0 });
});

test("память: мегабайты и мегапиксели округляются до одного знака", () => {
  expect(megabytes(1024 * 1024)).toBe(1);
  expect(megabytes(1.5 * 1024 * 1024)).toBe(1.5);
  expect(megabytes(0)).toBe(0);
  expect(megabytes(-5)).toBe(0);
  expect(megabytes(Number.NaN)).toBe(0);
  expect(megapixels(1920 * 1080)).toBe(2.1);
  expect(megapixels(0)).toBe(0);
});

test("память: доля кучи известна только при известном пределе", () => {
  expect(heapPressure(EMPTY_MEMORY)).toBeNull();
  expect(heapPressure({ ...EMPTY_MEMORY, heapUsed: 512, heapLimit: 2048 })).toBe(0.25);
  // Занятое больше предела не даёт «110 %»: доля ограничена единицей.
  expect(heapPressure({ ...EMPTY_MEMORY, heapUsed: 4096, heapLimit: 2048 })).toBe(1);
});

test("память: рост за минуту — не ноль, пока истории мало", () => {
  // Один замер: сравнивать не с чем.
  expect(growthPerMinute([])).toBeNull();
  expect(growthPerMinute([{ at: 1000, bytes: 100 }])).toBeNull();
  // Десять секунд истории — ещё не минута: молчим, а не пишем «0».
  expect(growthPerMinute([{ at: 0, bytes: 0 }, { at: 10_000, bytes: 10 * 1024 * 1024 }])).toBeNull();

  const mb = 1024 * 1024;
  // Ровно минута, +60 МБ: это и есть +60 МБ/мин.
  expect(growthPerMinute([{ at: 0, bytes: 100 * mb }, { at: 60_000, bytes: 160 * mb }]))
    .toBe(60 * mb);
  // Падение тоже видно: память умеет и отдаваться.
  expect(growthPerMinute([{ at: 0, bytes: 160 * mb }, { at: 60_000, bytes: 100 * mb }]))
    .toBe(-60 * mb);
  // Старые замеры за окном не учитываются: считаем последнюю минуту, а не всё.
  expect(growthPerMinute([
    { at: 0, bytes: 10 * mb },
    { at: 100_000, bytes: 200 * mb },
    { at: 160_000, bytes: 260 * mb },
  ])).toBe(60 * mb);
});

test("память: строка статуса печатает предел кучи рядом с занятым", () => {
  const base = {
    ...EMPTY_MEMORY,
    heapUsed: 300 * 1024 * 1024,
    heapLimit: 4096 * 1024 * 1024,
    canvases: 3,
    canvasPixels: 1920 * 1080 * 3,
    resourcesBytes: 64 * 1024 * 1024,
    domNodes: 1234,
  };
  const text = memoryText(base);
  expect(text).toContain("JS 300/4096 МБ");
  expect(text).toContain("холст 3");
  expect(text).toContain("ресурсы ≈64 МБ");
  expect(text).toContain("DOM 1234");
  // Без предела браузер не выдаёт цифру, которую мы не знаем.
  expect(memoryText({ ...base, heapLimit: 0 })).toContain("JS 300 МБ");
  // Пустой замер не превращается в «·  · ».
  expect(memoryText(EMPTY_MEMORY)).toBe("");
});

test("память: в Node замер не падает и не выдумывает числа", () => {
  const memory = readMemory();
  expect(memory.heapUsed).toBe(0);
  expect(memory.domNodes).toBe(0);
  expect(memory.canvases).toBe(0);
  expect(memory.resourcesBytes).toBeGreaterThanOrEqual(0);
});
