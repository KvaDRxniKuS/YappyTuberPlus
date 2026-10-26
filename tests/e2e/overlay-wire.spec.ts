import { expect, test } from "@playwright/test";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { AddressInfo } from "node:net";
import { CompositeBus, WebSocketBus } from "../../src/overlay/bus";
import { OverlayHost } from "../../src/overlay/host";
import { OverlayClient } from "../../src/overlay/client";
import type { RigFrame, RigPreset } from "../../src/types";

/**
 * Провод оверлея целиком: редактор и оверлей в разных процессах, единственный
 * транспорт — WebSocket-релей (так работает источник браузера в OBS и окно
 * приложения, если оно подключается к встроенному серверу).
 *
 * Тест ловит именно ту поломку, из-за которой диалог писал «Оверлей не
 * подключён»: протокол цел, но редактор публиковал кадры в адрес, где релея
 * нет. Здесь релей настоящий — простая пересылка JSON, как в
 * `src-tauri/src/overlay_server.rs`.
 */

async function relay() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const clients = new Set<WsSocket>();
  server.on("connection", (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("message", (data) => {
      for (const client of clients) {
        // Релей не возвращает сообщение отправителю — как встроенный сервер.
        if (client !== socket && client.readyState === 1) client.send(String(data));
      }
    });
  });
  const port = (server.address() as AddressInfo).port;
  return { server, clients, url: `ws://127.0.0.1:${port}/overlay-ws` };
}

function preset(): RigPreset {
  return {
    version: 2,
    name: "Проверка",
    canvas: { width: 640, height: 480 },
    globals: "",
    runtime: { fpsMode: "limited", fpsLimit: 60 },
    overlay: {
      width: 640, height: 480, followCanvas: true, scaleMode: "contain",
      background: "transparent", color: "#000000", chromaColor: "#00b140",
      alwaysOnTop: true, clickThrough: true, showGuide: false,
    },
    modules: [],
    objects: [
      {
        id: "root", name: "Риг", kind: "group", image: null, parentId: null,
        pivot: { x: 0.5, y: 0.5 },
        base: {
          x: 320, y: 240, rotation: 0, sizeX: 1, sizeY: 1,
          skewX: 0, skewY: 0, opacity: 1, visible: 1, layer: 0,
        },
        width: 640, height: 480, script: "x = 320",
      },
    ],
  };
}

test("оверлей подключается через релей, получает сцену и кадры", async () => {
  const bridge = await relay();
  const hostBus = new CompositeBus([new WebSocketBus(bridge.url)]);
  const viewerBus = new CompositeBus([new WebSocketBus(bridge.url)]);
  const seen: string[] = [];
  const host = new OverlayHost(hostBus, {
    hostName: "Проверка",
    onViewers: (ids) => seen.splice(0, seen.length, ...ids),
  });
  const client = new OverlayClient(viewerBus, { helloIntervalMs: 100, staleAfterMs: 4000 });

  try {
    host.start();
    host.setPreset(preset());
    client.start();

    // 1. hello доходит до редактора: в диалоге появляется счётчик оверлеев.
    await expect.poll(() => host.viewerIds.length, { timeout: 5000 }).toBe(1);
    expect(seen).toHaveLength(1);

    // 2. Редактор отвечает сценой, позой и настройками окна.
    await expect.poll(() => client.scene?.version ?? 0, { timeout: 5000 }).toBe(1);
    expect(client.config?.scaleMode).toBe("contain");
    expect(client.bases?.root?.x).toBe(320);
    // Сцена уже у оверлея, а кадров ещё не было: рисовать нечего, счётчик пуст.
    expect(client.frameCount).toBe(0);

    // 3. Поток кадров: редактор публикует, оверлей рисует.
    host.pushFrame({ seq: 1, objects: {} } as unknown as RigFrame);
    await expect.poll(() => client.frameCount, { timeout: 5000 }).toBe(1);
    expect(client.status).toBe("live");
    expect(client.host).toBe("Проверка");

    // 4. Дубли по `seq` не перерисовывают картинку дважды.
    host.pushFrame({ seq: 1, objects: {} } as unknown as RigFrame);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(client.frameCount).toBe(1);
  } finally {
    client.dispose();
    host.dispose();
    hostBus.close();
    viewerBus.close();
    for (const socket of bridge.clients) socket.terminate();
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
  }
});
