import { createHash } from 'node:crypto';
import { type Firestore, type DocumentSnapshot } from '@google-cloud/firestore';
import { z } from 'zod';
import { HOUR, MINUTE, SOURCE_FAMILY, blankState, activitySampleSchema, emptyActivity, hourStarts, retentionStart, mergeSleepRanges,
  type ActivityMetric, type ActivityPoint, type ActivitySample, type SyncState, type TimeRange } from '@healthcheck/core';
import { MetricStore } from './metric.js';

const missing = (): ActivitySample => ({ presence: 'missing', value: null });
const schema = z.object({ schemaVersion: z.literal(1), metric: z.string(), hourStart: z.iso.datetime(),
  points: z.array(activitySampleSchema).length(60), sourceFamily: z.literal(SOURCE_FAMILY) });
const hash = (points: ActivitySample[]) => createHash('sha256').update(JSON.stringify(points)).digest('hex');
export class ActivityStore extends MetricStore {
  constructor(db: Firestore, readonly metric: ActivityMetric, clock = Date.now) { super(db, clock, metric); }
  private collection() { return this.db.collection(`activityHourly/${this.metric}/hours`); }
  private ref(hour: string) { return this.collection().doc(hour); }
  private values(doc: DocumentSnapshot): ActivitySample[] {
    if (!doc.exists) return Array.from({ length: 60 }, missing);
    const value = schema.parse(doc.data());
    if (value.metric !== this.metric || doc.id !== this.ref(value.hourStart).id) throw new Error('活動ドキュメントが不正です。');
    return value.points;
  }
  async read(range: TimeRange): Promise<ActivityPoint[]> {
    const docs = await this.db.getAll(...hourStarts(range).map(hour => this.ref(hour)));
    const hours = new Map(docs.map(doc => [doc.id, this.values(doc)]));
    const cutoff = retentionStart(this.clock());
    return emptyActivity(range).map(p => {
      const ms = Date.parse(p.time), hour = Math.floor(ms / HOUR) * HOUR;
      return { ...p, ...(ms < cutoff ? missing() : hours.get(this.ref(new Date(hour).toISOString()).id)?.[(ms - hour) / MINUTE] ?? missing()) };
    });
  }
  async replace(range: TimeRange, points: ActivityPoint[], owner: string): Promise<{ changedHours: number; availableMinutes: number }> {
    const expected = emptyActivity(range);
    if (!expected.length || expected.length > 7 * 1440 || expected.length !== points.length) throw new Error('活動の保存範囲が不正です。');
    points.forEach((p, i) => { if (p.time !== expected[i]!.time) throw new Error('活動の時間順序が不正です。'); activitySampleSchema.parse(p); });
    const starts = hourStarts(range), refs = starts.map(hour => this.ref(hour));
    return this.db.runTransaction(async tx => {
      await this.checkLease(tx, owner);
      const state = await tx.get(this.stateRef());
      const docs = await tx.getAll(...refs);
      // 指標を絞った最新時間の検索。全消去した場合も正しいdataThroughへ戻す。
      const latest = await tx.get(this.collection().orderBy('latestValueTime', 'desc').limit(starts.length + 1));
      const previous = state.exists ? { ...blankState(), ...state.data() } as SyncState : blankState();
      const values = new Map(points.map(p => [p.time, { presence: p.presence, value: p.value } as ActivitySample]));
      const changed = new Map<string, ActivitySample[]>();
      const at = new Date(this.clock()).toISOString();
      let changedHours = 0;
      docs.forEach((doc, n) => {
        const data = this.values(doc), hour = starts[n]!;
        for (let i = 0; i < 60; i++) {
          const time = new Date(Date.parse(hour) + i * MINUTE).toISOString();
          if (values.has(time)) data[i] = values.get(time)!;
        }
        changed.set(hour, data);
        const contentHash = hash(data);
        if (doc.exists && doc.get('contentHash') === contentHash) return;
        if (!doc.exists && data.every(p => p.presence === 'missing')) return;
        changedHours++;
        if (data.every(p => p.presence === 'missing')) tx.delete(doc.ref);
        else tx.set(doc.ref, { schemaVersion: 1, metric: this.metric, hourStart: hour, points: data, sourceFamily: SOURCE_FAMILY, contentHash, updatedAt: at,
          latestValueTime: data.map((p, i) => p.presence === 'value' ? new Date(Date.parse(hour) + i * MINUTE).toISOString() : null).filter(v => v !== null).at(-1) ?? null });
      });
      // dataThroughは最新の数値の分。削除・省略への訂正も反映する。
      let dataThrough = previous.dataThrough;
      if (!dataThrough || (dataThrough >= range.from && dataThrough < range.to)) {
        dataThrough = null;
        // 下記クエリは書き込み前に読み取り済み。置換範囲より古い値への復帰も確認。
        for (const doc of latest.docs) if (!changed.has(doc.get('hourStart'))) changed.set(doc.get('hourStart'), this.values(doc));
        for (const [hour, data] of changed) data.forEach((p, i) => {
          const time = new Date(Date.parse(hour) + i * MINUTE).toISOString();
          if (p.presence === 'value' && Date.parse(time) >= retentionStart(this.clock()) && (!dataThrough || time > dataThrough)) dataThrough = time;
        });
      }
      for (const p of points) if (p.presence === 'value' && (!dataThrough || p.time > dataThrough)) dataThrough = p.time;
      tx.set(this.stateRef(), { ...previous, lastAttemptAt: at, lastSuccessAt: at, lastRange: range,
        completedRanges: mergeSleepRanges([...(previous.completedRanges ?? []), range], this.clock()), dataThrough, error: null });
      tx.delete(this.leaseRef());
      return { changedHours, availableMinutes: points.filter(p => p.presence === 'value').length };
    });
  }
  async prune(): Promise<number> {
    const owner = await this.acquire();
    try {
      const cutoff = retentionStart(this.clock()), hour = new Date(Math.floor(cutoff / HOUR) * HOUR).toISOString();
      let removed = 0;
      while (true) {
        const count = await this.db.runTransaction(async tx => {
          await this.checkLease(tx, owner);
          const docs = await tx.get(this.collection().where('hourStart', '<', hour).limit(200));
          docs.docs.forEach(doc => tx.delete(doc.ref));
          return docs.size;
        });
        removed += count;
        if (count < 200) break;
      }
      await this.db.runTransaction(async tx => {
        await this.checkLease(tx, owner);
        const ref = this.ref(hour), doc = await tx.get(ref), state = await tx.get(this.stateRef());
        if (doc.exists) {
          const data = this.values(doc);
          for (let i = 0; i < 60 && Date.parse(hour) + i * MINUTE < cutoff; i++) data[i] = missing();
          if (data.every(p => p.presence === 'missing')) { tx.delete(ref); removed++; }
          else if (hash(data) !== doc.get('contentHash')) tx.update(ref, { points: data, contentHash: hash(data), updatedAt: new Date(this.clock()).toISOString(), latestValueTime: data.map((p, i) => p.presence === 'value' ? new Date(Date.parse(hour) + i * MINUTE).toISOString() : null).filter(v => v !== null).at(-1) ?? null });
        }
        const previous = state.exists ? state.data() as SyncState : blankState();
        tx.set(this.stateRef(), { completedRanges: mergeSleepRanges(previous.completedRanges ?? [], this.clock()),
          dataThrough: previous.dataThrough && Date.parse(previous.dataThrough) >= cutoff ? previous.dataThrough : null }, { merge: true });
        tx.delete(this.leaseRef());
      });
      return removed;
    } catch (error) { await this.fail(owner, 'storage-error'); throw error; }
  }
}
