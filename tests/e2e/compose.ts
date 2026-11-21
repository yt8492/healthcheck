import { expect, type Locator, type Page } from '@playwright/test';

export async function frame(page: Page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

export async function boot(page: Page, url = '/') {
  await page.goto(url);
  await expect(page.locator('#boot')).toBeHidden({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: '期間', exact: true })).toBeVisible();
  await expect(page.getByText('心拍の記録を読み込んでいます', { exact: true })).toHaveCount(0);
  await frame(page);
}

// Semantics elements sit behind Compose's canvas. Their bounds locate real
// pointer/touch events on the canvas; no synthetic DOM clicks bypass the UI.
export async function reveal(page: Page, locator: Locator): Promise<{ x: number; y: number }> {
  await expect(locator).toBeAttached();
  for (let attempt = 0; attempt < 30; attempt++) {
    // Compose publishes its semantics asynchronously after drawing. Wait for
    // the target's bounds to settle before sending a real pointer event.
    let previous = '', stable = 0;
    await expect.poll(async () => {
      const current = JSON.stringify(await locator.boundingBox());
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      return stable;
    }, { intervals: [100] }).toBeGreaterThanOrEqual(2);
    const bounds = await locator.boundingBox(), viewport = page.viewportSize()!;
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
      if (x >= 0 && x < viewport.width && y >= 0 && y < viewport.height) {
        return { x, y };
      }
      await page.mouse.move(viewport.width / 2, viewport.height / 2);
      await page.mouse.wheel(0, Math.max(-600, Math.min(600, y - viewport.height / 2)));
      await frame(page);
    } else {
      await page.mouse.move(viewport.width / 2, viewport.height / 2);
      await page.mouse.wheel(0, viewport.height * 0.5);
      await frame(page);
    }
  }
  throw new Error(`Compose control did not enter viewport: ${locator}`);
}

export async function click(page: Page, locator: Locator) {
  const { x, y } = await reveal(page, locator);
  if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
  await frame(page);
}

export async function jump(page: Page, section: '期間' | '心拍' | '睡眠' | '活動') {
  await click(page, page.getByRole('button', { name: section, exact: true }));
}

export async function setDate(page: Page, name: string, value: string) {
  await click(page, page.getByRole('textbox', { name, exact: true }));
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(value);
  await frame(page);
}
