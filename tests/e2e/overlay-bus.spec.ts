import { test, expect } from "@playwright/test";
import { WebSocketBus, type TransportStats } from "../../src/overlay/bus";
import type { WireMessage } from "../../src/overlay/protocol";

/*
 * Проверки очереди отправки — без браузера и без настоящего сокета.
 *
 * Смысл: `WebSocket.send` не ждёт приёмника. Медленный OBS копит кадры в
 * буфере браузера, и оверлей отстаёт от редактора навсегда. Поэтому старый
 * кадр выбрасывается, а свежий ждёт, пока буфер опустеет. Эти тесты держат
 * именно такое поведение — и то, что команды (hello, файлы, управление окном)
 * при этом не теряются никогда.
 */

/** Сокет, у которого можно вручную задать занятость буфера. */
class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(text: string) {
    this.sent.push(text);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  /** Открыть линию: без этого шина считает сокет неготовым. */
  open() {
    this.onopen?.();
  }

  framesSent(): number {
    return this.sent.filter((text) => JSON.parse(text).t === "frame").length;
  }

  kinds(): string[] {
    return this.sent.map((text) => JSON.parse(text).t as string);
  }
}

function frame(seq: number): WireMessage {
  return {
    t: "frame",
    sender: "editor",
    sceneVersion: 1,
    frame: { seq, time: seq * 16, dt: 16, globals: {}, objects: {}, order: [] },
  } as WireMessage;
}

/** Шина на подставном сокете; сокет уже открыт. */
function makeBus(): { bus: WebSocketBus; socket: FakeSocket } {
  const socket = new FakeSocket();
  const bus = new WebSocketBus("ws://test/overlay-ws", () => socket as unknown as WebSocket);
  socket.open();
  return { bus, socket };
}

test("кадры уходят сразу, пока буфер свободен", () => {
  const { bus, socket } = makeBus();
  for (let seq = 1; seq <= 5; seq += 1) bus.post(frame(seq));
  expect(socket.framesSent()).toBe(5);
  const stats: TransportStats = bus.stats();
  expect(stats.frames).toBe(5);
  expect(stats.dropped).toBe(0);
  bus.close();
});

test("на занятом буфере остаётся только самый свежий кадр", () => {
  const { bus, socket } = makeBus();
  socket.bufferedAmount = 400 * 1024;
  for (let seq = 1; seq <= 10; seq += 1) bus.post(frame(seq));
  // Ни один не ушёл, и в памяти ждёт один — последний.
  expect(socket.framesSent()).toBe(0);
  expect(bus.stats().dropped).toBe(10);
  bus.close();
});

test("отложенный кадр уходит, когда буфер опустел, и это последний", async () => {
  const { bus, socket } = makeBus();
  socket.bufferedAmount = 400 * 1024;
  bus.post(frame(1));
  bus.post(frame(2));
  bus.post(frame(3));
  expect(socket.framesSent()).toBe(0);

  socket.bufferedAmount = 0;
  // Дренаж идёт по таймеру: 40 мс на попытку.
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(socket.framesSent()).toBe(1);
  const sent = JSON.parse(socket.sent[socket.sent.length - 1]) as { frame: { seq: number } };
  expect(sent.frame.seq).toBe(3);
  bus.close();
});

test("команды не выбрасываются даже на занятом буфере", () => {
  const { bus, socket } = makeBus();
  socket.bufferedAmount = 900 * 1024;
  bus.post({ t: "hello", sender: "viewer", role: "viewer", protocol: 2, sceneVersion: 0 } as WireMessage);
  bus.post({ t: "asset-ack", sender: "viewer", to: "editor", transferId: "t", index: 3 } as WireMessage);
  expect(socket.kinds()).toEqual(["hello", "asset-ack"]);
  expect(bus.stats().dropped).toBe(0);
  bus.close();
});

test("закрытая линия: кадр не копится в очереди и считается выброшенным", () => {
  const { bus, socket } = makeBus();
  socket.close();
  expect(bus.ready).toBe(false);
  bus.post(frame(1));
  bus.post({ t: "hello", sender: "viewer", role: "viewer", protocol: 2, sceneVersion: 0 } as WireMessage);
  // Сокет закрыт — кадр пропал, команда осталась в очереди до переподключения.
  expect(socket.framesSent()).toBe(0);
  expect(bus.stats().dropped).toBe(1);
  expect(bus.stats().frames).toBe(0);
  bus.close();
});

test("байты и пик буфера видны в статистике", () => {
  const { bus, socket } = makeBus();
  socket.bufferedAmount = 12 * 1024;
  bus.post(frame(1));
  socket.bufferedAmount = 90 * 1024;
  bus.post(frame(2));
  const stats = bus.stats();
  expect(stats.bytes).toBeGreaterThan(0);
  expect(stats.peakBuffered).toBe(90 * 1024);
  expect(stats.buffered).toBe(90 * 1024);
  bus.close();
});
