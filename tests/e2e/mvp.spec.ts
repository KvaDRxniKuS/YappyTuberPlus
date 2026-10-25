import { test, expect, type Page } from "@playwright/test";

async function openStudio(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator(".engine-status")).toHaveClass(/ready/, { timeout: 15_000 });
  await expect(page.locator(".tree-row")).toHaveCount(10);
  await expect(page.locator("canvas")).toBeVisible();
  return errors;
}

async function readPreset(page: Page) {
  await expect.poll(() => page.evaluate(() => localStorage.getItem("yappytuberplus.preset.v2")), { timeout: 5_000 }).not.toBeNull();
  // The preset is debounce-saved; allow the latest edit to reach storage as well.
  await page.waitForTimeout(750);
  return page.evaluate(() => JSON.parse(localStorage.getItem("yappytuberplus.preset.v2")!));
}

test("Rust WASM starts and renders animated frames without browser errors", async ({ page }) => {
  const errors = await openStudio(page);
  await expect(page.locator(".engine-status b")).toContainText("FPS");
  await page.waitForTimeout(800);
  const first = await page.locator(".status-message").textContent();
  await page.waitForTimeout(500);
  const second = await page.locator(".status-message").textContent();
  expect(second).not.toEqual(first);
  expect(errors).toEqual([]);
});

test("explicit FPS limiter changes the real processed frame rate", async ({ page }) => {
  await openStudio(page);
  const input = page.locator(".fps-control input");
  await input.fill("30");
  await input.press("Enter");
  await expect(input).toHaveValue("30");
  await page.waitForTimeout(2200);
  const text = await page.locator(".engine-status b").textContent();
  const fps = Number(text?.match(/\d+/)?.[0]);
  expect(fps).toBeGreaterThanOrEqual(27);
  expect(fps).toBeLessThanOrEqual(33);
});

test("right script panel is resizable and layout persists", async ({ page }) => {
  await openStudio(page);
  const panel = page.locator(".right-workspace");
  const before = (await panel.boundingBox())!.width;
  const splitter = page.locator(".splitter-vertical").nth(1);
  const box = await splitter.boundingBox();
  await page.mouse.move(box!.x + 4, box!.y + 250);
  await page.mouse.down();
  await page.mouse.move(box!.x - 85, box!.y + 250, { steps: 8 });
  await page.mouse.up();
  const after = (await panel.boundingBox())!.width;
  expect(after).toBeGreaterThan(before + 60);
  await page.waitForTimeout(400);
  const width = await page.evaluate(() => JSON.parse(localStorage.getItem("yappytuberplus.layout.v1")!).rightWidth);
  expect(width).toBeGreaterThan(440);
});

test("dragging a sprite on the scene changes base and moves its subtree", async ({ page }) => {
  await openStudio(page);
  const before = await readPreset(page);
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  const zoom = Math.min((box!.width - 70) / 1000, (box!.height - 70) / 600, 2);
  const panX = (box!.width - 1000 * zoom) / 2;
  const panY = (box!.height - 600 * zoom) / 2;
  const toScreen = (x: number, y: number) => ({ x: box!.x + panX + x * zoom, y: box!.y + panY + y * zoom });
  const start = toScreen(500, 450);
  const end = toScreen(560, 485);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".inspector-title input")).toHaveValue("Тело");
  const after = await readPreset(page);
  const oldBody = before.objects.find((object: any) => object.id === "body");
  const newBody = after.objects.find((object: any) => object.id === "body");
  const oldHead = before.objects.find((object: any) => object.id === "head");
  const newHead = after.objects.find((object: any) => object.id === "head");
  const oldEye = before.objects.find((object: any) => object.id === "eye_left");
  const newEye = after.objects.find((object: any) => object.id === "eye_left");
  expect(newBody.base.x - oldBody.base.x).toBeCloseTo(60, 0);
  expect(newBody.base.y - oldBody.base.y).toBeCloseTo(35, 0);
  expect(newHead.base.x - oldHead.base.x).toBeCloseTo(60, 0);
  expect(newHead.base.y - oldHead.base.y).toBeCloseTo(35, 0);
  expect(newEye.base.x - oldEye.base.x).toBeCloseTo(60, 0);
  expect(newEye.base.y - oldEye.base.y).toBeCloseTo(35, 0);
});

test("reparenting preserves custom formulas", async ({ page }) => {
  await openStudio(page);
  const eye = page.locator(".tree-row").filter({ hasText: "Глаз · левый" });
  const body = page.locator(".tree-row").filter({ hasText: "Тело" });
  await eye.dragTo(body);
  const preset = await readPreset(page);
  const moved = preset.objects.find((object: any) => object.id === "eye_left");
  expect(moved.parentId).toBe("body");
  expect(moved.script).toContain("sizeY = inherit * (1 - blink * 0.9)");
  expect(moved.script).toContain("layer = inherit + 1");
});

