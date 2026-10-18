import { describe, expect, it } from 'vitest';
import { GoogleHealthClient } from './index.js';
const range = { from: '2026-08-01T15:00:00.000Z', to: '2026-08-01T15:04:00.000Z' };
const window = (n: number, value: object) => ({ startTime: `2026-08-01T15:0${n}:00Z`, endTime: `2026-08-01T15:0${n + 1}:00Z`, ...value });
describe('活動の上流契約', () => {
  it('60sとsource familyで全ページ取得し、0・値省略・レコード欠損を保持する', async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const client = new GoogleHealthClient(async (url, init) => {
      const body = JSON.parse(init.body as string); requests.push({ url, body });
      return Response.json(body.pageToken ? { rollupDataPoints: [window(0, { steps: { countSum: '0' } }), window(1, {})] }
        : { rollupDataPoints: [window(2, { steps: { countSum: '35' } })], nextPageToken: 'next' });
    });
    const points = await client.activity('steps', range);
    expect(points.map(p => [p.presence, p.value])).toEqual([['value', 0], ['omitted', null], ['value', 35], ['missing', null]]);
    expect(requests[0]).toMatchObject({ url: 'https://health.googleapis.com/v4/users/me/dataTypes/steps/dataPoints:rollUp', body: {
      range: { startTime: range.from, endTime: range.to }, windowSize: '60s', dataSourceFamily: 'users/me/dataSourceFamilies/google-wearables' } });
    expect(requests[1]?.body.pageToken).toBe('next');
  });
  it('mmからmへ換算し、kcalを保持し、AZMを二重加重しない', async () => {
    const client = new GoogleHealthClient(async () => Response.json({ rollupDataPoints: [window(0, {
      distance: { millimetersSum: '1234' }, totalCalories: { kcalSum: 1.25 },
      activeZoneMinutes: { sumInFatBurnHeartZone: '1', sumInCardioHeartZone: '2', sumInPeakHeartZone: '2' },
    })] }));
    expect((await client.activity('distance', range))[0]?.value).toBe(1.234);
    expect((await client.activity('total-calories', range))[0]?.value).toBe(1.25);
    expect((await client.activity('active-zone-minutes', range))[0]?.value).toBe(5);
  });
  it.each([{ steps: {} }, {}])('値のないmessageを0へ変換しない %j', async value => {
    expect((await new GoogleHealthClient(async () => Response.json({ rollupDataPoints: [window(0, value)] })).activity('steps', range))[0]).toMatchObject({ presence: 'omitted', value: null });
  });
  it.each([{ countSum: '-1' }, { countSum: '1.5' }, { countSum: '9007199254740992' }, { countSum: 2 }])('不正な整数を保存しない %j', async steps => {
    await expect(new GoogleHealthClient(async () => Response.json({ rollupDataPoints: [window(0, { steps })] })).activity('steps', range)).rejects.toMatchObject({ code: 'invalid-upstream-data' });
  });
  it('循環ページ・重複・区間不正・途中失敗では部分結果を返さない', async () => {
    for (const body of [{ nextPageToken: 'loop' }, { rollupDataPoints: [window(0, {}), window(0, {})] }, { rollupDataPoints: [{ ...window(0, {}), endTime: range.to }] }]) {
      await expect(new GoogleHealthClient(async () => Response.json(body)).activity('steps', range)).rejects.toMatchObject({ code: 'invalid-upstream-data' });
    }
    let calls = 0;
    await expect(new GoogleHealthClient(async () => ++calls === 1 ? Response.json({ rollupDataPoints: [window(0, { steps: { countSum: '1' } })], nextPageToken: 'next' }) : new Response('', { status: 403 })).activity('steps', range)).rejects.toMatchObject({ code: 'access-denied' });
  });
});
