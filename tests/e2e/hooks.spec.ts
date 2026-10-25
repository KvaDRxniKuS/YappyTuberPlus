import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Хуки не должны стоять после раннего `return`.
 *
 * Если компонент в одном рендере вызывает пять хуков, а в другом (когда выделение
 * снято и рисуется заглушка «Выберите объект») — три, React падает с «Rendered
 * fewer hooks than expected» и размонтирует всё дерево: окно приложения пустеет.
 * Такое не ловится тестами движка и не видно в типах, поэтому проверяем сам
 * исходник: в теле компонента после `return` на верхнем уровне хуков быть не может.
 */

const COMPONENT = /^(?:export\s+)?(?:default\s+)?(?:function\s+([A-Z]\w*)|const\s+([A-Z]\w*)\s*=\s*(?:\([^)]*\)|\w+)\s*=>\s*\{)/;
const HOOK = /\buse[A-Z]\w*\s*(?:<[^>]*>)?\(/;
const RETURN_TOP = /^ {2}(?:if\s*\(.*\)\s*)?return\b/;
const RETURN_BLOCK = /^ {4}(?:if\s*\(.*\)\s*)?return\b/;
const IF_BLOCK = /^ {2}if\s*\(.*\)\s*\{\s*$/;
const BLOCK_CLOSE = /^ {2}\}\s*$/;
const DECLARATION = /^ {2}(?:const|let|var)\b/;

interface Violation {
  file: string;
  component: string;
  line: number;
  hook: string;
  returnLine: number;
}

export function scanSource(file: string, source: string): Violation[] {
  const violations: Violation[] = [];
  let component: string | null = null;
  let earlyReturn: number | null = null;
  let ifBlock: number | null = null;

  source.split("\n").forEach((text, index) => {
    const line = index + 1;
    const start = COMPONENT.exec(text);
    if (start) {
      component = start[1] || start[2];
      earlyReturn = null;
      ifBlock = null;
      return;
    }
    if (text.startsWith("}")) {
      component = null;
      earlyReturn = null;
      ifBlock = null;
      return;
    }
    if (!component) return;
    if (BLOCK_CLOSE.test(text)) { ifBlock = null; return; }
    if (!earlyReturn && IF_BLOCK.test(text)) { ifBlock = line; return; }
    if (!earlyReturn && RETURN_TOP.test(text)) { earlyReturn = line; return; }
    // `if (...) {` на верхнем уровне с возвратом внутри — тоже ранний выход:
    // дальше идут хуки, и число хуков между рендерами уже разное.
    if (!earlyReturn && ifBlock && RETURN_BLOCK.test(text)) { earlyReturn = line; return; }
    if (earlyReturn && DECLARATION.test(text) && HOOK.test(text)) {
      violations.push({ file, component, line, hook: text.trim(), returnLine: earlyReturn });
    }
  });

  return violations;
}

function componentFiles(): string[] {
  const files = ["src/App.tsx"];
  const dir = join(process.cwd(), "src", "components");
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".tsx")) files.push(join("src", "components", name));
  }
  return files;
}

test("в компонентах нет хуков после раннего return — иначе пустеет всё окно", () => {
  const violations = componentFiles().flatMap((file) => scanSource(file, readFileSync(file, "utf8")));
  const report = violations
    .map((item) => `${item.file}:${item.line} — ${item.hook} после return в строке ${item.returnLine} (${item.component})`)
    .join("\n");
  expect(report).toBe("");
});

test("проверка ловит хук после раннего выхода", () => {
  // Именно этот дефект опустошал окно: `useRef` стоял после заглушки инспектора.
  const broken = [
    "export function Sample(props: { object: object | null }) {",
    "  const preview = useAssetUrl(props.object);",
    "  if (!props.object) {",
    "    return <section className=\"inspector empty-state\" />;",
    "  }",
    "  const imageFit = useRef(false);",
    "  return <div>{preview}{imageFit.current}</div>;",
    "}",
  ].join("\n");
  const violations = scanSource("sample.tsx", broken);
  expect(violations).toHaveLength(1);
  expect(violations[0].line).toBe(6);
  expect(violations[0].returnLine).toBe(4);

  const fixed = [
    "export function Sample(props: { object: object | null }) {",
    "  const preview = useAssetUrl(props.object);",
    "  const imageFit = useRef(false);",
    "  if (!props.object) return <section className=\"inspector empty-state\" />;",
    "  return <div>{preview}{imageFit.current}</div>;",
    "}",
  ].join("\n");
  expect(scanSource("sample.tsx", fixed)).toEqual([]);

  // Однострочный ранний выход тоже закрывает дорогу хукам.
  const inlineBroken = [
    "export function Sample(props: { object: object | null }) {",
    "  const preview = useAssetUrl(props.object);",
    "  if (props.object === null) return null;",
    "  const imageFit = useRef(false);",
    "  return <div>{preview}{imageFit.current}</div>;",
    "}",
  ].join("\n");
  expect(scanSource("sample.tsx", inlineBroken)).toHaveLength(1);
});
