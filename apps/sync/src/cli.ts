import { parseArgs } from 'node:util';
import { InputError, recentRange, validateRange } from '@healthcheck/core';
import { GoogleHealthClient, HealthApiError } from '@healthcheck/google-health';
import { loadAuthorizedFetch } from '@healthcheck/google-health/credentials';
import { createStore, LeaseBusyError, LeaseExpiredError } from '@healthcheck/storage';
import { connect } from './connect.js';
import { syncHeart } from './sync.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    client: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, help: { type: 'boolean' },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log('connect [--client /path/to/oauth-client.json]\nsync [--from RFC3339 --to RFC3339]  ※既定は直近48時間、最大7日\nprune'); return;
  }
  if (command === 'connect') {
    await connect(values.client ?? process.env.GOOGLE_OAUTH_CLIENT_FILE ?? '.local/oauth-client.json',
      process.env.GOOGLE_HEALTH_TOKEN_FILE ?? '.local/google-health-tokens.json',
      process.env.GOOGLE_OAUTH_REDIRECT_URI ?? 'http://127.0.0.1:8787/oauth/callback'); return;
  }
  if (!['sync', 'prune'].includes(command)) throw new Error('不明なコマンドです。--helpを参照してください。');
  const store = createStore();
  try {
    if (command === 'prune') { console.log(`期限超過の${await store.prune()}時間ドキュメントを削除しました。`); return; }
    if (Boolean(values.from) !== Boolean(values.to)) throw new Error('--fromと--toは両方指定してください。');
    const requested = values.from && values.to ? { from: values.from, to: values.to } : recentRange(Date.now(), 48);
    const range = validateRange(requested.from, requested.to, Date.now(), 7 * 24 * 60);
    const result = await syncHeart(async () => {
      let request;
      try { request = await loadAuthorizedFetch(); }
      catch { throw new HealthApiError('reauth-required', 'OAuth設定とrefresh tokenを確認し、必要ならnpm run connectで再接続してください。'); }
      const client = new GoogleHealthClient(request);
      await client.verifyIdentity();
      return client;
    }, store, range);
    console.log(`心拍を同期しました。取得値のある分: ${result.availableMinutes}、変更した時間doc: ${result.changedHours}`);
    console.log(`期限超過の${await store.prune()}時間ドキュメントを削除しました。`);
  } finally { await store.db.terminate(); }
}

main().catch(error => {
  if (error instanceof InputError || error instanceof HealthApiError || error instanceof LeaseBusyError || error instanceof LeaseExpiredError) console.error(error.message);
  else console.error('処理に失敗しました。OAuth設定ファイル、Cloud IAM認証、Firestore接続、日時引数を確認してください。--helpとREADMEに設定手順があります。');
  // ライブラリ例外にはリクエスト・認証情報が入ることがあるため、そのままログに出さない。
  process.exitCode = 1;
});
