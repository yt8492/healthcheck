import { z } from 'zod';
import { DAY, HOUR, MINUTE, MAX_POINTS, InputError, type TimeRange, type PublicStatus, type SyncState } from './index.js';
import { mergeSleepRanges, wakeDate } from './sleep.js';

export const ACTIVITY_METRICS = ['steps', 'distance', 'total-calories', 'active-zone-minutes'] as const;
export type ActivityMetric = typeof ACTIVITY_METRICS[number];
export const activitySpecs = {
  steps: { label: '歩数', unit: 'steps', displayUnit: '歩', field: 'steps' },
  distance: { label: '距離', unit: 'm', displayUnit: 'm', field: 'distance' },
  'total-calories': { label: '総消費カロリー', unit: 'kcal', displayUnit: 'kcal', field: 'totalCalories' },
  'active-zone-minutes': { label: 'アクティブゾーン時間', unit: 'zone-minutes', displayUnit: 'ポイント', field: 'activeZoneMinutes' },
} as const;
export function isActivityMetric(value: unknown): value is ActivityMetric { return ACTIVITY_METRICS.includes(value as ActivityMetric); }
export const activitySampleSchema = z.discriminatedUnion('presence', [
  z.object({ presence: z.literal('value'), value: z.number().finite().nonnegative() }),
  z.object({ presence: z.literal('omitted'), value: z.null() }),
  z.object({ presence: z.literal('missing'), value: z.null() }),
]);
export type ActivitySample = z.infer<typeof activitySampleSchema>;
export type ActivityPoint = ActivitySample & { time: string };
export type ActivityResolution = '1m' | '1h' | '1d';
export type ActivityCoverage = 'not-fetched' | 'partial' | 'fetched';
export type ActivityTotals = { total: number | null; availableMinutes: number; omittedMinutes: number; missingMinutes: number; totalMinutes: number };
export type ActivityBucket = ActivityTotals & TimeRange;
export type ActivitySummary = ActivityTotals & { days: (ActivityBucket & { date: string; partialDay: boolean })[] };
export type ActivityResponse = TimeRange & {
  metric: ActivityMetric; unit: string; resolution: ActivityResolution; aggregation: 'sum-of-known-minute-values';
  points: ActivityBucket[]; summary: ActivitySummary; status: PublicStatus; coverage: ActivityCoverage;
};
export function emptyActivity(range: TimeRange): ActivityPoint[] {
  const result: ActivityPoint[] = [];
  for (let ms = Date.parse(range.from); ms < Date.parse(range.to); ms += MINUTE) result.push({ time: new Date(ms).toISOString(), presence: 'missing', value: null });
  return result;
}
export function activityCoverage(state: SyncState, range: TimeRange, now: number): ActivityCoverage {
  const completed = mergeSleepRanges(state.completedRanges ?? (state.lastRange ? [state.lastRange] : []), now);
  if (completed.some(r => r.from <= range.from && r.to >= range.to)) return 'fetched';
  return completed.some(r => r.from < range.to && r.to > range.from) ? 'partial' : 'not-fetched';
}
export function activityResolution(value: unknown, range: TimeRange): ActivityResolution {
  const minutes = (Date.parse(range.to) - Date.parse(range.from)) / MINUTE;
  if (value === undefined || value === 'auto') return minutes <= 2 * 1440 ? '1m' : minutes <= 14 * 1440 ? '1h' : '1d';
  if (value !== '1m' && value !== '1h' && value !== '1d') throw new InputError('活動のresolutionは1m、1h、1d、autoから選んでください。');
  if (value === '1m' && minutes > MAX_POINTS) throw new InputError('1mでは最大4096分です。auto、1h、1dを指定してください。');
  return value;
}
export function activityTotals(points: ActivityPoint[]): ActivityTotals {
  const known = points.filter(p => p.presence === 'value');
  return { total: known.length ? known.reduce((sum, p) => sum + p.value!, 0) : null, availableMinutes: known.length,
    omittedMinutes: points.filter(p => p.presence === 'omitted').length, missingMinutes: points.filter(p => p.presence === 'missing').length, totalMinutes: points.length };
}
export function activityBuckets(points: ActivityPoint[], range: TimeRange, resolution: ActivityResolution): ActivityBucket[] {
  const duration = resolution === '1m' ? MINUTE : resolution === '1h' ? HOUR : DAY;
  const offset = resolution === '1d' ? 9 * HOUR : 0;
  const start = Date.parse(range.from), end = Date.parse(range.to);
  const buckets: ActivityBucket[] = [];
  for (let ms = Math.floor((start + offset) / duration) * duration - offset; ms < end; ms += duration) {
    const from = Math.max(ms, start), to = Math.min(ms + duration, end);
    const part = points.slice((from - start) / MINUTE, (to - start) / MINUTE);
    buckets.push({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), ...activityTotals(part) });
  }
  return buckets;
}
export function summarizeActivity(points: ActivityPoint[], range: TimeRange): ActivitySummary {
  return { ...activityTotals(points), days: activityBuckets(points, range, '1d').map(bucket => ({ ...bucket, date: wakeDate(bucket.from),
    partialDay: Date.parse(bucket.to) - Date.parse(bucket.from) < DAY })) };
}
