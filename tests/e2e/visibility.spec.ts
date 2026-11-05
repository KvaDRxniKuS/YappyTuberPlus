import { expect, test } from "@playwright/test";
import { createDemoPreset } from "../../src/data/demoPreset";
import {
  DEFAULT_BEHAVIOUR, behaviourBlock, isDefault, readBehaviour, writeBehaviour,
} from "../../src/engine/behaviour";
import {
  EMPTY_VISIBILITY_CONTEXT, applyVisibility, readVisibilitySources, sourceMultiplier,
  visibilityOf, visibilityProduct, type VisibilityContext, type VisibilitySource,
} from "../../src/engine/visibility";
import { prepareFrame, neutralFrame } from "../../src/engine/frame";
import { DEFAULT_BASE, type RigFrame, type RigObject, type RigPreset } from "../../src/types";

/*
 * Видимость из источников.
 *
 * Правило одно: источник — множитель, итог — произведение. Поэтому здесь
 * проверяется не «какой источник главный», а арифметика долей: ноль гасит,
 * единица не мешает, дробь делает объект полупрозрачным. Флаг `visible`
 * остаётся двоичным — порог отделён от доли намеренно.
 */

function object(patch: Partial<RigObject> = {}): RigObject {
  return {
    id: "face",
    name: "Лицо",
    kind: "sprite",
    enabled: true,
    image: "asset:face-image",
    parentId: null,
    pivot: { x: 0.5, y: 0.5 },
    base: { ...DEFAULT_BASE },
    script: "",
    width: 200,
    height: 200,
    ...patch,
  };
}

/** Источник видимости: по умолчанию — вход модуля, готовый 0…1. */
function source(patch: Partial<VisibilitySource> = {}): VisibilitySource {
  return {
    kind: "input",
    module: "mic",
    name: "speak",
    gate: false,
    range: false,
    min: 0,
    max: 1,
    invert: false,
    ...patch,
  };
}

function context(patch: Partial<VisibilityContext> = {}): VisibilityContext {
  return { ...EMPTY_VISIBILITY_CONTEXT, ...patch };
}

test("видимость: каждый источник — множитель, итог — произведение", () => {
  const sources = [
    source({ module: "mic", name: "speak" }),
    source({ module: "auto", name: "blink" }),
  ];
  const values = { "mic.speak": 0.5, "auto.blink": 0.5 };
  expect(visibilityProduct(sources, "face", context({ values }))).toBeCloseTo(0.25, 6);
  // Ноль любого источника гасит объект целиком — в этом и смысл произведения.
  expect(visibilityProduct(sources, "face", context({ values: { "mic.speak": 0, "auto.blink": 1 } }))).toBe(0);
  // Пустой список — «не настроено»: объект не трогаем.
  expect(visibilityProduct([], "face", context({ values }))).toBe(1);
});

test("видимость: булев вход — ворота, без шкалы и min/max", () => {
  const gate = source({ module: "mouse", name: "left", gate: true, range: true, min: 0.2, max: 0.4 });
  expect(sourceMultiplier(gate, "face", context({ values: { "mouse.left": 1 } }))).toBe(1);
  expect(sourceMultiplier(gate, "face", context({ values: { "mouse.left": 0 } }))).toBe(0);
  // Шкала у ворот не читается: 0.3 — это «не нажато», а не 0.25 диапазона.
  expect(sourceMultiplier(gate, "face", context({ values: { "mouse.left": 0.3 } }))).toBe(0);
  // Инверсия переворачивает ворота.
  expect(sourceMultiplier({ ...gate, invert: true }, "face", context({ values: { "mouse.left": 0 } }))).toBe(1);
});

test("видимость: min/max входа растягиваются в 0…1, выбросы зажимаются", () => {
  const travel = source({ module: "cursor", name: "x", range: true, min: -1, max: 1 });
  expect(sourceMultiplier(travel, "face", context({ values: { "cursor.x": -1 } }))).toBeCloseTo(0, 6);
  expect(sourceMultiplier(travel, "face", context({ values: { "cursor.x": 0 } }))).toBeCloseTo(0.5, 6);
  expect(sourceMultiplier(travel, "face", context({ values: { "cursor.x": 1 } }))).toBeCloseTo(1, 6);
  expect(sourceMultiplier(travel, "face", context({ values: { "cursor.x": 9 } }))).toBe(1);
  expect(sourceMultiplier(travel, "face", context({ values: { "cursor.x": -9 } }))).toBe(0);
  // Без галочки значение считается готовым 0…1 — как его отдаёт модуль.
  const ready = source({ module: "cursor", name: "x" });
  expect(sourceMultiplier(ready, "face", context({ values: { "cursor.x": 0.25 } }))).toBeCloseTo(0.25, 6);
  expect(sourceMultiplier({ ...ready, invert: true }, "face", context({ values: { "cursor.x": 0.25 } }))).toBeCloseTo(0.75, 6);
});

test("видимость: state — переменная прошлого кадра важнее одноимённого параметра", () => {
  const own = object({ id: "face" });
  const preset: RigPreset = { ...createDemoPreset(), objects: [own] };
  const previous = neutralFrame(preset);
  (previous.objects[own.id] as unknown as Record<string, number>).opacity = 0.25;
  const state = source({ kind: "state", module: "", name: "opacity" });
  // Параметр объекта — из прошлого кадра.
  expect(sourceMultiplier(state, "face", context({ previous }))).toBeCloseTo(0.25, 6);
  // Переменная скрипта с тем же именем сильнее: именно её написал автор.
  const withGlobal: RigFrame = { ...previous, globals: { opacity: 1 } };
  expect(sourceMultiplier(state, "face", context({ previous: withGlobal }))).toBe(1);
  // Неизвестное имя — ноль, как в ядре.
  expect(sourceMultiplier(source({ kind: "state", module: "", name: "nope" }), "face", context({ previous }))).toBe(0);
});

