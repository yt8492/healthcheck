import { afterEach, describe, expect, it } from 'vitest';
import { DAY, blankState, emptyPoints, normalizeSleep, type SleepResponse, type SleepSession } from '@healthcheck/core';
import { createApp } from './app.js';
import { sleepPoint } from '../../../tests/fixtures.js';

const now = Date.parse('2026-10-11T03:00:30Z');
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const range = { from: '2026-10-09T15:00:00.000Z', to: '2026-10-09T16:00:00.000Z' };
async function setup(sessions: SleepSession[] = [], fail = false) {
  const app = await createApp({ emulator: true, read: async r => emptyPoints(r), state: async () => blankState(),
    sleep: { state: async () => blankState(), read: async () => { if (fail) throw new Error('private secret'); return sessions; } } }, { now: () => now });
  apps.push(app); return app;
}
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
describe('睡眠APIのページング・契約', () => {
  it('50件ずつ、同じ終了時刻もIDで安定して全件返す', async () => {
    const sessions = Array.from({ length: 113 }, (_, i) => normalizeSleep((i + 1).toString(16).padStart(64, '0'), sleepPoint(i).sleep));
    const app = await setup(sessions);
    let cursor: string | null = null;
    const received: string[] = [];
    do {
      const response = await app.inject(`/api/v1/sleep?${new URLSearchParams({ ...range, ...(cursor ? { cursor } : {}) })}`);
      expect(response.statusCode).toBe(200);
      const body: SleepResponse = response.json(); expect(body.sessions.length).toBeLessThanOrEqual(50);
      received.push(...body.sessions.map((s: SleepSession) => s.id)); cursor = body.nextCursor;
    } while (cursor);
    expect(received).toEqual(sessions.map(s => s.id)); expect(new Set(received).size).toBe(113);
  });
  it.each(['cursor=bad', 'cursor=%5B%5D', 'from=invalid&to=invalid', 'from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z'])('不正なクエリを400で返す %s', async query => {
    const response = await (await setup()).inject(`/api/v1/sleep?${query}`);
    expect(response.statusCode).toBe(400); expect(response.headers['cache-control']).toBe('no-store');
  });
  it('他の期間のcursorを受け付けない', async () => {
    const app = await setup();
    const cursor = Buffer.from(JSON.stringify({ ...range, from: '2026-10-08T00:00:00.000Z', id: '0'.repeat(64), endTime: range.to })).toString('base64url');
    expect((await app.inject(`/api/v1/sleep?${new URLSearchParams({ ...range, cursor })}`)).statusCode).toBe(400);
  });
  it('取得前は空配列と未取得状態を返す', async () => {
    const response = await (await setup()).inject('/api/v1/sleep');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ sessions: [], nextCursor: null, status: { metric: 'sleep', state: 'not-synced' } });
  });
  it('90日までの睡眠を検索でき、期限外のセッションを返さない', async () => {
    const from = new Date(Math.ceil((now - 90 * DAY) / 60_000) * 60_000).toISOString();
    const old = normalizeSleep('0'.repeat(64), sleepPoint(1, '2026-01-01T00:00:00Z', '2026-01-01T08:00:00Z').sleep);
    const response = await (await setup([old])).inject(`/api/v1/sleep?${new URLSearchParams({ from, to: '2026-10-11T03:00:00Z' })}`);
    expect(response.statusCode).toBe(200); expect(response.json().sessions).toEqual([]);
    expect(Number(response.headers['cache-control']?.toString().split('=').at(-1))).toBeLessThanOrEqual(30);
  });
  it('DB障害を空データとせず503で返す', async () => {
    const response = await (await setup([], true)).inject('/api/v1/sleep');
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain('secret');
  });
});
