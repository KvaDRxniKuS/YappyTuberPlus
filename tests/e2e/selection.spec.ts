import { test, expect } from "@playwright/test";
import {
  boxFromPoints, boxIntersects, pointInPolygon, polygonIntersectsBox, rangeIds,
  selectionRoots, subtreeIds, toggleId, treeRows,
} from "../../src/engine/selection";
import { History } from "../../src/engine/history";
import { applyEnabled, neutralFrame } from "../../src/engine/frame";
import { createDemoPreset } from "../../src/data/demoPreset";
import type { RigPreset } from "../../src/types";

test("дерево: Ctrl-переключение и Shift-диапазон по видимым строкам", () => {
  const order = ["head", "eye_l", "eye_r", "mouth", "body"];

  expect(toggleId([], "eye_l")).toEqual(["eye_l"]);
  expect(toggleId(["eye_l"], "eye_l")).toEqual([]);
  expect(toggleId(["eye_l"], "body")).toEqual(["eye_l", "body"]);

  expect(rangeIds(order, "eye_l", "mouth")).toEqual(["eye_l", "eye_r", "mouth"]);
  expect(rangeIds(order, "mouth", "eye_l")).toEqual(["eye_l", "eye_r", "mouth"]);
  expect(rangeIds(order, null, "body")).toEqual(["body"]);
  expect(rangeIds(order, "eye_l", "missing")).toEqual(["missing"]);
});

test("выборка: корни и поддеревья не задваиваются", () => {
  const preset = createDemoPreset();
  // character → body → head_group → head/eye/mouth; arm_left вложен в body.
  expect(selectionRoots(preset.objects, ["character", "body", "head"])).toEqual(["character"]);
  expect(selectionRoots(preset.objects, ["body", "arm_left"])).toEqual(["body"]);
  expect(selectionRoots(preset.objects, ["head", "arm_left"])).toEqual(["head", "arm_left"]);

  const subtree = new Set(subtreeIds(preset.objects, ["body"]));
  expect(subtree.has("head")).toBe(true);
  expect(subtree.has("mouth_scared") || subtree.has("mouth_closed")).toBe(true);
  expect(subtree.has("character")).toBe(false);
});

test("рамка и лассо считают пересечения предсказуемо", () => {
  const rect = boxFromPoints({ x: 10, y: 10 }, { x: 50, y: 40 });
  expect(boxIntersects(rect, boxFromPoints({ x: 40, y: 30 }, { x: 90, y: 80 }))).toBe(true);
  expect(boxIntersects(rect, boxFromPoints({ x: 60, y: 60 }, { x: 90, y: 80 }))).toBe(false);

  const triangle = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }];
  expect(pointInPolygon({ x: 10, y: 10 }, triangle)).toBe(true);
  expect(pointInPolygon({ x: 80, y: 80 }, triangle)).toBe(false);
  // Объект целиком внутри лассо.
  expect(polygonIntersectsBox(triangle, boxFromPoints({ x: 5, y: 5 }, { x: 25, y: 25 }))).toBe(true);
  // Рамка пересекает ребро лассо, центр снаружи.
  expect(polygonIntersectsBox(triangle, boxFromPoints({ x: 40, y: -20 }, { x: 80, y: 20 }))).toBe(true);
  // Далёкий объект не задевается.
  expect(polygonIntersectsBox(triangle, boxFromPoints({ x: 200, y: 200 }, { x: 240, y: 240 }))).toBe(false);
});

function snap(preset: RigPreset, selection: string[]) {
  return { preset, selection };
}

test("история: undo/redo возвращают и пресет, и выделение", () => {
  const first = createDemoPreset();
  const second: RigPreset = { ...first, name: "второй" };
  const third: RigPreset = { ...second, name: "третий" };
  const history = new History();

  history.record(snap(first, ["head"]), "Имя пресета", "preset-name");
  history.record(snap(second, ["head", "body"]), "Изменение");

  expect(history.canUndo).toBe(true);
  const back = history.undo(snap(third, ["body"]));
  expect(back?.preset.name).toBe("второй");
  expect(back?.selection).toEqual(["head", "body"]);

  const deeper = history.undo(snap(back!.preset, back!.selection));
  expect(deeper?.preset.name).toBe(first.name);
  expect(deeper?.selection).toEqual(["head"]);
  expect(history.canRedo).toBe(true);

  const forward = history.redo(snap(deeper!.preset, deeper!.selection));
  expect(forward?.preset.name).toBe("второй");
  expect(history.redo(snap(forward!.preset, forward!.selection))?.preset.name).toBe("третий");
});

