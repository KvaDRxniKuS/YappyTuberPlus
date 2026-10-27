import { test, expect } from "@playwright/test";
import {
  MODULE_FORMAT, PRESET_FORMAT, PRESET_FORMATS_READABLE, SLOT_INFO, SLOT_ORDER, VERSION,
  coreMessage, coreState, modulesMessage, outdatedMessage, outdatedSlots, packagingVersion,
  parseVersion, versionLabel, versionShort, versionString, versionTitle, withBuildStamp,
} from "../../src/version";
import { normalizePreset } from "../../src/engine/preset";
import { normalizeDefinition } from "../../src/modules/registry";
import { OVERLAY_PROTOCOL } from "../../src/overlay/protocol";
import { DEFAULT_BASE, type RigPreset } from "../../src/types";

/*
 * Паспорт версии проверяется как данные: набор чисел, разбор строки, сверка
 * поколений, подписи слотов и штамп сборки в файле пресета.
 */

test("паспорт: шесть чисел и подписи слотов", () => {
  // Порядок: релиз, ядро, файл, мост, модули, оболочка.
  expect(versionString()).toBe(
    `1.0.${VERSION.core}.${PRESET_FORMAT}.${OVERLAY_PROTOCOL}.${MODULE_FORMAT}.${VERSION.shell}`,
  );
  expect(versionString()).toBe("1.0.21.3.1.1.1");
  // Мост в паспорте и протокол оверлея — одно число, иначе они разъедутся.
  expect(VERSION.bridge).toBe(OVERLAY_PROTOCOL);
  expect(VERSION.format).toBe(PRESET_FORMAT);
  expect(VERSION.modules).toBe(MODULE_FORMAT);

  // Для человека — подписями, в том же порядке.
  expect(versionLabel()).toBe("1.0 · ядро 21 · файл 3 · мост 1 · модули 1 · оболочка 1");
  expect(versionShort()).toBe("1.0");
  // В установщик уходят только три числа: поколения туда не помещаются.
  expect(packagingVersion()).toBe("1.0.0");

  // У каждого слота есть имя и объяснение: подсказка в строке состояния.
  for (const slot of SLOT_ORDER) {
    expect(SLOT_INFO[slot].label).toBeTruthy();
    expect(SLOT_INFO[slot].hint.length).toBeGreaterThan(20);
  }
  const title = versionTitle();
  expect(title).toContain(versionLabel());
  expect(title).toContain(versionString());
  expect(title).toContain("ядро");
  expect(title).toContain("модули");
});

test("паспорт: разбор строки и мусор", () => {
  const parsed = parseVersion(versionString());
  expect(parsed).toEqual(VERSION);
  // Префиксы из подсказок и документации тоже понимаются.
  expect(parseVersion(`v${versionString()}`)).toEqual(VERSION);
  expect(parseVersion(`Версия ${versionString()}`)).toEqual(VERSION);
  // Неполный набор, лишнее число, буквы и не строка — не версия.
  for (const broken of [
    "", "1.0", "1.0.21.3.1.1", "1.0.21.3.1.1.1.1", "1.0.x.3.1.1.1", null, 42, versionLabel(),
  ]) {
    expect(parseVersion(broken)).toBeNull();
  }
});

test("паспорт: чужой файл — видно, какие слои отстали", () => {
  expect(outdatedSlots(versionString())).toEqual([]);
  expect(outdatedMessage(versionString())).toBeNull();
  expect(outdatedMessage(undefined)).toBeNull();

  // Файл из будущего: ядро и файл больше наших.
  const future = `1.0.${VERSION.core + 1}.${PRESET_FORMAT + 1}.${VERSION.bridge}.${VERSION.modules}.${VERSION.shell}`;
  expect(outdatedSlots(future)).toEqual(["core", "format"]);
  const message = outdatedMessage(future)!;
  expect(message).toContain("более новой сборкой");
  expect(message).toContain("ядро");
  expect(message).toContain("файл");

  // Старший релиз сам по себе не мешает: данные те же, читаем спокойно.
  const newerRelease = `2.5.${VERSION.core}.${VERSION.format}.${VERSION.bridge}.${VERSION.modules}.${VERSION.shell}`;
  expect(outdatedSlots(newerRelease)).toEqual([]);
  expect(outdatedMessage("не версия")).toBeNull();
});

