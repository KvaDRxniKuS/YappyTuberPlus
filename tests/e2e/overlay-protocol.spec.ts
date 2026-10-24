import { test, expect } from "@playwright/test";
import { BroadcastChannelBus, CompositeBus } from "../../src/overlay/bus";
import { OverlayClient } from "../../src/overlay/client";
import { OverlayHost } from "../../src/overlay/host";
import { scenePreset } from "../../src/overlay/protocol";
import { normalizeOverlay } from "../../src/engine/preset";
import { viewTransform } from "../../src/render/rigCanvas";
import { createDemoPreset } from "../../src/data/demoPreset";
import type { ObjectFrame, RigFrame } from "../../src/types";

const NEUTRAL: ObjectFrame = {
  x: 0, y: 0, rotation: 0, sizeX: 1, sizeY: 1, skewX: 0, skewY: 0,
  opacity: 1, visible: 1, layer: 0,
};

function frame(seq: number): RigFrame {
  const preset = createDemoPreset();
  return {
    seq,
    time: seq / 60,
    dt: 1 / 60,
    globals: {},
    objects: Object.fromEntries(preset.objects.map((object) => [object.id, { ...NEUTRAL, x: seq }])),
    order: preset.objects.map((object) => object.id),
    diagnostics: [],
  };
}

function channelPair(name: string) {
  const hostBus = new CompositeBus([new BroadcastChannelBus(name)]);
  const viewerBus = new CompositeBus([new BroadcastChannelBus(name)]);
  return { hostBus, viewerBus };
}

/*
 * These checks run in Node. BroadcastChannel exists there too, so the host and
 * the viewer can be exercised without a browser and without a running editor.
 */

test("editor publishes the scene, pose patches and frames to a viewer", async () => {
  const { hostBus, viewerBus } = channelPair(`overlay-test-${Date.now()}`);
  const host = new OverlayHost(hostBus, { hostName: "Стенд", announceIntervalMs: 50, viewerTimeoutMs: 500 });
  const client = new OverlayClient(viewerBus, { helloIntervalMs: 60 });
  try {
    host.start();
    host.setPreset(createDemoPreset());
    client.start();

    await expect.poll(() => client.scene?.name, { timeout: 4000 }).toBe("Mochi — стартовый риг");
    await expect.poll(() => client.config?.scaleMode, { timeout: 4000 }).toBe("contain");
    await expect.poll(() => host.viewerIds.length, { timeout: 4000 }).toBe(1);

    // Base-pose only edit must not resend the scene, but must reach the viewer.
    const moved = createDemoPreset();
    moved.objects[0].base.x += 40;
    host.setPreset(moved);
    await expect.poll(() => client.bases?.[moved.objects[0].id].x, { timeout: 4000 }).toBe(moved.objects[0].base.x);
    expect(client.scene?.version).toBe(1);

    host.pushFrame(frame(7));
    await expect.poll(() => client.frame?.seq, { timeout: 4000 }).toBe(7);
    await expect.poll(() => client.status, { timeout: 4000 }).toBe("live");

    // Structural edit bumps the scene version.
    const rebuilt = createDemoPreset();
    rebuilt.objects = rebuilt.objects.slice(0, 3);
    host.setPreset(rebuilt);
    await expect.poll(() => client.scene?.version, { timeout: 4000 }).toBe(2);
    await expect.poll(() => client.scene?.objects.length, { timeout: 4000 }).toBe(3);
  } finally {
    client.dispose();
    host.dispose();
    hostBus.close();
    viewerBus.close();
  }
});

