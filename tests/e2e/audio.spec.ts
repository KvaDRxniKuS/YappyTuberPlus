import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { smoothingAlpha } from "../../src/modules/audio";
import { moduleDefaults, moduleDefinition, normalizeDefinition, registerDefinitions } from "../../src/modules/registry";

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
