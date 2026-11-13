import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  calibrationOffsets, calibratablePath, calibratedValue, flattenFrame, parseIfacialFrame,
} from "../../src/modules/tracker";
import { applyMapping, readExternalSource } from "../../src/modules/external";
import { normalizeModules } from "../../src/engine/preset";
import { normalizeDefinition, registerDefinitions } from "../../src/modules/registry";
import { FaceTrackerEditor } from "../../src/components/FaceTrackerEditor";
import type { ExternalSourceRule, ModuleInstance } from "../../src/types";

/**
 * Калибровка позы телефона.
 *
 * Трекеры считают повороты относительно самого телефона: переставил телефон —
 * мимика та же, а «нейтраль» уехала. Поэтому кадр, снятый кнопкой
 * «Откалибровать», хранится в пресете и вычитается из головы и глаз. Мимика
 * ARKit не калибруется: её значения и есть лицо.
 */

test.beforeAll(() => {
  const directory = join(process.cwd(), "public", "modules");
  const index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")) as { modules: string[] };
  registerDefinitions(index.modules
    .map((id) => normalizeDefinition(JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"))))
    .filter((definition): definition is NonNullable<typeof definition> => definition !== null));
});

test("калибруются голова и глаза, мимика и служебные поля — нет", () => {
  expect(calibratablePath("head.rx")).toBe(true);
  expect(calibratablePath("$.head.x")).toBe(true);
  expect(calibratablePath("eyeLeft.ry")).toBe(true);
  expect(calibratablePath("eyeRight.rz")).toBe(true);
  // Мимика приходит как есть: положение телефона на неё не влияет.
  expect(calibratablePath("arkit.jawOpen")).toBe(false);
  expect(calibratablePath("$.arkit.eyeBlinkLeft")).toBe(false);
  // Ноль «лица не найдено» — не поза, номер кнопки — тоже.
  expect(calibratablePath("faceFound")).toBe(false);
  expect(calibratablePath("hotkey")).toBe(false);
});

test("эталон снимается с текущего кадра: только голова и глаза", () => {
  const frame = flattenFrame({
    arkit: { jawOpen: 0.42 },
    head: { rx: 12.5, ry: -4, rz: 1, x: 0.1, y: -0.2, z: 0 },
    eyeLeft: { rx: 3, ry: -2, rz: 0 },
    eyeRight: { rx: 3, ry: 2, rz: 0 },
    faceFound: 1,
    hotkey: 3,
  });
  const offsets = calibrationOffsets(frame);
  // Мимика и служебные поля в эталон не попадают ни при каких условиях.
  expect(Object.keys(offsets).filter((key) => key.startsWith("arkit"))).toEqual([]);
  expect(offsets.faceFound).toBeUndefined();
  expect(offsets.hotkey).toBeUndefined();
  // Голова и оба глаза — целиком, включая положение головы.
  expect(offsets["head.rx"]).toBe(12.5);
  expect(offsets["head.y"]).toBe(-0.2);
  expect(offsets["eyeLeft.ry"]).toBe(-2);
  expect(offsets["eyeRight.ry"]).toBe(2);
  expect(Object.keys(offsets).length).toBe(12);
  // Пустой кадр — калибровать нечем: эталон не пишется вовсе.
  expect(calibrationOffsets({})).toEqual({});
  // Мусор вместо числа не становится нулём.
  expect(calibrationOffsets({ "head.rx": Number.NaN })).toEqual({});
});

test("вычитание эталона: телефон прислал 32, персонаж получил 12", () => {
  expect(calibratedValue(32, 20)).toBe(12);
  expect(calibratedValue(5, -5)).toBe(10);
  // Поля без эталона идут как есть — и без числа тоже не выдумываются.
  expect(calibratedValue(7, undefined)).toBe(7);
  expect(calibratedValue(undefined, 20)).toBeUndefined();
  // Эталон ноль ничего не меняет, но и не ломает значение.
  expect(calibratedValue(3, 0)).toBe(3);
});

test("эталон вычитается до границ правила, а не после", () => {
  const payload = { head: { rx: 100 } };
  const mapping: ExternalSourceRule[] = [
    { input: "rx", path: "$.head.rx", min: -90, max: 90 },
  ];
  // Телефон стоит на 20°, макушка ушла за предел объекта: сначала сдвиг, потом зажим.
  expect(applyMapping(payload, mapping, { "head.rx": 20 })).toEqual({ rx: 80 });
  // Без эталона значение упирается в верхнюю границу.
  expect(applyMapping(payload, mapping)).toEqual({ rx: 90 });
  // Ключ эталона — плоский путь кадра, как в живой таблице (`$.` снимает чтение пресета).
  expect(applyMapping(payload, mapping, { "head.ry": 20 })).toEqual({ rx: 90 });
  // Мимика не калибруется, даже если эталон туда случайно попал.
  const shapes: ExternalSourceRule[] = [{ input: "jaw", path: "$.arkit.jawOpen", min: 0, max: 1 }];
  expect(applyMapping({ arkit: { jawOpen: 0.4 } }, shapes, { "arkit.jawOpen": 0.3 })).toEqual({ jaw: 0.4 });
});

test("эталон читается из пресета и чистится при чтении", () => {
  const source = readExternalSource({
    source: {
      transport: "ifacialmocap",
      url: "",
      mapping: [],
      calibration: {
        at: 1_700_000_000_000,
        offsets: { "$.head.rx": "12.5", "eyeLeft.ry": -2, "arkit.jawOpen": 0.4, faceFound: 1, "head.rz": "abc" },
      },
    },
  });
  expect(source.calibration?.at).toBe(1_700_000_000_000);
  // В эталоне остаются только голова и глаза, и только числа.
  expect(source.calibration?.offsets).toEqual({ "head.rx": 12.5, "eyeLeft.ry": -2 });
  // Пустой эталон — это «калибровки нет», а не эталон из нулей.
  expect(readExternalSource({ source: { calibration: { at: 5, offsets: {} } } }).calibration).toBeUndefined();
  expect(readExternalSource({ source: { calibration: { offsets: { "arkit.jawOpen": 1 } } } }).calibration).toBeUndefined();
  // Ничего не записано — поле не появляется: старые пресеты читаются как раньше.
  expect(readExternalSource({ source: { transport: "vtuberstudio" } }).calibration).toBeUndefined();
  expect(readExternalSource({ source: { calibration: "нет" } }).calibration).toBeUndefined();
});

test("настройки трекера и эталон переживают чтение пресета", () => {
  const modules = normalizeModules([{
    name: "face",
    type: "ifacialmocap",
    enabled: true,
    source: "live",
    config: {
      source: {
        transport: "ifacialmocap",
        url: "",
        host: "192.168.1.7",
        mapping: [{ input: "head_rx", path: "$.head.rx", min: -90, max: 90, holdMs: 0 }],
        calibration: { at: 7, offsets: { "head.rx": 20 } },
      },
    },
  }] as never);
  const restored = readExternalSource(modules[0].config as Record<string, unknown>);
  // Источник — объект, а не поле шаблона: без отдельного правила он терялся
  // целиком при каждой загрузке, вместе с отображением и эталоном.
  expect(restored.host).toBe("192.168.1.7");
  expect(restored.mapping.map((rule) => rule.path)).toEqual(["$.head.rx"]);
  expect(restored.calibration?.offsets).toEqual({ "head.rx": 20 });
  // Умолчания шаблона остаются: порты не обнуляются отсутствием поля в файле.
  expect(restored.port).toBe(49_983);
  expect(restored.listenPort).toBe(49_983);
});

test("кадр iFacialMocap калибруется теми же путями, что видит живая таблица", () => {
  const parsed = parseIfacialFrame(
    "jawOpen-50|eyeBlink_L-0|=head#-10,5,0,0.1,0.2,0.3|rightEye#4,2,0|leftEye#4,-2,0|",
  );
  const frame = flattenFrame(parsed);
  const offsets = calibrationOffsets(frame);
  expect(offsets["head.rx"]).toBe(-10);
  expect(offsets["head.ry"]).toBe(5);
  expect(offsets["eyeLeft.ry"]).toBe(-2);
  // Мимика в кадре осталась как есть.
  expect(frame["arkit.jawOpen"]).toBeCloseTo(0.5, 5);
  expect(offsets["arkit.jawOpen"]).toBeUndefined();
});

test("карточка трекера: кнопки калибровки и две колонки чисел", () => {
  const editor = readFileSync(join(process.cwd(), "src", "components", "FaceTrackerEditor.tsx"), "utf8");
  expect(editor).toContain("Откалибровать");
  expect(editor).toContain("Сбросить");
  expect(editor).toContain("calibrationOffsets");
  expect(editor).toContain("calibratedValue");
  // Две колонки появляются только с эталоном: без него сравнивать нечего.
  expect(editor).toContain("tracker-live-raw");
  expect(editor).toContain("Положение телефона");
  // Кадров нет или лицо не найдено — эталон не пишется, а карточка говорит почему.
  expect(editor).toContain("faceFound !== undefined && frame.faceFound < 0.5");
  const css = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");
  expect(css).toContain(".tracker-live-row.calibrated");
  expect(css).toContain(".tracker-live-head");
});

/** Карточка с эталоном: живая таблица открыта (отображение пустое) и показывает два числа. */
function renderCard(mapping: ExternalSourceRule[], offsets?: Record<string, number>): string {
  const module = {
    name: "face",
    type: "ifacialmocap",
    enabled: true,
    source: "live",
    config: {
      source: {
        transport: "ifacialmocap",
        url: "",
        mapping,
        calibration: offsets ? { at: 1_700_000_000_000, offsets } : undefined,
      },
    },
  } as unknown as ModuleInstance;
  return renderToStaticMarkup(createElement(FaceTrackerEditor, {
    module,
    transport: "ifacialmocap",
    status: { state: "live", message: null, packets: 10, rate: 60 } as never,
    preview: { "head.rx": 32, "eyeLeft.ry": 3, "arkit.jawOpen": 0.42, faceFound: 1 },
    logs: [],
    onChange: () => undefined,
  }));
}

test("карточка показывает телефон и персонаж рядом, а без эталона — одно число", () => {
  const calibratedCard = renderCard([], { "head.rx": 20 });
  // Сырое число телефона и результат после вычитания эталона — оба на месте.
  expect(calibratedCard).toContain("32.0°");
  expect(calibratedCard).toContain("12.0°");
  expect(calibratedCard).toContain("tracker-live-raw");
  // Мимика эталоном не сдвигается: 0.42 приходит как есть.
  expect(calibratedCard).toContain("0.42");
  // Подпись называет время эталона, а не просто «есть».
  expect(calibratedCard).toContain("эталон");

  const plainCard = renderCard([]);
  expect(plainCard).toContain("не задан");
  // Без эталона второй колонки нет — сравнивать нечего.
  expect(plainCard).not.toContain("tracker-live-raw");
  expect(plainCard).toContain("32.0°");
});
