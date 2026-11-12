import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  IFM_HELLO, TRACKER_FIELDS, TRACKER_INFO, TRACKER_TRANSPORTS,
  armName, flattenFrame, helloFor, isTrackerTransport, parseIfacialFrame,
  parseTrackerFrame, parseVtuberStudioFrame, trackerField, trackerInputName, trackerPorts,
} from "../../src/modules/tracker";
import { GENERIC_TRANSPORTS, EXTERNAL_TRANSPORTS, readExternalSource } from "../../src/modules/external";
import { applyMapping } from "../../src/modules/external";
import { moduleDefaults, moduleDefinition, normalizeDefinition, registerDefinitions } from "../../src/modules/registry";

/**
 * Кадр из документации iFacialMocap — дословно, вместе с мусором, который
 * встречается в живом потоке: скобки, `?` перед именем и хвост чисел.
 */
const IFM_SAMPLE = "mouthSmile_R-0(eyeLookOut_L-0)mouthUpperUp_L-11(eyeWide_R-0)mouthClose-8|mouthPucker-4|"
  + "mouthRollLower-9|eyeBlink_R-7|eyeLookDown_L-1|?cheekSquint_R-11|eyeBlink_L-7|tongueOut-0|jawRight-0|"
  + "eyeLookIn_R-9|cheekSquint_L-11|mouthDimple_L-10|mouthPress_L-4|eyeSquint_L-11|mouthRight-0|"
  + "mouthShrugLower-0|eyeLookUp_R-0|eyeLookOut_R-0|mouthPress_R-5|cheekPuff-2|jawForward-1|1|"
  + "mouthLowerDown_L-9|mouthFrown_L-6|mouthShrugUpper-26|browOuterUp_L-4|browInnerUp-20|"
  + "mouthDimple_R-10|browDown_R-0|mouthUpperUp_R-10|mouthRollUpper-8|mouthFunnel-12|"
  + "mouthStretch_R-21|mouthFrown_R-13|eyeLookDown_R-17|jawOpen-12|jawLeft-0|browDown_L-0|"
  + "mouthSmile_L-0|noseSneer_R-18|mouthLowerDown_R-8|noseSneer_L-21|eyeWide_L-0|"
  + "mouthStretch_L-21|browOuterUp_R-4|eyeLookIn_L-4|eyeSquint_R-11|eyeLookUp_L-0|mouthLeft-0|"
  + "=head#-21.488958,-6.038993,-6.6019735,-0.030653415,-0.10287084,-0.6584072|"
  + "rightEye#6.0297494,2.4403017,0.25649446|leftEye#6.034903,-1.6660284,-0.17520553|"
  + "34903,-1.6660284,-0.17520553|";

/** Кадр VTube Studio: JSON, который приходит на наш порт после запроса. */
const VTS_SAMPLE = JSON.stringify({
  Timestamp: 1_700_000_000_000,
  Hotkey: 3,
  FaceFound: true,
  Rotation: { x: 1, y: 2, z: 3 },
  Position: { x: 0.1, y: 0.2, z: 0.3 },
  BlendShapes: [{ k: "EyeBlinkLeft", v: 0.42 }, { k: "JawOpen", v: 0.5 }],
  EyeLeft: { x: 1, y: 2, z: 3 },
  EyeRight: { x: 4, y: 5, z: 6 },
});

const ARKIT_KEYS = new Set(
  TRACKER_FIELDS.filter((field) => field.group === "arkit").map((field) => field.key.replace(/^arkit\./, "")),
);

