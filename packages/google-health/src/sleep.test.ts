import { describe, expect, it } from 'vitest';
import { GoogleHealthClient } from './index.js';
import { sleepPoint } from '../../../tests/fixtures.js';

const range = { from: '2026-10-09T00:00:00.000Z', to: '2026-10-10T00:00:00.000Z' };
describe('Google Healthの睡眠取得', () => {
  it('終了時刻フィルター・25件・reconcileで全ページを取得し、本人IDを除く', async () => {
    const calls: URL[] = [];
    const client = new GoogleHealthClient(async (url, init) => {
      calls.push(new URL(url)); expect(init.method).toBe('GET');
      return Response.json(calls.length === 1 ? { dataPoints: [sleepPoint(1)], nextPageToken: 'next' } : { dataPoints: [sleepPoint(2)] });
    });
    const sessions = await client.sleepSessions(range);
    expect(sessions).toHaveLength(2); expect(sessions[0]?.id).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(sessions)).not.toContain('fictional');
    expect(calls[0]?.pathname).toContain('dataPoints:reconcile');
    expect(calls[0]?.searchParams.get('pageSize')).toBe('25');
    expect(calls[0]?.searchParams.get('filter')).toBe(`sleep.interval.end_time >= "${range.from}" AND sleep.interval.end_time < "${range.to}"`);
    expect(calls[1]?.searchParams.get('pageToken')).toBe('next');
  });
  it('正常な空データと権限不足を区別する', async () => {
    expect(await new GoogleHealthClient(async () => Response.json({})).sleepSessions(range)).toEqual([]);
    await expect(new GoogleHealthClient(async () => new Response('private payload', { status: 403 })).sleepSessions(range)).rejects.toMatchObject({ code: 'access-denied' });
  });
  it.each(['duplicate', 'bad-stage', 'bad-interval', 'bad-name', 'outside', 'loop'])('不正値・ページ循環を保存へ渡さない %s', async kind => {
    const point = sleepPoint(1);
    if (kind === 'bad-stage') point.sleep.stages[0]!.type = 'future-stage';
    if (kind === 'bad-interval') point.sleep.interval.endTime = 'bad';
    if (kind === 'bad-name') point.dataPointName = 'private invalid name';
    if (kind === 'outside') point.sleep.interval.endTime = range.to;
    const client = new GoogleHealthClient(async () => Response.json({ dataPoints: kind === 'loop' ? [] : kind === 'duplicate' ? [point, point] : [point],
      ...(kind === 'loop' ? { nextPageToken: 'same' } : {}) }));
    await expect(client.sleepSessions(range)).rejects.toMatchObject({ code: 'invalid-upstream-data' });
  });
  it('途中ページの失敗は空データとして成功させない', async () => {
    let count = 0;
    const client = new GoogleHealthClient(async () => ++count === 1 ? Response.json({ dataPoints: [sleepPoint(1)], nextPageToken: 'next' }) : new Response('', { status: 401 }));
    await expect(client.sleepSessions(range)).rejects.toMatchObject({ code: 'reauth-required' });
  });
});
