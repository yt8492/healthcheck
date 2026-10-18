import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVITY_METRICS, DAY, MINUTE, HOUR, emptyActivity, floorMinute, retentionStart, type TimeRange } from '@healthcheck/core';
import { GoogleHealthClient } from '@healthcheck/google-health';
import { HeartStore, LeaseBusyError, LeaseExpiredError } from '@healthcheck/storage';
import { syncActivity, syncMetrics } from '../apps/sync/src/sync.js';
import { createApp } from '../apps/api/src/app.js';

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('活動の検証にはローカルEmulatorが必要です。');
const db = new Firestore({ projectId: 'demo-healthcheck' });
let now = Date.parse('2026-08-05T00:03:30Z');
const root = new HeartStore(db, () => now), steps = root.activity('steps');
const range = { from: '2026-08-01T14:59:00.000Z', to: '2026-08-01T15:03:00.000Z' };
const fixture = (r = range) => emptyActivity(r).map((p, i) => i === 0 ? { ...p, presence: 'value' as const, value: 0 } : i === 1 ? { ...p, presence: 'omitted' as const, value: null } : i === 2 ? { ...p, presence: 'value' as const, value: 12 } : p);
beforeEach(async () => {
  now = Date.parse('2026-08-05T00:03:30Z');
  const response = await fetch(`http://${host}/emulator/v1/projects/demo-healthcheck/databases/(default)/documents`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Emulatorを初期化できません。');
});
afterAll(async () => { await db.terminate(); });

describe('活動の保存・同期・API', () => {
  it('明示的0・省略・欠損を保存し、再実行を冪等にし、JSTの日別合計をAPIへ返す', async () => {
    expect(await steps.replace(range, fixture(), await steps.acquire())).toMatchObject({ changedHours: 2 });
    expect(await steps.replace(range, fixture(), await steps.acquire())).toMatchObject({ changedHours: 0 });
    expect(await steps.read(range)).toEqual(fixture());
    const app = await createApp(root, { now: () => now, staticRoot: '/does-not-exist' });
    try {
      const response = await app.inject(`/api/v1/timeseries?${new URLSearchParams({ ...range, metric: 'steps', resolution: '1m' })}`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ metric: 'steps', unit: 'steps', coverage: 'fetched', summary: { total: 12, availableMinutes: 2, omittedMinutes: 1, missingMinutes: 1,
        days: [{ date: '2026-08-01', total: 0, partialDay: true }, { date: '2026-08-02', total: 12, partialDay: true }] } });
      const summary = (await app.inject(`/api/v1/summary?${new URLSearchParams(range)}`)).json();
      expect(summary.activity.steps.summary.total).toBe(12);
      expect(summary.activity.distance.summary.total).toBeNull(); expect(summary.activity.distance.coverage).toBe('not-fetched');
      const status = (await app.inject('/api/v1/status')).json();
      expect(status.metrics.steps.state).toBe('ok'); expect(status.metrics.distance.state).toBe('not-synced');
    } finally { await app.close(); }
  });
  it('訂正と部分削除で隣の分・別指標を保持し、最新測定を過去へ戻す', async () => {
    const old: TimeRange = { from: '2026-07-30T00:00:00.000Z', to: '2026-07-30T00:01:00.000Z' };
    await steps.replace(old, [{ time: old.from, presence: 'value', value: 4 }], await steps.acquire());
    await steps.replace(range, fixture(), await steps.acquire());
    const distance = root.activity('distance'); await distance.replace(range, fixture(), await distance.acquire());
    const part = { from: '2026-08-01T15:00:00.000Z', to: range.to };
    await steps.replace(part, emptyActivity(part), await steps.acquire());
    expect((await steps.read(range)).map(p => p.value)).toEqual([0, null, null, null]);
    expect((await steps.state()).dataThrough).toBe(range.from);
    await steps.replace(range, emptyActivity(range), await steps.acquire());
    expect((await steps.state()).dataThrough).toBe(old.from);
    expect(await distance.read(range)).toEqual(fixture());
    expect((await steps.state()).completedRanges).toEqual([old, range]);
  });
  it('途中ページの失敗では値・成功日時・取得範囲を変更しない', async () => {
    await steps.replace(range, fixture(), await steps.acquire());
    const before = await steps.state(); let calls = 0;
    const client = new GoogleHealthClient(async () => ++calls === 1 ? Response.json({ nextPageToken: 'next' }) : new Response('private', { status: 403 }));
    await expect(syncActivity(client, steps, range)).rejects.toMatchObject({ code: 'access-denied' });
    expect(await steps.read(range)).toEqual(fixture());
    expect(await steps.state()).toMatchObject({ lastSuccessAt: before.lastSuccessAt, completedRanges: before.completedRanges, error: { code: 'access-denied' } });
  });
  it('指標の部分失敗でも他の活動・心拍・睡眠を実行する', async () => {
    const client = new GoogleHealthClient(async url => url.includes('/distance/') ? new Response('', { status: 403 }) : Response.json({}));
    const result = await syncMetrics(async () => client, root, range, 'all');
    expect(result).toEqual(['heart-rate', 'sleep', ...ACTIVITY_METRICS].map(metric => ({ metric, ok: metric !== 'distance' })));
    expect((await steps.state()).lastSuccessAt).not.toBeNull(); expect((await root.activity('distance').state()).error?.code).toBe('access-denied');
  });
  it('指標別のロックと期限を確認し、別の所有者の値を上書きしない', async () => {
    const owner = await steps.acquire(); const other = root.activity('distance');
    await other.fail(await other.acquire(), 'storage-error');
    await expect(steps.acquire()).rejects.toBeInstanceOf(LeaseBusyError);
    now += 11 * MINUTE;
    await expect(steps.replace(range, fixture(), owner)).rejects.toBeInstanceOf(LeaseExpiredError);
    await steps.fail(owner, 'storage-error');
    expect((await steps.state()).lastSuccessAt).toBeNull();
  });
  it('90日境界の時間を分単位で削除し、他指標を消さず、失敗時も期限削除する', async () => {
    const cutoff = retentionStart(now), hour = Math.floor(cutoff / HOUR) * HOUR;
    const old = { from: new Date(hour - HOUR).toISOString(), to: new Date(hour + HOUR).toISOString() };
    const points = emptyActivity(old).map(p => ({ ...p, presence: 'value' as const, value: 0 }));
    await steps.replace(old, points, await steps.acquire());
    await root.activity('distance').replace(old, points, await root.activity('distance').acquire());
    expect((await steps.read(old)).filter(p => p.presence === 'value')).toHaveLength((hour + HOUR - cutoff) / MINUTE);
    const client = new GoogleHealthClient(async () => new Response('', { status: 403 }));
    expect(await syncMetrics(async () => client, root, range, 'steps')).toEqual([{ metric: 'steps', ok: false }]);
    const remaining = await db.collection('activityHourly/steps/hours').get(); expect(remaining.size).toBe(1);
    expect(remaining.docs[0]!.get('points').slice(0, (cutoff - hour) / MINUTE).every((p: { presence: string }) => p.presence === 'missing')).toBe(true);
    expect((await db.collection('activityHourly/distance/hours').get()).size).toBe(2);
    now += 91 * DAY; await steps.prune();
    expect((await db.collection('activityHourly/steps/hours').get()).empty).toBe(true);
    expect((await steps.state()).dataThrough).toBeNull(); expect((await steps.state()).completedRanges).toEqual([]);
  });
  it('90日を日別に取得し、未取得を0にせず、不正な指標・粒度・範囲を400にする', async () => {
    const app = await createApp(root, { now: () => now, staticRoot: '/does-not-exist' });
    try {
      const long = { from: new Date(retentionStart(now)).toISOString(), to: new Date(floorMinute(now)).toISOString(), metric: 'distance', resolution: 'auto' };
      const response = await app.inject(`/api/v1/timeseries?${new URLSearchParams(long)}`);
      expect(response.statusCode).toBe(200); expect(response.json().points.length).toBeLessThanOrEqual(91);
      expect(response.json()).toMatchObject({ unit: 'm', resolution: '1d', coverage: 'not-fetched', summary: { total: null } });
      for (const query of [{ ...long, resolution: '1m' }, { ...range, metric: 'invalid' }, { ...range, metric: 'steps', resolution: '5m' }, { ...long, from: '2025-01-01T00:00:00Z' }]) {
        expect((await app.inject(`/api/v1/timeseries?${new URLSearchParams(query)}`)).statusCode).toBe(400);
      }
    } finally { await app.close(); }
  });
});
