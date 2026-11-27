import { expect, test } from "@playwright/test";
import { orderedObjects } from "../../src/render/rigCanvas";
import { inheritsField, previewFrame, propagateBase, withBases } from "../../src/engine/structure";
import { createDemoPreset } from "../../src/data/demoPreset";
import type { BasePose, RigFrame, RigObject } from "../../src/types";
import { NEUTRAL_PARAMS } from "../../src/engine/frame";

const base = (x: number, y: number): BasePose => ({
  x, y, rotation: 0, sizeX: 1, sizeY: 1, skewX: 0, skewY: 0, opacity: 1, visible: 1, layer: 0,
});

const object = (id: string, parentId: string | null, pose: BasePose): RigObject => ({
  id, name: id, kind: "sprite", enabled: true, image: null, parentId,
  pivot: { x: 0.5, y: 0.5 }, base: pose, width: 100, height: 100, script: "",
});

test("поворот родителя поворачивает детей вокруг его пивота", () => {
  const objects = [
    object("parent", null, base(100, 100)),
    object("child", "parent", base(140, 100)),
    object("grandchild", "child", base(140, 140)),
  ];
  const rotated = propagateBase(objects, "parent", base(100, 100), { ...base(100, 100), rotation: 90 });
  const child = rotated.find((item) => item.id === "child")!;
  const grandchild = rotated.find((item) => item.id === "grandchild")!;
  expect(child.base.x).toBeCloseTo(100, 6);
  expect(child.base.y).toBeCloseTo(140, 6);
  expect(child.base.rotation).toBeCloseTo(90, 6);
  // Всё поддерево поворачивается жёстко: внук едет вместе с родителем.
  expect(grandchild.base.x).toBeCloseTo(60, 6);
  expect(grandchild.base.y).toBeCloseTo(140, 6);
  expect(grandchild.base.rotation).toBeCloseTo(90, 6);
});

test("масштаб и сдвиг родителя переносятся на детей", () => {
  const objects = [object("parent", null, base(100, 100)), object("child", "parent", base(140, 100))];
  const scaled = propagateBase(objects, "parent", base(100, 100), { ...base(100, 100), sizeX: 2, sizeY: 3 });
  expect(scaled.find((item) => item.id === "child")!.base.x).toBeCloseTo(180, 6);
  expect(scaled.find((item) => item.id === "child")!.base.y).toBeCloseTo(100, 6);
  const moved = propagateBase(objects, "parent", base(100, 100), base(130, 160));
  expect(moved.find((item) => item.id === "child")!.base.x).toBeCloseTo(170, 6);
  expect(moved.find((item) => item.id === "child")!.base.y).toBeCloseTo(160, 6);
});

test("без изменения позы родителя базы детей не трогаются", () => {
  const objects = [object("parent", null, base(100, 100)), object("child", "parent", base(140, 100))];
  const same = propagateBase(objects, "parent", base(100, 100), { ...base(100, 100), opacity: 0.5 });
  expect(same.find((item) => item.id === "child")!.base).toEqual(base(140, 100));
});

test("выделенный ребёнок не двигается дважды", () => {
  const objects = [
    object("parent", null, base(100, 100)),
    object("child", "parent", base(140, 100)),
    object("grandchild", "child", base(140, 140)),
  ];
  const moved = propagateBase(objects, "parent", base(100, 100), base(120, 100), ["child"]);
  expect(moved.find((item) => item.id === "child")!.base.x).toBe(140);
  // Поддерево выделенного ребёнка правит его собственный перенос.
  expect(moved.find((item) => item.id === "grandchild")!.base.x).toBe(140);
});

