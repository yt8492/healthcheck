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

test('7・30・90日、粒度、任意期間、履歴復元と保存境界', async ({ page }, info) => {
  await page.goto('/');
  const period = page.getByRole('region', { name: '表示期間', exact: true });
  for (const [days, resolution, label] of [[7, '5m', '5分'], [30, '1h', '1時間'], [90, '1d', '1日（JST）']] as const) {
    const response = page.waitForResponse(r => {
      const q = new URL(r.url()).searchParams;
      return r.url().includes('/timeseries?') && q.get('metric') === 'heart-rate' && q.get('resolution') === 'auto';
    });
    await period.getByRole('button', { name: `${days}日`, exact: true }).click();
    const body = await (await response).json();
    expect(body.resolution).toBe(resolution); expect(body.points.length).toBeLessThanOrEqual(4096);
    expect(body.summary.availableMinutes).toBeGreaterThan(0);
    await expect(page.getByRole('img', { name: `心拍の${label}平均と最小・最大のグラフ。下の表でも値を確認できます。`, exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('resolution')).toBe('auto');
  }
  await expect(page.getByRole('button', { name: '前の期間', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '次の期間', exact: true })).toBeDisabled();
  const daily = page.url();
  await page.reload();
  await expect(page).toHaveURL(daily);
  await expect(page.getByRole('img', { name: /心拍の1日（JST）平均/ })).toBeVisible();
  await page.getByLabel('心拍の表示粒度').selectOption('1m');
  await expect(period.getByRole('alert')).toContainText('4096');
  await expect(page.getByLabel('心拍の表示粒度')).toHaveValue('auto');
  await period.getByRole('button', { name: '7日', exact: true }).click();
  await page.getByLabel('心拍の表示粒度').selectOption('1h');
  await expect(page.getByRole('img', { name: /心拍の1時間平均/ })).toBeVisible();
  const hourly = page.url();
  await page.getByRole('button', { name: '前の期間', exact: true }).click();
  await expect(page).not.toHaveURL(hourly);
  await page.goBack();
  await expect(page).toHaveURL(hourly);
  await expect(page.getByLabel('心拍の表示粒度')).toHaveValue('1h');
  await period.getByText('日時を指定する', { exact: true }).click();
  const start = await page.getByLabel('開始日時（JST）').inputValue();
  await page.getByLabel('開始日時（JST）').fill(`${start.slice(0, 11)}01:03`);
  await page.getByRole('button', { name: '表示する', exact: true }).click();
  await expect(page.getByRole('img', { name: /心拍の1時間平均/ })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('from')).toContain(':03:00.000Z');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `.cache/previews/heart-long-${info.project.name}.png`, fullPage: true });
});
