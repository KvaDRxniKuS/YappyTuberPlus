import { test, expect } from "@playwright/test";
import { needsCore, needsReport, BASE_FUNCTIONS, CORE_FEATURES } from "../../src/engine/coreFeatures";
import { coreVerdict, VERSION } from "../../src/version";
import { normalizePreset } from "../../src/engine/preset";
import { stampPreset } from "../../src/engine/presetFile";
import { DEFAULT_BASE, type ObjectKind, type RigObject, type RigPreset } from "../../src/types";

/*
 * Требование сцены к ядру (`needs`) — не «чем записан файл», а «что нужно,
 * чтобы посчиталось». Проверяется по содержимому: виды объектов, функции и
 * параметры, которые реально используются, и то, чего в языке уже нет.
 */

function preset(objects: Partial<RigObject>[], globals = ""): RigPreset {
  const scene = objects.map((object, index) => ({
    id: `o${index}`, name: `Объект ${index}`, kind: "sprite" as ObjectKind, enabled: true,
    image: null, parentId: null, pivot: { x: 0.5, y: 0.5 }, base: { ...DEFAULT_BASE },
    script: "", width: 100, height: 100, ...object,
  }));
  return {
    version: 3, name: "Сцена", canvas: { width: 1000, height: 600 },
    objects: scene, globals,
    runtime: { fpsMode: "limited", fpsLimit: 60 },
    overlay: {}, modules: [],
  } as unknown as RigPreset;
}

test("требование: простая сцена просит минимум", () => {
  const simple = preset([{ script: "x = smooth(mic.loudness * 10, 80)\ny = spring(0, 2, 0.4)" }]);
  expect(needsCore(simple)).toBe(1);

  // Требование растёт только вслед за содержимым, а не вслед за редактором.
  expect(needsCore(preset([{ kind: "shape" }]))).toBe(20);
  expect(needsCore(preset([{ kind: "light" }]))).toBe(VERSION.core);
  expect(needsCore(preset([], "x = count(mic.talking.up)"))).toBe(16);
  expect(needsCore(preset([{ script: "y = near(x, 1, 0.1) * 5" }]))).toBe(9);
  expect(needsCore(preset([{ mask: { src: null } } as Partial<RigObject>]))).toBe(19);
  expect(needsCore(preset([{ warp: {} } as Partial<RigObject>]))).toBe(18);
});

test("требование: строки и комментарии не считаются кодом", () => {
  // Сообщение с вызовом внутри — это текст, а не формула.
  const message = preset([{
    script: 'text = "count(mic.talking.up) функций нет"\n// тут был count(mic.x.up)\nx = 1',
  }]);
  expect(needsCore(message)).toBeLessThan(16);

  // Присваивание строки само по себе — уже новое поколение языка.
  expect(needsCore(preset([{ script: 'text = "привет"' }]))).toBe(12);
});

test("требование: незнакомый вызов не притворяется старым", () => {
  const report = needsReport(preset([{ script: "x = mystery(1, 2)" }]));
  expect(report.unknown).toEqual(["mystery"]);
  expect(report.needs).toBe(VERSION.core);
  // Вердикт предупреждает, только если ядро уже ломало язык.
  expect(coreVerdict({ core: VERSION.core, acceptsFrom: 1 }, report).note).toBeNull();
  expect(coreVerdict({ core: VERSION.core, acceptsFrom: 16 }, report).state).toBe("incompatible");
});

test("требование: убранное из языка видно по сцене", () => {
  const report = needsReport(preset([{
    script: "x = 1",
    // hold остался в старых сценах: поколение сцены маленькое, а ядро его уже не разбирает.
  }], "x = 1"));
  expect(report.removed).toEqual([]);

  const old = needsReport(preset([{ script: "on mic.talking.hold(0.2) { x = 1 }" }]));
  expect(old.removed.map((item) => item.removed)).toEqual([16]);
  expect(old.needs).toBeLessThan(16);
});

test("требование: таблица признаков согласована с поколениями", () => {
  // Каждый признак ссылается на существующее поколение, а убранные — позже
  // своего появления: иначе таблица начнёт врать.
  for (const feature of CORE_FEATURES) {
    expect(feature.since).toBeGreaterThanOrEqual(1);
    expect(feature.since).toBeLessThanOrEqual(VERSION.core);
    if (feature.removed) expect(feature.removed).toBeGreaterThan(feature.since);
  }
  // Базовые функции не дублируются в признаках: иначе одно имя жило бы дважды.
  const inFeatures = new Set(CORE_FEATURES.flatMap((feature) => feature.functions ?? []));
  for (const name of BASE_FUNCTIONS) expect(inFeatures.has(name)).toBe(false);
});

test("требование: файл уносит его с собой", () => {
  const scene = preset([{ kind: "light" }]);
  const stamped = stampPreset(scene);
  expect(stamped.built).toContain(VERSION.core.toString());
  expect(stamped.needs).toBe(VERSION.core);

  // Требование переживает чтение файла, чтобы более старое ядро его увидело.
  const read = normalizePreset(stamped)!;
  expect(read.needs).toBe(VERSION.core);
  // В памяти сцены требования нет: оно считается при записи.
  expect(scene.needs).toBeUndefined();
});