test("порядок отрисовки: слой из кадра, при равенстве — структура", () => {
  const preset = createDemoPreset();
  const frame = (layers: Record<string, number>): RigFrame => ({
    seq: 1,
    time: 0,
    dt: 0,
    globals: {},
    objects: Object.fromEntries(preset.objects.map((item) => [item.id, {
      x: 0, y: 0, rotation: 0, sizeX: 1, sizeY: 1, skewX: 0, skewY: 0,
      opacity: 1, visible: 1, layer: layers[item.id] ?? item.base.layer,
    }])),
    order: [],
    diagnostics: [],
  });

  // Слой-литерал берётся из пресета (иначе порядок отставал бы от правки до
  // следующего тика), поэтому «слой из кадра» проверяем на формуле.
  const bodyIndex = preset.objects.findIndex((item) => item.id === "body");
  preset.objects[bodyIndex] = {
    ...preset.objects[bodyIndex],
    script: preset.objects[bodyIndex].script.replace(/^[ \t]*layer[ \t]*=.*$/m, "layer = manual.value"),
  };

  // Дичь: рука получает слой выше головы — рисуется последней.
  const raised = orderedObjects(preset, frame({ body: 9 }));
  expect(raised[raised.length - 1].id).toBe("body");

  // Равные слои: потомок поверх предка, верхняя строка структуры поверх нижней.
  const even = orderedObjects(preset, frame(Object.fromEntries(preset.objects.map((item) => [item.id, 0]))));
  const indexOf = (id: string) => even.findIndex((item) => item.id === id);
  // Верхняя строка структуры — поверх нижней: она рисуется позже.
  expect(indexOf("head")).toBeGreaterThan(indexOf("eye_left"));
  expect(indexOf("mouth")).toBeGreaterThan(indexOf("mouth_closed"));
  // Порядок не зависит от порядка массива в пресете: он общий для массива и дерева.
  expect(indexOf("head")).toBeGreaterThan(indexOf("body"));
});

test("выделенная группа двигает и свои объекты, а не один пивот", () => {
  const objects = [
    object("group", null, base(100, 100)),
    object("child", "group", base(140, 100)),
    object("grandchild", "child", base(140, 140)),
    object("other", null, base(400, 400)),
  ];
  const moved = withBases(objects, ["group"], (pose) => ({ ...pose, x: pose.x + 20, y: pose.y + 5 }));
  const at = (id: string) => moved.find((item) => item.id === id)!.base;
  expect(at("group")).toMatchObject({ x: 120, y: 105 });
  expect(at("child")).toMatchObject({ x: 160, y: 105 });
  expect(at("grandchild")).toMatchObject({ x: 160, y: 145 });
  // Сосед не тронут.
  expect(at("other")).toMatchObject({ x: 400, y: 400 });
});

test("общий ребёнок двух выделенных родителей двигается один раз", () => {
  const objects = [
    object("a", null, base(0, 0)),
    object("b", null, base(0, 0)),
    object("child", "a", base(10, 0)),
  ];
  const moved = withBases(objects, ["a", "b"], (pose) => ({ ...pose, x: pose.x + 10 }));
  expect(moved.find((item) => item.id === "child")!.base.x).toBe(20);
});

test("предпросмотр перекрывает только вклад своего слоя", () => {
  const objects = [object("eye", null, base(100, 100)), object("mouth", null, base(300, 300))];
  const frame: RigFrame = {
    seq: 4, time: 1, dt: 0.016, globals: {}, order: ["eye", "mouth"], diagnostics: [],
    objects: {
      // Живая симуляция: поведение + состояния по текущему входу.
      eye: { ...NEUTRAL_PARAMS, x: 40, y: 10, rotation: 15, sizeX: 2, opacity: 0.5 },
      mouth: { ...NEUTRAL_PARAMS, x: 7 },
    },
  };
  const shown = previewFrame(frame, objects, {
    id: "eye",
    // Слой вкладки даёт сейчас x = 40 и rotation = 15, а в точке — x = 25, rotation = 5.
    live: { x: 40, rotation: 15, sizeX: 2 },
    pose: { x: 25, rotation: 5, sizeX: 3 },
  })!;
  // Свой вклад снят, поза вкладки поставлена: 40 − 40 + 25, 15 − 15 + 5.
  expect(shown.objects.eye.x).toBe(25);
  expect(shown.objects.eye.rotation).toBe(5);
  // Множители перекрываются отношением: 2 × (3 / 2) = 3.
  expect(shown.objects.eye.sizeX).toBe(3);
  // Всё, чего слой не касается, остаётся кадровым — inherit и прочее не стираются.
  expect(shown.objects.eye.y).toBe(10);
  expect(shown.objects.eye.opacity).toBe(0.5);
  expect(shown.objects.eye.layer).toBe(NEUTRAL_PARAMS.layer);
  // Соседние объекты живут своим кадром.
  expect(shown.objects.mouth.x).toBe(7);
  // Исходный кадр не правится: движок продолжает считать как считал.
  expect(frame.objects.eye.x).toBe(40);
  // Без предпросмотра кадр идёт как есть.
  expect(previewFrame(frame, objects, null)).toBe(frame);
});

