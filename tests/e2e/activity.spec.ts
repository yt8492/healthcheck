import { expect, test } from '@playwright/test';
import { boot, click, jump } from './compose.js';

test('活動の指標・90日集計・URL復元', async ({ page }, info) => {
  await boot(page);
  await jump(page, '活動');
  await expect(page.getByRole('img', { name: '歩数の合計グラフ', exact: true })).toHaveCount(1);
  for (const [metric, label] of [['distance', '距離'], ['total-calories', '総消費カロリー'], ['active-zone-minutes', 'アクティブゾーン時間']] as const) {
    await click(page, page.getByRole('button', { name: label, exact: true }));
    await expect(page.getByRole('img', { name: `${label}の合計グラフ`, exact: true })).toHaveCount(1);
    expect(new URL(page.url()).searchParams.get('activityMetric')).toBe(metric);
  }
  await jump(page, '期間');
  await click(page, page.getByRole('button', { name: '90日', exact: true }));
  await jump(page, '活動');
  await expect(page.getByText(/^JSTの1日ごとの既知値の合計。/)).toHaveCount(1);
  await click(page, page.getByRole('button', { name: /活動の日別合計を確認する/ }));
  await expect(page.getByText(/^\d{4}-\d\d-\d\d$/, { exact: true })).toHaveCount(91);
  await jump(page, '期間');
  await click(page, page.getByRole('button', { name: '7日', exact: true }));
  const saved = page.url();
  await boot(page, saved);
  await jump(page, '活動');
  await expect(page.getByRole('img', { name: 'アクティブゾーン時間の合計グラフ', exact: true })).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get('activityMetric')).toBe('active-zone-minutes');
  await page.screenshot({ path: `.cache/previews/compose-activity-${info.project.name}.png` });
});

test('活動だけの通信失敗から再試行でき、心拍を維持する', async ({ page }) => {
  let fail = true;
  await page.route('**/api/v1/timeseries?*', route => new URL(route.request().url()).searchParams.get('metric') === 'steps' && fail
    ? route.fulfill({ status: 503, json: { error: { code: 'storage-unavailable' } } }) : route.continue());
  await boot(page);
  await expect(page.getByRole('img', { name: /心拍の1分平均/ })).toHaveCount(1);
  await jump(page, '活動');
  await expect(page.getByText('活動の記録を読み取れません。再試行してください。', { exact: true })).toBeVisible();
  fail = false;
  await click(page, page.getByRole('button', { name: '活動を再試行', exact: true }));
  await expect(page.getByRole('img', { name: '歩数の合計グラフ', exact: true })).toHaveCount(1);
});

test('取得済みの0と未取得の値を区別する', async ({ page }) => {
  let fetched = false;
  await page.route('**/api/v1/timeseries?*', async route => {
    if (new URL(route.request().url()).searchParams.get('metric') !== 'steps') { await route.continue(); return; }
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { ...body, coverage: fetched ? 'fetched' : 'not-fetched',
      points: body.points.map((p: object) => ({ ...p, total: fetched ? 0 : null })),
      summary: { ...body.summary, total: fetched ? 0 : null, availableMinutes: fetched ? 1 : 0 } } });
  });
  await boot(page);
  await jump(page, '活動');
  await expect(page.getByText('歩数：— 歩', { exact: true })).toBeVisible();
  await expect(page.getByText('この期間の活動はまだ取得していません。', { exact: true })).toBeVisible();
  fetched = true;
  await boot(page, page.url());
  await jump(page, '活動');
  await expect(page.getByText('歩数：0 歩', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: '歩数の合計グラフ', exact: true })).toHaveCount(1);
});
