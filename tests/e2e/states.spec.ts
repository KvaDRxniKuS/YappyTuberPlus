import { test, expect } from "@playwright/test";
import {
  EMPTY_STATES, addKey, addLayer, cloneLayers, insertLayers, invertByInput, keyAt, keyUnderPoint,
  layerRange, makeLayer, manualInputOf, mirrorLayer, moveKey, patchLayer, poseFromBase, readStates, removeKey, removeLayer,
  removeLayers, replacePose, resetStatesFor, reversePoses, scaleKeys, setPose, shiftPose, statesBlock, uniqueLayerName,
  weightsAt, poseAt, applyPoseToBase, sameBase, SMOOTH_DEFAULT, watchNames, writeStates,
  type StateLayer, type States,
} from "../../src/engine/states";
import { paramGroups } from "../../src/engine/paramNames";
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
    name: "взгляд", param: "manual.eye_x", smooth: 0, normalize: "sum",
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

test("сглаживание входа ставит smooth вокруг параметра до расчёта весов", () => {
  const block = statesBlock(states(bound({ smooth: 120 })), object(""));
  expect(block).toContain("t0_0 = limit((smooth(manual.eye_x, 120) - (-1)) / 2, 0, 1)");
  // Без сглаживания параметр идёт напрямую.
  expect(statesBlock(states(bound({ smooth: 0 })), object(""))).toContain("limit((manual.eye_x - (-1)) / 2, 0, 1)");
});

