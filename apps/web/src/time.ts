import { DAY, recentRange, validateRange, type TimeRange } from '@healthcheck/core';

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
  const range = validateRange(`${from}:00+09:00`, `${to}:00+09:00`, Date.now());
  if (Date.parse(range.to) - Date.parse(range.from) > DAY) throw new Error('この画面では24時間以内の範囲を指定してください。');
  return range;
}
export function rangeFromUrl(): { range: TimeRange; error?: string } {
  const q = new URLSearchParams(location.search);
  if (!q.has('from') && !q.has('to')) return { range: recentRange(Date.now()) };
  try {
    const range = validateRange(q.get('from'), q.get('to'), Date.now());
    if (Date.parse(range.to) - Date.parse(range.from) > DAY) throw new Error('表示期間は24時間以内で指定してください。');
    return { range };
  } catch (error) { return { range: recentRange(Date.now()), error: error instanceof Error ? error.message : 'URLの日時が不正です。' }; }
}
