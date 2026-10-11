import { z } from 'zod';
import { MINUTE, SOURCE_FAMILY, emptyPoints, heartValueSchema, minuteTime, type HeartPoint, type TimeRange, type SyncErrorCode } from '@healthcheck/core';

const ENDPOINT = 'https://health.googleapis.com/v4/users/me/dataTypes/heart-rate/dataPoints:rollUp';
export const HEART_SCOPE = 'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly';
export type AuthorizedFetch = (url: string, init: RequestInit) => Promise<Response>;

export class HealthApiError extends Error {
  constructor(public readonly code: SyncErrorCode, message: string) { super(message); this.name = 'HealthApiError'; }
}

const pageSchema = z.object({
  rollupDataPoints: z.array(z.object({
    startTime: z.string(), endTime: z.string(),
    heartRate: z.object({ beatsPerMinuteAvg: z.number(), beatsPerMinuteMin: z.number(), beatsPerMinuteMax: z.number() }).optional(),
  })).default([]),
  nextPageToken: z.string().optional(),
});

export class GoogleHealthClient {
  constructor(private readonly request: AuthorizedFetch, private readonly sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))) {}

  private async call(url: string, init: RequestInit): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt++) {
      let response: Response;
      try { response = await this.request(url, { ...init, signal: AbortSignal.timeout(30_000) }); }
      catch (error) { if (error instanceof HealthApiError) throw error;
        if (attempt < 3) { await this.sleep(1000 * 2 ** attempt); continue; }
        throw new HealthApiError('upstream-unavailable', 'Google Health APIとの通信に失敗しました。'); }
      if (response.ok) {
        try { return await response.json(); }
        catch { throw new HealthApiError('invalid-upstream-data', 'Google Health APIのJSONを読み取れません。'); }
      }
      if (response.status === 401) throw new HealthApiError('reauth-required', '本人のOAuth連携をやり直してください。');
      if (response.status === 403) throw new HealthApiError('access-denied', 'APIの利用対象、アカウント連携、読み取り権限を確認してください。');
      if (response.status !== 429 && response.status < 500) throw new HealthApiError('upstream-unavailable', `Google Health APIがHTTP ${response.status}を返しました。`);
      if (attempt < 3) {
        const retry = response.headers.get('retry-after');
        const parsed = retry === null ? NaN : /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
        // 長いRetry-Afterを無視して早く再試行しない。今回の実行は失敗として次回へ委ねる。
        if (Number.isFinite(parsed) && parsed > 30_000) throw new HealthApiError('upstream-unavailable', 'APIの待機指示が長いため次回の同期で再試行します。');
        await this.sleep(Math.max(1000 * 2 ** attempt, Number.isFinite(parsed) ? parsed : 0));
      }
    }
    throw new HealthApiError('upstream-unavailable', 'Google Health APIの再試行回数を超えました。');
  }

  async verifyIdentity(): Promise<void> {
    const body = await this.call('https://health.googleapis.com/v4/users/me/identity', { method: 'GET' });
    if (!z.object({ healthUserId: z.string().min(1) }).safeParse(body).success) {
      throw new HealthApiError('invalid-upstream-data', 'Google Healthの本人連携を確認できません。');
    }
  }

  async heartRate(range: TimeRange): Promise<HeartPoint[]> {
    const expected = emptyPoints(range);
    const values = new Map<string, HeartPoint>();
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const body = await this.call(ENDPOINT, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ range: { startTime: range.from, endTime: range.to }, windowSize: '60s', pageSize: 10000,
          dataSourceFamily: SOURCE_FAMILY, ...(pageToken ? { pageToken } : {}) }),
      });
      const result = pageSchema.safeParse(body);
      if (!result.success) throw new HealthApiError('invalid-upstream-data', '心拍のレスポンス形式が想定と異なります。');
      for (const raw of result.data.rollupDataPoints) {
        let time: string, end: string;
        try { time = minuteTime(raw.startTime); end = minuteTime(raw.endTime); }
        catch { throw new HealthApiError('invalid-upstream-data', '心拍の区間が1分境界に揃っていません。'); }
        if (Date.parse(end) - Date.parse(time) !== MINUTE || time < range.from || end > range.to || values.has(time)) {
          throw new HealthApiError('invalid-upstream-data', '心拍の区間に重複または範囲外の値があります。');
        }
        let value = null;
        if (raw.heartRate) {
          const checked = heartValueSchema.safeParse({ avg: raw.heartRate.beatsPerMinuteAvg, min: raw.heartRate.beatsPerMinuteMin, max: raw.heartRate.beatsPerMinuteMax });
          if (!checked.success) throw new HealthApiError('invalid-upstream-data', '心拍の平均・最小・最大の整合性を確認できません。');
          value = checked.data;
        }
        values.set(time, { time, value });
      }
      pageToken = result.data.nextPageToken || undefined;
      if (pageToken) {
        if (seenTokens.has(pageToken) || seenTokens.size >= 100) throw new HealthApiError('invalid-upstream-data', 'ページングが完了しません。');
        seenTokens.add(pageToken);
      }
    } while (pageToken);
    return expected.map(point => values.get(point.time) ?? point);
  }
}
