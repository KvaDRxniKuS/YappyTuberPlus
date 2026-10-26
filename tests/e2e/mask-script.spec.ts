import { expect, test } from "@playwright/test";
import { createDemoPreset } from "../../src/data/demoPreset";
import { normalizePreset } from "../../src/engine/preset";
import {
  MASK_END, MASK_START, hasMaskBlock, parseMaskBlock, writeMaskBlock,
} from "../../src/engine/maskScript";
import { defaultMask } from "../../src/render/shape";
import { maskStrength, NEUTRAL_VALUES } from "../../src/render/rigCanvas";
import type { RigObject } from "../../src/types";

const mask = {
  ...defaultMask(),
  kind: "points" as const,
  points: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 90 }],
  invert: true,
  feather: 4,
};

test("маска: блок дописывается в скрипт, читается обратно и не теряет формулы", () => {
  const script = "x = 0\nrotation = 0";
  const written = writeMaskBlock(script, mask);
  expect(written).toContain(MASK_START);
  expect(written).toContain(MASK_END);
  // Значение — обычная формула скрипта, а не только JSON в комментарии.
  expect(written).toContain("mask = 1");
  // Сам скрипт не пострадал: блок дописан в конец.
  expect(written.startsWith("x = 0")).toBe(true);

  const parsed = parseMaskBlock(written);
  expect(parsed?.kind).toBe("points");
  expect(parsed?.points).toEqual(mask.points);
  expect(parsed?.invert).toBe(true);
  expect(parsed?.feather).toBe(4);

  // Правка геометрии переписывает метаданные, но не формулу пользователя.
  const tuned = written.replace("mask = 1", "mask = 0.4");
  const next = writeMaskBlock(tuned, { ...mask, feather: 9 });
  expect(next).toContain("mask = 0.4");
  expect(parseMaskBlock(next)?.feather).toBe(9);
  // Один блок, а не два.
  expect(next.split(MASK_START)).toHaveLength(2);
});

test("маска: снятие настройки убирает блок, остальное остаётся", () => {
  const script = "// мой скрипт\nx = 10";
  const written = writeMaskBlock(script, mask);
  const cleared = writeMaskBlock(written, undefined);
  expect(cleared).not.toContain(MASK_START);
  expect(cleared).toContain("// мой скрипт");
  expect(cleared).toContain("x = 10");
  expect(hasMaskBlock(cleared)).toBe(false);
  expect(parseMaskBlock(cleared)).toBeNull();
});

test("маска: испорченный блок не роняет чтение", () => {
  const broken = `${MASK_START}\n// @mask {не json}\nmask = 1\n${MASK_END}`;
  expect(parseMaskBlock(broken)).toBeNull();
  // Блок без метаданных — это просто текст, настроек в нём нет.
  expect(parseMaskBlock(`${MASK_START}\nmask = 1\n${MASK_END}`)).toBeNull();
});

/** Тот же объект с другой маской — чтобы не собирать пресет руками. */
function withMask(name: string, value: RigObject["mask"]): RigObject {
  const preset = createDemoPreset();
  const object = preset.objects.find((item) => item.id === "head")!;
  return { ...object, name, mask: value };
}

test("маска: пресет и скрипт приводятся к одному виду", () => {
  const preset = createDemoPreset();
  const head = preset.objects.find((object) => object.id === "head")!;
  const loaded = normalizePreset({
    ...preset,
    objects: preset.objects.map((object) => (object.id === head.id ? { ...object, mask } : object)),
  });
  const kept = loaded.objects.find((object) => object.id === head.id)!;
  // Поле в пресете — только отражение блока в скрипте. Без блока маски нет.
  expect(kept.mask).toBeUndefined();
  expect(hasMaskBlock(kept.script)).toBe(false);
  // Блок есть — настройка читается из него.
  const withBlock = normalizePreset({
    ...preset,
    objects: preset.objects.map((object) => (object.id === head.id
      ? { ...object, mask, script: writeMaskBlock(object.script, mask) }
      : object)),
  }).objects.find((object) => object.id === head.id)!;
  expect(withBlock.mask?.invert).toBe(true);
  expect(parseMaskBlock(withBlock.script)?.feather).toBe(4);

  // Блок — истина: правка в скрипте перебивает поле пресета.
  const edited = normalizePreset({
    ...preset,
    objects: preset.objects.map((object) => (object.id === head.id
      ? { ...object, mask, script: writeMaskBlock(object.script, { ...mask, feather: 12 }) }
      : object)),
  });
  const fromScript = edited.objects.find((object) => object.id === head.id)!;
  expect(fromScript.mask?.feather).toBe(12);

  // Убрали блок руками — маски у объекта больше нет.
  const removed = normalizePreset({
    ...preset,
    objects: preset.objects.map((object) => (object.id === head.id
      ? { ...object, mask, script: object.script }
      : object)),
  });
  expect(removed.objects.find((object) => object.id === head.id)?.mask).toBeUndefined();
});

test("маска: сила из параметра, старое ядро не гасит маску", () => {
  expect(maskStrength({ ...NEUTRAL_VALUES, mask: 1 })).toBe(1);
  expect(maskStrength({ ...NEUTRAL_VALUES, mask: 0 })).toBe(0);
  expect(maskStrength({ ...NEUTRAL_VALUES, mask: 0.4 })).toBeCloseTo(0.4, 6);
  // Зажим: формулы могут дать что угодно.
  expect(maskStrength({ ...NEUTRAL_VALUES, mask: -3 })).toBe(0);
  expect(maskStrength({ ...NEUTRAL_VALUES, mask: 7 })).toBe(1);
  // Кадр ядра без параметра `mask` — маска работает как настроена.
  const legacy = { ...NEUTRAL_VALUES } as Record<string, number>;
  delete legacy.mask;
  expect(maskStrength(legacy as never)).toBe(1);
});