test.beforeAll(() => {
  const directory = join(process.cwd(), "public", "modules");
  const index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")) as { modules: string[] };
  const definitions = index.modules
    .map((id) => normalizeDefinition(JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"))))
    .filter((definition) => definition !== null);
  registerDefinitions(definitions);
});

test("каталог полей один для трёх приложений: 52 блендшейпа, голова, глаза, служебные", () => {
  expect(ARKIT_KEYS.size).toBe(52);
  // Имена кириллицей не дублируются, пути уникальны: иначе «+» добавил бы дубль.
  expect(new Set(TRACKER_FIELDS.map((field) => field.path)).size).toBe(TRACKER_FIELDS.length);
  expect(new Set(TRACKER_FIELDS.map((field) => field.label)).size).toBe(TRACKER_FIELDS.length);
  // Голова: три поворота и три координаты; глаза: по три оси на каждый.
  expect(TRACKER_FIELDS.filter((field) => field.group === "head").map((field) => field.key))
    .toEqual(["head.rx", "head.ry", "head.rz", "head.x", "head.y", "head.z"]);
  expect(TRACKER_FIELDS.filter((field) => field.group === "eye")).toHaveLength(6);
  expect(TRACKER_FIELDS.filter((field) => field.group === "service").map((field) => field.key))
    .toEqual(["faceFound", "hotkey"]);
  // Углы не зажаты в 0…1: поворот головы на 40° — рабочее значение.
  expect(trackerField("$.head.rx")?.min).toBe(-90);
  expect(trackerField("$.arkit.jawOpen")?.max).toBe(1);
  // Кириллическая подпись и латинский вход — не одно и то же поле.
  expect(trackerInputName(trackerField("$.head.rx")!)).toBe("head_rx");
  expect(trackerInputName(trackerField("$.arkit.jawOpen")!)).toBe("jawOpen");
  expect(trackerInputName(trackerField("$.faceFound")!)).toBe("face_found");
});

test("имена блендшейпов сводятся к одному виду: суффикс _L/_R и регистр", () => {
  expect(armName("eyeBlink_L")).toBe("eyeBlinkLeft");
  expect(armName("mouthSmile_R")).toBe("mouthSmileRight");
  expect(armName("EyeBlinkLeft")).toBe("eyeBlinkLeft");
  expect(armName("JawOpen")).toBe("jawOpen");
  expect(armName("browInnerUp")).toBe("browInnerUp");
  // Мусор перед именем и числовые хвосты не становятся входами.
  expect(armName("?cheekSquint_R")).toBe("cheekSquintRight");
  expect(armName("34903,-1.6660284,")).toBe("");
  expect(armName("")).toBe("");
});

test("кадр iFacialMocap разбирается вместе со скобками, мусором и блоками головы", () => {
  const frame = parseIfacialFrame(IFM_SAMPLE);
  expect(frame).not.toBeNull();
  const arkit = frame!.arkit as Record<string, number>;
  // Проценты стали долями. В первой версии протокола дефис — разделитель, а не
  // знак: отрицательные значения появились только с версией 2 и разделителем `&`.
  expect(arkit.jawOpen).toBeCloseTo(0.12, 6);
  expect(arkit.mouthSmileRight).toBeCloseTo(0, 6);
  expect(arkit.mouthShrugUpper).toBeCloseTo(0.26, 6);
  // В кадре нет ни одного поля, которого нет в каталоге.
  expect(Object.keys(arkit).every((key) => ARKIT_KEYS.has(key))).toBe(true);
  // Повороты — в градусах, положение — отдельными осями.
  const head = frame!.head as Record<string, number>;
  expect(head.rx).toBeCloseTo(-21.488958, 6);
  expect(head.rz).toBeCloseTo(-6.6019735, 6);
  expect(head.x).toBeCloseTo(-0.030653415, 6);
  // rightEye — это правый глаз: сторона не путается.
  expect((frame!.eyeRight as Record<string, number>).ry).toBeCloseTo(2.4403017, 6);
  expect((frame!.eyeLeft as Record<string, number>).rx).toBeCloseTo(6.034903, 6);
  expect(frame!.faceFound).toBe(1);
  expect(frame!.hotkey).toBe(0);
});

test("Facemotion3D: разделитель &, отрицательные значения не обрезаются", () => {
  const frame = parseIfacialFrame("jawOpen&45|mouthSmile_L&-12|browInnerUp&30|=head#1,2,3|rightEye#4,5,6|leftEye#7,8,9|");
  const arkit = frame!.arkit as Record<string, number>;
  expect(arkit.jawOpen).toBeCloseTo(0.45, 6);
  // Знак сохраняется: −12 % — движение в обратную сторону, а не ноль.
  expect(arkit.mouthSmileLeft).toBeCloseTo(-0.12, 6);
  expect((frame!.head as Record<string, number>).ry).toBe(2);
  // Прежний формат с «-» по-прежнему читается тем же разбором.
  expect((parseIfacialFrame("jawOpen-45|")!.arkit as Record<string, number>).jawOpen).toBeCloseTo(0.45, 6);
  // Хвост TCP-режима отрезается: кадров может прийти несколько подряд.
  const two = parseIfacialFrame("jawOpen-10|___iFacialMocapjawOpen-20|");
  expect((two!.arkit as Record<string, number>).jawOpen).toBeCloseTo(0.1, 6);
});

test("кадр VTube Studio: JSON с парами k/v, поворотами и служебными полями", () => {
  const frame = parseVtuberStudioFrame(VTS_SAMPLE);
  expect(frame).not.toBeNull();
  const arkit = frame!.arkit as Record<string, number>;
  // Значения уже в долях: делить на 100 их нельзя.
  expect(arkit.eyeBlinkLeft).toBeCloseTo(0.42, 6);
  // Регистр в протоколе не гарантирован: JawOpen — тот же jawOpen.
  expect(arkit.jawOpen).toBeCloseTo(0.5, 6);
  const head = frame!.head as Record<string, number>;
  expect(head).toEqual({ rx: 1, ry: 2, rz: 3, x: 0.1, y: 0.2, z: 0.3 });
  expect(frame!.eyeRight).toEqual({ rx: 4, ry: 5, rz: 6 });
  expect(frame!.faceFound).toBe(1);
  expect(frame!.hotkey).toBe(3);
  // Кнопка «нет» — это −1 у приложения, а не номер нажатой.
  const idle = parseVtuberStudioFrame(JSON.stringify({ Hotkey: -1, BlendShapes: [{ k: "JawOpen", v: 0 }] }));
  expect(idle!.hotkey).toBe(0);
  // Лицо потеряно — флаг честный, значения при этом приходят.
  const lost = parseVtuberStudioFrame(JSON.stringify({ FaceFound: false, BlendShapes: [{ k: "JawOpen", v: 0.1 }] }));
  expect(lost!.faceFound).toBe(0);
  // Чужой формат и пустота — не кадр, а не нули: журнал покажет предупреждение.
  expect(parseVtuberStudioFrame("не json")).toBeNull();
  expect(parseVtuberStudioFrame("{}")).toBeNull();
  expect(parseIfacialFrame("")).toBeNull();
});

test("разбор выбирается приложением, а пути для отображения — общие", () => {
  const fromPhone = parseTrackerFrame(IFM_SAMPLE, "ifacialmocap");
  const fromVts = parseTrackerFrame(VTS_SAMPLE, "vtuberstudio");
  // Один и тот же путь читается у обоих: смена приложения не ломает таблицу.
  const rules = [{ input: "jaw", path: "$.arkit.jawOpen", min: -1, max: 1 }];
  expect(applyMapping(fromPhone, rules).jaw).toBeCloseTo(0.12, 6);
  expect(applyMapping(fromVts, rules).jaw).toBeCloseTo(0.5, 6);
  // Отрицательное значение проходит, если границы это разрешают.
  expect(applyMapping(fromPhone, [{ input: "mouth", path: "$.arkit.mouthSmileRight" }]).mouth).toBeCloseTo(-0.0, 6);
  const negative = parseTrackerFrame("mouthSmile_L&-12|", "facemotion3d");
  expect(applyMapping(negative, [{ input: "smile", path: "$.arkit.mouthSmileLeft" }]).smile).toBeCloseTo(-0.12, 6);
});

test("плоский кадр для живой таблицы: точки в путях, флаги числами, время не мешает", () => {
  const flat = flattenFrame(parseTrackerFrame(VTS_SAMPLE, "vtuberstudio"));
  expect(flat["arkit.jawOpen"]).toBeCloseTo(0.5, 6);
  expect(flat["head.rx"]).toBe(1);
  expect(flat["eyeRight.rz"]).toBe(6);
  // Служебное время не участвует: иначе таблица «менялась» бы каждый кадр.
  expect(flat.ts).toBeUndefined();
  expect(flattenFrame({ faceFound: true }).faceFound).toBe(1);
  // Каждое поле каталога имеет свой ключ в плоском кадре.
  for (const field of TRACKER_FIELDS) {
    expect(field.key).not.toContain("$");
  }
});

test("рукопожатие и порты: приложение молчит, пока его не попросят", () => {
  expect(helloFor("ifacialmocap", 49_983)).toBe(IFM_HELLO);
  expect(helloFor("facemotion3d", 49_983)).toBe(`${IFM_HELLO}|sendDataVersion=v2`);
  // VTube Studio: свой порт приёма в запросе и время, на которое включается поток.
  const hello = JSON.parse(helloFor("vtuberstudio", 21_500)) as Record<string, unknown>;
  expect(hello.messageType).toBe("iOSTrackingDataRequest");
  expect(hello.ports).toEqual([21_500]);
  expect(hello.time).toBe(1);
  expect(String(hello.sentBy)).toContain("YappyTuberPlus");

  expect(TRACKER_INFO.ifacialmocap.port).toBe(49_983);
  expect(TRACKER_INFO.facemotion3d.port).toBe(49_983);
  expect(TRACKER_INFO.vtuberstudio.port).toBe(21_412);
  expect(trackerPorts({}, "ifacialmocap")).toEqual({ port: 49_983, listenPort: 49_983 });
  expect(trackerPorts({ port: 50_000, listenPort: 50_001 }, "ifacialmocap")).toEqual({ port: 50_000, listenPort: 50_001 });
  // Битый порт не превращается в «0»: берётся умолчание приложения.
  expect(trackerPorts({ port: 0, listenPort: 70_000 }, "vtuberstudio")).toEqual({ port: 21_412, listenPort: 21_412 });
});

test("три отдельных модуля: iFacialMocap, VTube Studio, Facemotion3D", () => {
  const directory = join(process.cwd(), "public", "modules");
  const index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")) as { modules: string[] };
  for (const transport of TRACKER_TRANSPORTS) {
    // Модуль можно не добавлять в проект: приложений три, и лишнее не нужно.
    expect(index.modules).toContain(transport);
    const definition = moduleDefinition(transport);
    expect(definition.unknownKind).toBeFalsy();
    expect(definition.kind).toBe("external");
    expect(definition.title.length).toBeGreaterThan(0);
    const config = moduleDefaults(definition) as { source?: Record<string, unknown> };
    const source = readExternalSource(config);
    // Транспорт шаблона не должен «сбрасываться» в ws — иначе модуль молчит.
    expect(source.transport).toBe(transport);
    expect(source.host).toBe("");
    expect(source.mapping).toEqual([]);
    expect(source.port).toBe(TRACKER_INFO[transport].port);
    expect(source.listenPort).toBe(TRACKER_INFO[transport].listenPort);
    expect(EXTERNAL_TRANSPORTS).toContain(transport);
    // В общем списке «Внешнего источника» трекеров нет: у них свой редактор.
    expect(GENERIC_TRANSPORTS).not.toContain(transport);
  }
});

test("настройки трекера переживают чтение пресета, битые поля не ломают запуск", () => {
  const source = readExternalSource({
    source: { transport: "vtuberstudio", host: " 192.168.1.7 ", port: "21500", listenPort: 21501, mapping: [] },
  });
  expect(source.transport).toBe("vtuberstudio");
  expect(source.host).toBe("192.168.1.7");
  expect(source.port).toBe(21_500);
  expect(source.listenPort).toBe(21_501);
  // Пустой адрес — законное состояние, «неизвестно» и «пусто» тут не различаются.
  expect(readExternalSource({ source: { transport: "ifacialmocap", host: "" } }).host).toBe("");
  // Мусор в портах отбрасывается: приёмник возьмёт умолчание приложения.
  const broken = readExternalSource({ source: { transport: "facemotion3d", port: -5, listenPort: "abc" } });
  expect(broken.port).toBeUndefined();
  expect(broken.listenPort).toBeUndefined();
  // Неизвестный транспорт по-прежнему безопасно превращается в WebSocket.
  expect(readExternalSource({ source: { transport: "нет-такого" } }).transport).toBe("ws");
  expect(isTrackerTransport("vtuberstudio")).toBe(true);
  expect(isTrackerTransport("ws")).toBe(false);
});
