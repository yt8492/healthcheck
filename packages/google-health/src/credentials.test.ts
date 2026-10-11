import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizedFetch, savePrivateJson } from './credentials.js';

afterEach(() => vi.restoreAllMocks());
describe('OAuth認証情報の処理', () => {
  it('refresh後のアクセストークンをAuthorizationだけに設定する', async () => {
    const client = new OAuth2Client();
    vi.spyOn(client, 'getAccessToken').mockImplementation(async () => ({ token: 'fake-access-token' }));
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}));
    await authorizedFetch(client)('https://health.googleapis.com/v4/users/me/identity', { method: 'GET' });
    const [url, init] = request.mock.calls[0]!;
    expect(url).not.toContain('fake-access-token');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fake-access-token');
  });
  it('invalid_grantと通信失敗を別の状態にする', async () => {
    const client = new OAuth2Client();
    const update = vi.spyOn(client, 'getAccessToken');
    update.mockRejectedValueOnce({ response: { status: 400, data: { error: 'invalid_grant', private: 'hidden' } } });
    await expect(authorizedFetch(client)('https://health.googleapis.com/', {})).rejects.toMatchObject({ code: 'reauth-required' });
    update.mockRejectedValueOnce(new Error('network error with private details'));
    await expect(authorizedFetch(client)('https://health.googleapis.com/', {})).rejects.toMatchObject({ code: 'upstream-unavailable' });
  });
  it('既存ファイルの権限が広くても秘密を0600で置き換える', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'healthcheck-token-test-'));
    const file = join(directory, 'token.json');
    try {
      await savePrivateJson(file, { refresh_token: 'fake-1' });
      await chmod(file, 0o644);
      await savePrivateJson(file, { refresh_token: 'fake-2' });
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ refresh_token: 'fake-2' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
