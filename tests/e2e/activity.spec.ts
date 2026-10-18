import { expect, test } from '@playwright/test';

test('活動の単位別表示・90日の日別集計・URL復元・心拍との期間一致', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  const panel = page.getByRole('region', { name: '活動の記録', exact: true });
  await expect(panel.getByRole('img', { name: /歩数の合計グラフ/ })).toBeVisible();
  const heartFrom = new URL(page.url()).searchParams.get('from');
  for (const [metric, label] of [['distance', '距離'], ['total-calories', '総消費カロリー'], ['active-zone-minutes', 'アクティブゾーン時間']] as const) {
    await panel.getByLabel('活動の指標').selectOption(metric);
    await expect(panel.getByRole('img', { name: new RegExp(`${label}の合計グラフ`) })).toBeVisible();
  }
  await panel.getByRole('button', { name: '活動90日', exact: true }).click();
  await expect(panel.getByText('JSTの1日ごとの既知値の合計。', { exact: false })).toBeVisible();
  await panel.locator('summary').filter({ hasText: '活動の日別合計を確認する' }).click();
  await expect(panel.getByRole('table')).toBeVisible();
  expect(await panel.locator('tbody tr').count()).toBeGreaterThanOrEqual(90);
  await expect(panel.getByRole('cell', { name: '途中集計・欠損あり', exact: true }).first()).toBeVisible();
  const saved = page.url(); await page.reload(); await expect(page).toHaveURL(saved);
  await expect(panel.getByLabel('活動の指標')).toHaveValue('active-zone-minutes');
  await expect(panel.getByRole('img', { name: /アクティブゾーン時間の合計グラフ/ })).toBeVisible();
  await panel.getByRole('button', { name: '心拍と同じ期間' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('activityFrom')).toBe(heartFrom);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: `.cache/previews/activity-${info.project.name}.png`, fullPage: true });
});

test('活動だけの通信失敗を表示し、他の指標を維持して再試行できる', async ({ page }) => {
  let fail = true;
  await page.route('**/api/v1/timeseries?*', async route => {
    const metric = new URL(route.request().url()).searchParams.get('metric');
    if (metric === 'steps' && fail) await route.fulfill({ status: 503, json: { error: { code: 'storage-unavailable' } } });
    else await route.continue();
  });
  await page.goto('/');
  const panel = page.getByRole('region', { name: '活動の記録', exact: true });
  await expect(panel.getByRole('alert')).toContainText('活動の記録を読み取れません');
  await expect(page.getByRole('img', { name: /心拍の1分平均/ })).toBeVisible();
  fail = false; await panel.getByRole('button', { name: '活動を再試行' }).click();
  await expect(panel.getByRole('img', { name: /歩数の合計グラフ/ })).toBeVisible();
});

test('取得済みの0と、未取得で数値のない状態を区別する', async ({ page }) => {
  let fetched = false;
  await page.route('**/api/v1/timeseries?*', async route => {
    if (new URL(route.request().url()).searchParams.get('metric') !== 'steps') { await route.continue(); return; }
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ json: { ...body, coverage: fetched ? 'fetched' : 'not-fetched',
      points: body.points.map((p: object) => ({ ...p, total: fetched ? 0 : null })),
      summary: { ...body.summary, total: fetched ? 0 : null, availableMinutes: fetched ? 1 : 0 } } });
  });
  await page.goto('/'); const panel = page.getByRole('region', { name: '活動の記録', exact: true });
  await expect(panel.locator('.activity-total strong')).toContainText('—');
  await expect(panel.getByText('この期間の活動はまだ取得していません。')).toBeVisible();
  fetched = true; await page.reload();
  await expect(panel.locator('.activity-total strong')).toContainText('0');
  await expect(panel.getByRole('img', { name: /歩数の合計グラフ/ })).toBeVisible();
});
