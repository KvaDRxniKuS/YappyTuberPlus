import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  adoptTrackerProfile, forgetTrackerProfile, readTrackerProfile, sourceWithProfile,
  stripTrackerProfile, writeTrackerProfile,
} from "../../src/modules/trackerProfile";
import { readExternalSource } from "../../src/modules/external";
import { sourceConfig } from "../../src/modules/sources";
import { normalizeModules, normalizePreset } from "../../src/engine/preset";
import { stampPreset } from "../../src/engine/presetFile";
import { normalizeDefinition, registerDefinitions } from "../../src/modules/registry";
import { createDemoPreset } from "../../src/data/demoPreset";
import { FaceTrackerEditor } from "../../src/components/FaceTrackerEditor";
import type { ModuleInstance, RigPreset } from "../../src/types";

/**
 * Профиль приложения для трекера.
 *
 * Адрес телефона, порты и эталон позы описывают эту машину и этот телефон, а не
 * сцену: риг переносят на другой компьютер, а телефон остаётся в своей сети.
 * Поэтому они живут в профиле приложения, а в риге остаётся отображение — какие
 * поля и под какими именами модуль отдаёт.
 */

/** Модуль трекера в пресете: отображение и (по желанию) машинные настройки. */
function trackerModule(options: {
  host?: string;
  port?: number;
  listenPort?: number;
  calibration?: { at: number; offsets: Record<string, number> };
  mapping?: Array<{ input: string; path: string }>;
} = {}): ModuleInstance {
  return {
    name: "face",
    type: "ifacialmocap",
    enabled: true,
    source: "live",
    config: {
      source: {
        transport: "ifacialmocap",
        url: "",
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.port === undefined ? {} : { port: options.port }),
        ...(options.listenPort === undefined ? {} : { listenPort: options.listenPort }),
        ...(options.calibration === undefined ? {} : { calibration: options.calibration }),
        mapping: (options.mapping ?? [{ input: "jaw", path: "$.arkit.jawOpen" }]).map((rule) => ({
          input: rule.input, path: rule.path, min: 0, max: 1, holdMs: 0,
        })),
      },
    },
  } as unknown as ModuleInstance;
}

function presetWith(module: ModuleInstance): RigPreset {
  const preset = createDemoPreset();
  preset.modules = [module];
  return preset;
}

function sourceOf(preset: RigPreset): Record<string, unknown> {
  return ((preset.modules[0].config as Record<string, unknown>).source ?? {}) as Record<string, unknown>;
}

test.beforeEach(() => {
  forgetTrackerProfile();
});

test("профиль помнит адрес, порты и эталон по транспорту", () => {
  // Незаведённый профиль — умолчания шаблона, а не нули.
  expect(readTrackerProfile("ifacialmocap")).toEqual({
    host: "", port: 49_983, listenPort: 49_983, calibration: undefined,
  });
  writeTrackerProfile("ifacialmocap", {
    host: " 192.168.1.7 ",
    port: 50_000,
    listenPort: 50_001,
    calibration: { at: 7, offsets: { "head.rx": 12, "arkit.jawOpen": 0.4 } },
  });
  const saved = readTrackerProfile("ifacialmocap");
  expect(saved.host).toBe("192.168.1.7");
  expect(saved.port).toBe(50_000);
  expect(saved.listenPort).toBe(50_001);
  // В эталон попадают только голова и глаза — правило то же, что у пресета.
  expect(saved.calibration?.offsets).toEqual({ "head.rx": 12 });
  // Соседний транспорт не задет: у каждого приложения свой телефон.
  expect(readTrackerProfile("vtuberstudio").host).toBe("");
  expect(readTrackerProfile("vtuberstudio").port).toBe(21_412);
  // Порт вне диапазона — снова умолчание, а не битая настройка.
  writeTrackerProfile("ifacialmocap", { port: 0 });
  expect(readTrackerProfile("ifacialmocap").port).toBe(49_983);
  // Сброс эталона: явный `undefined` стирает запись.
  writeTrackerProfile("ifacialmocap", { calibration: undefined });
  expect(readTrackerProfile("ifacialmocap").calibration).toBeUndefined();
  forgetTrackerProfile("ifacialmocap");
  expect(readTrackerProfile("ifacialmocap").host).toBe("");
});

test("профиль главнее рига, но пустой профиль ничего не стирает", () => {
  const legacy = readExternalSource({
    source: {
      transport: "ifacialmocap",
      mapping: [],
      host: "10.0.0.2",
      port: 49_990,
      calibration: { at: 5, offsets: { "head.rx": 3 } },
    },
  });
  // Профиля ещё нет: старый риг с адресом внутри работает как раньше.
  expect(sourceWithProfile(legacy).host).toBe("10.0.0.2");
  expect(sourceWithProfile(legacy).port).toBe(49_990);
  expect(sourceWithProfile(legacy).calibration?.offsets).toEqual({ "head.rx": 3 });
  // Профиль задан — его адрес главнее, а незаписанное берётся из рига.
  writeTrackerProfile("ifacialmocap", { host: "192.168.1.9" });
  const merged = sourceWithProfile(legacy);
  expect(merged.host).toBe("192.168.1.9");
  expect(merged.port).toBe(49_990);
  expect(merged.listenPort).toBe(49_983);
  expect(merged.calibration?.offsets).toEqual({ "head.rx": 3 });
  // Не трекер — профиль не при чём.
  const osc = readExternalSource({ source: { transport: "osc", url: "udp://0.0.0.0:9000", mapping: [] } });
  expect(sourceWithProfile(osc)).toEqual(osc);
});

