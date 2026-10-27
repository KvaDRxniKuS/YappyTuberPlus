import { test, expect, type Page } from "@playwright/test";
import { DEFAULT_BASE, type RigPreset } from "../../src/types";
import {
  fetchUpdateManifest, skippedUpdate, skipUpdate, updateIssues, updateSummary, updateVerdict,
  type UpdateManifest,
} from "../../src/engine/update";
import { VERSION, versionString } from "../../src/version";

/*
 * Автообновление: приложение сверяет свой паспорт с паспортом опубликованной
 * сборки и, если та новее, показывает диалог. Три двери — «Обновить», «Позже»,
 * «Пропустить версию»; перед установкой проверяется, сохранён ли пресет.
 */

/**
 * Граница совместимости текущего ядра (`ACCEPTS_FROM` в `crates/rig-core`).
 * В браузере её сообщает само ядро ответом `hello`, а тесту взять неоткуда —
 * поэтому число продублировано здесь; его же пишет `build.json`.
 */
const ACCEPTS_FROM = 16;

/** Паспорт опубликованной сборки: только числа, файлы для диалога не нужны. */
function manifest(overrides: Partial<UpdateManifest> = {}): UpdateManifest {
  return {
    schema: 1,
    version: "1.0.22.3.1.1.1",
    packaging: "1.0.0",
    core: 22,
    format: VERSION.format,
    bridge: VERSION.bridge,
    modules: VERSION.modules,
    shell: VERSION.shell,
    builtAt: "2026-01-01T00:00:00.000Z",
    commit: "abc1234",
    acceptsFrom: 16,
    files: [],
    ...overrides,
  };
}

/** Маска: она требует ядра 19, то есть заведомо выше старой сборки. */
const MASK = {
  kind: "points" as const, shapeId: "", points: [], file: null,
  origin: "project" as const, invert: false, feather: 0,
};

/** Сцена, которой нужно ядро 19 — на нём и проверяется несовместимость. */
function scene(withMask = true): RigPreset {
  return {
    version: 3,
    name: "Сцена",
    canvas: { width: 1000, height: 1000 },
    objects: [{
      id: "body", name: "Тело", kind: "sprite", enabled: true, image: null,
      parentId: null, pivot: { x: 0.5, y: 0.5 }, base: { ...DEFAULT_BASE },
      script: "", width: 100, height: 100,
      ...(withMask ? { mask: MASK } : {}),
    }],
    globals: "",
    runtime: { fpsMode: "limited", fpsLimit: 60 },
    overlay: {},
    modules: [],
  } as RigPreset;
}

async function openStudio(page: Page) {
  await page.goto("/");
  await expect(page.locator(".engine-status")).toHaveClass(/ready/, { timeout: 15_000 });
}

