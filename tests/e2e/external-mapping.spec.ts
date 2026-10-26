import { expect, test } from "@playwright/test";
import { applyMapping, applyRule, readExternalSource } from "../../src/modules/external";
import type { ExternalSourceRule } from "../../src/types";

/**
 * Таблица отображения внешнего источника.
 *
 * В ней два преобразования и ни одного больше: границы `min`/`max` и удержание
 * `holdMs`. Множителя и смещения нет намеренно — источник отдаёт число в своих
 * единицах (баллы, bits, удары в минуту), вход принимает его как есть, а шкалу
 * меняет скрипт. Удержание нужно событиям: пакет живёт один кадр.
 */

function rule(patch: Partial<ExternalSourceRule> = {}): ExternalSourceRule {
  return { input: "value", path: "$.value", kind: "level", min: 0, max: 1000, holdMs: 0, ...patch };
}

test("число проходит как есть: ни множителя, ни смещения", () => {
  // Bits пришли сотней — вход читает сотню, а не 0.01: шкалу меняет скрипт.
  expect(applyRule(rule({ max: 100_000 }), 100)).toBe(100);
  expect(applyRule(rule({ max: 220 }), 72)).toBe(72);
  // Старые пресеты могли сохранить `scale`/`offset` — они просто не читаются.
  const legacy = readExternalSource({
    source: {
      transport: "ws",
      url: "ws://127.0.0.1:17801/inputs",
      mapping: [{ input: "hr", path: "$.hr", min: 0, max: 220, scale: 0.5, offset: -10 }],
    },
  });
  expect(legacy.mapping[0]).not.toHaveProperty("scale");
  expect(legacy.mapping[0]).not.toHaveProperty("offset");
  expect(applyRule(legacy.mapping[0], 72)).toBe(72);
});

test("границы остаются: значение обрезается по min/max", () => {
  expect(applyRule(rule({ min: 0, max: 1 }), 5)).toBe(1);
  expect(applyRule(rule({ min: 0, max: 1 }), -3)).toBe(0);
  // Пульс в ударах в минуту ограничен своим пределом, а не долей.
  expect(applyRule(rule({ min: 30, max: 220 }), 12)).toBe(30);
});

test("удержание — единственное состояние строки: сколько держать, столько и помним", () => {
  const mapped = applyMapping(
    { bits: 500, cost: 300 },
    [
      rule({ input: "cheer", path: "$.bits", max: 100_000, holdMs: 2500 }),
      // Награда без удержания: чистое число, гасить нечего.
      rule({ input: "reward", path: "$.cost", max: 1_000_000, holdMs: 0 }),
    ],
  );
  expect(mapped).toEqual({ cheer: 500, reward: 300 });
});

test("условие строки и запасное значение работают без преобразований", () => {
  const mapping = [
    rule({
      input: "follow", path: "$.followed_at", kind: "flag", max: 1, holdMs: 4000, fallback: 1,
      when: { path: "$.followed_at" },
    }),
    rule({ input: "cmd", path: "$.text", kind: "flag", max: 1, fallback: 1, when: { path: "$.text", contains: "!dance", ignoreCase: true } }),
  ];
  // У фоллова в поле дата, а не число: «событие пришло» — это единица.
  expect(applyMapping({ followed_at: "2026-10-26T10:00:00Z" }, mapping)).toEqual({ follow: 1 });
  expect(applyMapping({ text: "!Dance" }, mapping)).toEqual({ cmd: 1 });
  expect(applyMapping({ text: "привет" }, mapping)).toEqual({});
});
