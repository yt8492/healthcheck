import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DAY, HOUR, MINUTE, emptyPoints, recentRange, retentionStart } from '@healthcheck/core';
import { GoogleHealthClient, HealthApiError } from '@healthcheck/google-health';
import { HeartStore, LeaseBusyError, LeaseExpiredError } from '@healthcheck/storage';
import { syncHeart } from '../apps/sync/src/sync.js';
import { createApp } from '../apps/api/src/app.js';
import { fixturePoints, rollupPage } from './fixtures.js';

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('この検証にはローカルFirestore Emulatorが必要です。npm run test:emulatorを使ってください。');
const db = new Firestore({ projectId: 'demo-healthcheck' });
let now = Date.parse('2026-10-11T03:00:30Z');
const store = new HeartStore(db, () => now);
const range = recentRange(now, 2);
beforeEach(async () => {
  now = Date.parse('2026-10-11T03:00:30Z');
  const response = await fetch(`http://${host}/emulator/v1/projects/demo-healthcheck/databases/(default)/documents`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Emulatorを初期化できません。');
});
afterAll(async () => { await db.terminate(); });
describe('Firestoreを通した同期・API', () => {
  it('上流JSON→1時間doc→公開APIを通し、繰り返し取得で不要な書き込みをしない', async () => {
    const points = fixturePoints(range);
    const client = new GoogleHealthClient(async () => Response.json(rollupPage(points)));
    expect(await syncHeart(client, store, range)).toMatchObject({ changedHours: 2 });
    expect(await syncHeart(client, store, range)).toMatchObject({ changedHours: 0 });
    const docs = await db.collection('seriesHourly').get();
    expect(docs.size).toBe(2); expect(docs.docs[0]?.get('points')).toHaveLength(60);
    const app = await createApp(store, { now: () => now, staticRoot: '/does-not-exist' });
    try {
      const result = await app.inject(`/api/v1/timeseries?${new URLSearchParams(range)}`);
      expect(result.statusCode).toBe(200); expect(result.json().points).toEqual(points);
      expect(result.json().status.state).toBe('ok');
    } finally { await app.close(); }
  });
  it('部分時間の訂正・削除を反映し、範囲外の分は維持する', async () => {
    const points = fixturePoints(range);
    await store.replace(range, points, await store.acquire());
    const partial = { from: new Date(Date.parse(range.from) + 10 * MINUTE).toISOString(), to: new Date(Date.parse(range.from) + 20 * MINUTE).toISOString() };
    await store.replace(partial, emptyPoints(partial), await store.acquire());
    const actual = await store.read(range);
    expect(actual.slice(10, 20).every(p => p.value === null)).toBe(true);
    expect(actual.slice(0, 10)).toEqual(points.slice(0, 10)); expect(actual.slice(20)).toEqual(points.slice(20));
  });
  it('途中ページの失敗では既存値と成功時刻を保持し安全なエラーだけを返す', async () => {
    const points = fixturePoints(range);
    await store.replace(range, points, await store.acquire());
    const success = (await store.state()).lastSuccessAt;
    let count = 0;
    const client = new GoogleHealthClient(async () => ++count === 1 ? Response.json(rollupPage(points.slice(0, 10), 'next')) : new Response('private token payload', { status: 401 }));
    await expect(syncHeart(client, store, range)).rejects.toMatchObject({ code: 'reauth-required' });
    expect(await store.read(range)).toEqual(points);
    expect(await store.state()).toMatchObject({ lastSuccessAt: success, error: { code: 'reauth-required' } });
  });
  it('重複同期を止め、期限切れの実行は保存を更新できない', async () => {
    const owner = await store.acquire();
    expect((await store.state()).lastSuccessAt).toBeNull();
    await expect(store.acquire()).rejects.toBeInstanceOf(LeaseBusyError);
    now += 11 * MINUTE;
    await expect(store.replace(range, fixturePoints(range), owner)).rejects.toBeInstanceOf(LeaseExpiredError);
    const replacement = await store.acquire();
    await store.fail(owner, 'storage-error');
    expect((await db.doc('jobLease/heart-rate').get()).get('owner')).toBe(replacement);
    await store.fail(replacement, 'storage-error');
  });
  it('取得前のOAuth設定失敗も状態へ記録し、保存済みの値を維持する', async () => {
    const points = fixturePoints(range);
    await store.replace(range, points, await store.acquire());
    await expect(syncHeart(async () => { throw new HealthApiError('reauth-required', 'private details'); }, store, range)).rejects.toMatchObject({ code: 'reauth-required' });
    expect(await store.read(range)).toEqual(points);
    expect((await store.state()).error?.code).toBe('reauth-required');
  });
  it('成功した空データは削除を反映し、最新測定時刻を前の時間へ戻す', async () => {
    const points = fixturePoints(range);
    await store.replace(range, points, await store.acquire());
    const lastHour = { from: new Date(Date.parse(range.to) - HOUR).toISOString(), to: range.to };
    await store.replace(lastHour, emptyPoints(lastHour), await store.acquire());
    expect((await store.state()).dataThrough).toBe(new Date(Date.parse(range.to) - HOUR - MINUTE).toISOString());
    expect((await db.collection('seriesHourly').get()).size).toBe(1);
  });
  it('測定時刻で90日の境界を削除し、境界時間の新しい分だけ残す', async () => {
    const cutoff = retentionStart(now), first = cutoff - HOUR;
    const oldRange = { from: new Date(first).toISOString(), to: new Date(cutoff + HOUR).toISOString() };
    const points = emptyPoints(oldRange).map(p => ({ ...p, value: { avg: 70, min: 65, max: 75 } }));
    await store.replace(oldRange, points, await store.acquire());
    await store.prune();
    const actual = await store.read(oldRange);
    expect(actual.filter(p => Date.parse(p.time) < cutoff).every(p => p.value === null)).toBe(true);
    expect(actual.filter(p => Date.parse(p.time) >= cutoff).every(p => p.value?.avg === 70)).toBe(true);
    const app = await createApp(store, { now: () => now, staticRoot: '/does-not-exist' });
    try { expect((await app.inject(`/api/v1/timeseries?${new URLSearchParams(oldRange)}`)).statusCode).toBe(400); }
    finally { await app.close(); }
    expect(cutoff).toBeGreaterThan(now - 90 * DAY);
  });
});
