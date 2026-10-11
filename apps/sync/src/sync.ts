import { type TimeRange } from '@healthcheck/core';
import { GoogleHealthClient, HealthApiError } from '@healthcheck/google-health';
import { HeartStore } from '@healthcheck/storage';

export async function syncHeart(input: GoogleHealthClient | (() => Promise<GoogleHealthClient>), store: HeartStore, range: TimeRange) {
  const owner = await store.acquire();
  try {
    const client = typeof input === 'function' ? await input() : input;
    const points = await client.heartRate(range);
    return await store.replace(range, points, owner);
  } catch (error) {
    await store.fail(owner, error instanceof HealthApiError ? error.code : 'storage-error');
    throw error;
  }
}
