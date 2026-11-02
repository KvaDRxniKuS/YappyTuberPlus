import { test, expect } from "@playwright/test";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { AddressInfo } from "node:net";
import { BroadcastChannelBus, CompositeBus, WebSocketBus } from "../../src/overlay/bus";
import { OverlayClient } from "../../src/overlay/client";
import { OverlayHost } from "../../src/overlay/host";
import { createDemoPreset } from "../../src/data/demoPreset";
import {
  assetMissing, clearAssetFailure, markAssetMissing, markAssetRequestFailed,
  markAssetRequestPending, retainAssetUrls,
} from "../../src/engine/assets";
import type { WireMessage } from "../../src/overlay/protocol";

class TapBus extends BroadcastChannelBus {
  readonly posted: WireMessage[] = [];

  constructor(name: string, private readonly drop?: (message: WireMessage) => boolean) {
    super(name);
  }

  override post(message: WireMessage): void {
    this.posted.push(message);
    if (!this.drop?.(message)) super.post(message);
  }
}

function channelPair(
  name: string,
  viewerDrop?: (message: WireMessage) => boolean,
  hostDrop?: (message: WireMessage) => boolean,
) {
  const hostWire = new TapBus(name, hostDrop);
  const viewerWire = new TapBus(name, viewerDrop);
  return {
    hostBus: new CompositeBus([hostWire]),
    viewerBus: new CompositeBus([viewerWire]),
    hostWire,
    viewerWire,
  };
}

