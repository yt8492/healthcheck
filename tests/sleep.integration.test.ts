import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, MINUTE, normalizeSleep, recentRange, retentionStart } from '@healthcheck/core';
import { GoogleHealthClient } from '@healthcheck/google-health';
import { HeartStore, LeaseBusyError, LeaseExpiredError } from '@healthcheck/storage';
import { syncMetrics, syncSleep } from '../apps/sync/src/sync.js';
import { createApp } from '../apps/api/src/app.js';
import { fixturePoints, rollupPage, sleepPoint } from './fixtures.js';

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('睡眠の検証にはローカルEmulatorが必要です。');
const db = new Firestore({ projectId: 'demo-healthcheck' });
let now = Date.parse('2026-10-11T03:00:30Z');
const heart = new HeartStore(db, () => now), store = heart.sleep;
const range = recentRange(now, 48);
const id = '1'.padStart(64, '0');
beforeEach(async () => {
  now = Date.parse('2026-10-11T03:00:30Z');
  const response = await fetch(`http://${host}/emulator/v1/projects/demo-healthcheck/databases/(default)/documents`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Emulatorを初期化できません。');
});
afterAll(async () => { await db.terminate(); });

describe('睡眠の保存・同期・API', () => {
  it('reconcile→正規化→保存→重なり検索を通し、同じ値は再保存しない', async () => {
    const client = new GoogleHealthClient(async () => Response.json({ dataPoints: [sleepPoint(1)] }));
    expect(await syncSleep(client, store, range)).toMatchObject({ changedSessions: 1 });
    expect(await syncSleep(client, store, range)).toMatchObject({ changedSessions: 0 });
    const app = await createApp(heart, { now: () => now, staticRoot: '/does-not-exist' });
    try {
      const partial = { from: '2026-10-09T15:00:00Z', to: '2026-10-09T16:00:00Z' };
      const response = await app.inject(`/api/v1/sleep?${new URLSearchParams(partial)}`);
      expect(response.statusCode).toBe(200);
      const s = response.json().sessions[0];
      expect(s.startTime).toBe('2026-10-09T13:00:00.000Z'); expect(s.endTime).toBe('2026-10-09T21:00:00.000Z');
      expect(s.wakeDate).toBe('2026-10-10'); expect(s.stageMinutes.awake).toBeCloseTo(9.6);
      const summary = (await app.inject(`/api/v1/summary?${new URLSearchParams(partial)}`)).json();
      expect(summary.sleep.durationMinutes).toBe(60); expect(summary.sleep.stageMinutes.deep).toBe(60);
      const status = (await app.inject('/api/v1/status')).json();
      expect(status.metrics.sleep.state).toBe('ok'); expect(status.metrics['heart-rate'].state).toBe('not-synced');
      expect(response.body).not.toContain('fictional');
    } finally { await app.close(); }
  });
  it('訂正で開始・終了と起床日を更新し、成功した空のスナップショットで削除する', async () => {
    await store.replace(range, [normalizeSleep(id, sleepPoint(1).sleep)], await store.acquire());
    const corrected = normalizeSleep(id, sleepPoint(1, '2026-10-10T14:00:00Z', '2026-10-10T22:00:00Z').sleep);
    await store.replace(range, [corrected], await store.acquire());
    expect(await store.read(range)).toEqual([corrected]);
    expect((await store.state()).dataThrough).toBe(corrected.endTime);
    await store.replace(range, [], await store.acquire());
    expect(await store.read(range)).toEqual([]); expect((await store.state()).dataThrough).toBeNull();
    expect((await store.state()).completedRanges).toEqual([range]);
  });
  it('終了時刻の範囲だけを置換し、隣の取得範囲と昼寝を保持する', async () => {
    const a = normalizeSleep(id, sleepPoint(1).sleep);
    const b = normalizeSleep('2'.padStart(64, '0'), sleepPoint(2, '2026-10-10T03:00:00Z', '2026-10-10T03:30:00Z').sleep);
    await store.replace(range, [a, b], await store.acquire());
    await store.replace({ from: range.from, to: a.endTime }, [], await store.acquire());
    expect(await store.read(range)).toEqual([a, b]);
    await store.replace({ from: a.endTime, to: b.endTime }, [], await store.acquire());
    expect(await store.read(range)).toEqual([b]); expect((await store.state()).dataThrough).toBe(b.endTime);
  });
  it('途中ページが失敗しても既存値と成功時刻を保持する', async () => {
    const s = normalizeSleep(id, sleepPoint(1).sleep);
    await store.replace(range, [s], await store.acquire());
    const success = (await store.state()).lastSuccessAt;
    let calls = 0;
    const client = new GoogleHealthClient(async () => ++calls === 1 ? Response.json({ dataPoints: [sleepPoint(2)], nextPageToken: 'next' }) : new Response('secret', { status: 401 }));
    await expect(syncSleep(client, store, range)).rejects.toMatchObject({ code: 'reauth-required' });
    expect(await store.read(range)).toEqual([s]);
    expect(await store.state()).toMatchObject({ lastSuccessAt: success, error: { code: 'reauth-required' } });
  });
  it('睡眠の権限不足でも心拍の同期を完了する', async () => {
    const points = fixturePoints(range);
    const client = new GoogleHealthClient(async url => url.includes('/sleep/') ? new Response('', { status: 403 }) : Response.json(rollupPage(points)));
    expect((await syncMetrics(async () => client, heart, range, 'all')).slice(0, 2)).toEqual([{ metric: 'heart-rate', ok: true }, { metric: 'sleep', ok: false }]);
    expect((await heart.state()).lastSuccessAt).not.toBeNull(); expect((await store.state()).error?.code).toBe('access-denied');
    expect(await heart.read(range)).toEqual(points);
  });
  it('心拍の失敗でも睡眠の同期を完了する', async () => {
    const client = new GoogleHealthClient(async url => url.includes('/sleep/') ? Response.json({ dataPoints: [sleepPoint(1)] }) : new Response('', { status: 403 }));
    expect((await syncMetrics(async () => client, heart, range, 'all')).slice(0, 2)).toEqual([{ metric: 'heart-rate', ok: false }, { metric: 'sleep', ok: true }]);
    expect((await store.state()).lastSuccessAt).not.toBeNull(); expect((await heart.state()).error?.code).toBe('access-denied');
  });
  it('指標別のロックを持ち、期限切れの保存は拒否する', async () => {
    const owner = await store.acquire(), heartOwner = await heart.acquire();
    await expect(store.acquire()).rejects.toBeInstanceOf(LeaseBusyError);
    now += 11 * MINUTE;
    await expect(store.replace(range, [], owner)).rejects.toBeInstanceOf(LeaseExpiredError);
    await heart.fail(heartOwner, 'storage-error'); await store.fail(owner, 'storage-error');
  });
  it('90日の期限は終了日時を使い、残るセッションの開始を切り詰めない', async () => {
    const cutoff = now - 90 * DAY;
    const a = normalizeSleep(id, sleepPoint(1, new Date(cutoff - DAY).toISOString(), new Date(cutoff + DAY).toISOString()).sleep);
    const b = normalizeSleep('2'.padStart(64, '0'), sleepPoint(2, new Date(cutoff - DAY).toISOString(), new Date(cutoff).toISOString()).sleep);
    const oldRange = { from: new Date(cutoff - MINUTE).toISOString(), to: new Date(cutoff + 2 * DAY).toISOString() };
    await store.replace(oldRange, [a, b], await store.acquire());
    const publicRange = { from: new Date(retentionStart(now)).toISOString(), to: new Date(cutoff + 2 * DAY).toISOString() };
    expect(await store.read(publicRange)).toEqual([a]);
    expect(await store.prune()).toBe(1);
    expect((await db.collection('sleepSessions').get()).size).toBe(1);
    expect((await store.read(publicRange))[0]?.startTime).toBe(a.startTime);
  });
});
