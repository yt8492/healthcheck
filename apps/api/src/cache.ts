import type { HeartPoint, SleepSession, SyncState, TimeRange } from '@healthcheck/core';
import type { ReadStore, SleepReadStore } from './app.js';

// Cloud Runの同じインスタンスでのみ共有する。失敗した読み取りは保存しない。
export function cacheReads(source: ReadStore, clock = Date.now, ttl = 30_000, capacity = 16): ReadStore {
  type Entry<T> = { expiresAt: number; result: Promise<T> };
  const ranges = new Map<string, Entry<HeartPoint[]>>();
  const sleepRanges = new Map<string, Entry<SleepSession[]>>();
  let sleepState: Entry<SyncState> | undefined;
  let state: Entry<SyncState> | undefined;
  function entry<T>(read: () => Promise<T>): Entry<T> {
    return { expiresAt: clock() + ttl, result: Promise.resolve().then(read) };
  }
  const sleep: SleepReadStore | undefined = source.sleep ? {
    state() {
      if (!sleepState || sleepState.expiresAt <= clock()) {
        const current = entry(() => source.sleep!.state());
        sleepState = current;
        void current.result.catch(() => { if (sleepState === current) sleepState = undefined; });
      }
      return sleepState.result;
    },
    read(range) {
      return readRange(sleepRanges, range, () => source.sleep!.read(range));
    },
  } : undefined;
  function readRange<T>(cache: Map<string, Entry<T>>, range: TimeRange, read: () => Promise<T>): Promise<T> {
    const key = `${range.from}/${range.to}`;
    for (const [key, cached] of cache) if (cached.expiresAt <= clock()) cache.delete(key);
    let current = cache.get(key);
    if (!current) {
      current = entry(read);
      const saved = current;
      if (cache.size >= capacity) cache.delete(cache.keys().next().value!);
      cache.set(key, current);
      void current.result.catch(() => { if (cache.get(key) === saved) cache.delete(key); });
    }
    return current.result;
  }
  return {
    emulator: source.emulator,
    sleep,
    state() {
      if (!state || state.expiresAt <= clock()) {
        const current = entry(() => source.state());
        state = current;
        void current.result.catch(() => { if (state === current) state = undefined; });
      }
      return state.result;
    },
    read(range: TimeRange) {
      return readRange(ranges, range, () => source.read(range));
    },
  };
}
