import { test, expect } from "@playwright/test";
import {
  EMPTY_STATES, addKey, addLayer, layerRange, makeLayer, manualInputOf, moveKey, patchLayer,
  poseFromBase, readStates, removeKey, removeLayer, resetStatesFor, setPose, statesBlock,
  watchNames, writeStates,
  type StateLayer, type States,
} from "../../src/engine/states";
import { engineStructure } from "../../src/engine/preset";
import { DEFAULT_BASE, type RigObject, type RigPreset } from "../../src/types";

/*
 * Блок состояний: разбор, генерация весов и вставка терма в авторские строки.
 * Всё это — данные и текст скрипта, поэтому проверяется без браузера и ядра.
 */

function object(script: string, parentId: string | null = null): RigObject {
  return {
    id: "o1", name: "Глаз", kind: "sprite", enabled: true, image: null,
    parentId, pivot: { x: 0.5, y: 0.5 }, base: { ...DEFAULT_BASE },
    script, width: 100, height: 100,
  };
}

function bound(partial: Partial<StateLayer> = {}): StateLayer {
  return {
    name: "взгляд", param: "manual.eye_x", range: [-1, 1], smooth: false, normalize: "sum",
    poses: [
      { at: -1, pose: { x: -20 } },
      { at: 1, pose: { x: 20 } },
    ],
    ...partial,
  };
}

function states(layer: StateLayer): States {
  return { layers: [layer] };
}

test("две позы дают линейный базис из двух весов", () => {
  const block = statesBlock(states(bound()), object(""));
  expect(block).toContain("t0_0 = limit((manual.eye_x - (-1)) / 2, 0, 1)");
  expect(block).toContain("x_states = (-20) * (1 - t0_0) + 20 * t0_0");
  // Терм веса в сумме даёт единицу — это и есть «две позы = сетка по одной оси».
  expect(block).not.toContain("y_states");
});

test("четыре ключа дают три участка и разные скорости", () => {
  const layer = bound({
    poses: [
      { at: -1, pose: { x: -30 } },
      { at: -0.5, pose: { x: -10 } },
      { at: 0.5, pose: { x: 10 } },
      { at: 1, pose: { x: 30 } },
    ],
  });
  const block = statesBlock(states(layer), object(""));
  expect(block).toContain("t0_0 = limit((manual.eye_x - (-1)) / 0.5, 0, 1)");
  expect(block).toContain("t0_1 = limit((manual.eye_x - (-0.5)) / 1, 0, 1)");
  expect(block).toContain("t0_2 = limit((manual.eye_x - 0.5) / 0.5, 0, 1)");
  // Крайние веса — крайние участки, средние — разность соседних.
  expect(block).toContain("x_states = (-30) * (1 - t0_0) + (-10) * (t0_0 * (1 - t0_1))"
    + " + 10 * (t0_1 * (1 - t0_2)) + 30 * t0_2");
});

test("плавный ход добавляет smoothstep в каждый участок", () => {
  const block = statesBlock(states(bound({ smooth: true })), object(""));
  expect(block).toContain("t0_0 = smoothstep(0, 1, limit((manual.eye_x - (-1)) / 2, 0, 1))");
});

test("свободный слой объявляет веса выражениями", () => {
  const layer: StateLayer = {
    name: "грусть", param: null, range: null, smooth: false, normalize: "sum",
    poses: [{ weight: "smooth(mood, 240)", pose: { y: 6 } }],
  };
  const block = statesBlock(states(layer), object(""));
  expect(block).toContain("w0_0 = (smooth(mood, 240))");
  expect(block).toContain("y_states = 6 * w0_0");
});

test("average делит на сумму весов, sum — нет", () => {
  const poses = [
    { weight: "smooth(mood, 240)", pose: { y: 10 } },
    { weight: "smooth(angry, 240)", pose: { y: 6 } },
  ];
  const sum = statesBlock(states({ ...bound(), param: null, normalize: "sum", poses }), object(""));
  const average = statesBlock(states({ ...bound(), param: null, normalize: "average", poses }), object(""));
  expect(sum).toContain("y_states = 10 * w0_0 + 6 * w0_1");
  expect(average).toContain("y_states = (10 * w0_0 + 6 * w0_1) / (w0_0 + w0_1)");
});

