import { createHash } from 'node:crypto';
import { Firestore, type DocumentSnapshot } from '@google-cloud/firestore';
import { z } from 'zod';
import { HOUR, MINUTE, SOURCE_FAMILY, blankState, emptyPoints, heartValueSchema, hourStarts, retentionStart,
  type HeartPoint, type HeartValue, type SyncState, type TimeRange } from '@healthcheck/core';

const hourSchema = z.object({
  schemaVersion: z.literal(1), metric: z.literal('heart-rate'), hourStart: z.string(),
  points: z.array(heartValueSchema.nullable()).length(60), sourceFamily: z.literal(SOURCE_FAMILY),
  contentHash: z.string(), updatedAt: z.string(),
});
import { MetricStore } from './metric.js';
import { SleepStore } from './sleep.js';
export { SleepStore } from './sleep.js';
export { LeaseBusyError, LeaseExpiredError } from './metric.js';

export function hourId(hour: string): string { return `heart-rate_${hour}`; }
function hash(points: (HeartValue | null)[]): string { return createHash('sha256').update(JSON.stringify(points)).digest('hex'); }
function readHour(doc: DocumentSnapshot): (HeartValue | null)[] {
  if (!doc.exists) return Array<HeartValue | null>(60).fill(null);
  const value = hourSchema.parse(doc.data());
  if (doc.id !== hourId(value.hourStart)) throw new Error('保存された時間とIDが一致しません。');
  return value.points;
}

export class HeartStore extends MetricStore {
  constructor(db: Firestore, clock = Date.now) { super(db, clock, 'heart-rate'); }
  get sleep(): SleepStore { return new SleepStore(this.db, this.clock); }

  async read(range: TimeRange): Promise<HeartPoint[]> {
    const refs = hourStarts(range).map(hour => this.db.doc(`seriesHourly/${hourId(hour)}`));
    const docs = await this.db.getAll(...refs);
    const hours = new Map(docs.map(doc => [doc.id, readHour(doc)]));
    return emptyPoints(range).map(point => {
      const ms = Date.parse(point.time), start = Math.floor(ms / HOUR) * HOUR;
      return { time: point.time, value: hours.get(hourId(new Date(start).toISOString()))?.[(ms - start) / MINUTE] ?? null };
    });
  }

