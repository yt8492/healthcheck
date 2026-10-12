import type { HeartPoint, SyncState, TimeRange } from '@healthcheck/core';
import type { ReadStore } from './app.js';

// Cloud Runの同じインスタンスでのみ共有する。失敗した読み取りは保存しない。
export function cacheReads(source: ReadStore, clock = Date.now, ttl = 30_000, capacity = 16): ReadStore {
  type Entry<T> = { expiresAt: number; result: Promise<T> };
  const ranges = new Map<string, Entry<HeartPoint[]>>();
  let state: Entry<SyncState> | undefined;
  function entry<T>(read: () => Promise<T>): Entry<T> {
    return { expiresAt: clock() + ttl, result: Promise.resolve().then(read) };
  }
  return {
    emulator: source.emulator,
    state() {
      if (!state || state.expiresAt <= clock()) {
        const current = entry(() => source.state());
        state = current;
        void current.result.catch(() => { if (state === current) state = undefined; });
      }
      return state.result;
    },
    read(range: TimeRange) {
      const key = `${range.from}/${range.to}`;
      for (const [key, cached] of ranges) if (cached.expiresAt <= clock()) ranges.delete(key);
      let current = ranges.get(key);
      if (!current) {
        current = entry(() => source.read(range));
        const saved = current;
        if (ranges.size >= capacity) ranges.delete(ranges.keys().next().value!);
        ranges.set(key, current);
        void current.result.catch(() => { if (ranges.get(key) === saved) ranges.delete(key); });
      }
      return current.result;
    },
  };
}
