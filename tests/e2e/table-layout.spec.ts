import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeDefinition, moduleDefinition, registerDefinitions } from "../../src/modules/registry";
import { tableMinWidth, tableTemplate, type TableColumn } from "../../src/components/tableLayout";

/**
 * Таблица настроек модуля при сужении панели.
 *
 * Требование: поля не уезжают за край экрана. Прокрутка появляется **внутри
 * блока таблицы**, а минимальные ширины колонок задаёт разработчик модуля в
 * шаблоне `editor.columns` — у названия строки и у одного числа они разные.
 */

const MAPPING: TableColumn[] = [
  { key: "input", width: 62, grow: 1 },
  { key: "path", width: 104, grow: 1.6 },
  { key: "label", width: 64, grow: 1 },
  { key: "min", width: 42 },
  { key: "max", width: 42 },
  { key: "duration", width: 96 },
  { key: "action", width: 26 },
];

test.beforeAll(() => {
  const directory = join(process.cwd(), "public", "modules");
  const index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8")) as { modules: string[] };
  const definitions = index.modules
    .map((id) => normalizeDefinition(JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"))))
    .filter((definition) => definition !== null);
  registerDefinitions(definitions);
});

test("ширины по умолчанию: тянущиеся колонки не уже своего минимума", () => {
  expect(tableTemplate(MAPPING)).toBe(
    "minmax(62px, 1fr) minmax(104px, 1.6fr) minmax(64px, 1fr) 42px 42px 96px 26px",
  );
});

test("шаблон модуля меняет минимум колонки, но не ломает раскладку", () => {
  const twitch = moduleDefinition("twitch");
  const columns = twitch.editor?.columns ?? {};
  // У Twitch поле JSON длинное: 172 px вместо 104.
  expect(columns.path).toBe(172);
  const template = tableTemplate(MAPPING, columns);
  expect(template).toContain("minmax(172px, 1.6fr)");
  expect(template).toContain("minmax(84px, 1fr)");
  // Числовым колонкам шаблон ширину не менял — они остались фиксированными.
  expect(template).toContain(" 42px 42px ");
});

test("минимальная ширина таблицы считается по колонкам и не меньше minWidth", () => {
  const plain = tableMinWidth(MAPPING, {}, 4);
  const sum = 62 + 104 + 64 + 42 + 42 + 96 + 26 + 7 * 4;
  expect(plain).toBe(sum);
  // Шаблон может только увеличить минимум.
  expect(tableMinWidth(MAPPING, {}, 4, 600)).toBe(600);
  expect(tableMinWidth(MAPPING, {}, 4, 100)).toBe(sum);
  const twitch = tableMinWidth(MAPPING, moduleDefinition("twitch").editor?.columns ?? {}, 4);
  expect(twitch).toBeGreaterThan(plain);
});

test("мусор в шаблоне не превращает колонку в нечитаемую", () => {
  const definition = normalizeDefinition({
    id: "teste", title: "Тест", kind: "external", inputs: [], fields: [],
    editor: { minWidth: 10, columns: { input: 12, path: 200, label: "много", min: null } },
    defaults: {},
  });
  expect(definition?.editor?.minWidth).toBe(120);
  // Слишком узкая колонка отбрасывается: остаётся ширина по умолчанию.
  expect(definition?.editor?.columns).toEqual({ path: 200 });
  // Модуль без блока `editor` живёт на умолчаниях.
  expect(normalizeDefinition({ id: "plain", kind: "manual", inputs: [], fields: [], defaults: {} })?.editor)
    .toBeUndefined();
});

test("прокрутка живёт в блоке таблицы, а не во вкладке", () => {
  const css = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");
  // Вкладка скроллится только вертикально — иначе поля уезжают за край.
  expect(css).toMatch(/\.modules-panel,\s*\n\.inputs-panel \{[^}]*overflow-y: auto; overflow-x: hidden;/);
  // У самой таблицы своя горизонтальная прокрутка.
  expect(css).toMatch(/\.external-mapping-scroll \{[^}]*overflow-x: auto;/);
  // Кнопка удаления прижата к правому краю прокрутки.
  expect(css).toMatch(/\.external-mapping-row \.row-action \{[^}]*position: sticky; right: 0;/);
});
