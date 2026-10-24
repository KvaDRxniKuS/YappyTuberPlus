import { expect, test } from "@playwright/test";
import { compileScripts, createEventState, runtimeValues } from "../../src/engine/scriptRuntime";
import { createDemoPreset } from "../../src/data/demoPreset";
import type { RigFrame, RigPreset } from "../../src/types";

function presetWith(globals: string, scripts: Record<string, string> = {}): RigPreset {
  const preset = createDemoPreset();
  return {
    ...preset,
    globals,
    modules: [],
    objects: preset.objects.map((object) => (scripts[object.id] !== undefined ? { ...object, script: scripts[object.id] } : object)),
  };
}

const frameOf = (globals: Record<string, number>, objects: Record<string, Record<string, number>> = {}): RigFrame => ({
  seq: 1,
  time: 1,
  dt: 1 / 30,
  globals,
  objects: objects as RigFrame["objects"],
  order: [],
  diagnostics: [],
});

test("событие разворачивается в условие с состоянием прошлого кадра", () => {
  const compiled = compileScripts(presetWith("on event.mouse.left.down {\n  a = !a\n}"));
  expect(compiled.events).toHaveLength(1);
  expect(compiled.events[0]).toMatchObject({ key: "event.e1", source: "mouse.left", kind: "down" });
  // Ядро понимает `not`, а не `!`: редактор приводит запись к его синтаксису.
  expect(compiled.globals.trim()).toBe("a = event.e1 ? (not state.g_a) : (state.g_a)");
  expect(compiled.states).toEqual([{ key: "state.g_a", name: "a" }]);
  // Строки блока остаются на местах (номера строк совпадают с редактором),
  // присваивание дописывается следом.
  const lines = compiled.globals.split("\n");
  expect(lines.slice(0, 3)).toEqual(["", "", ""]);
  expect(lines[3]).toBe("a = event.e1 ? (not state.g_a) : (state.g_a)");
});

test("импульс срабатывает один раз на фронт, состояние берётся из кадра", () => {
  const compiled = compileScripts(presetWith("on event.mouse.left.down {\n  a = !a\n}"));
  const state = createEventState();
  const at = (value: number, now: number) => runtimeValues(compiled, frameOf({ a: 1 }), { "mouse.left": value }, now, state);

  expect(at(0, 0)["event.e1"]).toBe(0);
  expect(at(1, 33)["event.e1"]).toBe(1); // фронт
  expect(at(1, 66)["event.e1"]).toBe(0); // держится — не повторяется
  expect(at(0, 99)["event.e1"]).toBe(0); // отпускание — не down
  expect(at(1, 132)["event.e1"]).toBe(1); // второй клик
  // Снимок переменной — то, что движок посчитал в прошлом кадре.
  expect(at(1, 165)["state.g_a"]).toBe(1);
});

test("up и change срабатывают на своих переходах", () => {
  const compiled = compileScripts(presetWith(
    "on event.cursor.left.up {\n  b = 1\n}\non event.cursor.wheel.change {\n  c = 2\n}",
  ));
  expect(compiled.events.map((rule) => rule.kind)).toEqual(["up", "change"]);
  const state = createEventState();
  const at = (values: Record<string, number>, now: number) => runtimeValues(compiled, frameOf({}), values, now, state);

  expect(at({ "cursor.left": 1, "cursor.wheel": 0 }, 0)["event.e1"]).toBe(0);
  expect(at({ "cursor.left": 1, "cursor.wheel": 0 }, 33)["event.e1"]).toBe(0);
  expect(at({ "cursor.left": 0, "cursor.wheel": 0 }, 66)["event.e1"]).toBe(1);
  expect(at({ "cursor.left": 0, "cursor.wheel": 0.5 }, 99)["event.e2"]).toBe(1);
  expect(at({ "cursor.left": 0, "cursor.wheel": 0.5 }, 132)["event.e2"]).toBe(0);
});

test("hold и relax ждут заданное время и не повторяются", () => {
  const compiled = compileScripts(presetWith(
    "on event.jump.down.hold(0.5) {\n  d = 1\n}\non event.jump.down.relax(0.5) {\n  d = 0\n}",
  ));
  expect(compiled.events.map((rule) => [rule.kind, rule.seconds])).toEqual([["hold", 0.5], ["relax", 0.5]]);
  const state = createEventState();
  const at = (value: number, now: number) => runtimeValues(compiled, frameOf({}), { "jump.down": value }, now, state);

  at(1, 0);
  expect(at(1, 300)["event.e1"]).toBe(0); // ещё не полсекунды
  expect(at(1, 600)["event.e1"]).toBe(1); // сработало
  expect(at(1, 900)["event.e1"]).toBe(0); // и больше не повторяется
  at(0, 1000);
  expect(at(0, 1300)["event.e2"]).toBe(0);
  expect(at(0, 1600)["event.e2"]).toBe(1); // отпущено дольше 0.5 с
});

test("событие в скрипте объекта меняет его параметр", () => {
  const preset = presetWith("", { head: "on event.board.down.down { x = 0 }" });
  const compiled = compileScripts(preset);
  const script = compiled.objects.get("head") || "";
  expect(script).toContain("x = event.e1 ? (0) : (state.o_head_x)");
  expect(compiled.states).toContainEqual({ key: "state.o_head_x", objectId: "head", param: "x" });
});

test("событие перекрывает обычное присваивание только на своём кадре", () => {
  const compiled = compileScripts(presetWith("a = 1\non event.mouse.left.down {\n  a = a + 5\n}"));
  const lines = compiled.globals.trim().split("\n");
  expect(lines).toHaveLength(1);
  // В теле своя переменная — прошлый кадр, а не сам себя: иначе это цикл.
  expect(lines[0]).toBe("a = event.e1 ? (state.g_a + 5) : (1)");
});

test("ссылка на чужой объект превращается в снимок прошлого кадра", () => {
  const preset = presetWith("target = mouth.x + head.parent.size_x");
  const compiled = compileScripts(preset);
  expect(compiled.globals.trim()).toBe("target = state.o_mouth_x + state.o_head_group_size_x");
  expect(compiled.states).toEqual([
    { key: "state.o_mouth_x", objectId: "mouth", param: "x" },
    { key: "state.o_head_group_size_x", objectId: "head_group", param: "size_x" },
  ]);
  // Снимок читается из кадра прошлого тика, отсутствующее — из значений по умолчанию.
  const values = runtimeValues(compiled, frameOf({}, { mouth: { x: 42 } }), {}, 0, createEventState());
  expect(values["state.o_mouth_x"]).toBe(42);
  expect(values["state.o_head_group_size_x"]).toBe(1);
});

test("свой parent и входы модулей не переписываются", () => {
  const preset = {
    ...presetWith("y = parent.size_x + mic.talking"),
    modules: [{ name: "mic", type: "loudness", enabled: true, source: "live", config: {} }],
  } as RigPreset;
  const compiled = compileScripts(preset);
  expect(compiled.globals.trim()).toBe("y = parent.size_x + mic.talking");
  expect(compiled.states).toHaveLength(0);
});