test("свободный слой объявляет веса выражениями", () => {
  const layer: StateLayer = {
    name: "грусть", param: null, smooth: 0, normalize: "sum",
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
  const layer = bound({ smooth: 200, normalize: "average" });
  const written = writeStates("", states(layer), object(""));
  const parsed = readStates(written.script);
  expect(parsed.layers).toHaveLength(1);
  expect(parsed.layers[0]).toMatchObject({
    name: "взгляд", param: "manual.eye_x", smooth: 200, normalize: "average",
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

test("шкала неявная: её задают крайние ключи, у одинокого — паспорт входа", () => {
  // Два ключа — это и есть границы отрезка: отдельного поля «отрезок» нет.
  expect(layerRange(bound())).toEqual([-1, 1]);
  expect(layerRange(bound({ poses: [{ at: 3, pose: {} }, { at: 9, pose: {} }] }))).toEqual([3, 9]);
  // Один ключ: отрезка ещё нет, шкалой служит паспорт входа.
  expect(layerRange(bound({ poses: [{ at: 5, pose: {} }] }), [-1, 1])).toEqual([-1, 1]);
  expect(layerRange(bound({ poses: [{ at: 5, pose: {} }] }))).toEqual([4, 6]);
  expect(layerRange(bound({ poses: [] }), [0, 100])).toEqual([0, 100]);
  expect(layerRange(bound({ poses: [] }))).toEqual([0, 1]);
});

test("в формате слоя нет поля «отрезок»", () => {
  const written = writeStates("x = 0", states(bound()), object(""));
  expect(written.script).not.toContain("\"range\"");
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


/* ── список параметров ───────────────────────────────────────────────── */

test("в списке параметров все группы: входы, глобальные, свои и кадр", () => {
  const groups = paramGroups({
    // Библиотека шаблонов в тесте не загружена, поэтому входы берём у ручного
    // модуля в режиме «состояния»: они выводятся из настроек экземпляра.
    modules: [{
      name: "mode", type: "manual", enabled: true, source: "manual",
      config: { mode: "enum", states: [{ name: "idle", label: "Покой" }, { name: "walk", label: "Идёт" }] },
    }],
    globals: ["blink", "mood"],
    values: { "clock.beat": 0 },
    script: "eye = mode.value * 2\nx = eye * 10",
  });
  const where = (name: string) => groups.find((group) => group.items.some((item) => item.name === name))?.title;
  // Раньше список обрывался на одном `auto.blink`: проверяем, что видны все источники.
  expect(groups.map((group) => group.title))
    .toEqual(["входы", "глобальные", "свои переменные", "значения кадра"]);
  expect(where("mode.walk")).toBe("входы");
  expect(where("blink")).toBe("глобальные");
  expect(where("eye")).toBe("свои переменные");
  expect(where("clock.beat")).toBe("значения кадра");
});

test("имя в списке встречается один раз и с подписью входа", () => {
  const groups = paramGroups({
    modules: [{
      name: "mode", type: "manual", enabled: true, source: "manual",
      config: { mode: "enum", states: [{ name: "walk", label: "Идёт" }] },
    }],
    globals: ["mode.walk"],
    values: { "mode.walk": 1 },
  });
  const flat = groups.flatMap((group) => group.items);
  expect(flat.filter((item) => item.name === "mode.walk")).toHaveLength(1);
  expect(flat.find((item) => item.name === "mode.walk")?.note).toBe("Идёт");
});

test("переменные кадра, которых нет у модулей, попадают отдельной группой", () => {
  const groups = paramGroups({ modules: [], values: { "signal.pulse": 0 } });
  expect(groups).toEqual([{ title: "значения кадра", items: [{ name: "signal.pulse", note: undefined }] }]);
});

/* ── инверсия, разворот, зеркало ─────────────────────────────────────── */

test("инверсия по входу зеркалит значения ключей, позы остаются при них", () => {
  const layer = invertByInput(bound({ poses: [{ at: -1, pose: { x: -20 } }, { at: 1, pose: { x: 20 } }] }));
  expect(layer.poses.map((pose) => pose.at)).toEqual([-1, 1]);
  expect(layer.poses.map((pose) => pose.pose.x)).toEqual([20, -20]);
});

test("на несимметричных ключах инверсия по входу и разворот расходятся", () => {
  const source = bound({ poses: [{ at: -10, pose: { x: 1 } }, { at: 4, pose: { x: 2 } }] });
  // По входу: ключи уезжают в симметричные точки паспорта (ось 0), позы едут с ключами.
  expect(invertByInput(source, [-10, 10]).poses.map((pose) => [pose.at, pose.pose.x])).toEqual([[-4, 2], [10, 1]]);
  // По таймлайну: ключи на месте, позы меняются местами.
  expect(reversePoses(source).poses.map((pose) => [pose.at, pose.pose.x])).toEqual([[-10, 2], [4, 1]]);
});

test("инверсия по входу дважды возвращает исходные ключи", () => {
  const source = bound({ poses: [{ at: 2, pose: { x: 1 } }, { at: 8, pose: { x: 2 } }] });
  expect(invertByInput(invertByInput(source, [0, 10]), [0, 10]).poses).toEqual(source.poses);
});

test("разворот по таймлайну не трогает значения ключей у свободного слоя", () => {
  const free = bound({ param: null, poses: [{ weight: "1", pose: { x: 1 } }, { weight: "2", pose: { x: 2 } }] });
  expect(reversePoses(free).poses.map((pose) => pose.weight)).toEqual(["2", "1"]);
});

test("зеркало относительно вертикальной оси через объект отражает X и знак поворота", () => {
  const layer = mirrorLayer(
    bound({ poses: [{ at: 0, pose: { x: 20, y: 4, rotation: 10, sizeX: 1.5 } }] }),
    { x: 0, y: 0, angle: 90 },
    { x: 0, y: 0 },
  );
  expect(layer.poses[0].pose.x).toBe(-20);
  expect(layer.poses[0].pose.y).toBe(4);
  expect(layer.poses[0].pose.rotation).toBe(-10);
  expect(layer.poses[0].pose.sizeX).toBe(1.5);
});

test("наклон при косой оси не переворачивается, при ортогональной — да", () => {
  const pose = { at: 0, pose: { x: 1, skewX: 6 } };
  expect(mirrorLayer(bound({ poses: [pose] }), { x: 0, y: 0, angle: 90 }, { x: 0, y: 0 }).poses[0].pose.skewX).toBe(-6);
  expect(mirrorLayer(bound({ poses: [pose] }), { x: 0, y: 0, angle: 30 }, { x: 0, y: 0 }).poses[0].pose.skewX).toBe(6);
});

test("зеркало считает точку оси: смещение за точкой отражается на другую сторону", () => {
  const layer = mirrorLayer(
    bound({ poses: [{ at: 0, pose: { x: 110 } }] }),
    { x: 100, y: 0, angle: 90 },
    { x: 0, y: 0 },
  );
  // Положение (110, 0) относительно оси x = 100 уходит в (90, 0).
  expect(layer.poses[0].pose.x).toBe(90);
});

test("зеркало отражает точки деформера в долях картинки", () => {
  const layer = mirrorLayer(
    bound({ poses: [{ at: 0, pose: {}, points: { "1": [0.1, 0.05] } }] }),
    { x: 0, y: 0, angle: 90 },
    { x: 0, y: 0, width: 200, height: 100 },
  );
  expect(layer.poses[0].points?.["1"]).toEqual([-0.1, 0.05]);
});

test("масштабирование ключей под новый диапазон переносит пропорционально", () => {
  const layer = scaleKeys(
    bound({ poses: [{ at: -1, pose: { x: -20 } }, { at: 0, pose: {} }, { at: 1, pose: { x: 20 } }] }),
    [-1, 1],
    [0, 1],
  );
  expect(layer.poses.map((pose) => pose.at)).toEqual([0, 0.5, 1]);
});

/* ── копии и вставка ─────────────────────────────────────────────────── */

test("копии получают свободные имена, в том числе внутри пачки", () => {
  const layers = [bound({ name: "взгляд" }), bound({ name: "взгляд" })];
  const copies = cloneLayers(layers, ["взгляд", "взгляд (2)"]);
  expect(copies.map((layer) => layer.name)).toEqual(["взгляд (3)", "взгляд (4)"]);
  // Правка копии не задевает оригинал: позы — свои объекты.
  copies[0].poses[0].pose.x = 999;
  expect(layers[0].poses[0].pose.x).toBe(-20);
});

test("имя слоя свободно и не переименовывает без нужды", () => {
  expect(uniqueLayerName("грусть", ["радость"])).toBe("грусть");
  expect(uniqueLayerName("грусть", ["грусть"])).toBe("грусть (2)");
  expect(uniqueLayerName("грусть (2)", ["грусть", "грусть (2)"])).toBe("грусть (3)");
});

test("вставка ставит копии после указанного слоя, удаление убирает пачку", () => {
  const source: States = { layers: [bound({ name: "a" }), bound({ name: "b" }), bound({ name: "c" })] };
  const pasted = insertLayers(source, [bound({ name: "x" })], 0);
  expect(pasted.layers.map((layer) => layer.name)).toEqual(["a", "x", "b", "c"]);
  expect(insertLayers(source, [], 99).layers.map((layer) => layer.name)).toEqual(["a", "b", "c"]);
  expect(removeLayers(source, [0, 2]).layers.map((layer) => layer.name)).toEqual(["b"]);
});

/* ── предпросмотр: веса и поза в точке таймлайна ────────────────────── */

test("веса в точке: на ключе — сама поза, между ключами — доля", () => {
  const layer = bound({ });
  expect(weightsAt(layer, -1)).toEqual([1, 0]);
  expect(weightsAt(layer, 0)).toEqual([0.5, 0.5]);
  expect(weightsAt(layer, 1)).toEqual([0, 1]);
  // За крайними ключами значение держится, а не экстраполируется.
  expect(weightsAt(layer, -5)).toEqual([1, 0]);
  expect(weightsAt(layer, 5)).toEqual([0, 1]);
});

test("веса в точке повторяют формулу участков у четырёх ключей", () => {
  const layer = bound({
    poses: [
      { at: 0, pose: {} }, { at: 1, pose: {} }, { at: 2, pose: {} }, { at: 3, pose: {} },
    ],
  });
  // Базис: [1 − t₀, t₀(1 − t₁), t₁(1 − t₂), t₂]; посередине второго участка
  // t₀ = 1, t₁ = 0.5, t₂ = 0 — вес делят второй и третий ключи.
  const weights = weightsAt(layer, 1.5);
  expect(weights[0]).toBeCloseTo(0, 9);
  expect(weights[1]).toBeCloseTo(0.5, 9);
  expect(weights[2]).toBeCloseTo(0.5, 9);
  expect(weights[3]).toBeCloseTo(0, 9);
  expect(weights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
});

test("поза слоя в точке: смещения складываются, размер — множитель", () => {
  const layer = bound({
    poses: [{ at: -1, pose: { x: -20, sizeX: 2 } }, { at: 1, pose: { x: 20, sizeX: 1 } }],
  });
  // Середина: смещения взаимно гасятся (в дельту не попадают), размер — 1.5.
  expect(poseAt(layer, 0)).toEqual({ sizeX: 1.5 });
  expect(poseAt(layer, -1)).toEqual({ x: -20, sizeX: 2 });
  // Пустая дельта: на ключе нет позы — объект не двигается.
  expect(poseAt(bound({ poses: [{ at: 0, pose: {} }] }), 0)).toEqual({});
});

test("путь жеста прибавляется к показанной позе, а не заменяет её", () => {
  // Что показывает ключ под точкой...
  const shown = poseAt(bound({ poses: [{ at: -1, pose: { x: -20, sizeX: 2 } }, { at: 3, pose: {} }] }), -1);
  expect(shown).toEqual({ x: -20, sizeX: 2 });
  // ...плюс то, что человек протащил мышью: смещения складываются, множители
  // перемножаются. Иначе объект прыгал бы назад к базе на каждом шаге.
  expect(shiftPose(shown, { x: 30, rotation: 5, sizeX: 1.5, opacity: 0.8 }))
    .toEqual({ x: 10, sizeX: 3, opacity: 0.8, rotation: 5 });
  // Исходная поза не портится: её читают и другие места панели.
  expect(shown).toEqual({ x: -20, sizeX: 2 });
  // Второй жест считается от новой позы: повторное смещение не удваивается.
  expect(shiftPose(shiftPose({ x: 5 }, { x: 10 }), { x: -5 })).toEqual({ x: 10 });
  // Мышь даёт длинную дробь — в ключ уходит тысячное округление.
  expect(shiftPose({}, { x: 1 / 3 })).toEqual({ x: 0.333 });
  // Нейтральная база множителей — единица, а не ноль.
  expect(shiftPose({}, { sizeX: 1.2 })).toEqual({ sizeX: 1.2 });
});

test("предпросмотр накладывает дельту на базу теми же правилами, что каналы", () => {
  const base = { x: 10, y: 0, rotation: 0, skewX: 0, skewY: 0, sizeX: 100, sizeY: 100, opacity: 1 };
  const posed = applyPoseToBase(base, { x: 5, rotation: -10, sizeX: 0.5, opacity: 0.5 }) as typeof base;
  expect(posed.x).toBe(15);
  expect(posed.rotation).toBe(-10);
  expect(posed.sizeX).toBe(50);
  expect(posed.opacity).toBe(0.5);
  expect(posed.y).toBe(0);
});

test("своя запись предпросмотра не считается правкой человека", () => {
  const base = { x: 10, y: 0, rotation: 0, skewX: 0, skewY: 0, sizeX: 100, sizeY: 100, opacity: 1 };
  expect(sameBase(base, { ...base, x: 10.0000001 })).toBe(true);
  expect(sameBase(base, { ...base, x: 10.5 })).toBe(false);
  expect(sameBase(null, base)).toBe(false);
});

test("старый формат сглаживания читается как включённое сглаживание", () => {
  const legacy = statesBlock({ layers: [{ ...bound(), smooth: 120 }] }, object(""));
  expect(legacy).toContain("smooth(manual.eye_x, 120)");
  const parsed = readStates(`// ── состояния: вкладка «Состояния» ──
// @states {"layers":[{"name":"взгляд","param":"manual.eye_x","smooth":true,"normalize":"sum","poses":[{"at":0,"pose":{}}]}]}
// ── конец состояний ──`);
  expect(parsed.layers[0].smooth).toBe(SMOOTH_DEFAULT);
});

test("ключ под точкой шкалы — ближайший, и правка его не переставляет", () => {
  const layer = bound({
    poses: [
      { at: -1, pose: { x: -20 } },
      { at: 0, pose: { x: 0 } },
      { at: 1, pose: { x: 20 } },
    ],
  });
  expect(keyUnderPoint(layer, -0.9)).toBe(0);
  expect(keyUnderPoint(layer, 0.1)).toBe(1);
  expect(keyUnderPoint(layer, 0.9)).toBe(2);
  // Точка между ключами: поле правит ближайший, а не первый.
  expect(keyUnderPoint(layer, 0.61)).toBe(2);
  // Порядок после переноса ключа восстанавливается — и «под точкой» остаётся
  // тот же ключ, а не первый в списке.
  const moved = moveKey(layer, 2, -0.5);
  // Ключи идут по возрастанию: −1, −0.5, 0 — перенесённый встал в середину.
  expect(moved.poses.map((item) => item.at)).toEqual([-1, -0.5, 0]);
  expect(keyUnderPoint(moved, -0.5)).toBe(1);
  expect(moved.poses[1].pose.x).toBe(20);
});

test("ключ на занятой позиции не появляется второй раз", () => {
  const layer = bound();
  expect(keyAt(layer, -1)).toBe(0);
  expect(keyAt(layer, 1)).toBe(1);
  expect(keyAt(layer, 0.5)).toBe(-1);
  // Значения с плавающей точкой сравниваются с допуском: 0.1 + 0.2 — это 0.3.
  const close = bound({ poses: [{ at: 0.3, pose: {} }, { at: 1, pose: {} }] });
  expect(keyAt(close, 0.1 + 0.2)).toBe(0);
  // Ключей нет — попадания тоже нет.
  expect(keyAt({ ...layer, poses: [] }, 0)).toBe(-1);
});

test("поза ключа заменяется целиком: снятое поле исчезает", () => {
  const layer = bound({ poses: [{ at: -1, pose: { x: 4, y: 7 } }, { at: 1, pose: {} }] });
  // returned to neutral → поле убирается, а не остаётся старым числом
  const cleared = replacePose(layer, 0, { x: 4 });
  expect(cleared.poses[0].pose).toEqual({ x: 4 });
  // полный сброс позы: ключ больше не двигает объект
  expect(replacePose(layer, 0, {}).poses[0].pose).toEqual({});
  // чужие ключи не трогаются
  expect(cleared.poses[1].pose).toEqual({});
});