  async replace(range: TimeRange, points: HeartPoint[], owner: string): Promise<{ changedHours: number; availableMinutes: number }> {
    const expected = emptyPoints(range);
    if (expected.length > 7 * 24 * 60 || points.length !== expected.length) throw new Error('保存する範囲とポイント数が一致しません。');
    points.forEach((point, index) => {
      if (point.time !== expected[index]?.time) throw new Error('心拍の時間順序が不正です。');
      if (point.value !== null) heartValueSchema.parse(point.value);
    });
    const starts = hourStarts(range), refs = starts.map(hour => this.db.doc(`seriesHourly/${hourId(hour)}`));
    return this.db.runTransaction(async tx => {
      await this.checkLease(tx, owner);
      const [stateDoc, ...docs] = await tx.getAll(this.stateRef(), ...refs);
      const previous = stateDoc?.exists ? { ...blankState(), ...stateDoc.data() } as SyncState : blankState();
      const values = new Map(points.map(point => [point.time, point.value]));
      let changedHours = 0;
      let dataThrough = previous.dataThrough;
      const older = (!dataThrough || (dataThrough >= range.from && dataThrough < range.to))
        ? await tx.get(this.db.collection('seriesHourly').where('hourStart', '<', starts[0]).orderBy('hourStart', 'desc').limit(1)) : null;
      const updatedAt = new Date(this.clock()).toISOString();
      for (const doc of docs) {
        const hour = starts[refs.findIndex(ref => ref.id === doc.id)];
        if (!hour) throw new Error('時間ドキュメントを識別できません。');
        const data = readHour(doc), start = Date.parse(hour);
        for (let i = 0; i < 60; i++) {
          const time = new Date(start + i * MINUTE).toISOString();
          if (values.has(time)) data[i] = values.get(time) ?? null;
        }
        const contentHash = hash(data);
        if (!doc.exists && data.every(value => value === null)) continue;
        if (doc.exists && doc.get('contentHash') === contentHash) continue;
        changedHours++;
        if (data.every(value => value === null)) tx.delete(doc.ref);
        else tx.set(doc.ref, { schemaVersion: 1, metric: 'heart-rate', hourStart: hour, points: data,
          contentHash, sourceFamily: SOURCE_FAMILY, updatedAt });
      }
      // 最新測定が今回の訂正区間内にある場合は、削除された値も反映する。
      if (!dataThrough || (dataThrough >= range.from && dataThrough < range.to)) {
        dataThrough = [...points].reverse().find(point => point.value !== null)?.time ?? null;
        // 区間外に残っている同じ時間の測定も考慮する。
        for (const doc of docs) {
          if (!doc.exists) continue;
          const hour = hourSchema.parse(doc.data());
          hour.points.forEach((value, i) => {
            const time = new Date(Date.parse(hour.hourStart) + i * MINUTE).toISOString();
            if (value && (time < range.from || time >= range.to) && (!dataThrough || time > dataThrough)) dataThrough = time;
          });
        }
        for (const doc of older?.docs ?? []) {
          const hour = hourSchema.parse(doc.data());
          hour.points.forEach((value, i) => {
            const time = new Date(Date.parse(hour.hourStart) + i * MINUTE).toISOString();
            if (value && Date.parse(time) >= retentionStart(this.clock()) && (!dataThrough || time > dataThrough)) dataThrough = time;
          });
        }
      }
      for (const point of points) if (point.value && (!dataThrough || point.time > dataThrough)) dataThrough = point.time;
      tx.set(this.stateRef(), { ...previous, lastAttemptAt: updatedAt, lastSuccessAt: updatedAt, lastRange: range, dataThrough, error: null });
      tx.delete(this.leaseRef());
      return { changedHours, availableMinutes: points.filter(point => point.value !== null).length };
    });
  }

  async prune(): Promise<number> {
    const owner = await this.acquire();
    try {
      const cutoff = retentionStart(this.clock()), hour = new Date(Math.floor(cutoff / HOUR) * HOUR).toISOString();
      let removed = 0;
      // 小さなトランザクションに分け、書き込み上限を越えない。毎回ロックを確認する。
      while (true) {
        const count = await this.db.runTransaction(async tx => {
          await this.checkLease(tx, owner);
          const docs = await tx.get(this.db.collection('seriesHourly').where('hourStart', '<', hour).limit(200));
          for (const doc of docs.docs) tx.delete(doc.ref);
          return docs.size;
        });
        removed += count;
        if (count < 200) break;
      }
      await this.db.runTransaction(async tx => {
        await this.checkLease(tx, owner);
        const ref = this.db.doc(`seriesHourly/${hourId(hour)}`), doc = await tx.get(ref);
        const state = await tx.get(this.stateRef());
        if (doc.exists) {
          const data = readHour(doc);
          for (let i = 0; i < 60 && Date.parse(hour) + i * MINUTE < cutoff; i++) data[i] = null;
          if (data.every(value => value === null)) { tx.delete(ref); removed++; }
          else if (hash(data) !== doc.get('contentHash')) tx.update(ref, { points: data, contentHash: hash(data), updatedAt: new Date(this.clock()).toISOString() });
        }
        const through = state.get('dataThrough');
        if (typeof through === 'string' && Date.parse(through) < cutoff) tx.set(this.stateRef(), { dataThrough: null }, { merge: true });
        tx.delete(this.leaseRef());
      });
      return removed;
    } catch (error) { await this.fail(owner, 'storage-error'); throw error; }
  }
}

export function createStore(): HeartStore {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) throw new Error('GOOGLE_CLOUD_PROJECTを設定してください。');
  if (process.env.FIRESTORE_EMULATOR_HOST && !projectId.startsWith('demo-')) {
    throw new Error('Emulatorにはdemo-で始まる検証用プロジェクトIDを指定してください。');
  }
  return new HeartStore(new Firestore({ projectId, databaseId: '(default)' }));
}
