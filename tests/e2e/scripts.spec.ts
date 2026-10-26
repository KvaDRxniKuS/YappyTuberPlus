import { expect, test } from "@playwright/test";
import { appendSnippet, eventNameFor, eventNames, eventSnippet } from "../../src/engine/scripts";

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
