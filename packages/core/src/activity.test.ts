import { describe, expect, it } from 'vitest';
import { activityBuckets, activityCoverage, activityResolution, activityTotals, blankState, emptyActivity, summarizeActivity } from './index.js';

const range = { from: '2026-08-01T14:59:00.000Z', to: '2026-08-01T15:03:00.000Z' };
describe('活動の合計とJSTの区間', () => {
  it('明示的な0、値の省略、レコード欠損を別に数え、既知値がない合計はnullにする', () => {
    const points = emptyActivity(range);
    points[0] = { time: points[0]!.time, presence: 'value', value: 0 };
    points[1] = { time: points[1]!.time, presence: 'omitted', value: null };
    expect(activityTotals(points)).toEqual({ total: 0, availableMinutes: 1, omittedMinutes: 1, missingMinutes: 2, totalMinutes: 4 });
    expect(activityTotals(points.slice(1)).total).toBeNull();
  });
  it('JSTの日跨ぎを分割し、端数日と今日の途中集計を日全体の合計にしない', () => {
    const points = emptyActivity(range).map((p, i) => ({ ...p, presence: 'value' as const, value: i + 1 }));
    expect(summarizeActivity(points, range)).toMatchObject({ total: 10, days: [
      { date: '2026-08-01', total: 1, totalMinutes: 1, partialDay: true },
      { date: '2026-08-02', total: 9, totalMinutes: 3, partialDay: true },
    ] });
    expect(activityBuckets(points, range, '1h').map(p => [p.total, p.totalMinutes])).toEqual([[1, 1], [9, 3]]);
  });
  it('JSTの1日を1440分にし、集計粒度の変更でも合計を保存する', () => {
    const full = { from: '2026-08-01T15:00:00.000Z', to: '2026-08-02T15:00:00.000Z' };
    const points = emptyActivity(full).map(p => ({ ...p, presence: 'value' as const, value: 0.125 }));
    expect(summarizeActivity(points, full).days[0]).toMatchObject({ total: 180, date: '2026-08-02', partialDay: false });
    for (const resolution of ['1m', '1h', '1d'] as const) expect(activityBuckets(points, full, resolution).reduce((sum, p) => sum + p.total!, 0)).toBe(180);
  });
  it('長期間の粒度と未取得・部分取得・取得済みを分離する', () => {
    const long = { from: '2026-07-01T15:00:00.000Z', to: range.to };
    expect(activityResolution('auto', range)).toBe('1m'); expect(activityResolution('auto', long)).toBe('1d');
    expect(() => activityResolution('1m', long)).toThrow();
    const now = Date.parse(range.to);
    expect(activityCoverage(blankState(), range, now)).toBe('not-fetched');
    expect(activityCoverage({ ...blankState(), completedRanges: [{ from: range.from, to: '2026-08-01T15:00:00.000Z' }] }, range, now)).toBe('partial');
    expect(activityCoverage({ ...blankState(), completedRanges: [range] }, range, now)).toBe('fetched');
  });
});
