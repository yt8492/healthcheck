import { expect, test } from '@playwright/test';

test('睡眠の全ページ・起床日ごとの内訳・詳細・URL復元を確認する', async ({ page }, info) => {
  let cursorRequests = 0;
  page.on('request', req => { if (req.url().includes('/api/v1/sleep?') && new URL(req.url()).searchParams.has('cursor')) cursorRequests++; });
  await page.goto('/');
  const sleep = page.getByRole('region', { name: '睡眠の記録', exact: true });
  await expect(sleep.getByText('睡眠の全ページを読み込んでいます')).toHaveCount(0);
  await expect(sleep.getByRole('img', { name: /睡眠段階/ }).first()).toBeVisible();
  await sleep.getByRole('button', { name: '睡眠90日', exact: true }).click();
  await expect(sleep.locator('.sleep-days > details')).toHaveCount(90);
  expect(cursorRequests).toBeGreaterThanOrEqual(3);
  const saved = page.url();
  await page.reload();
  await expect(page).toHaveURL(saved);
  await expect(sleep.locator('.sleep-days > details')).toHaveCount(90);
  const day = sleep.locator('.sleep-days > details').last();
  await day.locator(':scope > summary').focus();
  await day.locator(':scope > summary').press('Enter');
  const session = day.locator('.sleep-session').first();
  await session.locator('summary').focus();
  await session.locator('summary').press('Enter');
  await expect(session.getByText('実際の開始：', { exact: false })).toBeVisible();
  await expect(session.getByText('実際の終了：', { exact: false })).toBeVisible();
  await expect(session.getByRole('table')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `.cache/previews/sleep-${info.project.name}.png`, fullPage: true });
  await session.getByRole('button', { name: 'この睡眠前後の心拍を見る' }).click();
  await expect(page.getByRole('img', { name: /心拍の1分平均/ })).toBeVisible();
  expect(new URL(page.url()).searchParams.has('sleepFrom')).toBe(false);
});

test('部分期間でも睡眠詳細には実際の開始と終了を表示する', async ({ page }) => {
  const now = new Date();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 21);
  const from = new Date(end - 6 * 3_600_000).toISOString(), to = new Date(end - 5 * 3_600_000).toISOString();
  await page.goto(`/?${new URLSearchParams({ from, to })}`);
  const session = page.locator('.sleep-session').first();
  await session.locator('summary').click();
  const times = session.locator('time');
  await expect(times.nth(0)).toHaveAttribute('datetime', new Date(end - 8 * 3_600_000).toISOString());
  await expect(times.nth(1)).toHaveAttribute('datetime', new Date(end).toISOString());
});

test('睡眠の途中ページが失敗した場合に部分データを完全な集計として表示しない', async ({ page }) => {
  await page.route('**/api/v1/sleep?*', async route => {
    if (new URL(route.request().url()).searchParams.has('cursor')) {
      await route.fulfill({ status: 503, json: { error: { code: 'storage-unavailable' } } });
    } else await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: '睡眠90日', exact: true }).click();
  const sleep = page.getByRole('region', { name: '睡眠の記録', exact: true });
  await expect(sleep.getByRole('alert')).toContainText('睡眠の記録を読み取れません');
  await expect(sleep.locator('.sleep-overview')).toHaveCount(0);
  await expect(page.getByRole('img', { name: /心拍の1分平均/ })).toBeVisible();
});

test('未取得期間の空表示と、取得成功した空データを区別する', async ({ page }) => {
  let coverage = 'not-fetched';
  await page.route('**/api/v1/sleep?*', async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ json: { ...body, sessions: [], nextCursor: null, coverage } });
  });
  await page.goto('/');
  const sleep = page.getByRole('region', { name: '睡眠の記録', exact: true });
  await expect(sleep.getByText('この期間の睡眠は未取得、または一部だけ取得済みです。')).toBeVisible();
  await expect(sleep.getByText('この期間の取得は完了していません。', { exact: false })).toBeVisible();
  coverage = 'fetched';
  await page.reload();
  await expect(sleep.getByText('この期間に取得できた睡眠はありません。', { exact: false })).toBeVisible();
  await expect(sleep.getByText('この期間の取得は完了していません。', { exact: false })).toHaveCount(0);
});