test("паспорт: ядро сверяется отдельно от файла", () => {
  expect(coreState(VERSION.core)).toBe("ready");
  expect(coreMessage(VERSION.core)).toBeNull();
  // Ядра нет в ответе — оно старое и запроса версии не знает.
  expect(coreState(null)).toBe("older");
  expect(coreMessage(null)).toContain("пересоберите");
  expect(coreMessage(VERSION.core - 1)).toContain(`против ${VERSION.core}`);
  expect(coreState(VERSION.core + 1)).toBe("newer");
  expect(coreMessage(VERSION.core + 1)).toContain("новее редактора");
});

test("паспорт: модули новее редактора — это видно", () => {
  const ok = [
    { title: "Mouse", format: MODULE_FORMAT, unknownKind: false },
    { title: "Loudness", format: MODULE_FORMAT },
  ];
  expect(modulesMessage(ok)).toBeNull();
  expect(modulesMessage([])).toBeNull();

  // Новое поколение контракта шаблона: поля настроек могут не прочитаться.
  const future = [...ok, { title: "Жест", format: MODULE_FORMAT + 1 }];
  const message = modulesMessage(future)!;
  expect(message).toContain("Жест");
  expect(message).toContain("Manual");

  // Незнакомый вид модуля — та же тихая потеря: он станет «Manual».
  expect(modulesMessage([{ title: "Новый", format: MODULE_FORMAT, unknownKind: true }]))
    .toContain("Новый");
});

test("паспорт: шаблон модуля читает своё поколение и незнакомый вид", () => {
  const base = { id: "mouse", title: "Mouse", kind: "mouse", inputs: [] };
  // Старый шаблон без поля format считается текущим: молча ломаться не должен.
  expect(normalizeDefinition(base)!.format).toBe(MODULE_FORMAT);
  expect(normalizeDefinition({ ...base, format: 3 })!.format).toBe(3);
  expect(normalizeDefinition({ ...base, format: 3 })!.unknownKind).toBe(false);

  // Незнакомый вид модуля запоминается: панель и строка состояния скажут об этом.
  const unknown = normalizeDefinition({ ...base, kind: "gesture" })!;
  expect(unknown.kind).toBe("manual");
  expect(unknown.unknownKind).toBe(true);
  // Знакомый вид не помечается.
  expect(normalizeDefinition(base)!.unknownKind).toBe(false);
});

test("паспорт: штамп сборки попадает в файл, но не в историю", () => {
  const preset = {
    version: PRESET_FORMAT,
    name: "Сцена",
    canvas: { width: 1000, height: 600 },
    objects: [],
    globals: "",
    runtime: { fpsMode: "limited" as const, fpsLimit: 60 },
    overlay: normalizePreset(basePreset())!.overlay,
    modules: [],
  } as RigPreset;
  // В памяти пресета штампа нет — его ставит только запись файла.
  expect(preset.built).toBeUndefined();
  expect(withBuildStamp(preset).built).toBe(versionString());
  expect(preset.built).toBeUndefined();

  // Штамп переживает чтение пресета.
  expect(normalizePreset(withBuildStamp(preset))!.built).toBe(versionString());
});

test("формат: старое поколение читается, будущее — нет", () => {
  expect(PRESET_FORMATS_READABLE).toContain(PRESET_FORMAT);
  expect(PRESET_FORMATS_READABLE).toContain(2);

  // Пресет формата 2 (до света и карт нормалей) открывается и получает
  // текущее поколение: иначе он писался бы обратно старым.
  const old = normalizePreset(basePreset(2))!;
  expect(old.version).toBe(PRESET_FORMAT);
  expect(old.objects[0].kind).toBe("sprite");
  expect(old.objects[0].light).toBeUndefined();
  expect(old.objects[0].normal).toBeUndefined();

  expect(normalizePreset(basePreset(PRESET_FORMAT))!.version).toBe(PRESET_FORMAT);

  // Будущий формат редактор не берёт: иначе потеряет данные при сохранении.
  expect(normalizePreset(basePreset(PRESET_FORMAT + 1))).toBeNull();
  expect(normalizePreset(basePreset(1))).toBeNull();
});

/** Минимальный пресет нужного поколения: только то, что требует normalize. */
function basePreset(version = PRESET_FORMAT) {
  return {
    version,
    name: "Сцена",
    canvas: { width: 1000, height: 600 },
    objects: [{
      id: "body", name: "Тело", kind: "sprite", enabled: true, image: null, parentId: null,
      pivot: { x: 0.5, y: 0.5 }, base: { ...DEFAULT_BASE }, script: "", width: 100, height: 100,
    }],
    globals: "",
    runtime: { fpsMode: "limited", fpsLimit: 60 },
    overlay: {},
    modules: [],
  };
}
