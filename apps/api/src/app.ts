import Fastify, { LogController } from 'fastify';
import compress from '@fastify/compress';
import serveStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AGGREGATION, InputError, publicStatus, recentRange, summarize, validateRange, type HeartPoint, type SyncState, type TimeRange } from '@healthcheck/core';
import { cacheReads } from './cache.js';

export type ReadStore = { emulator: boolean; state(): Promise<SyncState>; read(range: TimeRange): Promise<HeartPoint[]> };

export async function createApp(source: ReadStore, options: { now?: () => number; staticRoot?: string; logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? false, logController: new LogController({ disableRequestLogging: true }) });
  const clock = options.now ?? Date.now;
  const store = cacheReads(source, clock);
  await app.register(compress);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer');
    if (req.url.startsWith('/api/')) reply.header('cache-control', reply.statusCode < 400 ? 'public, max-age=30' : 'no-store');
  });
  app.setErrorHandler((error, _req, reply) => {
    reply.header('cache-control', 'no-store');
    if (error instanceof InputError) { reply.code(400).send({ error: { code: 'invalid-query', message: error.message } }); return; }
    // DB/認証ライブラリの内部例外は公開しない。読み取り失敗を空データにもしない。
    reply.code(503).send({ error: { code: 'storage-unavailable', message: '保存データを読み取れません。時間を置いて再試行してください。' } });
  });
  function rangeOf(query: unknown): TimeRange {
    if (!query || typeof query !== 'object') throw new InputError('クエリが不正です。');
    const q = query as Record<string, unknown>;
    if (q.metric !== undefined && q.metric !== 'heart-rate') throw new InputError('この到達点ではmetric=heart-rateに対応しています。');
    if (q.resolution !== undefined && q.resolution !== '1m' && q.resolution !== 'auto') throw new InputError('この到達点ではresolution=1mに対応しています。');
    if (q.from === undefined && q.to === undefined) return recentRange(clock());
    return validateRange(q.from, q.to, clock());
  }
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api/v1/health', async () => ({ ok: true }));
  app.get('/api/v1/status', async () => publicStatus(await store.state(), clock(), store.emulator));
  app.get('/api/v1/timeseries', async req => {
    const range = rangeOf(req.query);
    const [points, state] = await Promise.all([store.read(range), store.state()]);
    return { ...range, metric: 'heart-rate', resolution: '1m', unit: 'bpm', aggregation: AGGREGATION,
      points, summary: summarize(points), status: publicStatus(state, clock(), store.emulator) };
  });
  app.get('/api/v1/summary', async req => {
    const range = rangeOf(req.query);
    const [points, state] = await Promise.all([store.read(range), store.state()]);
    return { ...range, metric: 'heart-rate', unit: 'bpm', aggregation: AGGREGATION,
      ...summarize(points), status: publicStatus(state, clock(), store.emulator) };
  });
  const staticRoot = options.staticRoot ?? resolve('dist/web');
  if (existsSync(staticRoot)) {
    await app.register(serveStatic, { root: staticRoot, index: 'index.html' });
  }
  return app;
}
