import { readFile, mkdir, writeFile, chmod, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { z } from 'zod';
import { HealthApiError, type AuthorizedFetch } from './index.js';

const clientSchema = z.object({ client_id: z.string().min(1), client_secret: z.string().min(1) });
const tokenSchema = clientSchema.extend({ refresh_token: z.string().min(1) });
export type OAuthClientConfig = z.infer<typeof clientSchema>;

export async function readClient(path: string): Promise<OAuthClientConfig> {
  const input: unknown = JSON.parse(await readFile(path, 'utf8'));
  const checked = z.object({ web: clientSchema }).safeParse(input);
  if (!checked.success) throw new Error('Webアプリケーション用OAuthクライアントJSONを指定してください。');
  return checked.data.web;
}

export async function savePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

export function authorizedFetch(client: OAuth2Client): AuthorizedFetch {
  return async (url, init) => {
    let token: string | null | undefined;
    try { token = (await client.getAccessToken()).token; }
    catch (error) {
      const status = z.object({ response: z.object({ status: z.number() }) }).safeParse(error);
      if (status.success && (status.data.response.status === 400 || status.data.response.status === 401)) {
        throw new HealthApiError('reauth-required', 'OAuthトークンを更新できません。npm run connectで再接続してください。');
      }
      throw new HealthApiError('upstream-unavailable', 'OAuthトークンの更新先と通信できません。');
    }
    if (!token) throw new HealthApiError('reauth-required', 'OAuthアクセストークンを取得できません。');
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  };
}

export async function loadAuthorizedFetch(): Promise<AuthorizedFetch> {
  let config: OAuthClientConfig, token: z.infer<typeof tokenSchema>;
  if (process.env.GOOGLE_HEALTH_CREDENTIAL_SECRET) {
    const secrets = new SecretManagerServiceClient();
    try {
      const [version] = await secrets.accessSecretVersion({ name: process.env.GOOGLE_HEALTH_CREDENTIAL_SECRET });
      const checked = tokenSchema.parse(JSON.parse(version.payload?.data?.toString() ?? ''));
      config = checked; token = checked;
    } finally { await secrets.close(); }
  } else {
    token = tokenSchema.parse(JSON.parse(await readFile(process.env.GOOGLE_HEALTH_TOKEN_FILE ?? '.local/google-health-tokens.json', 'utf8')));
    config = token;
  }
  const client = new OAuth2Client({ clientId: config.client_id, clientSecret: config.client_secret, transporterOptions: { timeout: 30_000 } });
  client.setCredentials(token);
  return authorizedFetch(client);
}
