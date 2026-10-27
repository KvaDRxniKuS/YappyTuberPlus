import { expect, test } from "@playwright/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * Документация не должна отставать от файлов.
 *
 * Это не «тест текста», а дешёвый сторож: структура в README, список документов и
 * договорённости (колесо — целое, файлы сборки описаны) сверяются с тем, что
 * реально лежит в репозитории. Раньше такое расхождение находилось глазами через
 * несколько задач.
 */

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Все файлы в корне с этими расширениями. */
function rootFiles(extensions: string[]): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => entry.name);
}

function dirFiles(dir: string, extension: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => entry.name);
}

test("README: структура перечисляет все лаунчеры, скрипты и документы", () => {
  const readme = read("README.md");
  const structure = readme.slice(readme.indexOf("## Структура"), readme.indexOf("## Что ещё не входит"));

  // Двойные клики и скрипты сборки — каждый на виду.
  for (const name of rootFiles([".bat", ".sh"])) {
    expect(structure, `${name} описан в структуре`).toContain(name);
  }
  for (const name of dirFiles("scripts", ".mjs")) {
    expect(structure, `scripts/${name} описан в структуре`).toContain(name);
  }
  // Документы: каждый либо в дереве, либо в ссылках раздела. Планы этапов
  // перечислены диапазоном (`PLAN-0.2.md … PLAN-0.5.md`), чтобы дерево не росло.
  for (const name of dirFiles("docs", ".md")) {
    const mentioned = /^PLAN-\d+\.\d+\.md$/.test(name)
      ? structure.includes("PLAN-0.") && structure.includes("PLAN-0.5.md")
      : structure.includes(name) || readme.includes(`docs/${name}`);
    expect(mentioned, `docs/${name} упомянут`).toBe(true);
  }
});

test("README: всё, что перечислено в структуре, существует", () => {
  const readme = read("README.md");
  const structure = readme.slice(readme.indexOf("## Структура"), readme.indexOf("## Что ещё не входит"));
  // Имена файлов из дерева: `имя.ext` в начале строки-узла.
  const names = [...structure.matchAll(/[├└│─\s]([\w.-]+\.(?:md|bat|sh|mjs|ts|json|html|wasm))/g)]
    .map((match) => match[1]);
  expect(names.length).toBeGreaterThan(30);
  const missing = names.filter((name) => {
    const candidates = [
      name,
      join("scripts", name),
      join("docs", name),
      join("tests/e2e", name),
      join("src/engine", name),
      join("public", name),
      join("dist", name),
    ];
    return !candidates.some((path) => existsSync(join(root, path)));
  });
  expect(missing, "все пути из структуры существуют").toEqual([]);
});

test("документы не ссылаются на несуществующие файлы", () => {
  const docs = ["README.md", "CHANGELOG.md", ...dirFiles("docs", ".md").map((name) => join("docs", name))];
  const broken: string[] = [];
  for (const path of docs) {
    const text = read(path);
    for (const match of text.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
      const target = match[2].split("#")[0];
      if (!target || /^(https?:|mailto:)/.test(target)) continue;
      const full = join(root, relative(root, join(path, "..", target)));
      if (!existsSync(full)) broken.push(`${path} → ${target}`);
    }
  }
  expect(broken).toEqual([]);
});

test("модуль мыши в шаблоне и в документации говорит одно и то же", () => {
  const template = JSON.parse(read("public/modules/mouse.json"));
  const wheel = template.inputs.find((spec: { name: string }) => spec.name === "wheel");
  // Колесо — целые щелчки: шаг 1 и честный предел за кадр.
  expect(wheel.step).toBe(1);
  expect([wheel.min, wheel.max]).toEqual([-20, 20]);

  const modules = read("docs/MODULES.md");
  expect(modules).toContain("целые щелчки");
  expect(modules).toContain("−20…20");
  // Средняя кнопка есть и в шаблоне, и в сводной таблице документации.
  expect(template.inputs.some((spec: { name: string }) => spec.name === "middle")).toBe(true);
  expect(modules).toContain("`left`, `right`, `middle`");
});

test("документация описывает обновление и публикацию там, где их будут искать", () => {
  // Обновление: раздел в «истине» (DESIGN) и подробности в VERSIONS.
  expect(read("docs/DESIGN.md")).toContain("## 23. Обновление сборки");
  expect(read("docs/VERSIONS.md")).toContain("Автообновление есть");
  expect(read("docs/BUILD.md")).toContain("publish-build");
  expect(read("docs/LAUNCHER.md")).toContain("sync-repo.mjs");
  // Ключ пропуска версии описан там, где перечислены ключи localStorage.
  expect(read("docs/DATA.md")).toContain("yappytuberplus.update.skip");
  // Известные ограничения честно называют несобранный Rust.
  expect(read("CHANGELOG.md")).toContain("update_stage");
});
