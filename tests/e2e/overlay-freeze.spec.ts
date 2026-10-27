import { test, expect } from "@playwright/test";
import { OverlayHost } from "../../src/overlay/host";
import { OverlayClient } from "../../src/overlay/client";
import { createDemoPreset } from "../../src/data/demoPreset";
import { NEUTRAL_PARAMS } from "../../src/engine/frame";
import { currentFrameSeq, nextFrameSeq } from "../../src/engine/frameSeq";
import type { ObjectFrame, RigFrame } from "../../src/types";
import type { WireMessage } from "../../src/overlay/protocol";

/**
 * Заглушка шины: доставляет сообщения между хостом и клиентом внутри процесса.
 * Так проверяется провод, а не сеть.
 */
function link() {
  const listeners = new Set<(message: WireMessage) => void>();
  const bus = {
    kind: "websocket" as const,
    label: "заглушка",
    parts: [],
    post(message: WireMessage) {
      // Настоящая дорога асинхронна: синхронная доставка зациклила бы
      // «приветствие → анонс → приветствие» в одном стеке.
      setTimeout(() => { for (const listener of listeners) listener(message); }, 0);
    },
    subscribe(listener: (message: WireMessage) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() {},
  };
  return bus;
}

function frameOf(preset: ReturnType<typeof createDemoPreset>, seq: number): RigFrame {
  const objects: Record<string, ObjectFrame> = {};
  for (const object of preset.objects) objects[object.id] = { ...NEUTRAL_PARAMS };
  return { seq, time: seq / 60, dt: 1 / 60, globals: {}, objects, order: preset.objects.map((o) => o.id), diagnostics: [] };
}

test("номер кадра не откатывается: пересоздание движка его не сбрасывает", () => {
  // Движок пересоздаётся на смене структуры и на «Стопе»; его собственная
  // нумерация начинается заново. Оверлей отбрасывает всё, что не новее
  // прошлого кадра, поэтому номер обязан выдавать редактор.
  const before = currentFrameSeq();
  const engineRestart = [0, 1, 2].map(() => nextFrameSeq());
  for (let index = 1; index < engineRestart.length; index += 1) {
    expect(engineRestart[index]).toBeGreaterThan(before + index - 1);
  }
  expect(engineRestart[0]).toBeGreaterThan(before);
  expect(currentFrameSeq()).toBe(engineRestart.at(-1));
});

test("после «Стопа» оверлей снова живой: кадры принимаются, заморозка не вечна", async () => {
  const preset = createDemoPreset();
  const bus = link() as never;
  const host = new OverlayHost(bus, { hostName: "Демо", announceIntervalMs: 60_000 });
  const client = new OverlayClient(bus, { helloIntervalMs: 60_000, staleAfterMs: 60_000 });
  try {
    host.start();
    host.setPreset(preset);
    client.start();
    await expect.poll(() => client.scene?.version ?? 0).toBe(1);

    // Живой поток: номера растут.
    host.pushFrame(frameOf(preset, nextFrameSeq()));
    host.pushFrame(frameOf(preset, nextFrameSeq()));
    await expect.poll(() => client.frameCount).toBe(2);

    // «Стоп»: движок пересоздан, оверлею уходит нейтральная поза.
    host.setFrozen(true, preset);
    await expect.poll(() => client.frameCount).toBe(3);
    const stoppedSeq = client.frame?.seq ?? 0;

    // «Продолжить»: кадры идут дальше, и их номер больше стоп-кадра.
    host.setFrozen(false, preset);
    host.pushFrame(frameOf(preset, nextFrameSeq()));
    await expect.poll(() => client.frameCount).toBe(4);
    expect(client.frame?.seq ?? 0).toBeGreaterThan(stoppedSeq);
    await expect.poll(() => client.status).toBe("live");
  } finally {
    client.dispose();
    host.dispose();
  }
});

test("перезапуск редактора при открытом источнике: новый номер принимается", async () => {
  const preset = createDemoPreset();
  const bus = link() as never;
  const first = new OverlayHost(bus, { hostName: "Первый", announceIntervalMs: 60_000 });
  // Оверлей в OBS представляется раз в секунду — так новый редактор узнаёт о нём
  // без перезапуска источника.
  const client = new OverlayClient(bus, { helloIntervalMs: 100, staleAfterMs: 60_000 });
  try {
    first.start();
    first.setPreset(preset);
    client.start();
    await expect.poll(() => client.scene?.version ?? 0).toBe(1);
    for (let index = 0; index < 3; index += 1) first.pushFrame(frameOf(preset, 900 + index));
    await expect.poll(() => client.frameCount).toBe(3);

    // Редактор перезапустили: новый хост, сцена новее, номера кадров — с начала.
    first.dispose();
    const second = new OverlayHost(bus, { hostName: "Второй", announceIntervalMs: 60_000 });
    second.start();
    second.setPreset({ ...preset, name: "После перезапуска" });
    // У нового хоста своя нумерация сцен, поэтому смотрим не на номер, а на
    // саму сцену: оверлей обязан принять её, а не держать прошлую.
    await expect.poll(() => client.scene?.name).toBe("После перезапуска");
    second.pushFrame(frameOf(preset, 1));
    // Раньше такой кадр отбрасывался как «старый» — и источник замирал.
    await expect.poll(() => client.frameCount).toBe(4);
    second.dispose();
  } finally {
    client.dispose();
  }
});
