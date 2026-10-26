import { expect, test } from "@playwright/test";
import {
  appendSnippet, describeIssues, eventNameFor, eventNames, eventSnippet, freeEventName,
  issueSpans, issueTarget, scopeTitle,
} from "../../src/engine/scripts";

/**
 * Блоки событий из панели «Входы».
 *
 * Кнопка — не учебный пример, а рабочая вставка: она должна давать скрипт,
 * который ядро примет сразу. Поэтому имя события из ключа входа
 * (`twitch.chat` → `twitch_chat`) и освобождение занятого имени проверяются
 * здесь, а не глазами.
 */

test("имя события собирается из ключа входа без точек", () => {
  expect(eventNameFor("twitch.chat")).toBe("twitch_chat");
  expect(eventNameFor("mouse.left")).toBe("mouse_left");
  // Дефисы и прочее, чего не бывает в имени, тоже становятся подчёркиваниями.
  expect(eventNameFor("pulse.hr-delta")).toBe("pulse_hr_delta");
});

test("заготовка события — объявление и обработчик", () => {
  expect(eventSnippet("click", "mouse.left.up")).toBe(
    "event click() { mouse.left.up }\non click {\n  \n}",
  );
});

test("вставка не создаёт второе событие с тем же именем", () => {
  const first = appendSnippet("", eventSnippet("twitch_chat", "twitch.chat.up"));
  expect(first).toContain("event twitch_chat() { twitch.chat.up }");
  expect(first).toContain("on twitch_chat {");

  // Второй блок того же входа — уже другое имя, иначе ядро ответило бы
  // «событие уже объявлено» прямо в скрипте пользователя.
  const second = appendSnippet(first, eventSnippet("twitch_chat", "twitch.chat.down"));
  expect(second).toContain("event twitch_chat_2() { twitch.chat.down }");
  expect(second).toContain("on twitch_chat_2 {");
  // Первый блок не тронут.
  expect(second).toContain("event twitch_chat() { twitch.chat.up }");
  expect(eventNames(second)).toEqual(["twitch_chat", "twitch_chat_2"]);

  // Третий — `_3`, а не повтор `_2`.
  const third = appendSnippet(second, eventSnippet("twitch_chat", "twitch.chat.change"));
  expect(eventNames(third)).toEqual(["twitch_chat", "twitch_chat_2", "twitch_chat_3"]);
  // `on` и `event` переименованы вместе: иначе подписка смотрела бы в пустоту.
  expect(third).not.toContain("event twitch_chat() { twitch.chat.change }");
});

test("свободное имя не переименовывается", () => {
  const snippet = eventSnippet("speak", "mic.talking > 0.2 in 500");
  expect(appendSnippet("a = 0", snippet)).toContain("event speak()");
});

test("блок без объявления события дописывается как есть", () => {
  // Заготовка может быть просто обработчиком: `on start { … }`.
  expect(appendSnippet("a = 0", "on start {\n  a = 1\n}")).toBe(
    "a = 0\n\non start {\n  a = 1\n}\n",
  );
});

test("занятое имя освобождается и для блока из шпаргалки", () => {
  // Шпаргалка вставляет блок в позицию курсора, а не в конец: имя проверяется
  // по всему тексту, а не по соседней строке.
  const snippet = eventSnippet("click", "mouse.left.up");
  expect(freeEventName("", snippet)).toBe(snippet);
  const taken = appendSnippet("a = 0", snippet);
  const second = freeEventName(taken, snippet);
  expect(second).toContain("event click_2() { mouse.left.up }");
  expect(second).toContain("on click_2 {");
  // Чужой текст не переписывается: в нём остаётся первый блок как есть.
  expect(second).not.toContain("event click()");
});

test("подсветка конфликта имён ставится на обе строки", () => {
  // Своя строка — точным диапазоном из ядра, вторая — целиком и только если она
  // в этом же тексте: чужой скрипт редактор не показывает.
  const source = "event clap() { mouse.left.up }\nx = 5\nevent boom(x = 1) { mouse.right.up }";
  const spans = issueSpans(
    source,
    [
      { line: 1, column: 1, length: 12, message: "первое", related: { scope: "head", line: 2 } },
      { line: 3, column: 1, length: 5, message: "второе", related: { scope: "globals", line: 1 } },
    ],
    "head",
  );
  // Сверяем не числа, а текст: смещения зависят от длины строк, а смысл — нет.
  expect(spans.map((span) => source.slice(span.from, span.to))).toEqual([
    "event clap()",
    // Строка 2 (`x = 5`) — вторая декларация: она в этом же скрипте.
    "x = 5",
    "event",
  ]);
  expect(spans.map((span) => span.related)).toEqual([false, true, false]);
});

test("второе объявление в другом скрипте здесь не подчёркивается", () => {
  const spans = issueSpans(
    "event clap() { mouse.left.up }",
    [{ line: 1, column: 1, length: 30, message: "занято", related: { scope: "globals", line: 4 } }],
    "head",
  );
  expect(spans).toEqual([{ from: 0, to: 30, related: false }]);
});

test("сообщение под редактором называет первое место и считает остальные", () => {
  expect(describeIssues([])).toBe("");
  expect(describeIssues([{ line: 1, column: 1, length: 3, message: "одна" }])).toBe("одна");
  expect(describeIssues([
    { line: 1, column: 1, length: 3, message: "одна" },
    { line: 2, column: 1, length: 3, message: "две" },
  ])).toBe("одна · ещё 1");
});

test("клик по ошибке ведёт ко второму объявлению в другом скрипте", () => {
  // Вторая строка в этом же тексте уже подчёркнута — переходить некуда.
  expect(issueTarget(
    [{ line: 1, column: 1, length: 5, message: "м", related: { scope: "head", line: 2 } }],
    "head",
  )).toBeNull();
  // А если она в глобальном скрипте — ведём туда.
  expect(issueTarget(
    [{ line: 1, column: 1, length: 5, message: "м", related: { scope: "globals", line: 7 } }],
    "head",
  )).toEqual({ scope: "globals", line: 7 });
  // У ошибки без второго места перехода нет вовсе.
  expect(issueTarget([{ line: 1, column: 1, length: 3, message: "м" }], "head")).toBeNull();
  // Несколько ошибок: берём первую, где есть куда идти.
  expect(issueTarget([
    { line: 1, column: 1, length: 3, message: "без места" },
    { line: 2, column: 1, length: 3, message: "в объект", related: { scope: "arm", line: 9 } },
  ], "head")).toEqual({ scope: "arm", line: 9 });
});

test("область называется как файл", () => {
  expect(scopeTitle("globals")).toBe("globals.rig");
  expect(scopeTitle("head")).toBe("head.rig");
});
