import { parseArgs } from 'node:util';
import { ACTIVITY_METRICS, isActivityMetric, InputError, recentRange, validateRange } from '@healthcheck/core';
import { GoogleHealthClient, HealthApiError } from '@healthcheck/google-health';
import { loadAuthorizedFetch } from '@healthcheck/google-health/credentials';
import { createStore, LeaseBusyError, LeaseExpiredError } from '@healthcheck/storage';
import { connect } from './connect.js';
import { syncMetrics } from './sync.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    client: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, help: { type: 'boolean' },
    sleep: { type: 'boolean' }, activity: { type: 'boolean' }, metric: { type: 'string', default: 'all' },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log('connect [--client /path/to/oauth-client.json] [--sleep] [--activity]\nsync [--metric heart-rate|sleep|activity|steps|distance|total-calories|active-zone-minutes|all] [--from RFC3339 --to RFC3339]  ※既定は直近48時間、最大7日\nprune'); return;
  }
  if (command === 'connect') {
    await connect(values.client ?? process.env.GOOGLE_OAUTH_CLIENT_FILE ?? '.local/oauth-client.json',
      process.env.GOOGLE_HEALTH_TOKEN_FILE ?? '.local/google-health-tokens.json',
      process.env.GOOGLE_OAUTH_REDIRECT_URI ?? 'http://127.0.0.1:8787/oauth/callback', values.sleep, values.activity); return;
  }
  if (!['sync', 'prune'].includes(command)) throw new Error('不明なコマンドです。--helpを参照してください。');
  const store = createStore();
  try {
    if (command === 'prune') {
      const results = await Promise.allSettled([store.prune(), store.sleep.prune(), ...ACTIVITY_METRICS.map(metric => store.activity(metric).prune())]);
      results.forEach((result, i) => console.log(`${['heart-rate', 'sleep', ...ACTIVITY_METRICS][i]}の期限削除: ${result.status === 'fulfilled' ? `${result.value}件` : '失敗'}`));
      if (results.some(result => result.status === 'rejected')) process.exitCode = 1;
      return;
    }
    const metric = values.metric;
    if (metric !== 'heart-rate' && metric !== 'sleep' && metric !== 'all' && metric !== 'activity' && !isActivityMetric(metric)) throw new InputError('--metricに対応する指標、activity、allを指定してください。');
    if (Boolean(values.from) !== Boolean(values.to)) throw new Error('--fromと--toは両方指定してください。');
    const requested = values.from && values.to ? { from: values.from, to: values.to } : recentRange(Date.now(), 48);
    const range = validateRange(requested.from, requested.to, Date.now(), 7 * 24 * 60);
    const results = await syncMetrics(async () => {
      let request;
      try { request = await loadAuthorizedFetch(); }
      catch { throw new HealthApiError('reauth-required', 'OAuth設定とrefresh tokenを確認し、必要ならnpm run connectで再接続してください。'); }
      const client = new GoogleHealthClient(request);
      await client.verifyIdentity();
      return client;
    }, store, range, metric);
    results.forEach(result => console.log(`${result.metric}: ${result.ok ? '同期・期限削除が完了' : '失敗（保存済みデータを維持。指標の同期状態を確認してください）'}`));
    if (results.some(result => !result.ok)) process.exitCode = 1;
  } finally { await store.db.terminate(); }
}

main().catch(error => {
  if (error instanceof InputError || error instanceof HealthApiError || error instanceof LeaseBusyError || error instanceof LeaseExpiredError) console.error(error.message);
  else console.error('処理に失敗しました。OAuth設定ファイル、Cloud IAM認証、Firestore接続、日時引数を確認してください。--helpとREADMEに設定手順があります。');
  // ライブラリ例外にはリクエスト・認証情報が入ることがあるため、そのままログに出さない。
  process.exitCode = 1;
});