test("живой вклад берётся из кадра, а не из числа, которое посчитала вкладка", () => {
  const objects = [object("eye", null, base(100, 100))];
  const frame: RigFrame = {
    seq: 9, time: 1, dt: 0.016, globals: {}, order: ["eye"], diagnostics: [],
    // Сцена уже получила новый кадр: мышь успела уехать.
    objects: { eye: { ...NEUTRAL_PARAMS, x: 55 } },
    // Блок состояний зеркалит вклад слоя в `vars` — из этого же кадра.
    vars: { eye: { states_x: 55 } },
  };
  const shown = previewFrame(frame, objects, {
    id: "eye",
    pose: { x: 20 },
    // Вкладка считала по прошлому кадру: это число не должно попасть в картинку,
    // иначе разница 55 − 10 осталась бы в объекте и он дёргался бы вместе с входом.
    live: { x: 10 },
  })!;
  expect(shown.objects.eye.x).toBe(20);
  // Кадр без `vars` (старое ядро) живёт на том, что прислала вкладка.
  const legacy: RigFrame = { ...frame, vars: undefined };
  expect(previewFrame(legacy, objects, { id: "eye", pose: { x: 20 }, live: { x: 10 } })!.objects.eye.x).toBe(65);
});

test("предпросмотр без кадра всё равно показывает позу", () => {
  const objects = [object("eye", null, base(100, 100))];
  // Движок на паузе кадр не присылает: значения берутся из базы, как в отрисовке.
  const shown = previewFrame(null, objects, { id: "eye", live: {}, pose: { x: 12 } })!;
  expect(shown.objects.eye.x).toBe(12);
  expect(shown.objects.eye.sizeX).toBe(1);
});

test("дети едут за предпросмотром только через inherit", () => {
  const objects = [
    { ...object("head", null, base(100, 100)), script: "x = inherit\ny = inherit\n" },
    { ...object("eye", "head", base(140, 100)), script: "x = inherit + 4\ny = 30\n" },
    { ...object("pin", "head", base(160, 100)), script: "x = 5\n" },
  ];
  const frame: RigFrame = {
    seq: 1, time: 0, dt: 0.016, globals: {}, order: [], diagnostics: [],
    objects: {
      head: { ...NEUTRAL_PARAMS, x: 30 },
      eye: { ...NEUTRAL_PARAMS, x: 34, y: 30 },
      pin: { ...NEUTRAL_PARAMS, x: 5 },
    },
  };
  const shown = previewFrame(frame, objects, { id: "head", live: { x: 30 }, pose: { x: 10 } })!;
  // Голова: 30 − 30 + 10.
  expect(shown.objects.head.x).toBe(10);
  // Глаз пишет x через inherit — значит меняется ровно на ту же поправку (−20).
  expect(shown.objects.eye.x).toBe(14);
  // Своё значение не трогаем: inherit тут ни при чём.
  expect(shown.objects.pin.x).toBe(5);
  // Поле y у глаза своё (30) — поправка y = 0 его и не касается.
  expect(shown.objects.eye.y).toBe(30);
  // Пресет не тронут.
  expect(objects[1].base.x).toBe(140);
});

