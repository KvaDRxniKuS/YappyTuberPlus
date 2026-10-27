import { expect, test } from "@playwright/test";
import {
  DEFAULT_BEHAVIOUR, behaviourBlock, readBehaviour, writeBehaviour, type Behaviour,
} from "../../src/engine/behaviour";
import { DEFAULT_BASE, type RigObject } from "../../src/types";

/*
 * Правило вкладки «Поведение»: **поле живёт, пока в пресете есть его модуль**.
 *
 * Микрофон даёт речь, модуль моргания — глаз, мышь — следование. Без модуля
 * формула не пишется вовсе, иначе ядро получило бы ссылку на несуществующий
 * вход. Настройки при этом остаются в блоке `@behaviour` и оживают, когда
 * модуль вернут.
 *
 * Здесь проверяется генератор, а не панель: панель прячет поля, генератор
 * решает, что попадёт в скрипт.
 */

const object: RigObject = {
  id: "head", name: "Голова", kind: "sprite", enabled: true, image: null, parentId: null,
  pivot: { x: 0.5, y: 0.5 }, base: { ...DEFAULT_BASE }, script: "", width: 100, height: 100,
};

const block = (patch: Partial<Behaviour>) => behaviourBlock({ ...DEFAULT_BEHAVIOUR, ...patch }, object);

test("без микрофона речь не пишется: ни рта, ни сквоша, ни прыжка, ни доворота", () => {
  const silent = block({
    squash: 0.6, bounce: 40, dragAngle: 20, mouth: "closed",
  });
  expect(silent).not.toContain(".speak");
  expect(silent).not.toContain(".talking");
  expect(silent).not.toContain("visible =");
});

test("модуль есть — формулы идут его именем, а не жёстким mic", () => {
  const withMic = block({ voiceModule: "mic", squash: 0.4, mouth: "open" });
  expect(withMic).toContain("mic.speak");
  expect(withMic).toContain("mic.talking");
  expect(withMic).toContain("visible =");

  // Пересозданный модуль получает имя шаблона: формулы должны поехать за ним.
  const renamed = block({ voiceModule: "loudness", squash: 0.4, mouth: "open" });
  expect(renamed).toContain("loudness.speak");
  expect(renamed).toContain("loudness.talking");
  expect(renamed).not.toContain("mic.");
});

test("глаз живёт только со своим модулем моргания", () => {
  expect(block({ eye: "closed" })).not.toContain(".blink");
  expect(block({ eye: "closed", eyeModule: "auto" })).toContain("auto.blink");
  expect(block({ eye: "open", eyeModule: "auto" })).toContain("1 - auto.blink");
  // Другой экземпляр — другое имя.
  expect(block({ eye: "closed", eyeModule: "blink_2" })).toContain("blink_2.blink");
});

test("битое имя модуля не становится текстом скрипта", () => {
  const broken = readBehaviour(`// @behaviour {"voiceModule":"микрофон","eyeModule":"1auto","mouth":"open","eye":"closed"}`);
  expect(broken.voiceModule).toBe("");
  expect(broken.eyeModule).toBe("");
  // И формулы не появляются: имя пустое.
  expect(behaviourBlock(broken, object)).not.toContain(".speak");
  expect(behaviourBlock(broken, object)).not.toContain(".blink");
});

test("без микрофона объект всё равно двигается: размеры, пределы, покачивание", () => {
  // Предел сустава виден только там, где есть отклонение: покачивание поворота.
  const moving = block({
    scaleX: 1.2, wiggleXAmp: 6, wiggleXFreq: 1, wiggleRotAmp: 10, wiggleRotFreq: 1, rotationalLimitLeft: 30,
  });
  expect(moving).toContain("sizeX =");
  expect(moving).toContain("sin(");
  expect(moving).toContain("limit(");
  expect(moving).not.toContain(".speak");
});

test("настройки речи сохраняются в блоке, даже когда формулы не пишутся", () => {
  const saved = { ...DEFAULT_BEHAVIOUR, squash: 0.7, bounce: 55, dragAngle: 25, mouth: "closed" as const };
  // Без имени модуля блок всё равно нужен: сквош и прыжок — сами по себе настройки.
  const script = writeBehaviour(object.script, saved, object).script;
  expect(script).toContain("@behaviour");
  expect(script).not.toContain(".speak");
  const back = readBehaviour(script);
  expect(back.squash).toBe(0.7);
  expect(back.bounce).toBe(55);
  expect(back.mouth).toBe("closed");

  // Вернули модуль — формулы появились с теми же числами.
  const revived = writeBehaviour(script, { ...back, voiceModule: "mic" }, object).script;
  expect(revived).toContain("mic.speak * 0.7");
  expect(revived).toContain("visible =");
  expect(readBehaviour(revived).squash).toBe(0.7);
});

test("в блоке нет старых полей следования за мышью", () => {
  const script = writeBehaviour("", {
    ...DEFAULT_BEHAVIOUR, followMouseModule: "mouse", followMouseWidth: 300, followMouseHeight: 160,
  }, object).script;
  expect(script).not.toContain("followMouseRadius");
  expect(script).not.toContain("followMouseRange");
  expect(script).toContain("followMouseWidth");
  expect(readBehaviour(script).followMouseWidth).toBe(300);
});
