import { expect, test } from "@playwright/test";
import { orderedObjects } from "../../src/render/rigCanvas";
import { propagateBase } from "../../src/engine/structure";
import { createDemoPreset } from "../../src/data/demoPreset";
import type { BasePose, RigFrame, RigObject } from "../../src/types";

const base = (x: number, y: number): BasePose => ({
  x, y, rotation: 0, sizeX: 1, sizeY: 1, skewX: 0, skewY: 0, opacity: 1, visible: 1, layer: 0,
});

const object = (id: string, parentId: string | null, pose: BasePose): RigObject => ({
  id, name: id, kind: "sprite", enabled: true, image: null, parentId,
  pivot: { x: 0.5, y: 0.5 }, base: pose, width: 100, height: 100, script: "",
});

test("поворот родителя поворачивает детей вокруг его пивота", () => {
  const objects = [
    object("parent", null, base(100, 100)),
    object("child", "parent", base(140, 100)),
    object("grandchild", "child", base(140, 140)),
  ];
  const rotated = propagateBase(objects, "parent", base(100, 100), { ...base(100, 100), rotation: 90 });
  const child = rotated.find((item) => item.id === "child")!;
  const grandchild = rotated.find((item) => item.id === "grandchild")!;
  expect(child.base.x).toBeCloseTo(100, 6);
  expect(child.base.y).toBeCloseTo(140, 6);
  expect(child.base.rotation).toBeCloseTo(90, 6);
  // Всё поддерево поворачивается жёстко: внук едет вместе с родителем.
  expect(grandchild.base.x).toBeCloseTo(60, 6);
  expect(grandchild.base.y).toBeCloseTo(140, 6);
  expect(grandchild.base.rotation).toBeCloseTo(90, 6);
});

test("масштаб и сдвиг родителя переносятся на детей", () => {
  const objects = [object("parent", null, base(100, 100)), object("child", "parent", base(140, 100))];
  const scaled = propagateBase(objects, "parent", base(100, 100), { ...base(100, 100), sizeX: 2, sizeY: 3 });
  expect(scaled.find((item) => item.id === "child")!.base.x).toBeCloseTo(180, 6);
  expect(scaled.find((item) => item.id === "child")!.base.y).toBeCloseTo(100, 6);
  const moved = propagateBase(objects, "parent", base(100, 100), base(130, 160));
  expect(moved.find((item) => item.id === "child")!.base.x).toBeCloseTo(170, 6);
  expect(moved.find((item) => item.id === "child")!.base.y).toBeCloseTo(160, 6);
});

test("без изменения позы родителя базы детей не трогаются", () => {
  const objects = [object("parent", null, base(100, 100)), object("child", "parent", base(140, 100))];
  const same = propagateBase(objects, "parent", base(100, 100), { ...base(100, 100), opacity: 0.5 });
  expect(same.find((item) => item.id === "child")!.base).toEqual(base(140, 100));
});

test("выделенный ребёнок не двигается дважды", () => {
  const objects = [
    object("parent", null, base(100, 100)),
    object("child", "parent", base(140, 100)),
    object("grandchild", "child", base(140, 140)),
  ];
  const moved = propagateBase(objects, "parent", base(100, 100), base(120, 100), ["child"]);
  expect(moved.find((item) => item.id === "child")!.base.x).toBe(140);
  // Поддерево выделенного ребёнка правит его собственный перенос.
  expect(moved.find((item) => item.id === "grandchild")!.base.x).toBe(140);
});

test("порядок отрисовки: слой из кадра, при равенстве — структура", () => {
  const preset = createDemoPreset();
  const frame = (layers: Record<string, number>): RigFrame => ({
    seq: 1,
    time: 0,
    dt: 0,
    globals: {},
    objects: Object.fromEntries(preset.objects.map((item) => [item.id, {
      x: 0, y: 0, rotation: 0, sizeX: 1, sizeY: 1, skewX: 0, skewY: 0,
      opacity: 1, visible: 1, layer: layers[item.id] ?? item.base.layer,
    }])),
    order: [],
    diagnostics: [],
  });

  // Слой-литерал берётся из пресета (иначе порядок отставал бы от правки до
  // следующего тика), поэтому «слой из кадра» проверяем на формуле.
  const bodyIndex = preset.objects.findIndex((item) => item.id === "body");
  preset.objects[bodyIndex] = {
    ...preset.objects[bodyIndex],
    script: preset.objects[bodyIndex].script.replace(/^[ \t]*layer[ \t]*=.*$/m, "layer = manual.value"),
  };

  // Дичь: рука получает слой выше головы — рисуется последней.
  const raised = orderedObjects(preset, frame({ body: 9 }));
  expect(raised[raised.length - 1].id).toBe("body");

  // Равные слои: потомок поверх предка, верхняя строка структуры поверх нижней.
  const even = orderedObjects(preset, frame(Object.fromEntries(preset.objects.map((item) => [item.id, 0]))));
  const indexOf = (id: string) => even.findIndex((item) => item.id === id);
  // Верхняя строка структуры — поверх нижней: она рисуется позже.
  expect(indexOf("head")).toBeGreaterThan(indexOf("eye_left"));
  expect(indexOf("mouth")).toBeGreaterThan(indexOf("mouth_closed"));
  // Порядок не зависит от порядка массива в пресете: он общий для массива и дерева.
  expect(indexOf("head")).toBeGreaterThan(indexOf("body"));
});
