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
