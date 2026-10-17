import { z } from 'zod';
export * from './sleep.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const RETENTION_DAYS = 90;
export const MAX_POINTS = 4096;
export const SOURCE_FAMILY = 'users/me/dataSourceFamilies/google-wearables';
export const AGGREGATION = 'mean-of-valid-minute-averages' as const;

export type HeartValue = { avg: number; min: number; max: number };
export type HeartPoint = { time: string; value: HeartValue | null };
export type TimeRange = { from: string; to: string };
export type SyncErrorCode = 'reauth-required' | 'access-denied' | 'upstream-unavailable' | 'invalid-upstream-data' | 'storage-error';
export type SyncState = {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastRange: TimeRange | null;
  completedRanges?: TimeRange[];
  dataThrough: string | null;
  error: { code: SyncErrorCode; at: string } | null;
};
export type PublicStatus = SyncState & {
  metric: 'heart-rate' | 'sleep';
  environment: 'emulator' | 'production';
  sourceFamily: string;
  state: 'not-synced' | 'ok' | 'delayed' | 'error';
  retentionDays: number;
};
export type HeartSummary = {
  avg: number | null;
  min: number | null;
  max: number | null;
  availableMinutes: number;
  totalMinutes: number;
  latest: { time: string; avg: number } | null;
};
export type TimeseriesResponse = TimeRange & {
  metric: 'heart-rate';
  unit: 'bpm';
  resolution: '1m';
  aggregation: typeof AGGREGATION;
  points: HeartPoint[];
  summary: HeartSummary;
  status: PublicStatus;
};

export class InputError extends Error {
  constructor(message: string) { super(message); this.name = 'InputError'; }
}

export const heartValueSchema = z.object({
  avg: z.number().finite().positive(),
  min: z.number().finite().positive(),
  max: z.number().finite().positive(),
}).refine(v => v.min <= v.avg && v.avg <= v.max, 'min <= avg <= max が必要です');

export function minuteTime(value: unknown): string {
  if (!z.iso.datetime({ offset: true }).safeParse(value).success || typeof value !== 'string') {
    throw new InputError('日時はタイムゾーン付きRFC 3339形式で指定してください。');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms % MINUTE !== 0) throw new InputError('日時は1分の境界で指定してください。');
  return new Date(ms).toISOString();
}

export function floorMinute(now: number): number { return Math.floor(now / MINUTE) * MINUTE; }
export function retentionStart(now: number): number { return Math.ceil((now - RETENTION_DAYS * DAY) / MINUTE) * MINUTE; }

export function validateRange(from: unknown, to: unknown, now: number, limit = MAX_POINTS): TimeRange {
  const range = { from: minuteTime(from), to: minuteTime(to) };
  const start = Date.parse(range.from), end = Date.parse(range.to);
  if (start >= end) throw new InputError('fromはtoより前に指定してください。');
  if (start < retentionStart(now)) throw new InputError('保存対象は測定時刻から直近90日です。');
  if (end > floorMinute(now)) throw new InputError('toは現在の完了した分までを指定してください。');
  if ((end - start) / MINUTE > limit) throw new InputError(`1回の取得は最大${limit}分です。範囲を短くしてください。`);
  return range;
}

export function recentRange(now: number, hours = 24): TimeRange {
  const to = floorMinute(now);
  return { from: new Date(to - hours * HOUR).toISOString(), to: new Date(to).toISOString() };
}

export function hourStarts(range: TimeRange): string[] {
  const starts: string[] = [];
  for (let ms = Math.floor(Date.parse(range.from) / HOUR) * HOUR; ms < Date.parse(range.to); ms += HOUR) {
    starts.push(new Date(ms).toISOString());
  }
  return starts;
}

export function emptyPoints(range: TimeRange): HeartPoint[] {
  const points: HeartPoint[] = [];
  for (let ms = Date.parse(range.from); ms < Date.parse(range.to); ms += MINUTE) {
    points.push({ time: new Date(ms).toISOString(), value: null });
  }
  return points;
}

export function summarize(points: HeartPoint[]): HeartSummary {
  let sum = 0, min = Infinity, max = -Infinity, count = 0;
  let latest: HeartSummary['latest'] = null;
  for (const { time, value } of points) {
    if (!value) continue;
    sum += value.avg; min = Math.min(min, value.min); max = Math.max(max, value.max); count++;
    if (!latest || time > latest.time) latest = { time, avg: value.avg };
  }
  return { avg: count ? sum / count : null, min: count ? min : null, max: count ? max : null,
    availableMinutes: count, totalMinutes: points.length, latest };
}

export function blankState(): SyncState {
  return { lastAttemptAt: null, lastSuccessAt: null, lastRange: null, dataThrough: null, error: null };
}

export function publicStatus(state: SyncState, now: number, emulator: boolean, metric: PublicStatus['metric'] = 'heart-rate'): PublicStatus {
  const condition = state.error ? 'error' : !state.lastSuccessAt ? 'not-synced'
    : now - Date.parse(state.lastSuccessAt) > HOUR ? 'delayed' : 'ok';
  const dataThrough = state.dataThrough && Date.parse(state.dataThrough) > now - RETENTION_DAYS * DAY ? state.dataThrough : null;
  return { ...state, dataThrough, metric, environment: emulator ? 'emulator' : 'production',
    sourceFamily: SOURCE_FAMILY, state: condition, retentionDays: RETENTION_DAYS };
}
