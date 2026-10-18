import { DAY, floorMinute, heartResolution, recentRange, retentionStart, validateRange, type HeartResolution, type TimeRange } from '@healthcheck/core';

export const dateTime = (time: string) => new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(time));
export const timeOnly = (time: string | number) => new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(time));
export const dateOnly = (time: string) => new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
}).format(new Date(time));
export const toInput = (time: string) => new Date(Date.parse(time) + 9 * 60 * 60_000).toISOString().slice(0, 16);
export function inputRange(from: string, to: string): TimeRange {
  return validateRange(`${from}:00+09:00`, `${to}:00+09:00`, Date.now(), 90 * 1440);
}
export function presetRange(days: number, now = Date.now()): TimeRange {
  const to = floorMinute(now);
  return { from: new Date(Math.max(retentionStart(now), to - days * DAY)).toISOString(), to: new Date(to).toISOString() };
}
export function moveRange(range: TimeRange, direction: number, now = Date.now()): TimeRange {
  const duration = Date.parse(range.to) - Date.parse(range.from);
  const start = Math.max(retentionStart(now), Math.min(floorMinute(now) - duration, Date.parse(range.from) + duration * direction));
  return { from: new Date(start).toISOString(), to: new Date(start + duration).toISOString() };
}
export function rangeFromUrl(): { range: TimeRange; resolution: HeartResolution | 'auto'; error?: string } {
  const q = new URLSearchParams(location.search);
  try {
    const range = !q.has('from') && !q.has('to') ? recentRange(Date.now()) : validateRange(q.get('from'), q.get('to'), Date.now(), 90 * 1440);
    const resolution = q.get('resolution') ?? 'auto';
    const selected = heartResolution(resolution, range);
    return { range, resolution: resolution === 'auto' ? 'auto' : selected };
  } catch (error) { return { range: recentRange(Date.now()), resolution: 'auto', error: error instanceof Error ? error.message : 'URLの日時が不正です。' }; }
}
