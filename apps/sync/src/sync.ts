import { type TimeRange } from '@healthcheck/core';
import { GoogleHealthClient, HealthApiError } from '@healthcheck/google-health';
import { HeartStore, SleepStore } from '@healthcheck/storage';

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

export async function syncSleep(input: GoogleHealthClient | (() => Promise<GoogleHealthClient>), store: SleepStore, range: TimeRange) {
  const owner = await store.acquire();
  try {
    const client = typeof input === 'function' ? await input() : input;
    const sessions = await client.sleepSessions(range);
    return await store.replace(range, sessions, owner);
  } catch (error) {
    await store.fail(owner, error instanceof HealthApiError ? error.code : 'storage-error');
    throw error;
  }
}

// 指標ごとに完了させる。片方の失敗で他方の取得・保存・期限削除を止めない。
export async function syncMetrics(input: () => Promise<GoogleHealthClient>, store: HeartStore, range: TimeRange, metric: 'heart-rate' | 'sleep' | 'all') {
  const results: { metric: string; ok: boolean }[] = [];
  for (const selected of metric === 'all' ? ['heart-rate', 'sleep'] as const : [metric]) {
    let ok = true;
    try {
      if (selected === 'heart-rate') await syncHeart(input, store, range);
      else await syncSleep(input, store.sleep, range);
    } catch { ok = false; }
    // 取得の部分失敗時にも、保存期限は進む。
    try { await (selected === 'heart-rate' ? store : store.sleep).prune(); }
    catch { ok = false; }
    results.push({ metric: selected, ok });
  }
  return results;
}
