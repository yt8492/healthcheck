import { describe, expect, it, vi } from 'vitest';
import { GoogleHealthClient, HealthApiError } from './index.js';
import { rollupPage } from '../../../tests/fixtures.js';

const range = { from: '2026-10-10T00:00:00.000Z', to: '2026-10-10T00:03:00.000Z' };
const a = { time: range.from, value: { avg: 60, min: 55, max: 65 } };
const b = { time: '2026-10-10T00:02:00.000Z', value: { avg: 70, min: 65, max: 75 } };
describe('Google Health API', () => {
  it('同じ60秒・データ源・範囲で全ページを取得し欠損を補う', async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json(rollupPage([a], 'next'))).mockResolvedValueOnce(Response.json(rollupPage([b])));
    expect(await new GoogleHealthClient(request).heartRate(range)).toEqual([a, { time: '2026-10-10T00:01:00.000Z', value: null }, b]);
    const first = JSON.parse(request.mock.calls[0]?.[1].body);
    const second = JSON.parse(request.mock.calls[1]?.[1].body);
    // 公式rollUp契約では日時はrange内。未知のトップレベル項目は実APIが400で拒否する。
    expect(first).toEqual({ range: { startTime: range.from, endTime: range.to }, windowSize: '60s', pageSize: 10000,
      dataSourceFamily: 'users/me/dataSourceFamilies/google-wearables' });
    expect(second).toEqual({ ...first, pageToken: 'next' });
  });
  it('429のRetry-Afterを待ち、再試行する', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '2' } })).mockResolvedValueOnce(Response.json({}));
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await new GoogleHealthClient(request, sleep).heartRate(range)).toHaveLength(3);
    expect(sleep).toHaveBeenCalledWith(2000);
  });
  it('長いRetry-Afterでは短縮して再試行しない', async () => {
    const request = vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '120' } }));
    await expect(new GoogleHealthClient(request).heartRate(range)).rejects.toMatchObject({ code: 'upstream-unavailable' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('2ページ目の認証失敗を空データとして返さない', async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json(rollupPage([a], 'next'))).mockResolvedValueOnce(new Response('sensitive upstream body', { status: 401 }));
    await expect(new GoogleHealthClient(request).heartRate(range)).rejects.toMatchObject({ code: 'reauth-required' });
  });
  it('トークン更新エラーを通信リトライで隠さない', async () => {
    const request = vi.fn().mockRejectedValue(new HealthApiError('reauth-required', '再接続'));
    await expect(new GoogleHealthClient(request).heartRate(range)).rejects.toMatchObject({ code: 'reauth-required' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('同じnextPageTokenを繰り返す応答を拒否する', async () => {
    await expect(new GoogleHealthClient(async () => Response.json({ nextPageToken: 'repeat' })).heartRate(range)).rejects.toMatchObject({ code: 'invalid-upstream-data' });
  });
  it.each([
    { ...a, value: { avg: 80, min: 55, max: 65 } },
    { ...a, time: '2026-10-10T00:00:01.000Z' },
    { ...a, time: range.to },
  ])('不整合な値や区間を保存へ渡さない', async point => {
    await expect(new GoogleHealthClient(async () => Response.json(rollupPage([point]))).heartRate(range)).rejects.toMatchObject({ code: 'invalid-upstream-data' });
  });
  it('重複した区間を二重に集計しない', async () => {
    await expect(new GoogleHealthClient(async () => Response.json(rollupPage([a, a]))).heartRate(range)).rejects.toMatchObject({ code: 'invalid-upstream-data' });
  });
});