test("размер — множитель, видимость только гасит", () => {
  const layer = bound({
    poses: [
      { at: -1, pose: { sizeX: 0.5, visible: 0.25 } },
      { at: 1, pose: { sizeX: 1, visible: 1 } },
    ],
  });
  const block = statesBlock(states(layer), object(""));
  expect(block).toContain("sizeX_states = 1 + ((-0.5) * (1 - t0_0))");
  expect(block).toContain("visible_states = (1 - (1 - t0_0) * 0.75)");
});

test("терм вставляется в авторскую строку и убирается при сбросе", () => {
  const script = "x = inherit + 3 * delta\ny = inherit\n";
  const written = writeStates(script, states(bound()), object(script, "group"));
  expect(written.script).toContain("x = inherit + x_states + 3 * delta");
  expect(written.script).toContain("// ── состояния: вкладка «Состояния» ──");
  const cleared = writeStates(written.script, EMPTY_STATES, object(written.script, "group"));
  expect(cleared.script).not.toContain("states");
  expect(cleared.script).toContain("x = inherit + 3 * delta");
});

test("сброс нескольких объектов возвращает скрипты по id", () => {
  const first = object("", null);
  const second = { ...object("", null), id: "o2" };
  const scripts = resetStatesFor([first, second]);
  expect(Object.keys(scripts).sort()).toEqual(["o1", "o2"]);
});

test("круг «запись → чтение» сохраняет ключи, отрезок и режим", () => {
  const layer = bound({ smooth: true, normalize: "average", range: [-2, 2] });
  const written = writeStates("", states(layer), object(""));
  const parsed = readStates(written.script);
  expect(parsed.layers).toHaveLength(1);
  expect(parsed.layers[0]).toMatchObject({
    name: "взгляд", param: "manual.eye_x", range: [-2, 2], smooth: true, normalize: "average",
  });
  expect(parsed.layers[0].poses.map((pose) => pose.at)).toEqual([-1, 1]);
  expect(parsed.layers[0].poses[0].pose).toEqual({ x: -20 });
});

test("ключи сортируются, одинаковые схлопываются", () => {
  const layer = bound({
    poses: [
      { at: 1, pose: { x: 20 } },
      { at: -1, pose: { x: -20 } },
      { at: -1, pose: { x: -22 } },
    ],
  });
  const parsed = readStates(writeStates("", states(layer), object("")).script);
  expect(parsed.layers[0].poses.map((pose) => pose.at)).toEqual([-1, 1]);
  expect(parsed.layers[0].poses[0].pose).toEqual({ x: -22 });
});

test("битый JSON не ломает объект и не переписывает скрипт", () => {
  const script = "// @states {это не json\nx = inherit\n";
  expect(readStates(script).layers).toEqual([]);
  const cleared = writeStates(script, EMPTY_STATES, object(script));
  expect(cleared.script).toBe(script);
});

test("в блок не попадает многострочное выражение", () => {
  const parsed = readStates(
    `// @states {"layers":[{"name":"a","param":null,"poses":[{"weight":"a\\nb","pose":{"x":1}}]}]}\n`,
  );
  expect(parsed.layers[0].poses[0].weight).toBeUndefined();
});

test("в watch попадают только локальные имена, не входы модулей", () => {
  expect(watchNames({ layers: [
    bound({ param: "manual.eye_x" }),
    bound({ param: "eye_target" }),
    bound({ param: "state.mood" }),
  ] })).toEqual(["eye_target"]);
});

test("структура для ядра просит переменные объекта в watch", () => {
  // Слой, привязанный к локальной переменной: рендерер её значения не видит,
  // поэтому имя уходит в `watch`, а ядро вернёт его в `vars` кадра.
  const script = writeStates("x = inherit\n", states(bound({ param: "eye_target" })), object("x = inherit")).script;
  const built = JSON.parse(engineStructure({
    canvas: { width: 1000, height: 600 },
    objects: [object(script)],
    globals: "",
    modules: [],
  } as unknown as RigPreset));
  expect(built.objects[0].watch).toEqual(["eye_target"]);
});

test("новый слой: привязка к первому входу или свободные веса", () => {
  expect(makeLayer(0, "manual.eye_x")).toMatchObject({ param: "manual.eye_x", normalize: "sum" });
  expect(makeLayer(1, "manual.eye_x").poses[0].at).toBe(0);
  expect(makeLayer(0, null).poses[0].weight).toBe("1");
});