test("история: быстрый набор в одном поле склеивается в один шаг", () => {
  const preset = createDemoPreset();
  const history = new History(100, 700);
  const start = snap(preset, ["head"]);

  history.record(start, "Имя пресета", "preset-name", 1000);
  history.record(snap({ ...preset, name: "a" }, ["head"]), "Имя пресета", "preset-name", 1200);
  history.record(snap({ ...preset, name: "ab" }, ["head"]), "Имя пресета", "preset-name", 1400);
  expect(history.depth).toBe(1);

  history.record(snap({ ...preset, name: "ab" }, ["head"]), "Имя пресета", "preset-name", 4000);
  expect(history.depth).toBe(2);

  history.record(snap({ ...preset, name: "ab" }, ["head"]), "Другое действие", undefined, 4100);
  expect(history.depth).toBe(3);
});

test("история: после отмены новая правка обнуляет возврат", () => {
  const preset = createDemoPreset();
  const history = new History();
  history.record(snap(preset, []), "Первое", undefined, 0);
  history.record(snap({ ...preset, name: "x" }, []), "Второе", undefined, 10);
  expect(history.undo(snap({ ...preset, name: "xy" }, []))).not.toBeNull();
  expect(history.canRedo).toBe(true);
  history.record(snap({ ...preset, name: "y" }, []), "Третье", undefined, 20);
  expect(history.canRedo).toBe(false);
});

test("глаз гасит объект через enabled, не трогая формулы", () => {
  const preset = createDemoPreset();
  const eyes = preset.objects.find((object) => object.id === "eye_left")!;
  const disabledPreset: RigPreset = {
    ...preset,
    objects: preset.objects.map((object) => (object.id === "eye_left" ? { ...object, enabled: false } : object)),
  };
  const after = disabledPreset.objects.find((object) => object.id === "eye_left")!;
  expect(after.script).toBe(eyes.script);
  expect(after.base.visible).toBe(eyes.base.visible);

  // Кадр фильтруется: сам объект гаснет, соседи и родители — нет.
  const frame = neutralFrame(disabledPreset);
  expect(frame.objects.eye_left.visible).toBe(0);
  expect(frame.objects.eye_right.visible).toBe(1);
  expect(frame.objects.head.visible).toBe(1);
});

test("нейтральный кадр и фильтр enabled учитывают вложенность", () => {
  const preset = createDemoPreset();
  const frame = neutralFrame(preset);
  expect(frame.objects.mouth.visible).toBe(1);

  // Выключаем группу головы — гаснут только её потомки.
  const disabledGroup: RigPreset = {
    ...preset,
    objects: preset.objects.map((object) => (object.id === "head_group" ? { ...object, enabled: false } : object)),
  };
  const gated = applyEnabled(disabledGroup, frame);
  expect(gated.objects.head.visible).toBe(0);
  expect(gated.objects.mouth.visible).toBe(0);
  expect(gated.objects.body.visible).toBe(1);
  // Исходный кадр не мутируется.
  expect(frame.objects.head.visible).toBe(1);
});

test("свёрнутая группа скрывает потомков, а не переносит их в конец списка", () => {
  const preset = createDemoPreset();
  const all = treeRows(preset.objects, new Set());
  expect(all.find((row) => row.object.id === "head_group")?.depth).toBe(2);
  expect(all.find((row) => row.object.id === "mouth")?.depth).toBe(3);

  const collapsed = treeRows(preset.objects, new Set(["head_group"]));
  const ids = collapsed.map((row) => row.object.id);
  expect(ids).toContain("head_group");
  for (const hidden of ["head", "eye_left", "eye_right", "mouth", "mouth_closed"]) {
    expect(ids).not.toContain(hidden);
  }
  // Ни один потомок не всплыл в корень.
  expect(collapsed.filter((row) => row.depth === 0).map((row) => row.object.id)).toEqual(["character"]);

  const rootsCollapsed = treeRows(preset.objects, new Set(["character"]));
  expect(rootsCollapsed.map((row) => row.object.id)).toEqual(["character"]);
});
