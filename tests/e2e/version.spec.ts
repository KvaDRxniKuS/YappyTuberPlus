import { test, expect } from "@playwright/test";
import {
  PRESET_FORMAT, PRESET_FORMATS_READABLE, SLOT_LABEL, VERSION, VERSION_SLOTS,
  coreMessage, coreState, outdatedMessage, outdatedSlots, packagingVersion, parseVersion,
  versionString, versionTitle, withBuildStamp,
} from "../../src/version";
import { normalizePreset } from "../../src/engine/preset";
import { OVERLAY_PROTOCOL } from "../../src/overlay/protocol";
import { DEFAULT_BASE, type RigPreset } from "../../src/types";

/*
 * Версии проверяются как данные: кортеж, разбор строки, сверка поколений и
 * штамп сборки в файле пресета. Ничего рисовать не нужно.
 */

test("версия: кортеж читается и пишется обратно", () => {
  // Порядок слотов зафиксирован: релиз, ядро, формат, мост, оболочка.
  expect(versionString()).toBe(`0.1.${VERSION.core}.${PRESET_FORMAT}.${OVERLAY_PROTOCOL}.${VERSION.shell}`);
  expect(VERSION.format).toBe(PRESET_FORMAT);
  // Мост в версии и протокол оверлея — одно число, иначе они разъедутся.
  expect(VERSION.bridge).toBe(OVERLAY_PROTOCOL);

  const parsed = parseVersion(versionString());
  expect(parsed).toEqual(VERSION);
  // Строка с префиксом из интерфейса тоже годится.
  expect(parseVersion(`v${versionString()}`)).toEqual(VERSION);
  expect(parseVersion(`Версия ${versionString()}`)).toEqual(VERSION);
  // Мусор и неполный набор — не версия.
  for (const broken of ["", "0.1", "0.1.2.3.1", "0.1.2.3.1.1.1", "0.1.x.3.1.1", null, 42]) {
    expect(parseVersion(broken)).toBeNull();
  }
});

test("версия: слоты подписаны и объяснены", () => {
  for (const slot of VERSION_SLOTS) {
    expect(SLOT_LABEL[slot]).toBeTruthy();
    expect(VERSION[slot]).toBeGreaterThan(0);
  }
  const title = versionTitle();
  expect(title).toContain(versionString());
  expect(title).toContain("ядро");
  expect(title).toContain("формат");
  // В установщик уходят только три числа: поколения туда не помещаются.
  expect(packagingVersion()).toBe("0.1.0");
});

test("версия: файл новее сборки — это видно и названо по слоям", () => {
  // Своё же поколение — всё в порядке, предупреждения нет.
  expect(outdatedSlots(versionString())).toEqual([]);
  expect(outdatedMessage(versionString())).toBeNull();
  expect(outdatedMessage(undefined)).toBeNull();

  // Файл из будущего: ядро и формат больше наших.
  const future = `0.1.${VERSION.core + 1}.${PRESET_FORMAT + 1}.${VERSION.bridge}.${VERSION.shell}`;
  expect(outdatedSlots(future)).toEqual(["core", "format"]);
  const message = outdatedMessage(future)!;
  expect(message).toContain("более новой сборкой");
  expect(message).toContain("ядро");
  expect(message).toContain("формат");

  // Старший релиз сам по себе не мешает: данные те же, читаем спокойно.
  const newerRelease = `0.9.${VERSION.core}.${PRESET_FORMAT}.${VERSION.bridge}.${VERSION.shell}`;
  expect(outdatedSlots(newerRelease)).toEqual([]);

  // Мусор в поле версии — не повод ругаться.
  expect(outdatedMessage("не версия")).toBeNull();
});

test("версия: ядро сверяется отдельно от файла", () => {
  expect(coreState(VERSION.core)).toBe("ready");
  expect(coreMessage(VERSION.core)).toBeNull();
  // Ядра нет в ответе — оно старое и запроса версии не знает.
  expect(coreState(null)).toBe("older");
  expect(coreMessage(null)).toContain("пересоберите");
  expect(coreMessage(VERSION.core - 1)).toContain(`против ${VERSION.core}`);
  // Ядро новее редактора: работает, но часть возможностей не используется.
  expect(coreState(VERSION.core + 1)).toBe("newer");
  expect(coreMessage(VERSION.core + 1)).toContain("новее редактора");
});

test("версия: штамп сборки попадает в файл, но не в историю", () => {
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
  const loaded = normalizePreset(withBuildStamp(preset))!;
  expect(loaded.built).toBe(versionString());
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

  // Текущий формат читается как есть.
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