test("Browser Source receives a large asset in acknowledged chunks", async () => {
  let droppedFirstAck = false;
  const { hostBus, viewerBus, hostWire } = channelPair(`overlay-assets-${Date.now()}`, (message) => {
    if (message.t !== "asset-ack" || droppedFirstAck) return false;
    droppedFirstAck = true;
    return true;
  });
  const sourceBytes = new Uint8Array(150_321);
  for (let index = 0; index < sourceBytes.length; index += 1) sourceBytes[index] = (index * 29 + 7) & 0xff;
  const source = new Blob([sourceBytes], { type: "image/test" });
  const host = new OverlayHost(hostBus, {
    hostName: "Ассеты",
    readAsset: async () => source,
    announceIntervalMs: 40,
    viewerTimeoutMs: 1000,
    assetAckTimeoutMs: 30,
    assetRetryLimit: 3,
  });
  let accepted: { id: string; blob: Blob } | null = null;
  const client = new OverlayClient(viewerBus, {
    helloIntervalMs: 50,
    acceptAsset: (id, blob) => { accepted = { id, blob }; },
  });

  try {
    host.start();
    host.setPreset(createDemoPreset());
    client.start();
    await expect.poll(() => client.scene?.version, { timeout: 4000 }).toBe(1);
    client.requestAsset("big-image");

    await expect.poll(() => accepted, { timeout: 4000 }).not.toBeNull();
    expect(droppedFirstAck).toBe(true);
    expect(accepted?.id).toBe("big-image");
    expect(accepted?.blob.type).toBe("image/test");
    expect(accepted?.blob.size).toBe(sourceBytes.length);
    expect(new Uint8Array(await accepted!.blob.arrayBuffer())).toEqual(sourceBytes);

    const chunks = hostWire.posted.filter((message) => message.t === "asset-chunk");
    expect(chunks.length).toBeGreaterThan(Math.ceil(sourceBytes.length / (48 * 1024)));
    expect(chunks.every((message) => message.t !== "asset-chunk" || message.data.length <= 65_536)).toBe(true);
    expect(hostWire.posted.some((message) => message.t === "asset")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(hostWire.posted.some((message) => message.t === "asset-error")).toBe(false);
  } finally {
    client.dispose();
    host.dispose();
    hostBus.close();
    viewerBus.close();
  }
});

test("asset read failure reaches the overlay diagnostics", async () => {
  const { hostBus, viewerBus } = channelPair(`overlay-assets-missing-${Date.now()}`);
  const host = new OverlayHost(hostBus, {
    hostName: "Ассеты",
    readAsset: async () => null,
    announceIntervalMs: 40,
    viewerTimeoutMs: 1000,
  });
  let failure: { id: string; reason: string } | null = null;
  const client = new OverlayClient(viewerBus, {
    helloIntervalMs: 50,
    onAssetFailure: (id, reason) => { failure = { id, reason }; },
  });

  try {
    host.start();
    host.setPreset(createDemoPreset());
    client.start();
    await expect.poll(() => client.scene?.version, { timeout: 4000 }).toBe(1);
    client.requestAsset("missing-image");
    await expect.poll(() => failure, { timeout: 4000 }).not.toBeNull();
    expect(failure).toEqual({ id: "missing-image", reason: "Не удалось прочитать файл из хранилища." });
  } finally {
    client.dispose();
    host.dispose();
    hostBus.close();
    viewerBus.close();
  }
});

test("asset transfer reports exhausted ACK retries", async () => {
  const { hostBus, viewerBus } = channelPair(
    `overlay-assets-timeout-${Date.now()}`,
    undefined,
    (message) => message.t === "asset-chunk",
  );
  const host = new OverlayHost(hostBus, {
    hostName: "Ассеты",
    readAsset: async () => new Blob([new Uint8Array(2_000)], { type: "image/test" }),
    announceIntervalMs: 40,
    viewerTimeoutMs: 1000,
    assetAckTimeoutMs: 25,
    assetRetryLimit: 0,
  });
  let failure: { id: string; reason: string } | null = null;
  const client = new OverlayClient(viewerBus, {
    helloIntervalMs: 50,
    onAssetFailure: (id, reason) => { failure = { id, reason }; },
  });

  try {
    host.start();
    host.setPreset(createDemoPreset());
    client.start();
    await expect.poll(() => client.scene?.version, { timeout: 4000 }).toBe(1);
    client.requestAsset("unconfirmed-image");
    await expect.poll(() => failure, { timeout: 4000 }).not.toBeNull();
    expect(failure).toEqual({
      id: "unconfirmed-image",
      reason: "Оверлей не подтвердил файл после повторных попыток.",
    });
  } finally {
    client.dispose();
    host.dispose();
    hostBus.close();
    viewerBus.close();
  }
});


test("local-origin misses stay quiet while a host transfer is pending", () => {
  const id = `pending-${Date.now()}`;
  retainAssetUrls([id]);
  try {
    markAssetRequestPending(id);
    markAssetMissing(id, "Локальная копия отсутствует.");
    expect(assetMissing(`asset:${id}`)).toBe(false);

    markAssetRequestFailed(id, "Хост не подтвердил файл.");
    expect(assetMissing(`asset:${id}`)).toBe(true);
  } finally {
    clearAssetFailure(id);
    retainAssetUrls([]);
  }
});

test("asset request timeout releases pending diagnostics when host is silent", async () => {
  const bus = new CompositeBus([new BroadcastChannelBus(`overlay-assets-silent-${Date.now()}`)]);
  let failure: { id: string; reason: string } | null = null;
  const client = new OverlayClient(bus, {
    helloIntervalMs: 60_000,
    assetRequestTimeoutMs: 25,
    onAssetFailure: (id, reason) => { failure = { id, reason }; },
  });
  try {
    client.start();
    client.requestAsset("silent-image");
    await expect.poll(() => failure, { timeout: 1000 }).toEqual({
      id: "silent-image",
      reason: "Передача файла остановилась: редактор не прислал данные вовремя.",
    });
  } finally {
    client.dispose();
    bus.close();
  }
});


test("large assets cross the OBS WebSocket relay as JSON-safe chunks", async () => {
  const relay = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => relay.once("listening", resolve));
  const peers = new Set<WsSocket>();
  relay.on("connection", (socket) => {
    peers.add(socket);
    socket.on("close", () => peers.delete(socket));
    socket.on("message", (data, binary) => {
      if (binary) return;
      for (const peer of peers) if (peer !== socket && peer.readyState === 1) peer.send(String(data));
    });
  });
  const port = (relay.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}/overlay-ws`;
  const hostBus = new CompositeBus([new WebSocketBus(url)]);
  const viewerBus = new CompositeBus([new WebSocketBus(url)]);
  const payload = new Uint8Array(110_003);
  payload.fill(0x6d);
  const source = new Blob([payload], { type: "image/test" });
  const host = new OverlayHost(hostBus, {
    hostName: "OBS Browser Source",
    readAsset: async () => source,
    announceIntervalMs: 40,
    viewerTimeoutMs: 1000,
  });
  let received: Blob | null = null;
  const client = new OverlayClient(viewerBus, {
    helloIntervalMs: 50,
    acceptAsset: (_id, blob) => { received = blob; },
  });

  try {
    host.start();
    host.setPreset(createDemoPreset());
    client.start();
    await expect.poll(() => client.scene?.version, { timeout: 4000 }).toBe(1);
    client.requestAsset("relay-image");
    await expect.poll(() => received, { timeout: 4000 }).not.toBeNull();
    expect(received?.size).toBe(payload.length);
    expect(new Uint8Array(await received!.arrayBuffer())).toEqual(payload);
  } finally {
    client.dispose();
    host.dispose();
    viewerBus.close();
    hostBus.close();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  }
});
