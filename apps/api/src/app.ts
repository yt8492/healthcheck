import Fastify, { LogController } from 'fastify';
import compress from '@fastify/compress';
import serveStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACTIVITY_METRICS, activityBuckets, activityCoverage, activityResolution, activitySpecs, emptyActivity, isActivityMetric, summarizeActivity, AGGREGATION, DAY, InputError, blankState, publicStatus, recentRange, sleepCoverage, summarize, summarizeSleep, validateRange,
  type ActivityMetric, type ActivityPoint, type HeartPoint, type SleepSession, type SyncState, type TimeRange } from '@healthcheck/core';
import { cacheReads } from './cache.js';

export type SleepReadStore = { state(): Promise<SyncState>; read(range: TimeRange): Promise<SleepSession[]> };
export type ActivityReadStore = { state(): Promise<SyncState>; read(range: TimeRange): Promise<ActivityPoint[]> };
export type ReadStore = { emulator: boolean; state(): Promise<SyncState>; read(range: TimeRange): Promise<HeartPoint[]>; sleep?: SleepReadStore; activity?(metric: ActivityMetric): ActivityReadStore };

export async function createApp(source: ReadStore, options: { now?: () => number; staticRoot?: string; logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? false, logController: new LogController({ disableRequestLogging: true }) });
  const clock = options.now ?? Date.now;
  const store = cacheReads(source, clock);
  await app.register(compress);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer');
    if (req.url.startsWith('/api/')) {
      const from = (req.query as Record<string, unknown> | null)?.from;
      const ttl = typeof from === 'string' ? Math.min(30, Math.max(0, Math.floor((Date.parse(from) + 90 * DAY - clock()) / 1000))) : 30;
      reply.header('cache-control', reply.statusCode < 400 ? `public, max-age=${ttl}` : 'no-store');
    }
  });
  app.setErrorHandler((error, _req, reply) => {
    reply.header('cache-control', 'no-store');
    if (error instanceof InputError) { reply.code(400).send({ error: { code: 'invalid-query', message: error.message } }); return; }
    // DB/認証ライブラリの内部例外は公開しない。読み取り失敗を空データにもしない。
    reply.code(503).send({ error: { code: 'storage-unavailable', message: '保存データを読み取れません。時間を置いて再試行してください。' } });
  });
  function rangeOf(query: unknown, long = false, activity = false): TimeRange {
    if (!query || typeof query !== 'object') throw new InputError('クエリが不正です。');
    const q = query as Record<string, unknown>;
    if (q.metric !== undefined && q.metric !== 'heart-rate' && !(activity && isActivityMetric(q.metric))) throw new InputError('metricはheart-rateまたは対応する活動指標を指定してください。');
    if (!activity && q.resolution !== undefined && q.resolution !== '1m' && q.resolution !== 'auto') throw new InputError('この到達点ではresolution=1mに対応しています。');
    if (q.from === undefined && q.to === undefined) return recentRange(clock());
    return validateRange(q.from, q.to, clock(), long ? 90 * 24 * 60 : undefined);
  }
  async function sleepData(range: TimeRange) {
    const [sessions, state] = await Promise.all([store.sleep?.read(range) ?? [], store.sleep?.state() ?? blankState()]);
    // キャッシュに残った値にも、リクエスト時点の終了日時による期限を適用する。
    return { sessions: sessions.filter(s => Date.parse(s.endTime) > clock() - 90 * DAY && s.startTime < range.to && s.endTime > range.from),
      status: publicStatus(state, clock(), store.emulator, 'sleep'), coverage: sleepCoverage(state, range, clock()) };
  }
  async function activityData(metric: ActivityMetric, range: TimeRange) {
    const activity = store.activity?.(metric);
    const [points, state] = await Promise.all([activity?.read(range) ?? emptyActivity(range), activity?.state() ?? blankState()]);
    return { points, metric, unit: activitySpecs[metric].unit, aggregation: 'sum-of-known-minute-values' as const,
      summary: summarizeActivity(points, range), status: publicStatus(state, clock(), store.emulator, metric), coverage: activityCoverage(state, range, clock()) };
  }
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api/v1/health', async () => ({ ok: true }));
  app.get('/api/v1/status', async () => {
    const [heart, sleep, ...activities] = await Promise.all([store.state(), store.sleep?.state() ?? blankState(), ...ACTIVITY_METRICS.map(m => store.activity?.(m).state() ?? blankState())]);
    const heartStatus = publicStatus(heart, clock(), store.emulator);
    return { ...heartStatus, metrics: { 'heart-rate': heartStatus, sleep: publicStatus(sleep, clock(), store.emulator, 'sleep'), ...Object.fromEntries(ACTIVITY_METRICS.map((m, i) => [m, publicStatus(activities[i]!, clock(), store.emulator, m)])) } };
  });
  app.get('/api/v1/timeseries', async req => {
    const q = req.query as Record<string, unknown>;
    if (isActivityMetric(q.metric)) {
      const range = rangeOf(q, true, true), resolution = activityResolution(q.resolution, range);
      const data = await activityData(q.metric, range);
      return { ...range, ...data, resolution, points: activityBuckets(data.points, range, resolution) };
    }
    const range = rangeOf(req.query);
    const [points, state] = await Promise.all([store.read(range), store.state()]);
    return { ...range, metric: 'heart-rate', resolution: '1m', unit: 'bpm', aggregation: AGGREGATION,
      points, summary: summarize(points), status: publicStatus(state, clock(), store.emulator) };
  });
  app.get('/api/v1/summary', async req => {
    const range = rangeOf(req.query, true);
    const activity = Object.fromEntries(await Promise.all(ACTIVITY_METRICS.map(async metric => {
      const { points: _points, ...data } = await activityData(metric, range);
      return [metric, data];
    })));
    const [points, state, sleep] = await Promise.all([store.read(range), store.state(), sleepData(range)]);
    return { ...range, metric: 'heart-rate', unit: 'bpm', aggregation: AGGREGATION,
      ...summarize(points), activity, status: publicStatus(state, clock(), store.emulator),
      sleep: { ...summarizeSleep(sleep.sessions, range), unit: 'minutes', status: sleep.status, coverage: sleep.coverage } };
  });
  app.get('/api/v1/sleep', async req => {
    const range = rangeOf(req.query, true);
    const q = req.query as Record<string, unknown>;
    const page = q.cursor === undefined ? null : decodeSleepCursor(q.cursor, range);
    const data = await sleepData(range);
    const eligible = data.sessions.filter(s => !page || s.endTime > page.endTime || (s.endTime === page.endTime && s.id > page.id));
    const sessions = eligible.slice(0, 50), last = sessions.at(-1);
    const nextCursor = eligible.length > 50 && last ? Buffer.from(JSON.stringify({ ...range, endTime: last.endTime, id: last.id })).toString('base64url') : null;
    return { ...range, metric: 'sleep', unit: 'minutes', sessions, nextCursor, status: data.status, coverage: data.coverage };
  });
  const staticRoot = options.staticRoot ?? resolve('dist/web');
  if (existsSync(staticRoot)) {
    await app.register(serveStatic, { root: staticRoot, index: 'index.html' });
  }
  return app;
}

function decodeSleepCursor(value: unknown, range: TimeRange): { endTime: string; id: string } {
  try {
    if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (cursor.from !== range.from || cursor.to !== range.to || typeof cursor.endTime !== 'string' ||
      new Date(cursor.endTime).toISOString() !== cursor.endTime || typeof cursor.id !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.id)) throw new Error();
    return { endTime: cursor.endTime, id: cursor.id };
  } catch { throw new InputError('cursorが不正か、表示期間と一致していません。'); }
}