test("поле пишется через inherit — видно по авторской строке", () => {
  expect(inheritsField("x = inherit + follow(offset, parent).x", "x")).toBe(true);
  expect(inheritsField("  y = inherit * 2\n", "y")).toBe(true);
  expect(inheritsField("x = follow(offset, parent).x", "x")).toBe(false);
  expect(inheritsField("rotation = 12\n", "rotation")).toBe(false);
  // Поле не объявлено — наследовать нечего.
  expect(inheritsField("y = inherit\n", "x")).toBe(false);
  // Чужое поле с похожим именем не путается: x и sizeX разные.
  expect(inheritsField("sizeX = inherit\n", "x")).toBe(false);
});

test("preview rotation moves child pivots like runtime follow, with nested reverse-order hierarchy",()=>{
 const objects=[
  {...object("grandchild","child",base(250,100)),script:"x = inherit + follow(offset, parent).x\ny = inherit + follow(offset, parent).y\nrotation = inherit\nsizeX = inherit\nsizeY = inherit"},
  {...object("child","parent",base(200,100)),script:"x = inherit + follow(offset, parent).x\ny = inherit + follow(offset, parent).y\nrotation = inherit\nsizeX = inherit\nsizeY = inherit"},
  object("parent",null,base(100,100)),
 ];
 const shown=previewFrame(null,objects,{id:"parent",live:{},pose:{rotation:90}})!;
 expect(shown.objects.child.rotation).toBe(90);
 expect(shown.objects.child.x).toBeCloseTo(-100);expect(shown.objects.child.y).toBeCloseTo(100);
 expect(shown.objects.grandchild.x).toBeCloseTo(-150);expect(shown.objects.grandchild.y).toBeCloseTo(150);
});

test("preview replaces live rotation and nonuniform scale, not double-applying follow",()=>{
 const objects=[object("parent",null,base(100,100)),object("child","parent",base(200,120))];
 const frame:RigFrame={seq:1,time:0,dt:0,globals:{},diagnostics:[],order:[],objects:{
  parent:{...NEUTRAL_PARAMS,rotation:90,sizeX:2,sizeY:3},
  // R90 * S(2,3) * (100,20) - (100,20) = (-160,180).
  child:{...NEUTRAL_PARAMS,x:-160,y:180,rotation:90,sizeX:2,sizeY:3},
 },vars:{parent:{states_rotation:90,states_sizeX:2,states_sizeY:3}}};
 const shown=previewFrame(frame,objects,{id:"parent",live:{},pose:{rotation:180,sizeX:3,sizeY:2}})!;
 expect(shown.objects.child.x).toBeCloseTo(-400);expect(shown.objects.child.y).toBeCloseTo(-60);
 expect(shown.objects.child.rotation).toBe(180);expect(shown.objects.child.sizeX).toBe(3);expect(shown.objects.child.sizeY).toBe(2);
 expect(frame.objects.child.x).toBe(-160);
});

test("preview respects explicit independent channels and interrupted inheritance",()=>{
 const objects=[object("parent",null,base(100,100)),
  {...object("fixed","parent",base(200,100)),script:"x = 7\ny = 8\nrotation = 0\nsizeX = 1\nsizeY = 1"},
  {...object("leaf","fixed",base(250,100)),script:"x = inherit + follow(offset,parent).x\ny = inherit + follow(offset,parent).y\nrotation = inherit"},
  {...object("translationOnly","parent",base(200,100)),script:"x = inherit\ny = inherit\nrotation = 0"},
 ];
 const shown=previewFrame(null,objects,{id:"parent",live:{},pose:{x:12,rotation:90}})!;
 expect(shown.objects.fixed.x).toBe(0);expect(shown.objects.fixed.y).toBe(0);
 expect(shown.objects.leaf.x).toBe(0);expect(shown.objects.leaf.y).toBe(0);expect(shown.objects.leaf.rotation).toBe(0);
 expect(shown.objects.translationOnly.x).toBe(12);expect(shown.objects.translationOnly.y).toBe(0);
});