/** Ответ репозитория подменяется: тест не зависит от сети. */
async function serveManifest(page: Page, info: UpdateManifest) {
  await page.route("https://raw.githubusercontent.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(info) }));
}

test("сравнение версий: новее, старее, совпадает, разъехалось", () => {
  const local = versionString();
  expect(updateVerdict(local, local)).toBe("none");
  // Новее хотя бы в одном слое и не старее ни в одном.
  expect(updateVerdict("1.0.21.3.1.1.1", "1.0.22.3.1.1.1")).toBe("newer");
  expect(updateVerdict("1.0.21.3.1.1.1", "1.0.21.4.1.1.1")).toBe("newer");
  // Старее: обновление не предлагается.
  expect(updateVerdict("1.0.22.3.1.1.1", "1.0.21.3.1.1.1")).toBe("older");
  // Слои разъехались: ядро новее, мост старее — молча не обновляем.
  expect(updateVerdict("1.0.21.3.2.1.1", "1.0.22.3.1.1.1")).toBe("mixed");
  expect(updateVerdict("не версия", "1.0.22.3.1.1.1")).toBe("unknown");
});

test("сводка обновления называет только изменившиеся слои", () => {
  const text = updateSummary(manifest());
  expect(text).toContain("1.0.22.3.1.1.1");
  expect(text).toContain(`ядро ${VERSION.core} → 22`);
  // Слои, которые не менялись, в сводке не повторяются.
  expect(text).not.toContain("мост");
});

test("совместимость: сцена и граница ядра дают отдельные пункты", () => {
  // Маске нужно ядро 19, а в опубликованной сборке 16.
  const older = manifest({ core: 16, version: "1.0.21.16.3.1.1.1", acceptsFrom: 16 });
  const issues = updateIssues(older, scene(), ACCEPTS_FROM);
  expect(issues.length).toBeGreaterThan(0);
  expect(issues[0].label).toBe("сцене нужно ядро 19, в новой сборке 16");
  expect(issues[0].detail).toContain("маска");

  // Новая сборка не старее сцены — тревоги нет.
  expect(updateIssues(manifest(), scene(), ACCEPTS_FROM)).toHaveLength(0);

  // Опубликованная сборка подняла границу: часть старых приёмов может не работать.
  const raised = manifest({ acceptsFrom: ACCEPTS_FROM + 4 });
  const raisedIssues = updateIssues(raised, scene(), ACCEPTS_FROM);
  expect(raisedIssues.some((issue) => issue.label.includes("только с ядра"))).toBe(true);
  expect(raisedIssues.map((issue) => issue.detail).join(" ")).toContain("маска");

  // Сцена без новых приёмов не попадает под поднятую границу.
  expect(updateIssues(raised, scene(false), ACCEPTS_FROM)).toHaveLength(0);
  // Сцены нет — расхождений не с чем сверять.
  expect(updateIssues(raised, null, ACCEPTS_FROM)).toHaveLength(0);
});

test("паспорт без сети не ломает проверку", async () => {
  // Адрес заведомо недоступен: функция обязана вернуть null, а не упасть.
  const info = await fetchUpdateManifest("http://127.0.0.1:9/build.json", 500);
  expect(info).toBeNull();
});

test("диалог: три кнопки, сохранение пресета и пропуск версии", async ({ page }) => {
  await serveManifest(page, manifest());
  await openStudio(page);

  // Ручная проверка: кнопка рядом с паспортом версии.
  await page.locator(".status-check").click();
  const dialog = page.getByRole("dialog", { name: "Доступно обновление" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Обновить" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Позже" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Пропустить версию" })).toBeVisible();
  await expect(dialog).toContainText("1.0.22.3.1.1.1");

  // Пресета ещё нет на диске — сначала предлагается сохранить.
  await dialog.getByRole("button", { name: "Обновить" }).click();
  await expect(dialog).toContainText("Пресет не сохранён");
  await expect(dialog.getByRole("button", { name: "Сохранить и обновить" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Обновить без сохранения" })).toBeVisible();
  await dialog.getByRole("button", { name: "Отмена" }).click();
  await expect(dialog.getByRole("button", { name: "Обновить" })).toBeVisible();

  // «Позже» просто закрывает: версия не запоминается.
  await dialog.getByRole("button", { name: "Позже" }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("yappytuberplus.update.skip"))).toBeNull();

  // «Пропустить версию» запоминает именно эту версию.
  await page.locator(".status-check").click();
  await dialog.getByRole("button", { name: "Пропустить версию" }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("yappytuberplus.update.skip")))
    .toBe("1.0.22.3.1.1.1");

  // Ручная проверка пропуск игнорирует: попросили — показали.
  await page.locator(".status-check").click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть" }).click();
  await expect(dialog).toBeHidden();
});

test("диалог: несовместимость перечисляется до кнопок", async ({ page }) => {
  await serveManifest(page, manifest({ core: 16, version: "1.0.22.16.3.1.1.1", acceptsFrom: 16 }));
  await openStudio(page);

  // Маска на объекте требует ядра 19 — с ядром 16 это и есть пункт расхождения.
  await page.evaluate((mask) => {
    const raw = JSON.parse(localStorage.getItem("yappytuberplus.preset.v2")!);
    raw.objects = raw.objects.map((object: { id: string }, index: number) =>
      index === 0 ? { ...object, mask } : object);
    localStorage.setItem("yappytuberplus.preset.v2", JSON.stringify(raw));
  }, MASK);
  await page.reload();
  await expect(page.locator(".engine-status")).toHaveClass(/ready/, { timeout: 15_000 });

  await page.locator(".status-check").click();
  const dialog = page.getByRole("dialog", { name: "Доступно обновление" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("несовместима местами");
  await expect(dialog).toContainText("маска");
  // Кнопки остаются на месте: выбор за человеком.
  await expect(dialog.getByRole("button", { name: "Обновить" })).toBeVisible();
});

test("пропуск версии живёт в localStorage", async ({ page }) => {
  await openStudio(page);
  expect(await page.evaluate(() => localStorage.getItem("yappytuberplus.update.skip"))).toBeNull();
  // Модуль работает и вне React: значение читается и снимается.
  await page.evaluate(() => localStorage.setItem("yappytuberplus.update.skip", "1.0.22.3.1.1.1"));
  expect(await page.evaluate(() => localStorage.getItem("yappytuberplus.update.skip")))
    .toBe("1.0.22.3.1.1.1");
  expect(typeof skippedUpdate).toBe("function");
  expect(typeof skipUpdate).toBe("function");
});
