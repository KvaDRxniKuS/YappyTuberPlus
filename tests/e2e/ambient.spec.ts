import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeDefinition, registerDefinitions, moduleDefaults, type ModuleDefinition } from "../../src/modules/registry";
import { composeValues, instanceInputs } from "../../src/modules/values";
import {
  AMBIENT_POINT_BASE, ambientConnection, ambientInputs, ambientPoints, ambientRate, ambientValues,
  resetAmbientState, sanitizePointName, uniquePointName, type AmbientPoint,
} from "../../src/modules/ambient";
import { areaOnFrame, areaOnScene, base64, obsAuth, sha256, utf8, type ObsTransform } from "../../src/modules/obs";
import { averageBox, type SamplePixels } from "../../src/render/sceneSample";
import type { ModuleInstance } from "../../src/types";

/*
 * «Свет из экрана».
 *
 * Три вещи, которые легко разъезжаются и которые видно только на числах:
 * усреднение участка, авторизация OBS (её формулу знает только документация) и
 * арифметика «трансформация элемента → область на кадре». Ядро и OBS для этих
 * проверок не нужны.
 */

const directory = join(process.cwd(), "public", "modules");
const template = JSON.parse(readFileSync(join(directory, "ambient.json"), "utf8")) as Record<string, unknown>;
const definition = normalizeDefinition(template) as ModuleDefinition;

// Библиотека шаблонов — как в приложении: без неё `ambient` станет «Manual».
const catalog = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")) as { modules: string[] };
registerDefinitions(catalog.modules
  .map((id) => normalizeDefinition(JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"))))
  .filter((item): item is ModuleDefinition => item !== null));

function ambient(config: Record<string, unknown> = {}): ModuleInstance {
  return {
    name: "ambient_1",
    type: "ambient",
    enabled: true,
    source: "manual",
    config: { ...moduleDefaults(definition), ...config },
  };
}

/** Пиксели для проверки: одна функция на все — меньше поводов ошибиться. */
function pixels(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): SamplePixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const index = (y * width + x) * 4;
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = a;
    }
  }
  return { width, height, data };
}

