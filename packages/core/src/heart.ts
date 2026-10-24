import { DAY, HOUR, MINUTE, MAX_POINTS, InputError, type HeartPoint, type HeartSummary, type HeartValue, type TimeRange } from './index.js';

export type HeartResolution = '1m' | '5m' | '1h' | '1d';
export type HeartTotals = { sum: number; availableMinutes: number; min: number | null; max: number | null; latest: HeartSummary['latest'] };
export type HeartBucket = HeartPoint & { to: string; sum: number; availableMinutes: number; totalMinutes: number };
export type HeartDisplay = { points: HeartBucket[]; summary: HeartSummary };
export function heartDuration(resolution: HeartResolution): number {
  return resolution === '1m' ? MINUTE : resolution === '5m' ? 5 * MINUTE : resolution === '1h' ? HOUR : DAY;
}
export const heartResolutionLabels = { '1m': '1分', '5m': '5分', '1h': '1時間', '1d': '1日（JST）' } as const;

export function heartIntervals(range: TimeRange, resolution: HeartResolution): TimeRange[] {
  const duration = heartDuration(resolution), offset = resolution === '1d' ? 9 * HOUR : 0;
  const start = Date.parse(range.from), end = Date.parse(range.to), intervals: TimeRange[] = [];
  for (let ms = Math.floor((start + offset) / duration) * duration - offset; ms < end; ms += duration) {
    intervals.push({ from: new Date(Math.max(ms, start)).toISOString(), to: new Date(Math.min(ms + duration, end)).toISOString() });
  }
  return intervals;
}
export function heartResolution(value: unknown, range: TimeRange): HeartResolution {
  const duration = Date.parse(range.to) - Date.parse(range.from);
  const selected = value === undefined || value === 'auto'
    ? duration <= DAY ? '1m' : duration <= 7 * DAY ? '5m' : duration <= 30 * DAY ? '1h' : '1d' : value;
  if (selected !== '1m' && selected !== '5m' && selected !== '1h' && selected !== '1d') throw new InputError('心拍のresolutionは1m、5m、1h、1d、autoから選んでください。');
  // 端数区間も1件として数える。
  if (heartIntervals(range, selected).length > MAX_POINTS) throw new InputError('返却区間は最大4096件です。期間を短くするか、粗い粒度を指定してください。');
  return selected;
}
export function mergeHeartTotals(values: HeartTotals[]): HeartTotals {
  let sum = 0, availableMinutes = 0, min = Infinity, max = -Infinity;
  let latest: HeartSummary['latest'] = null;
  for (const value of values) {
    sum += value.sum; availableMinutes += value.availableMinutes;
    if (value.min !== null) min = Math.min(min, value.min);
    if (value.max !== null) max = Math.max(max, value.max);
    if (value.latest && (!latest || value.latest.time > latest.time)) latest = value.latest;
  }
  return { sum, availableMinutes, min: availableMinutes ? min : null, max: availableMinutes ? max : null, latest };
}
export function heartTotals(points: HeartPoint[]): HeartTotals {
  return mergeHeartTotals(points.map(p => ({ sum: p.value?.avg ?? 0, availableMinutes: p.value ? 1 : 0,
    min: p.value?.min ?? null, max: p.value?.max ?? null, latest: p.value ? { time: p.time, avg: p.value.avg } : null })));
}
export function heartValue(totals: HeartTotals): HeartValue | null {
  return totals.availableMinutes ? { avg: totals.sum / totals.availableMinutes, min: totals.min!, max: totals.max! } : null;
}
export function heartBucket(range: TimeRange, totals: HeartTotals): HeartBucket {
  return { time: range.from, to: range.to, value: heartValue(totals), sum: totals.sum,
    availableMinutes: totals.availableMinutes, totalMinutes: (Date.parse(range.to) - Date.parse(range.from)) / MINUTE };
}
export function heartDisplay(parts: { range: TimeRange; totals: HeartTotals }[]): HeartDisplay {
  const totals = mergeHeartTotals(parts.map(p => p.totals));
  const points = parts.map(p => heartBucket(p.range, p.totals));
  return { points, summary: { ...heartValue(totals) ?? { avg: null, min: null, max: null },
    availableMinutes: totals.availableMinutes, totalMinutes: points.reduce((sum, p) => sum + p.totalMinutes, 0), latest: totals.latest } };
}
export function bucketHeartPoints(points: HeartPoint[], range: TimeRange, resolution: HeartResolution): HeartDisplay {
  const start = Date.parse(range.from);
  return heartDisplay(heartIntervals(range, resolution).map(part => ({ range: part,
    totals: heartTotals(points.slice((Date.parse(part.from) - start) / MINUTE, (Date.parse(part.to) - start) / MINUTE)) })));
}
