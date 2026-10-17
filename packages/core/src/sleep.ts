import { z } from 'zod';
import { MINUTE, floorMinute, retentionStart, type PublicStatus, type SyncState, type TimeRange } from './index.js';

export const SLEEP_STAGES = ['awake', 'light', 'deep', 'rem', 'asleep', 'restless', 'unknown'] as const;
export type SleepStageType = typeof SLEEP_STAGES[number];
export type SleepStage = { startTime: string; endTime: string; type: SleepStageType };
export type SleepTotals = {
  durationMinutes: number;
  asleepMinutes: number | null;
  stageMinutes: Record<SleepStageType, number>;
};
export type SleepSession = SleepTotals & {
  id: string; startTime: string; endTime: string; wakeDate: string;
  type: 'stages' | 'classic' | 'unknown'; nap: boolean | null;
  stages: SleepStage[];
};
export type SleepSummary = SleepTotals & {
  sessionCount: number;
  days: (SleepTotals & { date: string; sessionCount: number })[];
};
export type SleepResponse = TimeRange & {
  metric: 'sleep'; unit: 'minutes'; sessions: SleepSession[];
  nextCursor: string | null; status: PublicStatus; coverage: SleepCoverage;
};
export type SleepCoverage = 'not-fetched' | 'partial' | 'fetched';

export function mergeSleepRanges(ranges: TimeRange[], now: number): TimeRange[] {
  const cutoff = new Date(retentionStart(now)).toISOString();
  const result: TimeRange[] = [];
  for (const range of ranges.map(r => ({ from: r.from < cutoff ? cutoff : r.from, to: r.to }))
    .filter(r => r.from < r.to).sort((a, b) => a.from.localeCompare(b.from))) {
    const previous = result.at(-1);
    if (previous && range.from <= previous.to) previous.to = previous.to > range.to ? previous.to : range.to;
    else result.push({ ...range });
  }
  return result;
}

export function sleepCoverage(state: SyncState, range: TimeRange, now: number): SleepCoverage {
  if (!state.lastSuccessAt) return 'not-fetched';
  // 表示期間内に開始して後で終了するセッションも必要なので、直近の成功時点までを確認する。
  const to = new Date(floorMinute(Date.parse(state.lastSuccessAt))).toISOString();
  if (range.from >= to) return 'not-fetched';
  const completed = mergeSleepRanges(state.completedRanges ?? (state.lastRange ? [state.lastRange] : []), now);
  if (completed.some(r => r.from <= range.from && r.to >= to)) return 'fetched';
  return completed.some(r => r.from < to && r.to > range.from) ? 'partial' : 'not-fetched';
}

const timestamp = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString());
const intervalSchema = z.object({ startTime: timestamp, endTime: timestamp })
  .refine(v => v.startTime < v.endTime, '睡眠の開始は終了より前である必要があります');
const rawStage = intervalSchema.and(z.object({ type: z.enum([
  'AWAKE', 'LIGHT', 'DEEP', 'REM', 'ASLEEP', 'RESTLESS', 'SLEEP_STAGE_TYPE_UNSPECIFIED',
]).default('SLEEP_STAGE_TYPE_UNSPECIFIED') }));
export const rawSleepSchema = z.object({
  interval: intervalSchema,
  type: z.enum(['STAGES', 'CLASSIC', 'SLEEP_TYPE_UNSPECIFIED']).default('SLEEP_TYPE_UNSPECIFIED'),
  stages: z.array(rawStage).max(10_000).default([]),
  shortAwakenings: z.array(rawStage).max(10_000).default([]),
  outOfBedSegments: z.array(intervalSchema).max(10_000).default([]),
  metadata: z.object({ nap: z.boolean().optional() }).optional(),
});
export function wakeDate(endTime: string): string {
  return new Date(Date.parse(endTime) + 9 * 60 * MINUTE).toISOString().slice(0, 10);
}
export function emptySleepTotals(): SleepTotals {
  return { durationMinutes: 0, asleepMinutes: null,
    stageMinutes: { awake: 0, light: 0, deep: 0, rem: 0, asleep: 0, restless: 0, unknown: 0 } };
}
export function sleepTotals(stages: SleepStage[], range?: TimeRange): SleepTotals {
  const totals = emptySleepTotals();
  let known = false;
  for (const stage of stages) {
    const start = Math.max(Date.parse(stage.startTime), range ? Date.parse(range.from) : -Infinity);
    const end = Math.min(Date.parse(stage.endTime), range ? Date.parse(range.to) : Infinity);
    const minutes = Math.max(0, end - start) / MINUTE;
    totals.stageMinutes[stage.type] += minutes;
    totals.durationMinutes += minutes;
    if (minutes && stage.type !== 'unknown') known = true;
  }
  if (known) totals.asleepMinutes = totals.stageMinutes.light + totals.stageMinutes.deep + totals.stageMinutes.rem + totals.stageMinutes.asleep;
  return totals;
}