test("duplicate frames from two transports never rewind the overlay", async () => {
  const name = `overlay-dup-${Date.now()}`;
  const hostBus = new CompositeBus([new BroadcastChannelBus(name), new BroadcastChannelBus(name)]);
  const viewerBus = new CompositeBus([new BroadcastChannelBus(name)]);
  const host = new OverlayHost(hostBus, { hostName: "Дубль", announceIntervalMs: 50 });
  const client = new OverlayClient(viewerBus, { helloIntervalMs: 60 });
  try {
    host.start();
    host.setPreset(createDemoPreset());
    client.start();
    await expect.poll(() => client.scene?.version, { timeout: 4000 }).toBe(1);

    host.pushFrame(frame(10));
    await expect.poll(() => client.frame?.seq, { timeout: 4000 }).toBe(10);
    const count = client.frameCount;
    host.pushFrame(frame(9));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(client.frame?.seq).toBe(10);
    expect(client.frameCount).toBe(count);
  } finally {
    client.dispose();
    host.dispose();
    hostBus.close();
    viewerBus.close();
  }
});

test("a heartbeating viewer stays connected without forcing scene resends", async () => {
  const { hostBus, viewerBus } = channelPair(`overlay-heartbeat-${Date.now()}`);
  const host = new OverlayHost(hostBus, { hostName: "Пульс", announceIntervalMs: 100, viewerTimeoutMs: 300 });
  const client = new OverlayClient(viewerBus, { helloIntervalMs: 80 });
  try {
    host.start();
    host.setPreset(createDemoPreset());
    client.start();
    await expect.poll(() => host.viewerIds.length, { timeout: 4000 }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 700));
    // Two heartbeats are well past the timeout, but the viewer must survive them.
    expect(host.viewerIds.length).toBe(1);
    // The scene is only sent when it changes, not on every hello.
    expect(client.scene?.version).toBe(1);
  } finally {
    client.dispose();
    host.dispose();
    hostBus.close();
    viewerBus.close();
  }
});

test("host forgets a viewer that stopped answering", async () => {
  const { hostBus, viewerBus } = channelPair(`overlay-timeout-${Date.now()}`);
  const host = new OverlayHost(hostBus, { hostName: "Таймаут", announceIntervalMs: 50, viewerTimeoutMs: 150 });
  const client = new OverlayClient(viewerBus, { helloIntervalMs: 60 });
  try {
    host.start();
    host.setPreset(createDemoPreset());
    client.start();
    await expect.poll(() => host.viewerIds.length, { timeout: 4000 }).toBe(1);
    client.dispose();
    await expect.poll(() => host.viewerIds.length, { timeout: 4000 }).toBe(0);
  } finally {
    host.dispose();
    hostBus.close();
    viewerBus.close();
  }
});

test("overlay view transform and preset normalisation are predictable", () => {
  const contain = viewTransform("contain", { width: 1000, height: 600 }, 500, 500);
  expect(contain.scaleX).toBeCloseTo(0.5);
  expect(contain.offsetX).toBeCloseTo(0);
  expect(contain.offsetY).toBeCloseTo(100);

  const cover = viewTransform("cover", { width: 1000, height: 600 }, 500, 500);
  expect(cover.scaleX).toBeCloseTo(0.8333, 3);
  expect(cover.offsetX).toBeCloseTo(-166.67, 1);

  const stretch = viewTransform("stretch", { width: 1000, height: 600 }, 500, 300);
  expect(stretch.scaleX).toBeCloseTo(0.5);
  expect(stretch.scaleY).toBeCloseTo(0.5);

  const pixel = viewTransform("pixel", { width: 1000, height: 600 }, 500, 300);
  expect(pixel).toEqual({ scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 });

  const overlay = normalizeOverlay(undefined);
  expect(overlay.width).toBe(900);
  expect(overlay.scaleMode).toBe("contain");
  expect(overlay.background).toBe("transparent");
  expect(normalizeOverlay({ width: 5, height: 99999, scaleMode: "weird" as never }).width).toBe(120);
  expect(normalizeOverlay({ width: 5, height: 99999 }).height).toBe(4320);
  expect(normalizeOverlay({ scaleMode: "weird" as never }).scaleMode).toBe("contain");

  const preset = createDemoPreset();
  const scene = { version: 1, name: preset.name, canvas: preset.canvas, objects: preset.objects };
  const merged = scenePreset(scene, { [preset.objects[0].id]: { ...preset.objects[0].base, x: 777 } }, preset.overlay);
  expect(merged.objects[0].base.x).toBe(777);
  expect(merged.canvas.width).toBe(1000);
});
