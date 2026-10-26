import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { textChannel, resolveTemplate } from "../../src/render/text";
import { inputMeta, inputTexts, textInputName } from "../../src/modules/values";
import { readExternalSource } from "../../src/modules/external";
import { INPUT_FIELDS, hintAt } from "../../src/engine/signatures";
import { moduleDefaults, moduleDefinition, normalizeDefinition, registerDefinitions } from "../../src/modules/registry";
import type { ExternalTextLine } from "../../src/modules/sources";
import type { ModuleInstance } from "../../src/types";

/**
 * Текстовый канал, паспорта входов и подсказка событий.
 *
 * Проверяем то, что видит скрипт: какое сообщение станет «последним», как
 * читается история, откуда берутся границы входа и что показывает подсказка
 * при наборе заголовка события.
 */

test.beforeAll(() => {
  const directory = join(process.cwd(), "public", "modules");
  const index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")) as { modules: string[] };
  const definitions = index.modules
    .map((id) => normalizeDefinition(JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"))))
    .filter((definition) => definition !== null);
  registerDefinitions(definitions);
});

function twitchModule(source: Record<string, unknown> = {}): ModuleInstance {
  const definition = moduleDefinition("twitch");
  const defaults = moduleDefaults(definition) as Record<string, unknown>;
  const base = (defaults.source ?? {}) as Record<string, unknown>;
  return {
    name: "twitch",
    type: "twitch",
    enabled: true,
    source: "live",
    config: { ...defaults, source: { ...base, ...source } },
  };
}

test("шаблон берёт последнее сообщение, а не самое старое из буфера", () => {
  // Журнал держит свежие строки первыми: «третье» — последнее сообщение.
  const lines: ExternalTextLine[] = [
    { at: 3, text: "третье", author: "боб" },
    { at: 2, text: "второе", author: "ада" },
    { at: 1, text: "первое", author: "ада" },
  ];
  const channel = textChannel({ twitch: lines });
  expect(channel.twitch).toEqual({ text: "третье", author: "боб" });
  expect(resolveTemplate("{twitch.chat.user}: {twitch.chat.message}", channel)).toBe("боб: третье");
});

test("в ядро история уходит от старых к свежим и в пределах настройки", () => {
  const lines: ExternalTextLine[] = [
    { at: 3, text: "третье", author: "боб" },
    { at: 2, text: "второе", author: "ада" },
    { at: 1, text: "первое", author: "ада" },
  ];
  const texts = inputTexts([twitchModule({ text: { path: "$.text", input: "chat", history: 2 } })], { twitch: lines });
  // Свежие — в конце: message() = последнее, message(-1) = предыдущее.
  expect(texts["twitch.chat"].lines.map((line) => line.text)).toEqual(["второе", "третье"]);
  expect(texts["twitch.chat"].lines[1].author).toBe("боб");
});

test("вход текста берётся из настройки, иначе — из строки-счётчика", () => {
  expect(textInputName(twitchModule())).toBe("chat");
  const custom = twitchModule({ text: { path: "$.text", input: "reward" } });
  expect(textInputName(custom)).toBe("reward");
  expect(inputTexts([custom], { twitch: [{ at: 1, text: "раз", author: "ада" }] })).toEqual({
    "twitch.reward": { lines: [{ text: "раз", author: "ада" }] },
  });
  // Без истории ключа нет: движок знает вход по паспорту и отдаёт пустую строку.
  expect(inputTexts([twitchModule()], {})).toEqual({});
});

test("паспорт входа: подпись, границы, шаг и вид", () => {
  const meta = inputMeta([twitchModule()]);
  expect(meta["twitch.chat"]).toEqual({ label: "Сообщений", min: 0, max: 1_000_000, step: 1, kind: "level" });
  expect(meta["twitch.follow"].min).toBe(0);
  expect(meta["twitch.follow"].max).toBe(1);
});

test("настройки текста переживают чтение конфигурации", () => {
  const source = readExternalSource(twitchModule().config as Record<string, unknown>);
  expect(source.text).toEqual({
    path: "$.payload.event.message.text",
    authorPath: "$.payload.event.chatter_user_name",
    input: "chat",
    history: 12,
    showAuthor: true,
  });
  // Мусор в истории зажимается в 1…100, а не ломает модуль.
  const clamped = readExternalSource(
    twitchModule({ text: { path: "$.text", history: 1000, showAuthor: false } }).config as Record<string, unknown>,
  );
  expect(clamped.text?.history).toBe(100);
  expect(clamped.text?.showAuthor).toBe(false);
});

test("подсказка события объясняет новую форму по месту курсора", () => {
  const inputs = [{ key: "twitch.chat", label: "Сообщений" }, { key: "mic.db", label: "Громкость" }];
  const events = ["click", "chat"];

  // `on` — только объявленные события: путей к входам больше нет.
  const onEmpty = hintAt("on ", 3, { inputs, events });
  expect(onEmpty).toContain("on start");
  expect(onEmpty).toContain("click");
  expect(hintAt("on cli", "on cli".length, { inputs, events })).toContain("on click");

  // Старая форма записи — прямо говорим, что так не пишется.
  const old = hintAt("on mic.db.down", "on mic.db.down".length, { inputs, events });
  expect(old).toContain("event имя()");

  // Своё событие: форма, переменные, `in`.
  expect(hintAt("event ", "event ".length, { inputs, events })).toContain("event имя(переменные ; пауза)");
  expect(hintAt("event kick(loud = 1", "event kick(loud = 1".length, { inputs, events }))
    .toContain("пауза");
  const duration = "event kick() { mic.talking > 0.2 in ";
  expect(hintAt(duration, duration.length, { inputs, events })).toContain("in 0.5s");

  // Поля входа: направления уровня и активность за окно.
  const fields = hintAt("event chat() { twitch.chat.", "event chat() { twitch.chat.".length, { inputs, events });
  expect(fields).toContain("Сообщений");
  expect(fields).toContain("up · down · change");
  expect(fields).toContain("count(5)");

  // Вне событий подсказка не мешает вызову функции.
  expect(hintAt("text = fixed(mic.db, 2)", 12, { inputs, events })).toBeNull();
});

test("поля входа в подсказке — ровно те, что понимает ядро", () => {
  expect(INPUT_FIELDS.map((item) => item.field)).toEqual([
    "up", "down", "change", "count(5)", "sum(5)", "avg(5)",
  ]);
});
