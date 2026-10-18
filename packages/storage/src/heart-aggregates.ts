import { createHash } from 'node:crypto';
import { type Firestore, type Transaction } from '@google-cloud/firestore';
import { z } from 'zod';
import { DAY, HOUR, MINUTE, heartDisplay, heartDuration, heartIntervals, heartTotals, hourStarts, mergeHeartTotals, retentionStart,
  type HeartDisplay, type HeartPoint, type HeartResolution, type HeartTotals, type HeartValue, type TimeRange } from '@healthcheck/core';

const totalsSchema = z.object({ sum: z.number().finite().nonnegative(), availableMinutes: z.number().int().nonnegative(),
  min: z.number().finite().positive().nullable(), max: z.number().finite().positive().nullable(),
  latest: z.object({ time: z.string(), avg: z.number().finite().positive() }).nullable() });
const hourSchema = z.object({ schemaVersion: z.literal(1), start: z.string(), totals: totalsSchema, fiveMinutes: z.array(totalsSchema).length(12) });
const daySchema = z.object({ schemaVersion: z.literal(1), start: z.string(), totals: totalsSchema });
export function heartAggregateRef(db: Firestore, kind: 'hour' | 'day', start: string) {
  return db.doc(`${kind === 'hour' ? 'heartDisplayHourly' : 'heartDisplayDaily'}/${start}`);
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function dayStart(time: number): number { return Math.floor((time + 9 * HOUR) / DAY) * DAY - 9 * HOUR; }
function minutePoints(start: string, values: (HeartValue | null)[], cutoff: number): HeartPoint[] {
  return values.map((value, i) => ({ time: new Date(Date.parse(start) + i * MINUTE).toISOString(), value: Date.parse(start) + i * MINUTE < cutoff ? null : value }));
}

// 全読み取りを先に終え、呼び出し元の分値・状態と同一トランザクションで確定する。
export async function prepareHeartAggregates(db: Firestore, tx: Transaction, changed: Map<string, (HeartValue | null)[]>, now: number) {
  if (!changed.size) return () => 0;
  const days = [...new Set([...changed.keys()].map(start => new Date(dayStart(Date.parse(start))).toISOString()))];
  const hours = days.flatMap(from => hourStarts({ from, to: new Date(Date.parse(from) + DAY).toISOString() }));
  const unchanged = hours.filter(hour => !changed.has(hour));
  const raw = unchanged.length ? await tx.getAll(...unchanged.map(hour => db.doc(`seriesHourly/heart-rate_${hour}`))) : [];
  const existingValues = new Map(unchanged.map((hour, i) => [hour, raw[i]!.get('points') as (HeartValue | null)[] | undefined]));
  const hourRefs = [...changed.keys()].map(start => heartAggregateRef(db, 'hour', start));
  const dayRefs = days.map(start => heartAggregateRef(db, 'day', start));
  const existing = await tx.getAll(...hourRefs, ...dayRefs);
  const cutoff = retentionStart(now);
  const byHour = new Map(hours.map(start => [start, minutePoints(start, changed.get(start) ?? existingValues.get(start) ?? Array<null>(60).fill(null), cutoff)]));
  const updates = [
    ...[...changed.keys()].map(start => {
      const points = byHour.get(start)!;
      return { schemaVersion: 1, start, totals: heartTotals(points), fiveMinutes: Array.from({ length: 12 }, (_, i) => heartTotals(points.slice(i * 5, i * 5 + 5))) };
    }),
    ...days.map(start => ({ schemaVersion: 1, start, totals: mergeHeartTotals(hours.filter(hour => dayStart(Date.parse(hour)) === Date.parse(start)).map(hour => heartTotals(byHour.get(hour)!))) })),
  ];
  return () => {
    let writes = 0;
    updates.forEach((value, i) => {
      const contentHash = digest(value), doc = existing[i]!;
      if (doc.exists && doc.get('contentHash') === contentHash) return;
      tx.set(doc.ref, { ...value, contentHash, updatedAt: new Date(now).toISOString() }); writes++;
    });
    return writes;
  };
}

export async function readHeartDisplay(db: Firestore, range: TimeRange, resolution: HeartResolution, read: (range: TimeRange) => Promise<HeartPoint[]>): Promise<HeartDisplay> {
  const intervals = heartIntervals(range, resolution);
  if (resolution === '1m') {
    const points = await read(range);
    return heartDisplay(intervals.map((part, i) => ({ range: part, totals: heartTotals([points[i]!]) })));
  }
  const refs = new Map<string, ReturnType<typeof heartAggregateRef>>();
  const plans = intervals.map(part => {
    if (Date.parse(part.to) - Date.parse(part.from) !== heartDuration(resolution)) return { part, key: null };
    const start = resolution === '1d' ? part.from : new Date(Math.floor(Date.parse(part.from) / HOUR) * HOUR).toISOString();
    const ref = heartAggregateRef(db, resolution === '1d' ? 'day' : 'hour', start);
    refs.set(ref.path, ref);
    return { part, key: ref.path };
  });
  const docs = refs.size ? await db.getAll(...refs.values()) : [];
  const stored = new Map(docs.map(doc => [doc.ref.path, doc]));
  // 未移行のドキュメントだけ分値へフォールバックする。読取専用APIは保存を変更しない。
  const rawHours = new Set<string>();
  for (const { part, key } of plans) if (!key || !stored.get(key)?.exists) for (const hour of hourStarts(part)) rawHours.add(hour);
  const raw = new Map<string, HeartPoint[]>();
  // 隣接する時間をまとめ、端数と未移行の範囲を重複して読まない。
  const sorted = [...rawHours].sort();
  const groups: TimeRange[] = [];
  for (const hour of sorted) {
    const last = groups.at(-1), to = new Date(Date.parse(hour) + HOUR).toISOString();
    if (last?.to === hour) last.to = to; else groups.push({ from: hour, to });
  }
  for (const group of groups) for (const point of await read(group)) {
    const hour = new Date(Math.floor(Date.parse(point.time) / HOUR) * HOUR).toISOString();
    if (!raw.has(hour)) raw.set(hour, []);
    raw.get(hour)!.push(point);
  }
  return heartDisplay(plans.map(({ part, key }) => {
    const doc = key ? stored.get(key) : undefined;
    let totals: HeartTotals;
    if (doc?.exists) {
      const parsed = (resolution === '1d' ? daySchema : hourSchema).parse(doc.data());
      if (doc.ref.path !== heartAggregateRef(db, resolution === '1d' ? 'day' : 'hour', parsed.start).path) throw new Error('心拍集計の期間が一致しません。');
      totals = resolution === '5m' ? hourSchema.parse(parsed).fiveMinutes[(Date.parse(part.from) % HOUR) / (5 * MINUTE)]! : parsed.totals;
    } else {
      totals = heartTotals(hourStarts(part).flatMap(hour => raw.get(hour) ?? []).filter(p => p.time >= part.from && p.time < part.to));
    }
    return { range: part, totals };
  }));
}
