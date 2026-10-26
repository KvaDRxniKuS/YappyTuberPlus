import { expect, test } from "@playwright/test";
import { externalUrl, openExternal } from "../../src/engine/links";
import { TWITCH_APPS, TWITCH_VERIFY } from "../../src/modules/twitch";

/**
 * Ссылки из интерфейса открываются системным браузером.
 *
 * Проверяем то, что можно проверить без окна: адрес принимается только веб и
 * только «чистый» — строка уходит в системную команду, поэтому посторонние
 * символы в ней недопустимы. Само открытие в браузере — руками.
 */

test("ссылки модуля Twitch — обычные веб-адреса", () => {
  // Консоль разработчика: рядом с полем Client ID стоит именно этот адрес.
  expect(TWITCH_APPS).toBe("https://dev.twitch.tv/console/apps");
  expect(externalUrl(TWITCH_APPS)).toBe(TWITCH_APPS);
  expect(externalUrl(TWITCH_VERIFY)).toBe(TWITCH_VERIFY);
});

test("внешними считаются только http и https", () => {
  expect(externalUrl("https://dev.twitch.tv/console/apps")).toBe("https://dev.twitch.tv/console/apps");
  expect(externalUrl("  http://127.0.0.1:17800/overlay.html  ")).toBe("http://127.0.0.1:17800/overlay.html");
  expect(externalUrl("javascript:alert(1)")).toBeNull();
  expect(externalUrl("file:///C:/Windows/System32/calc.exe")).toBeNull();
  expect(externalUrl("cmd://start")).toBeNull();
  expect(externalUrl("")).toBeNull();
});

test("в адресе не остаётся символов системной команды", () => {
  // Иначе строка вроде этой выполнила бы вторую команду в оболочке Windows.
  expect(externalUrl("https://example.com/&calc.exe")).toBeNull();
  expect(externalUrl("https://example.com/|start")).toBeNull();
  expect(externalUrl("https://example.com/\"quoted\"")).toBeNull();
  expect(externalUrl("https://example.com/a\nb")).toBeNull();
  expect(externalUrl("https://example.com/;rm -rf")).toBeNull();
});

test("недопустимый адрес не открывается", async () => {
  // В Node нет окна: функция обязана вернуть «не открылось», а не упасть.
  await expect(openExternal("javascript:alert(1)")).resolves.toBe(false);
  await expect(openExternal("https://dev.twitch.tv/console/apps")).resolves.toBe(false);
});
