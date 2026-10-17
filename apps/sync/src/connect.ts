import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { HEART_SCOPE, SLEEP_SCOPE, GoogleHealthClient } from '@healthcheck/google-health';
import { readClient, savePrivateJson, authorizedFetch } from '@healthcheck/google-health/credentials';

export function validState(received: string | null, expected: string): boolean {
  if (!received) return false;
  const actual = Buffer.from(received), wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export async function connect(clientPath: string, tokenPath: string, redirectUri: string, includeSleep = false): Promise<void> {
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port || redirect.search || redirect.hash) {
    throw new Error('OAuthコールバックにはポート付きのhttp://127.0.0.1を指定してください。');
  }
  const config = await readClient(clientPath);
  const client = new OAuth2Client({ clientId: config.client_id, clientSecret: config.client_secret, redirectUri, transporterOptions: { timeout: 30_000 } });
  const verifier = await client.generateCodeVerifierAsync();
  const state = randomBytes(32).toString('hex');
  const scopes = includeSleep ? [HEART_SCOPE, SLEEP_SCOPE] : [HEART_SCOPE];
  const authUrl = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: scopes,
    state, code_challenge: verifier.codeChallenge, code_challenge_method: CodeChallengeMethod.S256 });
  let finish: (code: string) => void = () => {}, reject: (error: Error) => void = () => {};
  const codePromise = new Promise<string>((resolve, fail) => { finish = resolve; reject = fail; });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', redirect.origin);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    if (url.pathname !== redirect.pathname) { res.writeHead(404).end('Not found'); return; }
    if (!validState(url.searchParams.get('state'), state)) { res.writeHead(400).end('OAuth stateが一致しません。'); return; }
    if (url.searchParams.has('error')) {
      res.writeHead(400).end('連携が許可されませんでした。ターミナルを確認してください。');
      reject(new Error('OAuth連携が許可されませんでした。')); return;
    }
    const code = url.searchParams.get('code');
    if (!code) { res.writeHead(400).end('認証コードがありません。'); return; }
    res.end('Googleからの応答を受け取りました。ターミナルで連携結果を確認してください。');
    finish(code);
  });
  await new Promise<void>((resolve, fail) => {
    server.once('error', fail);
    server.listen(Number(redirect.port), '127.0.0.1', resolve);
  });
  const timer = setTimeout(() => reject(new Error('OAuth連携が10分以内に完了しませんでした。')), 10 * 60_000);
  try {
    console.log(includeSleep
      ? '更新した紹介文・プライバシーポリシーを公開済みであることを確認してください。心拍に加え、睡眠の開始・終了、時間、段階・覚醒を90日保存し、公開APIと画面でインターネットに公開します。'
      : '心拍の読み取りを許可してください。');
    console.log('本人のGoogleアカウントで次のURLを開き、説明したデータの取得・公開に同意する場合に読み取りを許可してください。');
    console.log(authUrl);
    const code = await codePromise;
    const { tokens } = await client.getToken({ code, codeVerifier: verifier.codeVerifier });
    if (!tokens.refresh_token) throw new Error('refresh tokenが取得できません。連携許可を確認して再接続してください。');
    const granted = new Set((tokens.scope ?? '').split(/\s+/));
    if (scopes.some(scope => !granted.has(scope))) throw new Error('必要な読み取り権限が許可されていません。既存の認証情報は変更していません。');
    client.setCredentials(tokens);
    await new GoogleHealthClient(authorizedFetch(client)).verifyIdentity();
    await savePrivateJson(tokenPath, { ...config, refresh_token: tokens.refresh_token, scope: tokens.scope, connectedAt: new Date().toISOString() });
    console.log('本人連携を確認し、同期用のOAuth認証情報をローカルに保存しました（権限0600）。');
  } finally {
    clearTimeout(timer);
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