test("inspector layer writes the object script", async ({ page }) => {
  await openStudio(page);
  const layer = page.locator(".number-field").filter({ hasText: "Слой" }).first().locator('input[type="number"]');
  await layer.fill("4");
  await layer.press("Enter");
  const preset = await readPreset(page);
  const character = preset.objects.find((object: any) => object.id === "character");
  expect(character.base.layer).toBe(4);
  expect(character.script).toContain("layer = 4");
  await expect(page.locator(".engine-status")).toHaveClass(/ready/);
});

test("pause freezes the runtime and stop returns it to the neutral pose", async ({ page }) => {
  await openStudio(page);
  await page.getByTitle("Пауза · K").click();
  await expect(page.getByTitle("Продолжить · K")).toBeVisible();
  await page.waitForTimeout(250);
  const before = await page.locator(".status-message").textContent();
  await page.waitForTimeout(350);
  expect(await page.locator(".status-message").textContent()).toEqual(before);

  await page.getByTitle(/^Стоп/).click();
  await page.waitForTimeout(200);
  await expect(page.locator(".status-stopped")).toBeVisible();

  await page.getByTitle("Продолжить · K").click();
  await page.waitForTimeout(300);
  await expect(page.locator(".status-stopped")).toHaveCount(0);
  expect(await page.locator(".status-message").textContent()).not.toEqual(before);
});

test("PNG import adds a usable sprite", async ({ page }) => {
  await openStudio(page);
  await page.locator('input[type="file"][accept="image/png,image/webp"]').setInputFiles("public/assets/demo/eye.png");
  await expect(page.locator(".tree-row")).toHaveCount(11);
  await expect(page.locator(".inspector-title input")).toHaveValue("eye");
  const preset = await readPreset(page);
  expect(preset.objects.at(-1).image).toMatch(/^data:image\/png;base64,/);
});

test("Ctrl+клик и Shift+клик собирают мультивыделение", async ({ page }) => {
  await openStudio(page);
  const rows = page.locator(".tree-row");
  await rows.nth(1).click();
  await expect(page.locator(".tree-row.selected")).toHaveCount(1);

  await rows.nth(3).click({ modifiers: ["Control"] });
  await expect(page.locator(".tree-row.selected")).toHaveCount(2);
  await expect(page.locator(".inspector-title-static")).toContainText("Выделено 2");

  // Shift+клик: диапазон от основного (nth(3)) до кликнутого (nth(5)).
  await rows.nth(5).click({ modifiers: ["Shift"] });
  await expect(page.locator(".tree-row.selected")).toHaveCount(3);

  // Ctrl+клик по уже выделенному убирает его из выборки.
  await rows.nth(3).click({ modifiers: ["Control"] });
  await expect(page.locator(".tree-row.selected")).toHaveCount(2);
});

test("F2 переименовывает объект в дереве и отменяется через Ctrl+Z", async ({ page }) => {
  await openStudio(page);
  await page.locator(".tree-row").filter({ hasText: "Тело" }).click();
  await page.keyboard.press("F2");
  const input = page.locator(".tree-rename input");
  await expect(input).toBeFocused();
  await input.fill("Корпус");
  await input.press("Enter");
  await expect(page.locator(".tree-row").filter({ hasText: "Корпус" })).toHaveCount(1);
  await expect(page.locator(".tree-rename input")).toHaveCount(0);

  await page.keyboard.press("Control+z");
  await expect(page.locator(".tree-row").filter({ hasText: "Тело" })).toHaveCount(1);
});

test("рамка выделяет объекты, включая скрытые", async ({ page }) => {
  await openStudio(page);
  const eyeRow = page.locator(".tree-row").filter({ hasText: "Глаз · левый" });
  await eyeRow.hover();
  await eyeRow.locator(".tree-eye").click();

  await page.getByTitle(/Выделение рамкой/).click();
  const box = (await page.locator(".scene-viewport canvas").boundingBox())!;
  await page.mouse.move(box.x + 3, box.y + 3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 3, box.y + box.height - 3, { steps: 12 });
  await page.mouse.up();

  await expect(page.locator(".tree-row.selected")).toHaveCount(10);
});

