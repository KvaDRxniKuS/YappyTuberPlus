import { test, expect } from "@playwright/test";
import { IncompatiblePresetError, presetCompatibility } from "../../src/engine/presetCheck";
import { parsePreset } from "../../src/engine/presetFile";
import { DEFAULT_BASE, type RigPreset } from "../../src/types";
import { PRESET_FORMAT, VERSION, versionString } from "../../src/version";

/*
 * Открытие «чужого» пресета: вместо молчаливого отказа редактор объясняет, чем
 * версии не сошлись и что именно может не работать. Отдельного режима «только
 * для чтения» нет.
 */

function file(options: {
  version?: number;
  built?: string;
  needs?: number;
  kind?: string;
  script?: string;
} = {}) {
  return {
    version: options.version ?? PRESET_FORMAT,
    ...(options.built ? { built: options.built } : {}),
    ...(options.needs !== undefined ? { needs: options.needs } : {}),
    name: "Чужая сцена",
    canvas: { width: 1000, height: 600 },
    objects: [{
      id: "body", name: "Тело", kind: options.kind ?? "sprite", enabled: true, image: null,
      parentId: null, pivot: { x: 0.5, y: 0.5 }, base: { ...DEFAULT_BASE },
      script: options.script ?? "", width: 100, height: 100,
    }],
    globals: "",
    runtime: { fpsMode: "limited", fpsLimit: 60 },
    overlay: {},
    modules: [],
  };
}

/** Заголовки и объяснения одним текстом: важны оба. */
function labels(report: { issues: Array<{ label: string; detail: string }> }): string {
  return report.issues.map((issue) => `${issue.label}: ${issue.detail}`).join(" | ");
}

test("совместимость: файл новее — объясняем, что не сойдётся", () => {
  const future = file({ version: PRESET_FORMAT + 1, built: `1.0.${VERSION.core}.${PRESET_FORMAT + 1}.1.1.1` });
  const report = presetCompatibility(future);
  expect(report.canOpen).toBe(false);
  expect(report.fileVersion).toBe(`1.0.${VERSION.core}.${PRESET_FORMAT + 1}.1.1.1`);
  expect(labels(report)).toContain(`формат файла ${PRESET_FORMAT + 1}`);
  // Каждый пункт объясняет последствие, а не просто констатирует версию.
  for (const issue of report.issues) expect(issue.detail.length).toBeGreaterThan(20);

  // Тот же отказ приходит из файлового пути и несёт готовый отчёт.
  expect(() => parsePreset(JSON.stringify(future))).toThrow(IncompatiblePresetError);
  try {
    parsePreset(JSON.stringify(future));
  } catch (reason) {
    const error = reason as IncompatiblePresetError;
    expect(error.report.canOpen).toBe(false);
    expect(error.message).toContain("Версии несовместимы");
  }
});

test("совместимость: старый формат открывается без жалоб", () => {
  const old = file({ version: 2 });
  const report = presetCompatibility(old);
  expect(report.canOpen).toBe(true);
  expect(report.issues).toEqual([]);
  // Через файловый путь он тоже читается: миграция на месте.
  const parsed = parsePreset(JSON.stringify(old)) as RigPreset;
  expect(parsed.version).toBe(PRESET_FORMAT);
});

test("совместимость: файл записан более новым ядром — отдельный пункт", () => {
  // Требование по содержимому считается по сцене, а не по числу из файла:
  // иначе удалённая фигура продолжала бы требовать ядро 20 до сохранения.
  const ahead = file({ needs: VERSION.core + 4 });
  const report = presetCompatibility(ahead);
  // Файл открывается: данные читаются, речь о том, что он новее.
  expect(report.canOpen).toBe(true);
  expect(labels(report)).toContain(`файл записан сборкой с ядром ${VERSION.core + 4}`);
  expect(report.issues[0].detail).toContain("более новой сборкой");

  // Пустая сцена ничего не просит: своего требования у неё нет.
  expect(labels(report)).not.toContain(`сцене нужно ядро ${VERSION.core + 4}`);
});

test("совместимость: незнакомый вид объекта и убранные формы", () => {
  const unknown = presetCompatibility(file({ kind: "hologram" }));
  expect(labels(unknown)).toContain("незнакомый вид объекта");
  expect(labels(unknown)).toContain("hologram");
  // Формат совпадает — файл откроется, но предупредить есть о чём.
  expect(unknown.canOpen).toBe(true);

  const removed = presetCompatibility(file({ script: "on mic.talking.hold(0.2) { x = 1 }" }));
  expect(labels(removed)).toContain("убранные формы");
});

test("совместимость: остальные слои видны по штампу сборки", () => {
  const newer = file({
    built: `1.0.${VERSION.core}.${PRESET_FORMAT}.${VERSION.bridge + 1}.${VERSION.modules + 1}.${VERSION.shell + 1}`,
  });
  const report = presetCompatibility(newer);
  expect(labels(report)).toContain("мост");
  expect(labels(report)).toContain("модули");
  expect(labels(report)).toContain("оболочка");
  // Формат тот же, значит открыть можно — но человек увидит, что может отвалиться.
  expect(report.canOpen).toBe(true);
  expect(report.fileLabel).toContain("ядро");
});

test("совместимость: не пресет и не JSON", () => {
  expect(labels(presetCompatibility(null))).toContain("не пресет");
  expect(() => parsePreset("{ не json")).toThrow(/не JSON/);
  // Штамп текущей сборки ничего не ломает.
  expect(presetCompatibility(file({ built: versionString() })).issues).toEqual([]);
});
