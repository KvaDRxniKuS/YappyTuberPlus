import { expect, test } from "@playwright/test";
import { bridgeUrlFromLocation, isAppOrigin } from "../../src/overlay/protocol";
import { relayUrlFromServer } from "../../src/overlay/window";

/**
 * Адрес релея оверлея.
 *
 * Ошибка, из-за которой оверлей не подключался в приложении: адрес моста
 * угадывался из `location`, и редактор в окне Tauri стучался в
 * `ws://tauri.localhost/overlay-ws`. Такого сокета нет — релей живёт на
 * встроенном сервере (`127.0.0.1:17800`). Здесь закреплено, какой адрес
 * получает каждая из трёх страниц: окно приложения, источник OBS и браузер.
 */

const APP_PAGES = [
  "http://tauri.localhost/overlay.html?overlay=1",
  "https://tauri.localhost/overlay.html",
  "tauri://localhost/overlay.html",
  "http://ipc.localhost/",
  "asset://localhost/overlay.html",
];

test("окно приложения не выдумывает мост по своему адресу", () => {
  for (const page of APP_PAGES) {
    const location = new URL(page);
    expect(isAppOrigin(location), page).toBe(true);
    // null означает «мост берём у встроенного сервера», а не «моста нет».
    expect(bridgeUrlFromLocation(location.search, location), page).toBeNull();
  }
});

test("браузер и источник OBS берут мост с того же хоста", () => {
  const dev = new URL("http://localhost:5173/overlay.html?overlay=1");
  expect(isAppOrigin(dev)).toBe(false);
  expect(bridgeUrlFromLocation(dev.search, dev)).toBe("ws://localhost:5173/overlay-ws");

  // Страница встроенного сервера: её же адрес и есть релей.
  const obs = new URL("http://127.0.0.1:17800/overlay.html?overlay=1&guide=1");
  expect(bridgeUrlFromLocation(obs.search, obs)).toBe("ws://127.0.0.1:17800/overlay-ws");

  const secure = new URL("https://preview.example/overlay.html");
  expect(bridgeUrlFromLocation(secure.search, secure)).toBe("wss://preview.example/overlay-ws");
});

test("явный адрес и выключенный транспорт важнее догадок", () => {
  const page = new URL("http://localhost:5173/overlay.html");
  expect(bridgeUrlFromLocation("?bridge=ws://127.0.0.1:9000/relay", page))
    .toBe("ws://127.0.0.1:9000/relay");
  // `transport=broadcast|tauri` — «мост не поднимать», даже в браузере.
  expect(bridgeUrlFromLocation("?transport=tauri", page)).toBeNull();
  expect(bridgeUrlFromLocation("?transport=broadcast", page)).toBeNull();
  // В окне приложения явный адрес тоже главнее.
  const app = new URL("http://tauri.localhost/overlay.html");
  expect(bridgeUrlFromLocation("?bridge=ws://127.0.0.1:17800/overlay-ws", app))
    .toBe("ws://127.0.0.1:17800/overlay-ws");
});

test("адрес релея выводится из адреса встроенного сервера", () => {
  expect(relayUrlFromServer("http://127.0.0.1:17800/overlay.html"))
    .toBe("ws://127.0.0.1:17800/overlay-ws");
  // `0.0.0.0` — адрес прослушивания: подключаться к нему нельзя.
  expect(relayUrlFromServer("http://0.0.0.0:17800/overlay.html"))
    .toBe("ws://127.0.0.1:17800/overlay-ws");
  expect(relayUrlFromServer("https://overlay.example/overlay.html"))
    .toBe("wss://overlay.example/overlay-ws");
  // Переменные адреса из `YTP_OVERLAY_WEB` не ломают путь релея.
  expect(relayUrlFromServer("http://localhost:18000/custom/page.html?x=1#top"))
    .toBe("ws://localhost:18000/overlay-ws");
  expect(relayUrlFromServer("не адрес")).toBeNull();
});
