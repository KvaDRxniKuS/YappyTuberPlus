import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * Раскладка «сцена + инспектор».
 *
 * Правило, которое здесь закреплено: **инспектор не отнимает у сцены место**.
 * Он живёт вкладкой в правой панели, а центр занят только превью — раньше
 * нижняя половина центра уходила под параметры объекта.
 *
 * Тест читает исходники и стили: браузерных прогонов в песочнице нет, а
 * проверять надо именно раскладку, а не поведение компонентов. Если кто-то
 * вернёт инспектор под сцену, тест это заметит сразу, а не на глаз через
 * неделю.
 */

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Фрагмент между двумя маркерами: так проверяется «что внутри main». */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from, `маркер «${start}» найден`).toBeGreaterThan(-1);
  expect(to, `маркер «${end}» найден`).toBeGreaterThan(from);
  return text.slice(from, to);
}

test("инспектор — вкладка правой панели, а не блок под сценой", () => {
  const app = read("src/App.tsx");
  const center = between(app, '<main className="center-workspace">', "</main>");
  // В центре только сцена: ни инспектора, ни сплиттера высоты.
  expect(center).toContain("<Scene");
  expect(center).not.toContain("<Inspector");
  expect(center).not.toContain("sceneHeight");
  // Инспектор передаётся в правую панель готовым элементом.
  expect(app).toContain("inspector={(");
});

test("вкладка «Параметры» стоит сразу после «Поведения»", () => {
  const panel = read("src/components/RightPanel.tsx");
  const behaviour = panel.indexOf('setTab("behaviour")');
  const parameters = panel.indexOf('setTab("parameters")');
  const inputs = panel.indexOf('setTab("inputs")');
  expect(behaviour).toBeGreaterThan(-1);
  expect(parameters).toBeGreaterThan(behaviour);
  expect(inputs).toBeGreaterThan(parameters);
  // Смена выделения не выбивает из параметров: объекты переключают подряд.
  expect(panel).toContain('current === "parameters"');
  // Вкладка показывает переданный инспектор и растягивает его на всю высоту.
  expect(panel).toContain('className="inspector-slot"');
  expect(panel).toContain("inspector?: ReactNode");
});

test("сцена занимает центр целиком, поле sceneHeight больше не используется", () => {
  const css = read("src/styles.css");
  expect(css).toContain(".center-workspace { min-width: 0; min-height: 0; display: flex;");
  expect(css).toContain(".center-workspace > .scene-panel { flex: 1 1 auto; }");
  expect(css).toContain(".inspector-slot > .inspector { flex: 1 1 auto; }");

  const app = read("src/App.tsx");
  // Клэмп и сплиттер высоты убраны: сцена не делится ни с кем.
  expect(app).not.toContain("limits.sceneHeight");
  expect(app).not.toContain('resize("sceneHeight"');
  expect(app).not.toContain("splitter-horizontal");
});

test("плашки-переключатели не растягиваются на всю панель", () => {
  // Отдельная строка — плашка по размеру кнопок. `.dense` остаётся только там,
  // где она стоит рядом с подписью в `.behaviour-state` (направление доворота).
  const light = read("src/components/LightSection.tsx");
  const overlay = light.slice(light.indexOf('<div className="segmented'));
  expect(light).toContain('className="segmented small inline" title="Обычное наложение');
  expect(overlay).toContain("inline");

  const behaviour = read("src/components/BehaviourPanel.tsx");
  expect(behaviour).toContain('className="segmented small inline" title="Форма волны мерцания"');
  const presetRule = between(behaviour, '<div className="preset-rule"', "preset-rule-head");
  expect(presetRule.length).toBeGreaterThan(0);
  expect(behaviour).toContain(`className="segmented small inline">
              <button
                className={rule.mode === "only" ? "active" : ""}`);
});