test("приёмник берёт адрес из профиля, а отображение — из рига", () => {
  writeTrackerProfile("ifacialmocap", { host: "192.168.1.44", port: 49_983, listenPort: 49_984 });
  const config = sourceConfig(trackerModule({ mapping: [{ input: "jaw", path: "$.arkit.jawOpen" }] }));
  // Это ровно то, что уходит в Rust (`source_start`): без адреса из профиля
  // приёмник искал бы телефон широковещательно при каждом запуске.
  expect(config.host).toBe("192.168.1.44");
  expect(config.listenPort).toBe(49_984);
  expect(config.mapping.map((rule) => rule.path)).toEqual(["$.arkit.jawOpen"]);
});

test("в файле рига нет адреса, портов и эталона, отображение на месте", () => {
  const preset = presetWith(trackerModule({
    host: "192.168.1.7",
    port: 49_983,
    listenPort: 49_983,
    calibration: { at: 7, offsets: { "head.rx": 12 } },
    mapping: [{ input: "jaw", path: "$.arkit.jawOpen" }, { input: "head_rx", path: "$.head.rx" }],
  }));
  const stamped = JSON.parse(JSON.stringify(stampPreset(preset))) as RigPreset;
  const source = sourceOf(stamped);
  // Машинные настройки не уезжают вместе с ригом.
  expect(source.host).toBeUndefined();
  expect(source.port).toBeUndefined();
  expect(source.listenPort).toBeUndefined();
  expect(source.calibration).toBeUndefined();
  // А отображение — часть сцены, оно остаётся.
  expect((source.mapping as unknown[]).length).toBe(2);
  expect(JSON.stringify(stamped)).not.toContain("192.168.1.7");
  // Запись не портит исходный пресет: редактор продолжает работать с ним.
  expect(sourceOf(preset).host).toBe("192.168.1.7");
});

test("старое автосохранение переезжает в профиль один раз", () => {
  const adopted = adoptTrackerProfile(presetWith(trackerModule({
    host: "192.168.1.7",
    port: 49_990,
    calibration: { at: 7, offsets: { "head.rx": 12 } },
  })));
  // Из пресета настройки ушли…
  expect(sourceOf(adopted).host).toBeUndefined();
  expect(sourceOf(adopted).calibration).toBeUndefined();
  // …и оказались в профиле: адрес не приходится искать заново.
  expect(readTrackerProfile("ifacialmocap").host).toBe("192.168.1.7");
  expect(readTrackerProfile("ifacialmocap").port).toBe(49_990);
  expect(readTrackerProfile("ifacialmocap").calibration?.offsets).toEqual({ "head.rx": 12 });
  // Профиль уже заведён — адрес из другого пресета его не перебивает.
  const other = adoptTrackerProfile(presetWith(trackerModule({ host: "10.0.0.9" })));
  expect(readTrackerProfile("ifacialmocap").host).toBe("192.168.1.7");
  expect(sourceOf(other).host).toBeUndefined();
});

test("перезапуск: отображение трекера не пустеет ни до, ни после чтения папки modules", () => {
  const module = trackerModule({
    host: "192.168.1.7",
    mapping: [{ input: "jaw", path: "$.arkit.jawOpen" }, { input: "head_rx", path: "$.head.rx" }],
  });
  // Автосохранение пишется без машинных настроек — читаем ровно этот текст.
  const saved = JSON.stringify(stripTrackerProfile(presetWith(module)));
  // 1. Старт приложения: папка modules ещё не прочитана, шаблон неизвестен.
  const loaded = normalizePreset(JSON.parse(saved));
  expect(loaded).not.toBeNull();
  expect(readExternalSource(loaded!.modules[0].config as Record<string, unknown>).mapping.length).toBe(2);
  // 2. Папка прочитана — App прогоняет модули второй раз по известному шаблону.
  const directory = join(process.cwd(), "public", "modules");
  const index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")) as { modules: string[] };
  registerDefinitions(index.modules
    .map((id) => normalizeDefinition(JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"))))
    .filter((definition): definition is NonNullable<typeof definition> => definition !== null));
  const after = normalizeModules(loaded!.modules);
  const restored = readExternalSource(after[0].config as Record<string, unknown>);
  expect(restored.mapping.map((rule) => rule.input)).toEqual(["jaw", "head_rx"]);
  expect(restored.mapping.map((rule) => rule.path)).toEqual(["$.arkit.jawOpen", "$.head.rx"]);
});

test("карточка трекера показывает адрес из профиля и говорит, где он живёт", () => {
  writeTrackerProfile("ifacialmocap", { host: "192.168.1.55" });
  const html = renderToStaticMarkup(createElement(FaceTrackerEditor, {
    module: trackerModule(),
    transport: "ifacialmocap",
    status: { state: "live", message: null, packets: 10, rate: 60 } as never,
    preview: { "head.rx": 1 },
    logs: [],
    onChange: () => undefined,
  }));
  expect(html).toContain("192.168.1.55");
  // Подсказка объясняет, почему адреса нет в риге.
  expect(html).toContain("профиле приложения");
  // Порты тоже приходят из профиля — умолчания шаблона видны в полях.
  expect(html).toContain("49");
});

test("правка карточки пишет машинные настройки в профиль, а отображение — в пресет", () => {
  const editor = readFileSync(join(process.cwd(), "src", "components", "FaceTrackerEditor.tsx"), "utf8");
  expect(editor).toContain("sourceWithProfile");
  expect(editor).toContain("writeTrackerProfile");
  // Профиль обновляется до того, как правка уходит в пресет.
  expect(editor.indexOf("writeTrackerProfile(props.transport")).toBeLessThan(editor.indexOf("props.onChange(next, label)"));
  const app = readFileSync(join(process.cwd(), "src", "App.tsx"), "utf8");
  expect(app).toContain("adoptTrackerProfile");
  expect(app).toContain("JSON.stringify(stripTrackerProfile(preset))");
});
