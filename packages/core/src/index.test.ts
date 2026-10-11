import { describe, expect, it } from 'vitest';
import { DAY, MINUTE, emptyPoints, hourStarts, summarize, validateRange, retentionStart } from './index.js';

const now = Date.parse('2026-10-11T03:00:30Z');
describe('日時・心拍集計', () => {
  it('JSTをUTCに正規化し、終了を含まない', () => {
    const range = validateRange('2026-10-10T23:59:00+09:00', '2026-10-11T00:01:00+09:00', now);
    expect(range.from).toBe('2026-10-10T14:59:00.000Z');
    expect(emptyPoints(range).map(p => p.time)).toEqual(['2026-10-10T14:59:00.000Z', '2026-10-10T15:00:00.000Z']);
    expect(hourStarts(range)).toHaveLength(2);
  });
  it.each([
    ['2026-02-30T00:00:00Z', '2026-10-10T00:00:00Z'],
    ['2026-10-10T00:00:01Z', '2026-10-10T00:01:00Z'],
    ['2026-10-10T00:00:00', '2026-10-10T00:01:00Z'],
    ['2026-10-11T03:00:00Z', '2026-10-11T03:01:00Z'],
    ['2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z'],
    ['2026-10-01T00:00:00Z', '2026-10-10T00:00:00Z'],
  ])('不正日時・未完了の分・多すぎるポイントを拒否する %s', (from, to) => {
    expect(() => validateRange(from, to, now)).toThrow();
  });
  it('90日境界の端数は切り上げ、期限外の1分を返さない', () => {
    const first = retentionStart(now);
    expect(first).toBe(Math.ceil((now - 90 * DAY) / MINUTE) * MINUTE);
    expect(() => validateRange(new Date(first - MINUTE).toISOString(), new Date(first + MINUTE).toISOString(), now)).toThrow();
    expect(validateRange(new Date(first).toISOString(), new Date(first + MINUTE).toISOString(), now)).toBeTruthy();
  });
  it('欠損を0とせず有効な1分値だけを平均し、測定時刻を添える', () => {
    expect(summarize([
      { time: '2026-10-10T01:00:00Z', value: { avg: 60, min: 50, max: 70 } },
      { time: '2026-10-10T01:01:00Z', value: null },
      { time: '2026-10-10T01:02:00Z', value: { avg: 90, min: 80, max: 110 } },
    ])).toEqual({ avg: 75, min: 50, max: 110, availableMinutes: 2, totalMinutes: 3, latest: { time: '2026-10-10T01:02:00Z', avg: 90 } });
    expect(summarize([{ time: '2026-10-10T01:01:00Z', value: null }])).toMatchObject({ avg: null, min: null, max: null, latest: null });
  });
});
