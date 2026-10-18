import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY, HOUR, MINUTE, bucketHeartPoints, emptyPoints, recentRange, retentionStart, summarize } from '@healthcheck/core';
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
      expect(result.statusCode).toBe(200); expect(result.json().points.map(({ time, value }: typeof points[number]) => ({ time, value }))).toEqual(points);
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
  it('表示用集計は分値と同時に更新し、粒度を変えても平均・最小最大・欠損が一致する', async () => {
    const long = { from: '2026-10-08T14:58:00.000Z', to: '2026-10-10T15:02:00.000Z' };
    const points = emptyPoints(long).map((p, i) => ({ ...p, value: i % 67 === 0 || i > 1440 && i < 1500 ? null : { avg: 60 + i % 30, min: 45, max: 130 } }));
    await store.replace(long, points, await store.acquire());
    for (const resolution of ['1m', '5m', '1h', '1d'] as const) {
      expect(await store.readDisplay(long, resolution)).toEqual(bucketHeartPoints(points, long, resolution));
    }
    const partial = { from: '2026-10-08T14:59:00.000Z', to: '2026-10-10T15:01:00.000Z' };
    expect(await store.readDisplay(partial, '1d')).toEqual(bucketHeartPoints(points.slice(1, -1), partial, '1d'));
    const app = await createApp(store, { now: () => now, staticRoot: '/does-not-exist' });
    try {
      const res = await app.inject(`/api/v1/timeseries?${new URLSearchParams({ ...long, resolution: '1d' })}`);
      expect(res.statusCode).toBe(200); expect(res.json().summary).toEqual(summarize(points));
      expect(res.json().points).toEqual(bucketHeartPoints(points, long, '1d').points);
    } finally { await app.close(); }
  });
  it('同じ内容では集計を書き直さず、訂正された時間とJST日だけ更新する', async () => {
    const points = fixturePoints(range);
    await store.replace(range, points, await store.acquire());
    const before = await db.collection('heartDisplayHourly').get();
    const dayBefore = await db.collection('heartDisplayDaily').get();
    now += MINUTE;
    await store.replace(range, points, await store.acquire());
    expect((await db.collection('heartDisplayHourly').get()).docs.map(d => d.data())).toEqual(before.docs.map(d => d.data()));
    expect((await db.collection('heartDisplayDaily').get()).docs.map(d => d.data())).toEqual(dayBefore.docs.map(d => d.data()));
    const part = { from: points[15]!.time, to: points[16]!.time };
    await store.replace(part, [{ time: part.from, value: { avg: 150, min: 149, max: 151 } }], await store.acquire());
    expect((await db.collection('heartDisplayHourly').get()).docs.filter(d => d.get('updatedAt') === new Date(now).toISOString())).toHaveLength(1);
    expect((await db.collection('heartDisplayDaily').get()).docs.filter(d => d.get('updatedAt') === new Date(now).toISOString())).toHaveLength(1);
    const actual = (await store.readDisplay(range, '1h')).summary, expected = summarize(await store.read(range));
    expect(actual.avg).toBeCloseTo(expected.avg!, 10);
    expect({ ...actual, avg: null }).toEqual({ ...expected, avg: null });
    await store.replace(range, emptyPoints(range), await store.acquire());
    expect((await store.readDisplay(range, '1h')).points.every(p => p.value === null && p.availableMinutes === 0)).toBe(true);
    expect((await db.collection('heartDisplayDaily').get()).docs[0]?.get('totals.availableMinutes')).toBe(0);
  });
  it('既存分値の移行は成功時刻・分値を変えず、冪等に再開できる', async () => {
    await store.replace(range, fixturePoints(range), await store.acquire());
    for (const collection of ['heartDisplayHourly', 'heartDisplayDaily']) {
      const docs = await db.collection(collection).get();
      for (const doc of docs.docs) await doc.ref.delete();
    }
    const state = await store.state(), raw = await store.read(range);
    expect((await store.readDisplay(range, '1h')).summary).toEqual(summarize(raw));
    expect(await store.rebuildAggregates(range)).toBeGreaterThan(0);
    now += MINUTE;
    expect(await store.rebuildAggregates(range)).toBe(0);
    expect((await store.state()).lastSuccessAt).toBe(state.lastSuccessAt);
    expect(await store.read(range)).toEqual(raw);
  });
  it('全欠損で取得に成功した時間も空の集計を一度だけ保存する', async () => {
    expect(await store.replace(range, emptyPoints(range), await store.acquire())).toMatchObject({ changedHours: 0 });
    const before = (await db.collection('heartDisplayHourly').get()).docs.map(d => d.data());
    expect(before).toHaveLength(2);
    now += MINUTE;
    await store.replace(range, emptyPoints(range), await store.acquire());
    expect((await db.collection('heartDisplayHourly').get()).docs.map(d => d.data())).toEqual(before);
    const read = vi.spyOn(store, 'read');
    expect((await store.readDisplay(range, '1h')).summary).toMatchObject({ avg: null, availableMinutes: 0 });
    expect(read).not.toHaveBeenCalled(); read.mockRestore();
  });
  it('90日表示は日集計を読み、保存境界の1分値は集計後も保持・期限後に削除する', async () => {
    const cutoff = retentionStart(now);
    const first = { from: new Date(cutoff).toISOString(), to: new Date(cutoff + HOUR).toISOString() };
    await store.replace(first, emptyPoints(first).map(p => ({ ...p, value: { avg: 70, min: 65, max: 75 } })), await store.acquire());
    const long = { from: first.from, to: new Date(Math.floor(now / MINUTE) * MINUTE).toISOString() };
    for (let start = cutoff; start < Date.parse(long.to); start += 7 * DAY) {
      await store.rebuildAggregates({ from: new Date(start).toISOString(), to: new Date(Math.min(start + 7 * DAY, Date.parse(long.to))).toISOString() });
    }
    const reads = vi.spyOn(db, 'getAll');
    const result = await store.readDisplay(long, '1d');
    const documents = reads.mock.calls.reduce((count, call) => count + call.length, 0);
    reads.mockRestore();
    expect(result.points.length).toBeLessThanOrEqual(91);
    expect(documents).toBeLessThan(140);
    expect(result.summary).toMatchObject({ avg: 70, availableMinutes: 60 });
    expect(await store.read(first)).toHaveLength(60);
    now += 2 * MINUTE;
    await store.prune();
    expect((await store.read(first)).slice(0, 2).every(p => p.value === null)).toBe(true);
    expect((await store.read(first)).slice(2).every(p => p.value?.avg === 70)).toBe(true);
    const after = { ...long, from: new Date(retentionStart(now)).toISOString() };
    expect((await store.readDisplay(after, '1d')).summary.availableMinutes).toBe(58);
  }, 60_000);
});
