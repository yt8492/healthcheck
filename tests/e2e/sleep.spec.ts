import { expect, test } from '@playwright/test';
import { boot, click, jump, reveal } from './compose.js';

test('睡眠の全ページ・日ごとの内訳・詳細・前後の期間入力', async ({ page }, info) => {
  let cursorRequests = 0;
  page.on('request', req => { if (req.url().includes('/api/v1/sleep?') && new URL(req.url()).searchParams.has('cursor')) cursorRequests++; });
  await boot(page);
  await click(page, page.getByRole('button', { name: '90日', exact: true }));
  await jump(page, '睡眠');
  const days = page.getByRole('button', { name: /^[+−] \d{4}-\d\d-\d\d · 睡眠/ });
  await expect(days).toHaveCount(90);
  expect(cursorRequests).toBeGreaterThanOrEqual(3);
  const bookmark = new URL(page.url());
  bookmark.searchParams.set('from', new Date(Date.parse(bookmark.searchParams.get('from')!) + 86_400_000).toISOString());
  const saved = bookmark.href;
  await boot(page, saved);
  await jump(page, '睡眠');
  await expect(page).toHaveURL(saved);
  await expect(days).toHaveCount(89);
  await click(page, days.first());
  await click(page, page.getByRole('button', { name: /^\+ 詳細を見る/ }).first());
  await reveal(page, page.getByText(/^実際の終了：/));
  await expect(page.getByText(/^実際の開始：/)).toBeVisible();
  await expect(page.getByText(/^実際の終了：/)).toBeVisible();
  await page.screenshot({ path: `.cache/previews/compose-sleep-${info.project.name}.png` });
  await click(page, page.getByRole('button', { name: 'この睡眠前後の日時を入力', exact: true }));
  await expect(page.getByRole('textbox', { name: '開始日時（JST）', exact: true })).toBeVisible();
  await expect(page).toHaveURL(saved);
  await click(page, page.getByRole('button', { name: '表示する', exact: true }));
  await expect(page).not.toHaveURL(saved);
  await jump(page, '心拍');
  await expect(page.getByRole('img', { name: /心拍の1分平均/ })).toHaveCount(1);
});

test('部分期間でも睡眠詳細には実際の開始と終了を表示する', async ({ page }) => {
  const now = new Date();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 21);
  const from = new Date(end - 6 * 3_600_000).toISOString(), to = new Date(end - 5 * 3_600_000).toISOString();
  const jst = (time: number) => new Date(time + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
  await boot(page, `/?${new URLSearchParams({ from, to })}`);
  await jump(page, '睡眠');
  await expect(page.getByRole('img', { name: '睡眠段階のタイムライン', exact: true })).toHaveCount(1);
  await click(page, page.getByRole('button', { name: /^\+ 詳細を見る/ }).first());
  await reveal(page, page.getByText(/^実際の終了：/));
  await expect(page.getByText(`実際の開始：${jst(end - 8 * 3_600_000)} JST`, { exact: true })).toBeVisible();
  await expect(page.getByText(`実際の終了：${jst(end)} JST`, { exact: true })).toBeVisible();
});

test('途中ページの失敗時に部分データを完全な集計として表示しない', async ({ page }) => {
  await page.route('**/api/v1/sleep?*', route => new URL(route.request().url()).searchParams.has('cursor')
    ? route.fulfill({ status: 503, json: { error: { code: 'storage-unavailable' } } }) : route.continue());
  await boot(page);
  await click(page, page.getByRole('button', { name: '90日', exact: true }));
  await jump(page, '睡眠');
  await expect(page.getByText('睡眠の記録を読み取れません。再試行してください。', { exact: true })).toBeVisible();
  await expect(page.getByText(/^表示期間内の合計：/)).toHaveCount(0);
  await jump(page, '心拍');
  await expect(page.getByRole('img', { name: /心拍の1日（JST）平均/ })).toHaveCount(1);
});

test('未取得期間と取得成功した空データを区別する', async ({ page }) => {
  let coverage = 'not-fetched';
  await page.route('**/api/v1/sleep?*', async route => {
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { ...body, sessions: [], nextCursor: null, coverage } });
  });
  await boot(page);
  await jump(page, '睡眠');
  await expect(page.getByText('この期間の睡眠は未取得、または一部だけ取得済みです。', { exact: true })).toBeVisible();
  coverage = 'fetched';
  await boot(page, page.url());
  await jump(page, '睡眠');
  await expect(page.getByText(/^この期間に取得できた睡眠はありません。/)).toBeVisible();
  await expect(page.getByText(/^この期間の取得は完了していません。/)).toHaveCount(0);
});
