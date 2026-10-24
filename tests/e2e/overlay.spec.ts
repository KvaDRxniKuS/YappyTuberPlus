import { test, expect, type Page } from "@playwright/test";

async function openStudio(page: Page) {
  await page.goto("/");
  await expect(page.locator(".engine-status")).toHaveClass(/ready/, { timeout: 15_000 });
}

test("overlay window receives the live scene from the editor", async ({ page, context }) => {
  await openStudio(page);
  await page.locator(".overlay-button").click();
  const dialog = page.locator(".overlay-dialog");
  await expect(dialog).toBeVisible();

  // The guide draws a status HUD; without it the overlay is fully transparent.
  await dialog.getByText("Служебная рамка").click();

  const popupPromise = context.waitForEvent("page");
  await dialog.getByRole("button", { name: "Открыть оверлей" }).click();
  const overlay = await popupPromise;
  await overlay.waitForLoadState("domcontentloaded");

  await expect(overlay.locator(".overlay-pill b")).toHaveText("В эфире", { timeout: 15_000 });
  await expect(overlay.locator(".overlay-meta")).toContainText("1000 × 600");

  const first = await overlay.locator(".overlay-meta").textContent();
  await overlay.waitForTimeout(1200);
  const second = await overlay.locator(".overlay-meta").textContent();
  expect(second).not.toEqual(first);

  // The editor knows a viewer is attached.
  await expect(page.locator(".overlay-button")).toHaveClass(/live/, { timeout: 10_000 });
  await expect(page.locator(".overlay-dialog .overlay-state")).toContainText("Подключено оверлеев: 1", { timeout: 10_000 });
});

test("overlay without an editor shows the waiting state and keeps the page transparent", async ({ page }) => {
  await page.goto("/overlay.html?overlay=1&guide=1");
  await expect(page.locator(".overlay-pill b")).toHaveText("Ожидание редактора", { timeout: 10_000 });
  await expect(page.locator(".overlay-hint")).toBeVisible();
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe("rgba(0, 0, 0, 0)");
});

test("overlay settings persist in the preset", async ({ page }) => {
  await openStudio(page);
  await page.locator(".overlay-button").click();
  const dialog = page.locator(".overlay-dialog");
  const width = dialog.locator(".number-field input").first();
  await width.fill("1280");
  await width.press("Enter");
  await dialog.getByText("Хромакей").click();
  await page.waitForTimeout(900);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("yappytuberplus.preset.v2")!));
  expect(stored.overlay.width).toBe(1280);
  expect(stored.overlay.background).toBe("chroma");
  await expect(dialog.locator(".overlay-url")).toHaveValue(/overlay\.html/);
});
