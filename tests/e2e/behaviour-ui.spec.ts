import { expect, test, type Page } from "@playwright/test";
import { readBehaviour } from "../../src/engine/behaviour";

async function openStudio(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".engine-status")).toHaveClass(/ready/, { timeout: 15_000 });
  await expect(page.locator(".tree-row")).toHaveCount(10);
}

test("source selectors show one source and retain an explicit second-source choice", async ({ page }) => {
  await openStudio(page);

  // Demo has one microphone module and one AutoBlink module. Pickers must stay
  // visible even when their value cannot yet be changed.
  const voice = page.getByLabel("Источник речи");
  const blink = page.getByLabel("Источник моргания");
  await expect(voice).toBeVisible();
  await expect(voice).toBeDisabled();
  await expect(voice).toHaveValue("mic");
  await expect(blink).toBeVisible();
  await expect(blink).toBeDisabled();
  await expect(blink).toHaveValue("auto");

  // Open the module palette and verify it overlays the connected-module list
  // while remaining within the available height of the tab.
  await page.locator(".right-tabs button").filter({ hasText: "Модули" }).click();
  const addButton = page.getByRole("button", { name: "Добавить модуль" });
  await expect(addButton).toBeVisible();
  const addBox = await addButton.boundingBox();
  const listBox = await page.locator(".module-list").boundingBox();
  expect(addBox).not.toBeNull();
  expect(listBox).not.toBeNull();
  expect(addBox!.y).toBeLessThan(listBox!.y);

  await addButton.click();
  const palette = page.locator(".module-palette");
  await expect(palette).toBeVisible();
  const paletteBox = await palette.boundingBox();
  expect(paletteBox).not.toBeNull();
  expect(paletteBox!.height).toBeGreaterThan(250);
  expect(paletteBox!.y + paletteBox!.height).toBeGreaterThan(listBox!.y);
  expect(paletteBox!.y).toBeLessThan(listBox!.y + listBox!.height);

  // Adding another Loudness creates a second selectable source.
  await palette.locator(".module-palette-item").filter({ hasText: "Loudness" }).first().click();
  await page.locator(".right-tabs button").filter({ hasText: "Поведение" }).click();
  await expect(voice).toBeEnabled();
  await expect(voice.locator("option")).toHaveCount(2);
  await voice.selectOption("loudness");

  await expect.poll(async () => {
    const script = await page.evaluate(() => {
      const stored = localStorage.getItem("yappytuberplus.preset.v2");
      if (!stored) return "";
      const preset = JSON.parse(stored);
      return preset.objects.find((item: { id: string }) => item.id === "character")?.script ?? "";
    });
    return readBehaviour(script).voiceModule;
  }, { timeout: 5_000 }).toBe("loudness");

  // The selected source survives a full reload, not only a React rerender.
  await page.reload();
  await expect(page.locator(".engine-status")).toHaveClass(/ready/, { timeout: 15_000 });
  await expect(page.getByLabel("Источник речи")).toHaveValue("loudness");
});

test("секции «Поведения» сворачиваются по одной и сначала раскрыты", async ({ page }) => {
  await openStudio(page);
  await page.locator(".right-tabs button").filter({ hasText: "Поведение" }).click();

  const wiggle = page.locator(".behaviour-panel .section-toggle").filter({ hasText: "Покачивание" });
  const reaction = page.locator(".behaviour-panel .section-toggle").filter({ hasText: "Реакция" });
  // Начальное состояние — раскрыто: длинную вкладку не надо разворачивать руками.
  await expect(wiggle).toHaveAttribute("aria-expanded", "true");
  await expect(reaction).toHaveAttribute("aria-expanded", "true");

  await wiggle.click();
  await expect(wiggle).toHaveAttribute("aria-expanded", "false");
  // Соседняя секция остаётся раскрытой: состояния независимы.
  await expect(reaction).toHaveAttribute("aria-expanded", "true");
  // Свёрнутая секция прячет всё, кроме заголовка.
  const wiggleSection = page.locator(".behaviour-section.collapsed").filter({ hasText: "Покачивание" });
  await expect(wiggleSection).toHaveCount(1);
  await expect(wiggleSection.locator(".behaviour-state").first()).toBeHidden();

  // Состояние переживает смену объекта: дерево не раскрывается заново.
  await page.locator(".tree-row").nth(1).click();
  await page.locator(".tree-row").first().click();
  await expect(wiggle).toHaveAttribute("aria-expanded", "false");
});

test("сброс поведения — возврат к значениям, а не закрытие панели", async ({ page }) => {
  await openStudio(page);
  await page.locator(".right-tabs button").filter({ hasText: "Поведение" }).click();
  const reset = page.locator(".behaviour-head .icon-button");
  await expect(reset).toHaveAttribute("title", /Сбросить поведение/);
  // Иконка — круглая стрелка: крестик читался как «закрыть».
  await expect(reset.locator("svg.lucide-rotate-ccw")).toHaveCount(1);
});

test("«Добавить модуль» остаётся на виду при прокрутке, а входы шаблона — под описанием", async ({ page }) => {
  await openStudio(page);
  await page.locator(".right-tabs button").filter({ hasText: "Модули" }).click();

  // Кнопка закреплена: после прокрутки списка она не уезжает вверх.
  const panel = page.locator(".modules-panel");
  const addButton = page.getByRole("button", { name: "Добавить модуль" });
  const before = await addButton.boundingBox();
  await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const after = await addButton.boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
  await expect(addButton).toBeVisible();

  // Палитра: входы шаблона стоят под описанием, внутри текстового блока.
  await addButton.click();
  const item = page.locator(".module-palette-item").first();
  const insideText = await item.evaluate((element) => {
    const inputs = element.querySelector(".module-palette-inputs");
    if (!inputs) return null;
    return inputs.parentElement?.classList.contains("module-palette-text") ?? false;
  });
  expect(insideText).toBe(true);
  const description = await item.locator("small").first().boundingBox();
  const inputs = await item.locator(".module-palette-inputs").boundingBox();
  expect(description).not.toBeNull();
  expect(inputs).not.toBeNull();
  expect(inputs!.y).toBeGreaterThan(description!.y);
});

test("следование за мышью без модуля объясняет, каких входов нет", async ({ page }) => {
  await openStudio(page);
  await page.locator(".right-tabs button").filter({ hasText: "Поведение" }).click();

  // В стартовом пресете модуля мыши нет: секция есть, но говорит об этом прямо.
  const follow = page.locator(".behaviour-section").filter({ hasText: "Следование за мышью" });
  await expect(follow.locator(".behaviour-warning")).toContainText("mouse.x");
  await expect(follow.locator(".behaviour-warning")).toContainText("mouse.y");
  // Выбирать нечего — выбора источника нет вовсе.
  await expect(page.getByLabel("Источник мыши")).toHaveCount(0);
});