test("скрытие панели не растягивает канвас сцены", async ({ page }) => {
  await openStudio(page);
  await page.locator(".status-collapse").first().click();
  await page.waitForTimeout(60);
  const mismatch = await page.evaluate(() => {
    const element = document.querySelector<HTMLCanvasElement>(".scene-viewport canvas")!;
    const host = element.parentElement!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return Math.abs(element.width - Math.round(host.clientWidth * dpr))
      + Math.abs(element.height - Math.round(host.clientHeight * dpr));
  });
  expect(mismatch).toBeLessThanOrEqual(2);
});

test("глаз временно скрывает объект, не переписывая его скрипт", async ({ page }) => {
  await openStudio(page);
  const before = await readPreset(page);
  const row = page.locator(".tree-row").filter({ hasText: "Глаз · левый" });
  await row.hover();
  await row.locator(".tree-eye").click();
  await page.waitForTimeout(200);

  const after = await readPreset(page);
  const was = before.objects.find((object: any) => object.id === "eye_left");
  const now = after.objects.find((object: any) => object.id === "eye_left");
  expect(now.enabled).toBe(false);
  expect(now.script).toBe(was.script);
  expect(now.base.visible).toBe(was.base.visible);

  // Повторный клик возвращает объект в кадр.
  await row.locator(".tree-eye").click();
  await page.waitForTimeout(200);
  const again = await readPreset(page);
  expect(again.objects.find((object: any) => object.id === "eye_left").enabled).toBe(true);
});

test("перетаскивание выделенной в структуре группы двигает всю группу", async ({ page }) => {
  await openStudio(page);
  await page.locator(".tree-row").filter({ hasText: "Персонаж" }).click();
  await expect(page.locator(".tree-row.selected")).toHaveCount(1);

  const before = await readPreset(page);
  const box = (await page.locator(".scene-viewport canvas").boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 30, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const after = await readPreset(page);
  const moved = after.objects.filter((object: any, index: number) => {
    const was = before.objects[index];
    return was && object.base.x !== was.base.x;
  });
  // Группа тянет всех потомков: двигаются персонаж, тело, голова, руки и т. д.
  expect(moved.length).toBeGreaterThan(3);
  // Выделение осталось на группе, а не перескочило на спрайт под курсором.
  await expect(page.locator(".tree-row.selected")).toHaveCount(1);
  await expect(page.locator(".tree-row.primary")).toContainText("Персонаж");
});

test("Alt+↓ переставляет объект в структуре", async ({ page }) => {
  await openStudio(page);
  const rows = page.locator(".tree-row");
  await expect(rows.nth(4)).toContainText("Глаз · левый");
  await rows.nth(4).click();
  await page.keyboard.press("Alt+ArrowDown");
  await page.waitForTimeout(150);
  await expect(rows.nth(4)).toContainText("Глаз · правый");
  await expect(rows.nth(5)).toContainText("Глаз · левый");

  await page.keyboard.press("Control+z");
  await expect(rows.nth(4)).toContainText("Глаз · левый");
});

test("клик по пустому месту сцены снимает выделение, но не роняет окно", async ({ page }) => {
  const errors = await openStudio(page);
  await expect(page.locator(".inspector-title input")).toHaveValue("Тело");

  // Нижний левый угол холста — заведомо пустое место: там нет ни спрайта, ни
  // группы, ни подписи размера холста, которая живёт у верхнего левого угла.
  const box = (await page.locator(".scene-viewport canvas").boundingBox())!;
  await page.mouse.click(box.x + 6, box.y + box.height - 6);

  // Выделение снято: инспектор показывает заглушку, сцена и панели на месте.
  await expect(page.locator(".inspector.empty-state")).toBeVisible();
  await expect(page.locator(".inspector.empty-state")).toContainText("Выберите объект");
  await expect(page.locator(".tree-row.selected")).toHaveCount(0);
  await expect(page.locator(".scene-viewport canvas")).toBeVisible();
  await expect(page.locator(".right-tabs")).toBeVisible();
  await expect(page.locator(".tree-footer")).toBeVisible();
  // Возврат выделения кликом по дереву тоже работает: интерфейс живой.
  await page.locator(".tree-row").filter({ hasText: "Тело" }).click();
  await expect(page.locator(".inspector-title input")).toHaveValue("Тело");
  expect(errors).toEqual([]);
});

test("мультивыделение не роняет инспектор", async ({ page }) => {
  const errors = await openStudio(page);
  const rows = page.locator(".tree-row");
  await rows.nth(4).click();
  await rows.nth(5).click({ modifiers: ["Control"] });
  await expect(page.locator(".inspector .multi-list")).toBeVisible();
  await expect(page.locator(".multi-name")).toHaveCount(2);
  await expect(page.locator(".app-shell")).toBeVisible();
  expect(errors).toEqual([]);
});
