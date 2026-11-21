import { expect, test } from '@playwright/test';
import { boot, click, jump, setDate } from './compose.js';

test('24時間の記録・期間移動・URL復元・日時入力', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await boot(page);
  await expect(page.getByText(/Emulatorの架空データ/)).toBeVisible();
  await expect(page.getByRole('img', { name: /心拍の1分平均/ })).toHaveCount(1);
  const current = page.url();
  await click(page, page.getByRole('button', { name: '前の期間', exact: true }));
  await expect(page).not.toHaveURL(current);
  const previous = page.url();
  await boot(page, previous);
  await expect(page).toHaveURL(previous);
  await click(page, page.getByRole('button', { name: '日時を指定する', exact: true }));
  const start = new URL(page.url()).searchParams.get('from')!;
  const jst = new Date(Date.parse(start) + 10 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
  await setDate(page, '開始日時（JST）', `${jst.slice(0, 14)}03`);
  await click(page, page.getByRole('button', { name: '表示する', exact: true }));
  await expect(page).toHaveURL(/from=[^&]*%3A03%3A00/);
  await jump(page, '心拍');
  await expect(page.getByRole('img', { name: /心拍の1分平均/ })).toHaveCount(1);
  await click(page, page.getByRole('img', { name: /心拍の1分平均/ }));
  await expect(page.getByText(/^平均 .* bpm · 最小 /)).toHaveCount(1);
  await page.screenshot({ path: `.cache/previews/compose-heart-${info.project.name}.png` });
  expect(errors).toEqual([]);
});

test('未同期の状態では架空の値を作らない', async ({ page }) => {
  await page.route('**/api/v1/timeseries?*', async route => {
    if (new URL(route.request().url()).searchParams.get('metric') !== 'heart-rate') { await route.continue(); return; }
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { ...body, points: body.points.map((p: object) => ({ ...p, value: null })),
      summary: { avg: null, min: null, max: null, availableMinutes: 0, totalMinutes: 1440, latest: null },
      status: { ...body.status, state: 'not-synced', lastSuccessAt: null, dataThrough: null } } });
  });
  await boot(page);
  await jump(page, '心拍');
  await expect(page.getByText('まだ記録がありません', { exact: true })).toBeVisible();
  await expect(page.getByText('—', { exact: true })).toHaveCount(4);
  await expect(page.getByRole('img', { name: /心拍の1分平均/ })).toHaveCount(0);
});

test('DB障害をデータなしとせず、再試行で復帰する', async ({ page }) => {
  let fail = true;
  await page.route('**/api/v1/timeseries?*', route => fail && new URL(route.request().url()).searchParams.get('metric') === 'heart-rate'
    ? route.fulfill({ status: 503, json: { error: { code: 'storage-unavailable' } } }) : route.continue());
  await boot(page);
  await jump(page, '心拍');
  await expect(page.getByText('心拍の記録を読み取れません。再試行してください。', { exact: true })).toBeVisible();
  fail = false;
  await click(page, page.getByRole('button', { name: '心拍を再試行', exact: true }));
  await expect(page.getByRole('img', { name: /心拍の1分平均/ })).toHaveCount(1);
});

test('7・30・90日、粒度、履歴復元と保存境界', async ({ page }) => {
  await boot(page);
  for (const [days, resolution, label] of [[7, '5m', '5分'], [30, '1h', '1時間'], [90, '1d', '1日（JST）']] as const) {
    await jump(page, '期間');
    const response = page.waitForResponse(r => new URL(r.url()).searchParams.get('metric') === 'heart-rate');
    await click(page, page.getByRole('button', { name: `${days}日`, exact: true }));
    const body = await (await response).json();
    expect(body.resolution).toBe(resolution);
    expect(body.points.length).toBeLessThanOrEqual(4096);
    expect(body.summary.availableMinutes).toBeGreaterThan(0);
    await jump(page, '心拍');
    await expect(page.getByRole('img', { name: `心拍の${label}平均と最小・最大のグラフ`, exact: true })).toHaveCount(1);
  }
  await jump(page, '期間');
  const daily = page.url();
  await click(page, page.getByRole('button', { name: '前の期間', exact: true }));
  await expect(page).toHaveURL(daily);
  await click(page, page.getByRole('button', { name: '次の期間', exact: true }));
  await expect(page).toHaveURL(daily);
  // Reload a range away from the moving retention boundary: a saved 90-day
  // boundary legitimately expires when the wall clock advances one minute.
  await click(page, page.getByRole('button', { name: '7日', exact: true }));
  const weekly = page.url();
  await boot(page, weekly);
  await expect(page).toHaveURL(weekly);
  await jump(page, '心拍');
  await click(page, page.getByRole('button', { name: '心拍の表示粒度 1分', exact: true }));
  await expect(page.getByText(/4096/)).toBeVisible();
  expect(new URL(page.url()).searchParams.get('resolution')).toBe('auto');
  await click(page, page.getByRole('button', { name: '心拍の表示粒度 1時間', exact: true }));
  await expect(page.getByRole('img', { name: /心拍の1時間平均/ })).toHaveCount(1);
  const hourly = page.url();
  await jump(page, '期間');
  await click(page, page.getByRole('button', { name: '前の期間', exact: true }));
  await expect(page).not.toHaveURL(hourly);
  await page.goBack();
  await expect(page).toHaveURL(hourly);
  await jump(page, '心拍');
  await expect(page.getByRole('img', { name: /心拍の1時間平均/ })).toHaveCount(1);
});

test('共通の表示期間を全指標に適用し、履歴で復元する', async ({ page }) => {
  await boot(page);
  await expect(page.getByRole('img', { name: /心拍の1分平均/ })).toHaveCount(1);
  const initialUrl = page.url(), initialFrom = new URL(initialUrl).searchParams.get('from');
  const responses = ['heart-rate', 'sleep', 'steps'].map(metric => page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.ok() && url.searchParams.get('from') !== initialFrom &&
      (metric === 'sleep' ? url.pathname === '/api/v1/sleep' : url.pathname === '/api/v1/timeseries' && url.searchParams.get('metric') === metric);
  }));
  await click(page, page.getByRole('button', { name: '7日', exact: true }));
  const range = new URL(page.url()).searchParams;
  for (const response of await Promise.all(responses)) {
    const query = new URL(response.url()).searchParams;
    expect(query.get('from')).toBe(range.get('from'));
    expect(query.get('to')).toBe(range.get('to'));
  }
  await page.goBack();
  await expect(page).toHaveURL(initialUrl);
  await expect(page.getByRole('img', { name: /心拍の1分平均/ })).toHaveCount(1);
});
