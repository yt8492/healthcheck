import { describe, expect, it } from 'vitest';
import { DAY, MINUTE, bucketHeartPoints, emptyPoints, heartIntervals, heartResolution, recentRange, retentionStart, validateRange } from './index.js';

const now = Date.parse('2026-10-18T06:02:30Z');
describe('心拍の長期間集計', () => {
  it.each([[1, '1m'], [7, '5m'], [30, '1h'], [90, '1d']] as const)('%i日のautoは%s', (days, resolution) => {
    expect(heartResolution('auto', recentRange(now, days * 24))).toBe(resolution);
  });
  it('欠損の多い区間に同じ重みを与えず、元の分平均の合計と分数を保つ', () => {
    const range = { from: '2026-10-17T00:00:00Z', to: '2026-10-17T02:00:00Z' };
    const points = emptyPoints(range).map((p, i) => ({ ...p, value: i < 60 ? { avg: 60, min: 40, max: 80 } : i === 60 ? { avg: 120, min: 100, max: 140 } : null }));
    const display = bucketHeartPoints(points, range, '1h');
    expect(display.points.map(p => p.value?.avg)).toEqual([60, 120]);
    expect(display.summary).toMatchObject({ avg: 3720 / 61, min: 40, max: 140, availableMinutes: 61, totalMinutes: 120 });
    expect(display.points[1]).toMatchObject({ sum: 120, availableMinutes: 1, totalMinutes: 60 });
  });
  it('全欠損はnull、空の分数は残り、最新値もnullとなる', () => {
    const range = recentRange(now);
    const result = bucketHeartPoints(emptyPoints(range), range, '1h');
    expect(result.points.every(p => p.value === null && p.availableMinutes === 0 && p.totalMinutes > 0)).toBe(true);
    expect(result.summary).toMatchObject({ avg: null, min: null, max: null, latest: null, availableMinutes: 0, totalMinutes: 1440 });
  });
  it('UTC時間境界、JST日境界と両端の端数をクリップする', () => {
    const range = { from: '2026-10-16T14:58:00Z', to: '2026-10-17T15:02:00Z' };
    expect(heartIntervals(range, '1d')).toEqual([
      { from: '2026-10-16T14:58:00.000Z', to: '2026-10-16T15:00:00.000Z' },
      { from: '2026-10-16T15:00:00.000Z', to: '2026-10-17T15:00:00.000Z' },
      { from: '2026-10-17T15:00:00.000Z', to: '2026-10-17T15:02:00.000Z' },
    ]);
    expect(bucketHeartPoints(emptyPoints(range), range, '1h').points.map(p => p.totalMinutes)).toEqual([2, ...Array<number>(24).fill(60), 2]);
  });
  it('4096区間の上限には端数区間も含め、90日保存境界を守る', () => {
    const from = Date.parse('2026-09-01T00:01:00Z');
    const range = { from: new Date(from).toISOString(), to: new Date(from + 4096 * 5 * MINUTE).toISOString() };
    expect(() => heartResolution('5m', range)).toThrow('4096');
    expect(heartResolution('5m', { ...range, to: new Date(from + (4096 * 5 - 1) * MINUTE).toISOString() })).toBe('5m');
    const cutoff = retentionStart(now);
    expect(() => validateRange(new Date(cutoff - MINUTE).toISOString(), new Date(now - MINUTE).toISOString(), now, 90 * 1440)).toThrow();
    expect(validateRange(new Date(cutoff).toISOString(), new Date(Math.floor(now / MINUTE) * MINUTE).toISOString(), now, 90 * 1440)).toBeTruthy();
    expect(cutoff).toBeGreaterThan(now - 90 * DAY);
  });
});