// 覚醒の和集合を優先して主段階を分割する。欠けた段階を睡眠と推測しない。
export function normalizeSleep(id: string, input: unknown): SleepSession {
  const raw = rawSleepSchema.parse(input);
  const { startTime, endTime } = raw.interval;
  const primary = [...raw.stages].sort((a, b) => a.startTime.localeCompare(b.startTime));
  for (let i = 0; i < primary.length; i++) {
    const stage = primary[i]!;
    if (stage.startTime < startTime || stage.endTime > endTime || (i > 0 && primary[i - 1]!.endTime > stage.startTime)) {
      throw new Error('睡眠段階が重複しているかセッションの範囲外です。');
    }
  }
  const awakenings = [...raw.shortAwakenings, ...raw.outOfBedSegments];
  if (awakenings.some(v => v.startTime < startTime || v.endTime > endTime)) throw new Error('覚醒の区間が睡眠の範囲外です。');
  const boundaries = [...new Set([startTime, endTime, ...primary.flatMap(v => [v.startTime, v.endTime]),
    ...awakenings.flatMap(v => [v.startTime, v.endTime])])].sort();
  const stages: SleepStage[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!, end = boundaries[i + 1]!;
    const base = primary.find(v => v.startTime <= start && v.endTime >= end);
    const awake = awakenings.some(v => v.startTime <= start && v.endTime >= end);
    const type: SleepStageType = awake ? 'awake' : !base || base.type === 'SLEEP_STAGE_TYPE_UNSPECIFIED' ? 'unknown' : base.type.toLowerCase() as SleepStageType;
    const previous = stages.at(-1);
    if (previous?.type === type && previous.endTime === start) previous.endTime = end;
    else stages.push({ startTime: start, endTime: end, type });
  }
  return { id, startTime, endTime, wakeDate: wakeDate(endTime), type: raw.type === 'STAGES' ? 'stages' : raw.type === 'CLASSIC' ? 'classic' : 'unknown',
    nap: raw.metadata?.nap ?? null, stages, ...sleepTotals(stages) };
}

export function summarizeSleep(sessions: SleepSession[], range: TimeRange): SleepSummary {
  const totals = emptySleepTotals();
  const days = new Map<string, SleepSummary['days'][number]>();
  for (const session of sessions) {
    const current = sleepTotals(session.stages, range);
    if (!current.durationMinutes) continue;
    let day = days.get(session.wakeDate);
    if (!day) { day = { date: session.wakeDate, sessionCount: 0, ...emptySleepTotals() }; days.set(day.date, day); }
    day.sessionCount++;
    for (const target of [totals, day]) {
      target.durationMinutes += current.durationMinutes;
      if (current.asleepMinutes !== null) target.asleepMinutes = (target.asleepMinutes ?? 0) + current.asleepMinutes;
      for (const type of SLEEP_STAGES) target.stageMinutes[type] += current.stageMinutes[type];
    }
  }
  return { ...totals, sessionCount: [...days.values()].reduce((n, day) => n + day.sessionCount, 0),
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}
