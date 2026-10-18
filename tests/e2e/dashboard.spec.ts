import { expect, test } from '@playwright/test';

test('24時間の記録・期間移動・URL復元・日時指定', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '心拍の記録', exact: true })).toBeVisible();
  await expect(page.getByText('Emulatorの架空データ', { exact: false })).toBeVisible();
  await expect(page.getByRole('img', { name: /心拍の1分平均/ })).toBeVisible();
  await expect(page.locator('.coverage')).toContainText('1440');
  expect(new URL(page.url()).searchParams.get('from')).toBeTruthy();
  const current = page.url();
  await page.getByRole('button', { name: '前の期間', exact: true }).click();
  await expect(page).not.toHaveURL(current);
  await expect(page.getByRole('img', { name: /心拍の1分平均/ })).toBeVisible();
  const previous = page.url();
  await page.reload();
  await expect(page).toHaveURL(previous);
  await expect(page.getByRole('img', { name: /心拍の1分平均/ })).toBeVisible();
  await page.getByText('日時を指定する', { exact: true }).click();
  await expect(page.getByLabel('開始日時（JST）')).toBeVisible();
  await page.getByRole('button', { name: '表示する', exact: true }).click();
  await expect(page.getByRole('img', { name: /心拍の1分平均/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: `.cache/previews/${info.project.name}.png`, fullPage: true });
});

test('未同期の状態では架空の値を作らない', async ({ page }) => {
  await page.route('**/api/v1/timeseries?*', async route => {
    if (new URL(route.request().url()).searchParams.get('metric') !== 'heart-rate') { await route.continue(); return; }
    const original = await route.fetch(); const body = await original.json();
    await route.fulfill({ json: { ...body, points: body.points.map((p: { time: string }) => ({ ...p, value: null })),
      summary: { avg: null, min: null, max: null, availableMinutes: 0, totalMinutes: 1440, latest: null },
      status: { ...body.status, state: 'not-synced', lastSuccessAt: null, dataThrough: null } } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'まだ記録がありません' })).toBeVisible();
  await expect(page.locator('.stat-value').first()).toContainText('—');
  await expect(page.getByRole('img', { name: /心拍の1分平均/ })).toHaveCount(0);
});

test('DB障害をデータなしとして表示しない', async ({ page }) => {
  await page.route('**/api/v1/timeseries?*', route => new URL(route.request().url()).searchParams.get('metric') === 'heart-rate' ? route.fulfill({ status: 503, json: { error: { code: 'storage-unavailable' } } }) : route.continue());
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('記録を読み取れません');
  await expect(page.getByRole('heading', { name: '記録を表示できません' })).toBeVisible();
  await expect(page.getByRole('button', { name: '再試行', exact: true })).toBeVisible();
});