test("видимость: signal.* читается из канала сигналов", () => {
  const signal = source({ kind: "signal", module: "", name: "reward" });
  expect(sourceMultiplier(signal, "face", context({ signals: { reward: 1 } }))).toBe(1);
  expect(sourceMultiplier(signal, "face", context({ values: { "signal.reward": 0.5 } }))).toBeCloseTo(0.5, 6);
  expect(sourceMultiplier(signal, "face", context())).toBe(0);
});

test("видимость: источник без имени не участвует в произведении", () => {
  const sources = [source({ name: "" }), source({ module: "mic", name: "speak" })];
  expect(visibilityProduct(sources, "face", context({ values: { "mic.speak": 0.5 } }))).toBeCloseTo(0.5, 6);
});

test("видимость: visible двоичный, доля уходит в прозрачность", () => {
  const preset: RigPreset = { ...createDemoPreset(), objects: [object()] };
  const behaviour = { ...DEFAULT_BEHAVIOUR, visibility: [source()] };
  const script = writeBehaviour(object().script, behaviour, object()).script;
  const withScript: RigPreset = { ...preset, objects: [object({ script })] };
  const frame = neutralFrame(withScript);
  frame.objects.face = { ...frame.objects.face, opacity: 0.8, visible: 1 };

  // Доля 0.75 — объект виден, но прозрачнее.
  const half = applyVisibility(withScript, frame, context({ values: { "mic.speak": 0.75 } }));
  expect(half.objects.face.visible).toBe(1);
  expect(half.objects.face.opacity).toBeCloseTo(0.6, 6);

  // Доля ниже порога гасит флаг, а не мигает между кадрами.
  const faint = applyVisibility(withScript, frame, context({ values: { "mic.speak": 0.4 } }));
  expect(faint.objects.face.visible).toBe(0);
  expect(faint.objects.face.opacity).toBeCloseTo(0.32, 6);

  // Ноль источника — ровно ноль.
  const hidden = applyVisibility(withScript, frame, context({ values: { "mic.speak": 0 } }));
  expect(hidden.objects.face.visible).toBe(0);
  expect(hidden.objects.face.opacity).toBe(0);

  // Единица ничего не меняет: кадр остаётся тем же объектом, без копии.
  const shown = applyVisibility(withScript, frame, context({ values: { "mic.speak": 1 } }));
  expect(shown).toBe(frame);
});

test("видимость: уже невидимый объект не оживает от множителя", () => {
  const script = writeBehaviour("", { ...DEFAULT_BEHAVIOUR, visibility: [source()] }, object()).script;
  const preset: RigPreset = { ...createDemoPreset(), objects: [object({ script })] };
  const frame = neutralFrame(preset);
  frame.objects.face = { ...frame.objects.face, visible: 0, opacity: 1 };
  const result = applyVisibility(preset, frame, context({ values: { "mic.speak": 1 } }));
  expect(result.objects.face.visible).toBe(0);
});

test("видимость: prepareFrame гасит выключенный объект сильнее источников", () => {
  const script = writeBehaviour("", { ...DEFAULT_BEHAVIOUR, visibility: [source()] }, object()).script;
  const preset: RigPreset = { ...createDemoPreset(), objects: [object({ script, enabled: false })] };
  const frame = neutralFrame(preset);
  frame.objects.face = { ...frame.objects.face, visible: 1, opacity: 1 };
  const result = prepareFrame(preset, frame, undefined, context({ values: { "mic.speak": 1 } }));
  expect(result.objects.face.visible).toBe(0);
});

test("видимость: настройки живут в блоке поведения и читаются обратно", () => {
  const target = object();
  const sources = [
    source({ module: "mic", name: "speak", range: true, min: 0, max: 4, invert: true }),
    source({ kind: "state", module: "", name: "mood", gate: true }),
    source({ kind: "signal", module: "", name: "reward" }),
  ];
  const behaviour = { ...DEFAULT_BEHAVIOUR, visibility: sources };
  expect(isDefault(behaviour)).toBe(false);
  const block = behaviourBlock(behaviour, target);
  expect(block).toContain('"visibility"');
  // Формул у видимости нет: она считается в редакторе и не пишет `visible`.
  expect(block).not.toContain("visible =");

  const written = writeBehaviour("", behaviour, target).script;
  expect(readBehaviour(written).visibility).toEqual(sources);
  expect(visibilityOf(object({ script: written }))).toEqual(sources);
});

test("видимость: битые записи блока отбрасываются и не гасят объект", () => {
  // Источник без модуля читать неоткуда — его нет; пустое имя остаётся, но не
  // участвует, поэтому незаконченная настройка не прячет объект.
  expect(readVisibilitySources([
    { kind: "input", name: "speak" },
    { kind: "input", module: "mic", name: "" },
    { kind: "signal", name: "reward" },
    { kind: "nonsense", name: "x" },
    null,
    "строка",
  ])).toEqual([
    { kind: "input", module: "mic", name: "", gate: false, range: false, min: 0, max: 1, invert: false },
    { kind: "signal", module: "", name: "reward", gate: false, range: false, min: 0, max: 1, invert: false },
  ]);
  // Пустой диапазон — не растяжение: иначе объект стал бы «всегда виден».
  expect(readVisibilitySources([{ kind: "signal", name: "a", range: true, min: 2, max: 2 }])[0].range).toBe(false);
});
