import { afterEach, describe, expect, it } from 'vitest';
import { blankState, emptyPoints, floorMinute, retentionStart } from '@healthcheck/core';
import { createApp, type ReadStore } from './app.js';

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const now = Date.parse('2026-10-11T03:00:30Z');
const store: ReadStore = { emulator: true, state: async () => blankState(), read: async range => emptyPoints(range) };
async function setup(input = store) { const app = await createApp(input, { now: () => now, staticRoot: '/does-not-exist' }); apps.push(app); return app; }
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
describe('公開API', () => {
  it('稼働確認はDB障害時にもプロセスの起動を確認できる', async () => {
    const fail = async () => { throw new Error('database unavailable'); };
    const app = await setup({ emulator: false, read: fail, state: fail });
    const response = await app.inject('/api/v1/health');
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ ok: true });
  });
  it('未同期を空白の1440分と状態で返す。0を作らない', async () => {
    const res = await (await setup()).inject('/api/v1/timeseries');
    const body = res.json();
    expect(res.statusCode).toBe(200); expect(body.points).toHaveLength(1440);
    expect(body.summary).toMatchObject({ avg: null, availableMinutes: 0 });
    expect(body.status).toMatchObject({ state: 'not-synced', environment: 'emulator' });
    expect(res.headers['cache-control']).toBe('public, max-age=30');
  });
  it.each(['metric=sleep', 'resolution=1s', 'from=invalid&to=invalid', 'from=2026-01-01T00:00:00Z&to=2026-01-01T00:01:00Z', 'from=2026-10-01T00:00:00Z&to=2026-10-10T00:00:00Z&resolution=1m'])('不正クエリを400で返す %s', async query => {
    const res = await (await setup()).inject(`/api/v1/timeseries?${query}`);
    expect(res.statusCode).toBe(400); expect(res.json().error.code).toBe('invalid-query');
    expect(res.headers['cache-control']).toBe('no-store');
  });
  it.each(['/api/v1/timeseries', '/api/v1/summary', '/api/v1/status'])('DB失敗は503で返し内部例外を公開しない %s', async url => {
    const fail = async () => { throw new Error('refresh_token=SECRET private-user-id'); };
    const res = await (await setup({ emulator: false, read: fail, state: fail })).inject(url);
    expect(res.statusCode).toBe(503); expect(res.body).not.toContain('SECRET');
  });
  it('90日APIはautoで日集計、明示1mの上限超えと保存境界外は400', async () => {
    const app = await setup();
    const range = { from: new Date(retentionStart(now)).toISOString(), to: new Date(floorMinute(now)).toISOString() };
    const q = new URLSearchParams(range);
    const res = await app.inject(`/api/v1/timeseries?${q}&resolution=auto`);
    expect(res.statusCode).toBe(200); expect(res.json().resolution).toBe('1d');
    expect(res.json().points.length).toBeLessThanOrEqual(91);
    expect(res.json().points.every((p: { value: unknown }) => p.value === null)).toBe(true);
    expect((await app.inject(`/api/v1/timeseries?${q}&resolution=1m`)).statusCode).toBe(400);
    q.set('from', new Date(retentionStart(now) - 60_000).toISOString());
    expect((await app.inject(`/api/v1/timeseries?${q}`)).statusCode).toBe(400);
  });
});
