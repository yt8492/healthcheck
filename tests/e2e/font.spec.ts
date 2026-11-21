import { expect, test } from '@playwright/test';

test('同梱した日本語フォントの読み込み完了を待って表示する', async ({ page }) => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const external: string[] = [];
  page.on('request', request => { if (new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url()); });
  await page.route('**/composeResources/**/noto_sans_jp.ttf', async route => { await ready; await route.continue(); });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app canvas')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.locator('#boot')).toBeVisible();
  await expect(page.getByRole('button', { name: '期間', exact: true })).toHaveCount(0);
  release();
  await expect(page.locator('#boot')).toBeHidden({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: '期間', exact: true })).toBeVisible();
  expect(external).toEqual([]);
});

test('フォント取得失敗を表示して再読み込みできる', async ({ page }) => {
  let fail = true;
  await page.route('**/composeResources/**/noto_sans_jp.ttf', route => fail ? route.fulfill({ status: 503, body: '' }) : route.continue());
  await page.goto('/');
  await expect(page.locator('#boot')).toContainText('文字の表示に必要なデータを読み込めませんでした。', { timeout: 60_000 });
  fail = false;
  await page.getByRole('button', { name: '再読み込み', exact: true }).click();
  await expect(page.locator('#boot')).toBeHidden({ timeout: 60_000 });
});
