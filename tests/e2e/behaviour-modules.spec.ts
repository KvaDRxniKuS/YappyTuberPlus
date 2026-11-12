import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BehaviourPanel } from "../../src/components/BehaviourPanel";
import {
  DEFAULT_BEHAVIOUR, behaviourBlock, readBehaviour, writeBehaviour, type Behaviour,
} from "../../src/engine/behaviour";
import { DEFAULT_BASE, type ModuleInstance, type RigObject } from "../../src/types";

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
  expect(silent).not.toContain("visible_behaviour =");
});

test("модуль есть — формулы идут его именем, а не жёстким mic", () => {
  const withMic = block({ voiceModule: "mic", squash: 0.4, mouth: "open" });
  expect(withMic).toContain("mic.speak");
  expect(withMic).toContain("mic.talking");
  expect(withMic).toContain("visible_behaviour =");

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

test("явно выбранные источники сохраняются до включения правил", () => {
  const selected = { ...DEFAULT_BEHAVIOUR, voiceModule: "mic_2", eyeModule: "auto_2" };
  const script = writeBehaviour("", selected, object).script;
  expect(script).toContain("@behaviour");
  expect(script).not.toContain(".speak");
  expect(script).not.toContain(".blink");
  expect(readBehaviour(script)).toMatchObject({ voiceModule: "mic_2", eyeModule: "auto_2" });

  const rewritten = writeBehaviour(script, readBehaviour(script), object).script;
  expect(readBehaviour(rewritten)).toMatchObject({ voiceModule: "mic_2", eyeModule: "auto_2" });
});

test("селекторы речи и моргания видны с одним источником и показывают выбранный второй", () => {
  const mic = (name: string): ModuleInstance => ({
    name, type: "loudness", enabled: true, source: "live", config: {},
  });
  const auto = (name: string): ModuleInstance => ({
    name, type: "autoblink", enabled: true, source: "manual", config: {},
  });
  const render = (script: string, modules: ModuleInstance[]) => renderToStaticMarkup(createElement(
    BehaviourPanel,
    { object: { ...object, script }, selection: [{ ...object, script }], onChange: () => {}, modules },
  ));
  const picker = (markup: string, label: string) => {
    const labelAt = markup.indexOf(`aria-label="${label}"`);
    expect(labelAt).toBeGreaterThanOrEqual(0);
    const start = markup.lastIndexOf("<select", labelAt);
    const end = markup.indexOf("</select>", labelAt) + "</select>".length;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return markup.slice(start, end);
  };

  const single = render("", [mic("mic"), auto("auto")]);
  for (const [label, name] of [["Источник речи", "mic"], ["Источник моргания", "auto"]]) {
    const select = picker(single, label);
    expect(select).toContain("disabled=\"\"");
    expect(select).toContain(`<option value="${name}" selected="">${name}</option>`);
  }

  const saved = writeBehaviour("", {
    ...DEFAULT_BEHAVIOUR, voiceModule: "mic_2", eyeModule: "auto_2",
  }, object).script;
  const multiple = render(saved, [mic("mic"), mic("mic_2"), auto("auto"), auto("auto_2")]);
  for (const [label, selected, other] of [
    ["Источник речи", "mic_2", "mic"],
    ["Источник моргания", "auto_2", "auto"],
  ]) {
    const select = picker(multiple, label);
    expect(select).not.toContain("disabled=\"\"");
    expect(select).toContain(`<option value="${selected}" selected="">${selected}</option>`);
    expect(select).toContain(`<option value="${other}">${other}</option>`);
  }
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
  expect(moving).toContain("sizeX_behaviour =");
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

test("следование за мышью пишет имя выбранного модуля напрямую", () => {
  // Источник — снимок имени из блока: генератор не знает списка модулей.
  const script = writeBehaviour("", {
    ...DEFAULT_BEHAVIOUR, followMouseModule: "cursor", followMouseStrength: 1,
  }, object).script;
  expect(script).toContain("cursor.x");
  expect(script).toContain("cursor.y");
  // Жёсткого `mouse` в формуле нет: второй модуль мыши повезёт объект за собой.
  expect(script).not.toContain("mouse.x");
  expect(script).not.toContain("mouse.y");
  // Шкала не пересчитывается: вход читается ровно как его отдаёт модуль.
  expect(script).not.toContain("cursor.px");
  expect(readBehaviour(script).followMouseModule).toBe("cursor");
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

const child: RigObject = { ...object, parentId: "torso" };

test("блок поведения пишет только добавку и не переопределяет параметры", () => {
  const written = block({ wiggleXAmp: 6, wiggleXFreq: 1, scaleX: 1.2 });
  expect(written).toContain("x_behaviour =");
  expect(written).toContain("sizeX_behaviour = 1.2");
  // Своего присваивания параметру в блоке больше нет: параметр задаёт автор.
  expect(written).not.toMatch(/^\s*x\s*=/m);
  expect(written).not.toMatch(/^\s*sizeX\s*=/m);
  // И наследства в добавке тоже нет — его складывает авторская строка.
  expect(written).not.toContain("inherit");
});

test("склейка: терм встаёт сразу за inherit, ручной код остаётся целым", () => {
  const behaviour: Behaviour = {
    ...DEFAULT_BEHAVIOUR, wiggleXAmp: 6, wiggleXFreq: 1, wiggleYAmp: 4, wiggleYFreq: 1, scaleX: 1.5,
  };
  const script = "x = inherit + 3 * delta\ny = 2\nsizeX = inherit\nlayer = inherit";
  const written = writeBehaviour(script, behaviour, child).script;
  // Слагаемое вставлено после inherit: и наш терм, и авторское `3 * delta` на месте.
  expect(written).toContain("x = inherit + x_behaviour + 3 * delta");
  // Строка без inherit — терм в конец, остальное не тронуто.
  expect(written).toContain("y = 2 + y_behaviour");
  // Размер — множитель, а не слагаемое: тип значения решает оператор.
  expect(written).toContain("sizeX = inherit * sizeX_behaviour");
  // Чужие строки не тронуты вовсе.
  expect(written).toContain("layer = inherit");
});

test("склейка идемпотентна и не дублирует слагаемое", () => {
  const behaviour: Behaviour = { ...DEFAULT_BEHAVIOUR, wiggleXAmp: 6, wiggleXFreq: 1 };
  const once = writeBehaviour("x = inherit + 3 * delta", behaviour, child).script;
  const twice = writeBehaviour(once, behaviour, child).script;
  expect(twice).toBe(once);
  expect(twice.match(/x_behaviour/g)?.length).toBe(2); // блок + строка
});

test("сброс поведения убирает слагаемое, но оставляет авторскую строку", () => {
  const behaviour: Behaviour = { ...DEFAULT_BEHAVIOUR, wiggleXAmp: 6, wiggleXFreq: 1 };
  const written = writeBehaviour("x = inherit + 3 * delta", behaviour, child).script;
  expect(written).toContain("x_behaviour");
  const reset = writeBehaviour(written, DEFAULT_BEHAVIOUR, child).script;
  expect(reset).not.toContain("x_behaviour");
  expect(reset).toContain("x = inherit + 3 * delta");
});

test("строки нет — редактор её добавляет и сам ставит нужный оператор", () => {
  const behaviour: Behaviour = { ...DEFAULT_BEHAVIOUR, wiggleXAmp: 6, wiggleXFreq: 1 };
  // С родителем опора — inherit.
  const withParent = writeBehaviour("", behaviour, child).script;
  expect(withParent).toContain("x = inherit + x_behaviour");
  // Без родителя inherit недоступен — берётся чистый канал.
  const root = writeBehaviour("", behaviour, object).script;
  expect(root).toContain("x = x_behaviour");
  expect(root).not.toContain("inherit");
});

test("«сглаживать и наследство» возвращает прежнее ощущение через добавку", () => {
  // По умолчанию фильтр стоит на добавке: наследство родителя не тормозит.
  const plain = behaviourBlock({ ...DEFAULT_BEHAVIOUR, smooth: 0.5, wiggleYAmp: 4, wiggleYFreq: 1 }, child);
  expect(plain).toContain("y_behaviour = smooth(");
  expect(plain).not.toContain("+ inherit");
  // С галочкой фильтруется сумма, но канал остаётся добавкой: из неё вычитается inherit.
  const merged = behaviourBlock(
    { ...DEFAULT_BEHAVIOUR, smooth: 0.5, smoothInherit: true, wiggleYAmp: 4, wiggleYFreq: 1 },
    child,
  );
  expect(merged).toContain("+ inherit");
  expect(merged).toMatch(/- inherit\)/);
});
