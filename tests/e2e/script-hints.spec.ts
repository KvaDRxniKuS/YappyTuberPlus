import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scriptHints } from "../../src/engine/scripts";

/*
 * Подсказка про приоритет тернарного оператора.
 *
 * Ядро разбирает `inherit + flag ? a : b` как `(inherit + flag) ? a : b` — это
 * обычный приоритет, ошибки нет, но слагаемое молча уходит в условие. Подсказка
 * ловит именно эту форму и объясняет, что произошло. Проверяем и обратное: там,
 * где сумма честная (сравнение, скобки, знак числа), подсказки быть не должно.
 */

const cases: Array<{ name: string; source: string; hints: number }> = [
  {
    name: "строка из отчёта: inherit попал в условие",
    source: "x = inherit + vtuberstudio.face_found ? eyes_x_deg + follow(offset, parent).x : x_behaviour",
    hints: 1,
  },
  { name: "скобки вокруг ветки", source: "x = inherit + (vtuberstudio.face_found ? 40 : 5)", hints: 0 },
  { name: "сравнение в условии — сумма честная", source: "x = mic.a + mic.b > 0.5 ? 1 : 0", hints: 0 },
  { name: "минус перед вопросом", source: "x = a - b ? 1 : 2", hints: 1 },
  { name: "знак числа — не действие", source: "x = -1 ? 1 : 2", hints: 0 },
  { name: "строка не код", source: 'text = "a + b ? c : d"', hints: 0 },
  { name: "комментарий не код", source: "// a + b ? c : d\nx = 1", hints: 0 },
  { name: "условие уже в скобках", source: "x = (a + b) ? 1 : 2", hints: 0 },
  { name: "логика рядом — условие честное", source: "x = a + b and c ? 1 : 2", hints: 0 },
  { name: "суммы нет", source: "x = flag ? 1 : 2", hints: 0 },
  { name: "событие не считается", source: "x = 1\nevent click() { mouse.left.up }\non click {\n  x = 2\n}", hints: 0 },
];

test("подсказка: приоритет «?» ловится, намеренные условия — нет", () => {
  for (const item of cases) {
    expect(scriptHints(item.source).length, item.name).toBe(item.hints);
  }
});

test("подсказка: называет строку, знак и что делать", () => {
  const [hint] = scriptHints("x = 1\ny = inherit + flag ? 2 : 3");
  expect(hint.line).toBe(2);
  expect(hint.message).toContain("inherit + flag ? … : …");
  expect(hint.message).toContain("(inherit + flag) ? … : …");
  // Объяснение говорит про скобки: подсказка должна вести к правке, а не ругать.
  expect(hint.detail).toContain("оберните ветку в скобки");

  // Знак называется тот, что написан: «−», а не «+».
  const [minus] = scriptHints("x = a - b ? 1 : 2");
  expect(minus.message).toContain("«−» перед «?»");
});

test("подсказка: редактор показывает её строкой под текстом", () => {
  const root = process.cwd();
  const editor = readFileSync(join(root, "src", "components", "ScriptEditor.tsx"), "utf8");
  expect(editor).toContain("scriptHints");
  expect(editor).toContain('className="script-hint-line"');
  // Переход к строке: подсказка не просто текст, по ней ставят каретку.
  expect(editor).toContain("gotoLine(hints[0].line)");
  // Шпаргалка объясняет приоритет — до того, как человек наступит на него.
  expect(editor).toContain("связывает слабее «+»");

  const css = readFileSync(join(root, "src", "styles.css"), "utf8");
  expect(css).toContain(".script-hint-line {");
  expect(css).toContain(".script-hint-icon {");
});