test("клик по таймлайну: ключ добавляется, повторный клик не плодит двойника", () => {
  const layer = bound({ poses: [{ at: -1, pose: { x: -20 } }] });
  const once = addKey(layer, 1, { x: 20 });
  expect(once.poses.map((pose) => pose.at)).toEqual([-1, 1]);
  const twice = addKey(once, 1, { y: 5 });
  expect(twice.poses).toHaveLength(2);
  expect(twice.poses[1].pose).toEqual({ x: 20, y: 5 });
});

test("ключ переезжает и сортируется, одинаковые сливаются", () => {
  const layer = bound({ poses: [{ at: -1, pose: { x: -1 } }, { at: 0, pose: { x: 0 } }] });
  expect(moveKey(layer, 0, 2).poses.map((pose) => pose.at)).toEqual([0, 2]);
  expect(moveKey(layer, 0, 0).poses).toHaveLength(1);
});

test("удаление ключа и слоя не трогает остальные", () => {
  const two = addLayer(states(bound()), makeLayer(1, null));
  expect(removeLayer(two, 0).layers).toHaveLength(1);
  expect(removeLayer(two, 0).layers[0].param).toBeNull();
  expect(removeKey(bound(), 0).poses).toHaveLength(1);
});

test("правка слоя меняет только выбранный", () => {
  const two = addLayer(states(bound()), makeLayer(1, null));
  const patched = patchLayer(two, 1, { name: "злость" });
  expect(patched.layers[0].name).toBe("взгляд");
  expect(patched.layers[1].name).toBe("злость");
});

test("отрезок таймлайна: свой, затем крайние ключи, затем 0…1", () => {
  expect(layerRange(bound({ range: [-2, 2] }))).toEqual([-2, 2]);
  expect(layerRange(bound({ range: null }))).toEqual([-1, 1]);
  expect(layerRange(bound({ range: null, poses: [{ at: 5, pose: {} }] }))).toEqual([4, 6]);
  expect(layerRange(bound({ range: null, poses: [] }), [0, 100])).toEqual([0, 100]);
  expect(layerRange(bound({ range: null, poses: [] }))).toEqual([0, 1]);
});

test("предпросмотр двигает только manual-входы", () => {
  expect(manualInputOf("manual.eye_x")).toBe("eye_x");
  expect(manualInputOf("tracker.head_rx")).toBeNull();
  expect(manualInputOf(null)).toBeNull();
});

test("запись позы: сдвиг складывается, размер — отношением", () => {
  const pose = poseFromBase(
    { x: 10, y: 20, rotation: 5, sizeX: 2, sizeY: 1, opacity: 1 },
    { x: 16, y: 20, rotation: 5, sizeX: 1, sizeY: 1, opacity: 0.5 },
  );
  // Неизменённые поля в позу не попадают: ключ хранит только то, что двигали.
  expect(pose).toEqual({ x: 6, sizeX: 0.5, opacity: 0.5 });
});

test("дельта позы не накапливает ошибку округления", () => {
  const pose = poseFromBase({ x: 0 }, { x: 0.0000004, rotation: 12.34567 });
  expect(pose.x).toBeUndefined();
  expect(pose.rotation).toBe(12.346);
});

test("поза пишется в выбранный ключ, остальные не меняются", () => {
  const layer = setPose(bound(), 1, { y: 4 });
  expect(layer.poses[0].pose).toEqual({ x: -20 });
  expect(layer.poses[1].pose).toEqual({ x: 20, y: 4 });
});

test("пустая поза не теряет слой: блок остаётся в скрипте", () => {
  // Слой только что создан, ни одного поля не тронуто — каналов нет, но
  // настройки обязаны пережить запись, иначе вкладка обнулилась бы.
  const layer = bound({ poses: [{ at: -1, pose: {} }, { at: 1, pose: {} }] });
  const written = writeStates("x = inherit\n", states(layer), object("x = inherit", "g"));
  expect(written.script).toContain("// @states ");
  expect(written.script).not.toContain("x_states");
  expect(readStates(written.script).layers[0].poses).toHaveLength(2);
  expect(written.script).toContain("x = inherit");
});