test("ambient: средний цвет участка — это среднее видимых пикселей", () => {
  const red = pixels(8, 8, () => [255, 0, 0, 255]);
  expect(averageBox(red, { x: 0.5, y: 0.5, size: 0.5 })).toEqual({ r: 1, g: 0, b: 0, a: 1 });

  // Половина красная, половина синяя — на стыке средний фиолетовый.
  const two = pixels(8, 8, (x) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  const middle = averageBox(two, { x: 0.5, y: 0.5, size: 1 });
  expect(middle?.r).toBeCloseTo(0.5, 2);
  expect(middle?.b).toBeCloseTo(0.5, 2);

  // Прозрачное в средний цвет не попадает: цвет — только у видимого.
  const half = pixels(8, 8, (x) => (x < 4 ? [0, 255, 0, 255] : [0, 0, 0, 0]));
  const visible = averageBox(half, { x: 0.5, y: 0.5, size: 1 });
  expect(visible?.g).toBeCloseTo(1, 2);
  expect(visible?.a).toBeCloseTo(0.5, 2);

  // Совсем прозрачный участок — не «нет данных», а прозрачный цвет.
  expect(averageBox(pixels(4, 4, () => [0, 0, 0, 0]), { x: 0.5, y: 0.5, size: 1 })).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  // Пустых пикселей не бывает — но если данные битые, лучше `null`, чем деление на ноль.
  expect(averageBox({ width: 0, height: 0, data: [] }, { x: 0.5, y: 0.5, size: 1 })).toBeNull();
});

test("ambient: размытие захватывает соседние пиксели", () => {
  // Левая половина красная, правая чёрная. Точка стоит в чёрной, но у границы:
  // без размытия она чёрная, с размытием подмешивается красное.
  const half = pixels(32, 32, (x) => (x < 16 ? [255, 0, 0, 255] : [0, 0, 0, 255]));
  const point = averageBox(half, { x: 0.62, y: 0.5, size: 0.02 });
  const wide = averageBox(half, { x: 0.62, y: 0.5, size: 0.02 }, 6);
  expect(point?.r).toBeCloseTo(0, 5);
  expect(wide!.r).toBeGreaterThan(0);
  // Дальше от границы размытие не помогает: оно расширяет участок, а не ищет цвет.
  expect(averageBox(half, { x: 0.95, y: 0.5, size: 0.02 }, 6)?.r).toBeCloseTo(0, 5);

  // Яркость точки считается от видимого: max(r,g,b) на прозрачность.
  expect(ambientValues({ r: 0.5, g: 0.25, b: 0, a: 0.5 }).level).toBeCloseTo(0.25, 5);
});

test("ambient: хеш и авторизация OBS совпадают с эталоном", () => {
  const reference = (text: string) => createHash("sha256").update(text).digest("base64");
  expect(base64(sha256(utf8("abc")))).toBe(reference("abc"));
  expect(base64(sha256(utf8("пароль")))).toBe(reference("пароль"));

  // Формула obs-websocket v5: base64(sha256(base64(sha256(пароль+salt)) + challenge)).
  const password = "секрет";
  const salt = "соль";
  const challenge = "вызов";
  const expected = createHash("sha256")
    .update(`${createHash("sha256").update(`${password}${salt}`).digest("base64")}${challenge}`)
    .digest("base64");
  expect(obsAuth(password, { salt, challenge })).toBe(expected);
  // Авторизация не запрошена — ответа нет.
  expect(obsAuth(password, null)).toBeNull();
});

test("ambient: точка едет за источником — арифметика трансформации", () => {
  const transform: ObsTransform = {
    positionX: 100, positionY: 50, width: 400, height: 200,
    cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0, rotation: 0,
  };
  const video = { baseWidth: 1920, baseHeight: 1080 };
  const area = areaOnScene({ x: 0.5, y: 0.5, size: 0.1 }, transform, video);
  expect(area.x).toBeCloseTo(300 / 1920, 5);
  expect(area.y).toBeCloseTo(150 / 1080, 5);
  // Сторона — в долях меньшей стороны кадра: квадрат остаётся квадратом.
  expect(area.size).toBeCloseTo((0.1 * 200) / 1080, 5);

  // Источник уехал вправо — точка уехала вместе с ним, ничего не правим.
  const moved = areaOnScene({ x: 0.5, y: 0.5, size: 0.1 }, { ...transform, positionX: 900 }, video);
  expect(moved.x).toBeGreaterThan(area.x);

  // Без следования точка задана прямо в долях кадра.
  expect(areaOnFrame({ x: 0.25, y: 0.75, size: 0.2 })).toEqual({ x: 0.25, y: 0.75, size: 0.2 });
});

test("ambient: точка — пять входов, имена не повторяются", () => {
  const module = ambient({
    points: [AMBIENT_POINT_BASE, { ...AMBIENT_POINT_BASE, name: "spot_1", label: "Вторая" }],
  });
  const points = ambientPoints(module);
  // Одно имя на две точки — вторая получает своё, а не затирает первую.
  expect(points.map((point) => point.name)).toEqual(["spot_1", "spot_1_2"]);

  const specs = instanceInputs(module);
  expect(specs.map((spec) => spec.name)).toEqual([
    "spot_1_r", "spot_1_g", "spot_1_b", "spot_1_a", "spot_1_level",
    "spot_1_2_r", "spot_1_2_g", "spot_1_2_b", "spot_1_2_a", "spot_1_2_level",
  ]);
  expect(specs.every((spec) => spec.min === 0 && spec.max === 1)).toBe(true);

  // Кириллица в имени не проходит: имя уходит в скрипт.
  // Кириллица вычищается целиком — остаётся запасное имя.
  expect(sanitizePointName("Свет слева")).toBe("spot");
  expect(sanitizePointName("9 left")).toBe("s_9_left");
  expect(uniquePointName([{ ...AMBIENT_POINT_BASE, name: "spot_1" }], "spot_1")).toBe("spot_1_2");

  // Частота замеров и адрес OBS — из настроек экземпляра.
  expect(ambientRate(ambient({ rate: 120 }))).toBe(30);
  expect(ambientRate(ambient({ rate: 0 }))).toBe(1);
  expect(ambientConnection(ambient({ connection: { host: " 192.168.1.5 ", port: 4456 } })))
    .toEqual({ host: "192.168.1.5", port: 4456 });
});

test("ambient: замеры становятся входами, без замера — прошлый цвет", () => {
  resetAmbientState();
  // Сглаживание off: здесь проверяется раскладка, а не инерция.
  const module = ambient({ points: [{ ...AMBIENT_POINT_BASE, smooth: 0 }] });
  const values = composeValues([module], {
    audio: {}, manual: {}, auto: {}, now: 1000, dt: 1 / 30,
    ambient: { ambient_1: { spot_1: { r: 1, g: 0.5, b: 0, a: 1 } } },
  });
  expect(values["ambient_1.spot_1_r"]).toBeCloseTo(1, 5);
  expect(values["ambient_1.spot_1_g"]).toBeCloseTo(0.5, 5);
  expect(values["ambient_1.spot_1_level"]).toBeCloseTo(1, 5);

  // Замера нет (OBS не подключён) — держим прошлое, а не гасим свет в ноль.
  const frozen = composeValues([module], { audio: {}, manual: {}, auto: {}, now: 1010, dt: 1 / 30 });
  expect(frozen["ambient_1.spot_1_r"]).toBeCloseTo(1, 5);

  // Выключенный вход в кадр не попадает.
  const off = { ...ambient({ points: [{ ...AMBIENT_POINT_BASE, smooth: 0 }] }), disabledInputs: ["spot_1_level"] };
  const limited = composeValues([off], {
    audio: {}, manual: {}, auto: {}, now: 1020, dt: 1 / 30,
    ambient: { ambient_1: { spot_1: { r: 0.2, g: 0.2, b: 0.2, a: 1 } } },
  });
  expect(limited["ambient_1.spot_1_level"]).toBeUndefined();
  expect(limited["ambient_1.spot_1_r"]).toBeCloseTo(0.2, 5);
});

test("ambient: сглаживание тянет цвет к новому, а не прыгает", () => {
  resetAmbientState();
  const module = ambient({ points: [{ ...AMBIENT_POINT_BASE, smooth: 100 }] });
  const first = composeValues([module], {
    audio: {}, manual: {}, auto: {}, now: 0, dt: 1 / 30,
    ambient: { ambient_1: { spot_1: { r: 1, g: 1, b: 1, a: 1 } } },
  });
  expect(first["ambient_1.spot_1_r"]).toBeCloseTo(1, 5);
  // Резко почернело: за один кадр цвет уходит не до конца — на этом и держится
  // «не мигает на каждом движении».
  const second = composeValues([module], {
    audio: {}, manual: {}, auto: {}, now: 33, dt: 1 / 30,
    ambient: { ambient_1: { spot_1: { r: 0, g: 0, b: 0, a: 1 } } },
  });
  expect(second["ambient_1.spot_1_r"]).toBeGreaterThan(0.9);
  // Через несколько секунд — почти чёрный (100 % ≈ полторы секунды на половину
  // разницы, поэтому за 4 секунды остаётся меньше десятой доли).
  let last = second;
  for (let step = 0; step < 120; step += 1) {
    last = composeValues([module], {
      audio: {}, manual: {}, auto: {}, now: 66 + step * 33, dt: 1 / 30,
      ambient: { ambient_1: { spot_1: { r: 0, g: 0, b: 0, a: 1 } } },
    });
  }
  expect(last["ambient_1.spot_1_r"]).toBeLessThan(0.1);
});

test("ambient: точка привязывается к цвету так же, как канал цвета", () => {
  const points: AmbientPoint[] = ambientPoints(ambient());
  expect(points[0].source.kind).toBe("scene");

  const behaviour = readFileSync(join(process.cwd(), "src", "components", "BehaviourPanel.tsx"), "utf8");
  // Список источников цвета общий: свет не должен знать, палитра это или экран.
  expect(behaviour).toContain('kind === "ambient"');
  expect(behaviour).toContain("ambientPoints(module)");

  // Пароль OBS — в настройках приложения, а не в пресете.
  const templateText = readFileSync(join(directory, "ambient.json"), "utf8");
  expect(templateText).not.toContain("password");
  const editor = readFileSync(join(process.cwd(), "src", "components", "AmbientEditor.tsx"), "utf8");
  // Пароль вводится в карточке модуля, но живёт в настройках приложения:
  // правка идёт мимо `onConfig`, поэтому в пресет он не попадёт.
  expect(editor).toContain("setObsPassword(");
  expect(editor).toContain('type="password"');

  const obs = readFileSync(join(process.cwd(), "src", "modules", "obs.ts"), "utf8");
  expect(obs).toContain("yappytuber.obs.password");
  expect(obs).toContain("localStorage");
});

test("ambient: своя сцена замеряется отдельным проходом без интерфейса", () => {
  const scene = readFileSync(join(process.cwd(), "src", "components", "Scene.tsx"), "utf8");
  expect(scene).toContain("sceneSampler.prepare(");
  expect(scene).toContain("sceneSampler.commit()");

  const hook = readFileSync(join(process.cwd(), "src", "hooks", "useAmbientSample.ts"), "utf8");
  expect(hook).toContain("sceneSampler.request()");
  expect(hook).toContain("areaOnScene(");
  expect(hook).toContain("obsPassword()");

  const index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")) as { modules: string[] };
  expect(index.modules).toContain("ambient");
  expect(template.kind).toBe("ambient");
});
