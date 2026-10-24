import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAY, MINUTE, floorMinute, retentionStart } from '@healthcheck/core';
import { inputRange, moveRange, presetRange, rangeFromUrl } from './time.js';

const now = Date.parse('2026-10-18T06:02:30Z');
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('心拍の期間とURL', () => {
  it('90日プリセットを保存境界に収め、前後移動も境界で止める', () => {
    const range = presetRange(90, now);
    expect(Date.parse(range.from)).toBe(retentionStart(now));
    expect(Date.parse(range.to)).toBe(floorMinute(now));
    expect(moveRange(range, -1, now)).toEqual(range);
    expect(moveRange(range, 1, now)).toEqual(range);
    const week = presetRange(7, now), previous = moveRange(week, -1, now);
    expect(Date.parse(previous.from)).toBe(Date.parse(week.from) - 7 * DAY);
    expect(moveRange(previous, 1, now)).toEqual(week);
  });
  it('保存した日時と粒度を復元し、不正な粒度では安全な初期表示へ戻す', () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const range = presetRange(30, now);
    vi.stubGlobal('location', { search: `?${new URLSearchParams({ ...range, resolution: '1h' })}` });
    expect(rangeFromUrl()).toEqual({ range, resolution: '1h' });
    vi.stubGlobal('location', { search: `?${new URLSearchParams({ ...range, resolution: '1m' })}` });
    expect(rangeFromUrl()).toMatchObject({ resolution: 'auto', error: expect.stringContaining('4096') });
  });
  it('JST任意期間は24時間より長く指定でき、未来と保存境界外は拒否する', () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    expect(inputRange('2026-10-01T09:03', '2026-10-15T09:07')).toEqual({ from: '2026-10-01T00:03:00.000Z', to: '2026-10-15T00:07:00.000Z' });
    expect(() => inputRange('2026-10-01T09:03', '2026-10-19T09:07')).toThrow();
    vi.stubGlobal('location', { search: `?${new URLSearchParams({ from: new Date(retentionStart(now) - MINUTE).toISOString(), to: new Date(floorMinute(now)).toISOString() })}` });
    expect(rangeFromUrl().error).toContain('90日');
  });
});
