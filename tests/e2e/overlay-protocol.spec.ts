import { test, expect } from "@playwright/test";
import { BroadcastChannelBus, CompositeBus } from "../../src/overlay/bus";
import { OverlayClient } from "../../src/overlay/client";
import { OverlayHost } from "../../src/overlay/host";
import { overlayBackground, scenePreset, structureSignature, toOverlayScene } from "../../src/overlay/protocol";
import { normalizeOverlay } from "../../src/engine/preset";
import { viewTransform } from "../../src/render/rigCanvas";
import { createDemoPreset } from "../../src/data/demoPreset";
import { DEFAULT_OVERLAY, DEFAULT_BASE, type ObjectFrame, type RigFrame } from "../../src/types";
import { defaultShape } from "../../src/render/shape";
import { defaultWarp } from "../../src/render/warp";

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

test("capture window shares the overlay background and keeps transparency", () => {
  const base = { ...DEFAULT_OVERLAY };

  // В нативном окне прозрачность сохраняется: альфа уходит в запись.
  expect(overlayBackground({ ...base, background: "transparent" }, { capture: true, native: true }))
    .toEqual({ mode: "transparent", color: null });

  // Браузер прозрачных окон не даёт — в превью подставляем тёмный фон.
  expect(overlayBackground({ ...base, background: "transparent" }, { capture: true, native: false }))
    .toEqual({ mode: "color", color: "#0f1215" });

  // Обычный оверлей ничего не подменяет.
  expect(overlayBackground({ ...base, background: "transparent" }, { native: false }))
    .toEqual({ mode: "transparent", color: null });

  // Цвет и хромакей общие с оверлеем.
  expect(overlayBackground({ ...base, background: "color", color: "#123456" }, { capture: true }))
    .toEqual({ mode: "color", color: "#123456" });
  expect(overlayBackground({ ...base, background: "chroma", chromaColor: "#00b140" }, { capture: true, native: true }))
    .toEqual({ mode: "chroma", color: "#00b140" });
});

/**
 * Сцена уезжает в оверлей не каждый кадр, а только при изменении подписи.
 * Если подпись не видит правку, OBS продолжает рисовать старое: «слой в
 * редакторе есть, а в эфире его нет» — ровно та жалоба, из-за которой этот
 * тест и появился.
 */
test("подпись сцены видит глаз, фигуры, маски и деформацию", () => {
  const preset = createDemoPreset();
  const sprite = preset.objects.find((object) => object.kind === "sprite")!;
  const patch = (object: typeof sprite) => ({
    ...preset,
    objects: preset.objects.map((item) => (item.id === sprite.id ? object : item)),
  });
  const base = structureSignature(preset);

  // Глаз в структуре — самый частый случай: включили слой, а OBS его не видит.
  expect(structureSignature(patch({ ...sprite, enabled: false }))).not.toBe(base);
  // Новая маска.
  expect(structureSignature(patch({
    ...sprite,
    mask: { kind: "points", shapeId: "", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], file: null, invert: false, feather: 0 },
  }))).not.toBe(base);
  // Инверсия и мягкий край маски тоже меняют картинку.
  expect(structureSignature(patch({
    ...sprite,
    mask: { kind: "points", shapeId: "", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], file: null, invert: true, feather: 0 },
  }))).not.toBe(structureSignature(patch({
    ...sprite,
    mask: { kind: "points", shapeId: "", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], file: null, invert: false, feather: 0 },
  })));
  // Фигура и деформация.
  expect(structureSignature(patch({ ...sprite, shape: defaultShape(10, 10) }))).not.toBe(base);
  expect(structureSignature(patch({ ...sprite, warp: { ...defaultWarp(), enabled: true } }))).not.toBe(base);
  // Правка формы деформации — тоже новая сцена.
  const warpFlat = { ...defaultWarp(), enabled: true };
  const warpBent = { ...warpFlat, corners: { ...warpFlat.corners, tl: { x: 20, y: 0 } } };
  expect(structureSignature(patch({ ...sprite, warp: warpBent }))).not.toBe(structureSignature(patch({ ...sprite, warp: warpFlat })));
});

test("сцена для оверлея несёт маску, фигуру и деформацию целиком", () => {
  const preset = createDemoPreset();
  const sprite = preset.objects.find((object) => object.kind === "sprite")!;
  const rich = {
    ...preset,
    objects: preset.objects.map((item) => (item.id === sprite.id
      ? { ...item, warp: { ...defaultWarp(), enabled: true }, base: { ...DEFAULT_BASE } }
      : item)),
  };
  const scene = toOverlayScene(rich, 7);
  const sent = scene.objects.find((object) => object.id === sprite.id)!;
  expect(sent.warp?.enabled).toBe(true);
  expect(scene.version).toBe(7);
  // Скрипты в оверлей не едут: их исполняет ядро редактора.
  expect(scene.objects.every((object) => object.script === "")).toBe(true);
});
