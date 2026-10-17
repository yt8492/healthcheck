import { describe, expect, it } from 'vitest';
import { blankState, mergeSleepRanges, normalizeSleep, sleepCoverage, summarizeSleep } from './index.js';
import { sleepPoint } from '../../../tests/fixtures.js';

describe('睡眠の正規化とJSTの集計', () => {
  it('日跨ぎをJSTの起床日に対応付ける', () => {
    const session = normalizeSleep('test', sleepPoint(1).sleep);
    expect(session.wakeDate).toBe('2026-10-10');
    expect(session.durationMinutes).toBe(480);
    expect(session.stageMinutes.awake).toBeCloseTo(9.6);
    expect(session.asleepMinutes).toBeCloseTo(470.4);
  });
  it('短い覚醒同士・主段階の覚醒・離床の重なりを一度だけ計上する', () => {
    const raw = sleepPoint(1, '2026-10-10T00:00:00Z', '2026-10-10T01:00:00Z').sleep;
    raw.stages = [{ startTime: '2026-10-10T00:00:00Z', endTime: '2026-10-10T00:20:00Z', type: 'AWAKE' },
      { startTime: '2026-10-10T00:20:00Z', endTime: '2026-10-10T01:00:00Z', type: 'LIGHT' }];
    raw.shortAwakenings = [{ startTime: '2026-10-10T00:10:00Z', endTime: '2026-10-10T00:30:00Z', type: 'AWAKE' },
      { startTime: '2026-10-10T00:25:00Z', endTime: '2026-10-10T00:35:00Z', type: 'AWAKE' }];
    const s = normalizeSleep('test', { ...raw, outOfBedSegments: [{ startTime: '2026-10-10T00:30:00Z', endTime: '2026-10-10T00:40:00Z' }] });
    expect(s.stageMinutes.awake).toBe(40); expect(s.asleepMinutes).toBe(20);
    expect(s.durationMinutes).toBe(60); expect(s.stages).toHaveLength(2);
  });
  it('部分期間の内訳とセッション全体の時刻・内訳を分ける', () => {
    const s = normalizeSleep('test', sleepPoint(1).sleep);
    const result = summarizeSleep([s], { from: '2026-10-09T15:00:00Z', to: '2026-10-09T16:00:00Z' });
    expect(result.durationMinutes).toBe(60); expect(result.stageMinutes.deep).toBe(60);
    expect(result.days[0]?.date).toBe('2026-10-10');
    expect(s.startTime).toBe('2026-10-09T13:00:00.000Z'); expect(s.durationMinutes).toBe(480);
  });
  it('昼寝と夜の睡眠を同じ起床日にまとめる', () => {
    const night = normalizeSleep('night', sleepPoint(1).sleep);
    const nap = normalizeSleep('nap', { interval: { startTime: '2026-10-10T03:00:00Z', endTime: '2026-10-10T03:30:00Z' },
      metadata: { nap: true }, type: 'CLASSIC', stages: [{ startTime: '2026-10-10T03:00:00Z', endTime: '2026-10-10T03:30:00Z', type: 'ASLEEP' }] });
    const result = summarizeSleep([night, nap], { from: night.startTime, to: nap.endTime });
    expect(result.days).toHaveLength(1); expect(result.sessionCount).toBe(2);
    expect(result.days[0]?.stageMinutes.asleep).toBe(30);
  });
  it('段階未提供を睡眠ゼロにせず、欠けた段階を不明として保持する', () => {
    const raw = sleepPoint(1).sleep;
    const unknown = normalizeSleep('unknown', { interval: raw.interval });
    expect(unknown.asleepMinutes).toBeNull(); expect(unknown.stageMinutes.unknown).toBe(480);
    const partial = normalizeSleep('partial', { ...raw, stages: raw.stages.slice(0, 1), shortAwakenings: [] });
    expect(partial.stageMinutes.unknown).toBe(360);
    expect(summarizeSleep([unknown], rawInterval(raw.interval)).asleepMinutes).toBeNull();
  });
  it('不正な区間と重なる主段階を拒否する', () => {
    const raw = sleepPoint(1).sleep;
    expect(() => normalizeSleep('bad', { ...raw, stages: [...raw.stages, raw.stages[0]] })).toThrow();
    expect(() => normalizeSleep('bad', { interval: { startTime: raw.interval.endTime, endTime: raw.interval.startTime } })).toThrow();
  });
  it('成功範囲を結合し、未取得・一部取得・取得済みの空を区別する', () => {
    const now = Date.parse('2026-10-11T00:00:00Z');
    const a = { from: '2026-10-09T00:00:00.000Z', to: '2026-10-10T00:00:00.000Z' };
    const b = { from: a.to, to: '2026-10-11T00:00:00.000Z' };
    const state = { ...blankState(), lastSuccessAt: b.to, lastRange: b, completedRanges: [b] };
    expect(sleepCoverage(blankState(), a, now)).toBe('not-fetched');
    expect(sleepCoverage(state, a, now)).toBe('partial');
    expect(mergeSleepRanges([b, a, a], now)).toEqual([{ from: a.from, to: b.to }]);
    state.completedRanges = mergeSleepRanges([a, b], now);
    expect(sleepCoverage(state, a, now)).toBe('fetched');
    expect(sleepCoverage(state, { from: '2026-10-08T00:00:00.000Z', to: a.from }, now)).toBe('partial');
  });
});
function rawInterval(interval: { startTime: string; endTime: string }) { return { from: interval.startTime, to: interval.endTime }; }
