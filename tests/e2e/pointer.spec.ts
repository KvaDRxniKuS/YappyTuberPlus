import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { moduleDefaults, moduleDefinition, normalizeDefinition, registerDefinitions } from "../../src/modules/registry";
import { composeValues, instanceInputs } from "../../src/modules/values";
import { normalizeModules } from "../../src/engine/preset";
import {
  PointerState, keyInputName, keyLabel, keyboardKeys, mouseArea, mouseSpaceOf, mouseValue,
  monitorLabel, uniqueKeyName, type PointerFrame, type ScreenSpace,
} from "../../src/modules/pointer";
import type { KeyboardKey, ModuleInstance } from "../../src/types";

test.beforeAll(() => {
  const directory = join(process.cwd(), "public", "modules");
  const index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")) as { modules: string[] };
  const definitions = index.modules
    .map((id) => normalizeDefinition(JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"))))
    .filter((definition) => definition !== null);
  registerDefinitions(definitions);
});

const module = (name: string, type: string, config: ModuleInstance["config"] = {}): ModuleInstance => ({
  name,
  type,
  enabled: true,
  source: "manual",
  config: { ...moduleDefaults(moduleDefinition(type)), ...config },
});

test("нажатие считается один раз, автоповтор не крутит счётчик", () => {
  const state = new PointerState();
  state.key("Space", true, 0);
  state.key("Space", true, 10); // автоповтор
  const frame = state.snapshot(500);
  expect(frame.keys.Space).toEqual({ down: 1, hold: 0.5, hits: 1 });
  state.key("Space", false, 600);
  const released = state.snapshot(900);
  expect(released.keys.Space).toEqual({ down: 0, hold: 0, hits: 1 });
  // Повторное отпускание ничего не ломает.
  state.key("Space", false, 950);
  expect(state.snapshot(1000).keys.Space.hits).toBe(1);
});

test("движение мыши копится между кадрами и сбрасывается", () => {
  const state = new PointerState();
  // Первый замер только запоминает место: смещения от нуля координат быть не должно.
  state.move(200, 800);
  const first = state.snapshot(0);
  expect(first.mouse.screenX).toBe(200);
  expect(first.mouse.screenY).toBe(800);
  expect(first.mouse.dx).toBe(0);
  expect(first.mouse.dy).toBe(0);
  // Дальше смещение — пиксели экрана: 30 − 20 = +10, 60 − 80 = −20.
  state.move(230, 780);
  const moved = state.snapshot(33);
  expect(moved.mouse.screenX).toBe(230);
  expect(moved.mouse.dx).toBe(30);
  expect(moved.mouse.dy).toBe(-20);
  const idle = state.snapshot(66);
  expect(idle.mouse.dx).toBe(0);
  expect(idle.mouse.dy).toBe(0);
});

test("колесо нормируется и обрезается, кнопки отпускаются по blur", () => {
  const state = new PointerState();
  state.wheel(100);
  state.wheel(100);
  expect(state.snapshot(0).mouse.wheel).toBe(1);
  state.button("left", true);
  state.button("right", true);
  expect(state.snapshot(0).mouse.left).toBe(1);
  state.releaseAll();
  const released = state.snapshot(0);
  expect(released.mouse.left).toBe(0);
  expect(released.mouse.right).toBe(0);
  // Место на экране не обрезается: курсор бывает и за границей окна.
  state.move(2600, -40);
  const far = state.snapshot(0);
  expect(far.mouse.screenX).toBe(2600);
  expect(far.mouse.screenY).toBe(-40);
});

test("имена и подписи клавиш", () => {
  expect(keyInputName("Space")).toBe("space");
  expect(keyInputName("KeyA")).toBe("a");
  expect(keyInputName("Digit1")).toBe("1");
  expect(keyInputName("ShiftLeft")).toBe("shift_left");
  expect(keyLabel("KeyQ")).toBe("Q");
  expect(keyLabel("Space")).toBe("Пробел");
  expect(keyLabel("ArrowLeft")).toBe("←");
  expect(uniqueKeyName([{ name: "space" }], "space")).toBe("space_2");
});

test("клавиатурный модуль: входы из настроек экземпляра", () => {
  const keys: KeyboardKey[] = [
    { code: "Space", name: "space" },
    { code: "KeyQ", name: "q" },
  ];
  const keyboard = module("board", "keyboard", { keys });
  expect(keyboardKeys(keyboard)).toEqual(keys);
  const inputs = instanceInputs(keyboard);
  expect(inputs.map((spec) => spec.name)).toEqual(["space", "q"]);
  expect(inputs[1].label).toBe("Q");

  const values = composeValues([keyboard], {
    audio: {}, manual: {}, auto: {},
    pointer: { keys: { Space: { down: 1, hold: 1.5, hits: 3 }, KeyQ: { down: 0, hold: 0, hits: 1 } }, mouse: emptyMouse() },
  });
  expect(values["board.space"]).toBe(1);
  expect(values["board.q"]).toBe(0);

  // Выключенный вход не уходит в кадр.
  const disabled = { ...keyboard, disabledInputs: ["q"] };
  const partial = composeValues([disabled], {
    audio: {}, manual: {}, auto: {},
    pointer: { keys: { Space: { down: 1, hold: 1, hits: 1 } }, mouse: emptyMouse() },
  });
  expect(partial["board.space"]).toBe(1);
  expect(partial["board.q"]).toBeUndefined();
});

test("модуль одной клавиши отдаёт down, hold и hits", () => {
  const jump = module("jump", "key", { code: "Space" });
  const values = composeValues([jump], {
    audio: {}, manual: {}, auto: {},
    pointer: { keys: { Space: { down: 1, hold: 0.75, hits: 2 } }, mouse: emptyMouse() },
  });
  expect(values["jump.down"]).toBe(1);
  expect(values["jump.hold"]).toBe(0.75);
  expect(values["jump.hits"]).toBe(2);

  // Другая клавиша в config — другие значения.
  const other = module("other", "key", { code: "KeyA" });
  const none = composeValues([other], { audio: {}, manual: {}, auto: {}, pointer: { keys: {}, mouse: emptyMouse() } });
  expect(none["other.down"]).toBe(0);
});

/**
 * Экран для тестов: окно 800×600 в точке (100, 50), монитор 1920×1080,
 * курсор в точке (500, 350). В физических пикселях монитора масштаб 1.
 */
function screen(overrides: Partial<ScreenSpace> = {}): ScreenSpace {
  return {
    window: { x: 100, y: 50, width: 800, height: 600, scale: 1 },
    monitors: [
      { index: 0, name: "Основной", x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary: true },
      { index: 1, name: "Второй", x: 1920, y: 0, width: 1280, height: 1024, scale: 1, primary: false },
    ],
    scene: { x: 300, y: 150, width: 400, height: 400, scale: 1 },
    ...overrides,
  };
}

test("мышь: позиция, смещение, кнопки и колесо как входы", () => {
  // По умолчанию модуль смотрит на монитор: (500, 350) из 1920×1080.
  const mouse = module("cursor", "mouse");
  const frame: PointerFrame = {
    keys: {},
    mouse: { screenX: 500, screenY: 350, dx: -10, dy: 20, left: 1, right: 0, wheel: 0.5 },
    screen: screen(),
  };
  const values = composeValues([mouse], { audio: {}, manual: {}, auto: {}, pointer: frame });
  expect(values["cursor.x"]).toBeCloseTo(500 / 1920, 6);
  expect(values["cursor.y"]).toBeCloseTo(350 / 1080, 6);
  // Пиксели внутри области — то же место, но без деления на размер.
  expect(values["cursor.px"]).toBe(500);
  expect(values["cursor.py"]).toBe(350);
  // Смещение — пиксели за кадр, а не доли.
  expect(values["cursor.dx"]).toBe(-10);
  expect(values["cursor.dy"]).toBe(20);
  expect(values["cursor.left"]).toBe(1);
  expect(values["cursor.wheel"]).toBe(0.5);
});

test("мышь: область чтения — окно, монитор и сцена", () => {
  const frame: PointerFrame = {
    keys: {},
    mouse: { screenX: 500, screenY: 350, dx: 0, dy: 0, left: 0, right: 0, wheel: 0 },
    screen: screen(),
  };
  const inWindow = module("inwindow", "mouse", { space: "window" });
  const inScene = module("inscene", "mouse", { space: "scene" });
  const onSecond = module("second", "mouse", { space: "monitor", monitor: "1" });
  const values = composeValues([inWindow, inScene, onSecond], { audio: {}, manual: {}, auto: {}, pointer: frame });
  // Окно начинается в (100, 50) и имеет размер 800×600.
  expect(values["inwindow.x"]).toBeCloseTo(400 / 800, 6);
  expect(values["inwindow.y"]).toBeCloseTo(300 / 600, 6);
  expect(values["inwindow.px"]).toBe(400);
  // Сцена начинается в (300, 150) и имеет размер 400×400.
  expect(values["inscene.x"]).toBeCloseTo(200 / 400, 6);
  expect(values["inscene.py"]).toBe(200);
  // Второй монитор начинается с x = 1920: курсор левее него — отрицательные пиксели.
  expect(values["second.px"]).toBe(500 - 1920);
  expect(values["second.x"]).toBe(0);
});

test("мышь: без геометрии экрана координаты нулевые, кнопки работают", () => {
  const mouse = module("cursor", "mouse");
  const frame: PointerFrame = {
    keys: {},
    mouse: { screenX: 500, screenY: 350, dx: 4, dy: 0, left: 1, right: 0, wheel: 0 },
  };
  const values = composeValues([mouse], { audio: {}, manual: {}, auto: {}, pointer: frame });
  expect(values["cursor.x"]).toBe(0);
  expect(values["cursor.px"]).toBe(0);
  expect(values["cursor.left"]).toBe(1);
  expect(values["cursor.dx"]).toBe(4);
});

test("мышь: инверсия Y — свойство экземпляра", () => {
  const frame: PointerFrame = {
    keys: {},
    mouse: { screenX: 480, screenY: 108, dx: 0, dy: 20, left: 0, right: 0, wheel: 0 },
    screen: { ...screen(), scene: null, window: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } },
  };
  const plain = module("plain", "mouse", { space: "window" });
  const flipped = module("flipped", "mouse", { space: "window", invertY: true });
  const values = composeValues([plain, flipped], { audio: {}, manual: {}, auto: {}, pointer: frame });
  expect(values["plain.y"]).toBeCloseTo(0.1, 6);
  expect(values["plain.dy"]).toBe(20);
  expect(values["flipped.y"]).toBeCloseTo(0.9, 6);
  expect(values["flipped.dy"]).toBe(-20);
  // Инверсия не трогает X.
  expect(values["flipped.x"]).toBeCloseTo(0.25, 6);
});

test("бинда нет: модуль key отдаёт нули, пустая строка переживает загрузку", () => {
  const jump = module("jump", "key", { code: "" });
  const values = composeValues([jump], {
    audio: {}, manual: {}, auto: {},
    pointer: { keys: { Space: { down: 1, hold: 0.5, hits: 4 } }, mouse: emptyMouse() },
  });
  expect(values["jump.down"]).toBe(0);
  expect(values["jump.hold"]).toBe(0);
  expect(values["jump.hits"]).toBe(0);
  // Пустой code — осознанное «бинда нет», а не повод подставить Space.
  const stored = normalizeModules([jump])[0];
  expect(stored.config.code).toBe("");
  const fresh = normalizeModules([{ name: "empty", type: "key", enabled: true, source: "manual", config: {} }])[0];
  expect(fresh.config.code).toBe("");
});

test("пресет сохраняет клавиши и код клавиши", () => {
  const modules = normalizeModules([
    { name: "board", type: "keyboard", enabled: true, source: "manual", config: {
      keys: [
        { code: "Space", name: "bad name!" },
        { code: "KeyQ", name: "space" },
        { code: "KeyQ", name: "dup" },
        { code: "", name: "пусто" },
      ],
    } },
    { name: "jump", type: "key", enabled: true, source: "manual", config: { code: "KeyZ" } },
    { name: "future", type: "future-module", enabled: true, source: "live", config: { keys: [{ code: "KeyX", name: "x" }] } },
  ]);
  // Имена чистятся и не повторяются, пустой код отбрасывается.
  expect((modules[0].config.keys as KeyboardKey[]).map((key) => key.name)).toEqual(["bad_name", "space"]);
  expect(modules[1].config.code).toBe("KeyZ");
  // Неизвестный шаблон не теряет свои клавиши.
  expect((modules[2].config.keys as KeyboardKey[]).map((key) => key.code)).toEqual(["KeyX"]);
});

function emptyMouse() {
  return { screenX: 0, screenY: 0, dx: 0, dy: 0, left: 0, right: 0, wheel: 0 };
}

test("стоп обнуляет счётчики hits, но не состояние клавиши", () => {
  const state = new PointerState();
  state.key("Space", true, 0);
  state.key("Space", false, 100);
  state.key("Space", true, 200);
  expect(state.snapshot(300).keys.Space).toMatchObject({ down: 1, hits: 2 });

  state.resetHits();
  const after = state.snapshot(300).keys.Space;
  expect(after.hits).toBe(0);
  expect(after.down).toBe(1);
  // Нажатие после стопа считается заново.
  state.key("Space", false, 400);
  state.key("Space", true, 500);
  expect(state.snapshot(600).keys.Space.hits).toBe(1);
});
