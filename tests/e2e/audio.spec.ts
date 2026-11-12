import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deviceChoice, smoothingAlpha } from "../../src/modules/audio";
import { moduleDefaults, moduleDefinition, normalizeDefinition, registerDefinitions } from "../../src/modules/registry";
import { normalizePreset } from "../../src/engine/preset";
import { PRESET_FORMAT } from "../../src/version";

test.beforeAll(() => {
  const directory = join(process.cwd(), "public", "modules");
  const index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")) as { modules: string[] };
  const definitions = index.modules
    .map((id) => normalizeDefinition(JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"))))
    .filter((definition) => definition !== null);
  registerDefinitions(definitions);
});

test("сглаживание speak задаётся в миллисекундах и не зависит от частоты таймера", () => {
  // Постоянная времени: за 70 мс проходим 63 % пути.
  expect(smoothingAlpha(0.07, 70)).toBeCloseTo(1 - Math.exp(-1), 6);
  // Два шага по 35 мс дают тот же результат, что один шаг 70 мс.
  const twoSteps = 1 - (1 - smoothingAlpha(0.035, 70)) ** 2;
  expect(twoSteps).toBeCloseTo(smoothingAlpha(0.07, 70), 6);
  // «0 мс» — мгновенная реакция, «0 с» — не двигаемся.
  expect(smoothingAlpha(0.04, 0)).toBe(1);
  expect(smoothingAlpha(0, 70)).toBe(0);
  // Атака быстрее спада.
  expect(smoothingAlpha(0.04, 70)).toBeGreaterThan(smoothingAlpha(0.04, 220));
});

test("у Loudness настраиваются атака и спад, speak и пик не одно и то же", () => {
  const definition = moduleDefinition("loudness");
  expect(definition.fields.map((field) => field.key)).toContain("attack");
  expect(definition.fields.map((field) => field.key)).toContain("release");
  const config = moduleDefaults(definition);
  expect(config.attack).toBe(70);
  expect(config.release).toBe(220);
  // speak — RMS со сглаживанием, loudness — мгновенный пик: это разные входы.
  const speak = definition.inputs.find((input) => input.name === "speak");
  const loudness = definition.inputs.find((input) => input.name === "loudness");
  expect(speak?.hint).toMatch(/сглаж/i);
  expect(loudness?.label).toMatch(/пик/i);
  expect(loudness?.hint).toMatch(/без сглаживания/i);
});

test("выбор микрофона не подменяется на «системный», если устройства пока нет в списке", () => {
  // Идентификатор лежит в пресете, а список устройств приходит из системы. До
  // первого разрешения у устройств пустые идентификаторы и подписи, поэтому
  // сохранённого микрофона в списке нет. Раньше <select> в этом случае молча
  // показывал первый пункт — и выбор выглядел потерянным после каждого запуска.
  const devices = [{ id: "mic-a", label: "Микрофон" }, { id: "mic-b", label: "Гарнитура" }];
  expect(deviceChoice(devices, "mic-b")).toEqual({ value: "mic-b", missing: false });
  // Пустое значение — это осознанный «системный по умолчанию».
  expect(deviceChoice(devices, "")).toEqual({ value: "default", missing: false });
  expect(deviceChoice(devices, undefined)).toEqual({ value: "default", missing: false });
  // Устройства нет в списке: пункт остаётся своим, но помечается «не найден».
  expect(deviceChoice(devices, "mic-old")).toEqual({ value: "mic-old", missing: true });
});

test("микрофон из пресета переживает сохранение и загрузку", () => {
  const preset = normalizePreset({
    version: PRESET_FORMAT,
    name: "сцена",
    canvas: { width: 1000, height: 600 },
    objects: [],
    modules: [{
      name: "Голос",
      type: "loudness",
      enabled: true,
      source: "live",
      config: { deviceId: "mic-b", gain: 1.2, processing: true },
    }],
  });
  expect(preset).not.toBeNull();
  const module = preset!.modules[0];
  // Идентификатор — часть настроек модуля: без него микрофон каждый запуск
  // оказывался «системным по умолчанию».
  expect(module.config.deviceId).toBe("mic-b");
  expect(module.config.gain).toBe(1.2);
  expect(module.config.processing).toBe(true);
});

test("системный микрофон переключается вслед за системой, а не остаётся прежним", () => {
  const audio = readFileSync(join(process.cwd(), "src", "modules", "audio.ts"), "utf8");
  // «По умолчанию» — пустой deviceId: только тогда getUserMedia берёт текущий.
  expect(audio).toContain("function streamConstraints");
  expect(audio).toContain('streamKey === "default" ? {} : { deviceId: { exact: streamKey } }');
  // Переоткрытие захвата по событию смены устройств: поток сам за системой не ходит.
  expect(audio).toContain("async followDefault()");
  expect(audio).toContain("item.source.disconnect(item.analyser)");
  expect(audio).toContain("source.connect(item.analyser)");
  // Тот же микрофон (в системе добавилось устройство) — соединение не трогаем.
  expect(audio).toContain("previousId === nextId");
  const hook = readFileSync(join(process.cwd(), "src", "hooks", "useModuleInputs.ts"), "utf8");
  expect(hook).toContain('"devicechange"');
  expect(hook).toContain("engine().followDefault()");
});
