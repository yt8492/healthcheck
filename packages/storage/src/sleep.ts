import { createHash } from 'node:crypto';
import { type Firestore, type DocumentSnapshot } from '@google-cloud/firestore';
import { DAY, SOURCE_FAMILY, blankState, mergeSleepRanges, sleepTotals, wakeDate, SLEEP_STAGES,
  type SleepSession, type SyncState, type TimeRange } from '@healthcheck/core';
import { z } from 'zod';
import { MetricStore } from './metric.js';

const sessionSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), startTime: z.iso.datetime(), endTime: z.iso.datetime(),
  wakeDate: z.string(), type: z.enum(['stages', 'classic', 'unknown']), nap: z.boolean().nullable(),
  stages: z.array(z.object({ startTime: z.iso.datetime(), endTime: z.iso.datetime(), type: z.enum(SLEEP_STAGES) })),
});
function checked(input: unknown): SleepSession {
  const s = sessionSchema.parse(input);
  if (s.startTime >= s.endTime || s.wakeDate !== wakeDate(s.endTime) || !s.stages.length) throw new Error('睡眠の保存値が不正です。');
  let last = s.startTime;
  for (const stage of s.stages) {
    if (stage.startTime !== last || stage.endTime <= stage.startTime || stage.endTime > s.endTime) throw new Error('睡眠段階が連続していません。');
    last = stage.endTime;
  }
  if (last !== s.endTime) throw new Error('睡眠段階が不足しています。');
  return { ...s, ...sleepTotals(s.stages) };
}
function readSession(doc: DocumentSnapshot): SleepSession {
  const session = checked(doc.data());
  if (session.id !== doc.id || doc.get('schemaVersion') !== 1) throw new Error('睡眠ドキュメントが不正です。');
  return session;
}
const hash = (session: SleepSession) => createHash('sha256').update(JSON.stringify(session)).digest('hex');

export class SleepStore extends MetricStore {
  constructor(db: Firestore, clock = Date.now) { super(db, clock, 'sleep'); }
  async read(range: TimeRange): Promise<SleepSession[]> {
    const cutoff = new Date(this.clock() - 90 * DAY).toISOString();
    const docs = await this.db.collection('sleepSessions').where('endTime', '>', range.from > cutoff ? range.from : cutoff).orderBy('endTime').get();
    return docs.docs.map(readSession).filter(s => s.startTime < range.to && Date.parse(s.endTime) <= this.clock())
      .sort((a, b) => a.endTime.localeCompare(b.endTime) || a.id.localeCompare(b.id));
  }
  async replace(range: TimeRange, input: SleepSession[], owner: string): Promise<{ changedSessions: number; sessions: number }> {
    if (Date.parse(range.to) - Date.parse(range.from) > 7 * DAY) throw new Error('睡眠の同期範囲は最大7日です。');
    const sessions = input.map(checked), ids = new Set(sessions.map(s => s.id));
    if (ids.size !== sessions.length || sessions.some(s => s.endTime < range.from || s.endTime >= range.to)) throw new Error('睡眠の範囲または識別子が不正です。');
    if (sessions.some(s => Buffer.byteLength(JSON.stringify(s)) > 900_000)) throw new Error('睡眠ドキュメントのサイズ上限を超えています。');
    return this.db.runTransaction(async tx => {
      await this.checkLease(tx, owner);
      const stateDoc = await tx.get(this.stateRef());
      // 最新セッションの削除と時刻訂正を同じスナップショットで判定する。
      const existing = await tx.get(this.db.collection('sleepSessions'));
      const remaining = new Map(existing.docs.map(doc => [doc.id, readSession(doc)]));
      const changes: (() => void)[] = [];
      for (const doc of existing.docs) {
        const s = remaining.get(doc.id)!;
        if (s.endTime >= range.from && s.endTime < range.to && !ids.has(s.id)) {
          remaining.delete(s.id); changes.push(() => { tx.delete(doc.ref); });
        }
      }
      for (const s of sessions) {
        remaining.set(s.id, s);
        const contentHash = hash(s), old = existing.docs.find(doc => doc.id === s.id);
        if (old?.get('contentHash') === contentHash) continue;
        changes.push(() => { tx.set(this.db.doc(`sleepSessions/${s.id}`), { ...s, schemaVersion: 1, contentHash, sourceFamily: SOURCE_FAMILY,
          updatedAt: new Date(this.clock()).toISOString() }); });
      }
      if (changes.length > 400) throw new Error('睡眠の変更が多すぎます。同期範囲を短くしてください。');
      changes.forEach(write => write());
      const dataThrough = [...remaining.values()].filter(s => Date.parse(s.endTime) > this.clock() - 90 * DAY)
        .map(s => s.endTime).sort().at(-1) ?? null;
      const at = new Date(this.clock()).toISOString();
      const previous = stateDoc.exists ? stateDoc.data() as SyncState : blankState();
      const completedRanges = mergeSleepRanges([...(previous.completedRanges ?? (previous.lastRange ? [previous.lastRange] : [])), range], this.clock());
      tx.set(this.stateRef(), { ...previous, lastAttemptAt: at, lastSuccessAt: at, lastRange: range, completedRanges, dataThrough, error: null });
      tx.delete(this.leaseRef());
      return { changedSessions: changes.length, sessions: sessions.length };
    });
  }
  async prune(): Promise<number> {
    const owner = await this.acquire();
    try {
      let removed = 0;
      const cutoff = new Date(this.clock() - 90 * DAY).toISOString();
      while (true) {
        const count = await this.db.runTransaction(async tx => {
          await this.checkLease(tx, owner);
          const docs = await tx.get(this.db.collection('sleepSessions').where('endTime', '<=', cutoff).limit(200));
          docs.docs.forEach(doc => tx.delete(doc.ref));
          return docs.size;
        });
        removed += count;
        if (count < 200) break;
      }
      await this.db.runTransaction(async tx => {
        await this.checkLease(tx, owner);
        const state = await tx.get(this.stateRef());
        const through = state.get('dataThrough');
        if (typeof through === 'string' && through <= cutoff) tx.set(this.stateRef(), { dataThrough: null }, { merge: true });
        tx.delete(this.leaseRef());
      });
      return removed;
    } catch (error) { await this.fail(owner, 'storage-error'); throw error; }
  }
}
