import { describe, expect, it, vi } from 'vitest';
import { blankState, bucketHeartPoints, emptyPoints, type HeartResolution, type TimeRange } from '@healthcheck/core';
import { cacheReads } from './cache.js';

const range = { from: '2026-10-12T00:00:00Z', to: '2026-10-12T00:01:00Z' };
function source() { return { emulator: false, state: vi.fn(async () => blankState()), read: vi.fn(async (r: TimeRange) => emptyPoints(r)) }; }

describe('公開APIの読み取りキャッシュ', () => {
  it('並行要求を共有し、期限を過ぎると同期後のデータを読み直す', async () => {
    let now = 0;
    const db = source(), cached = cacheReads(db, () => now);
    await Promise.all([cached.read(range), cached.read({ ...range }), cached.state(), cached.state()]);
    expect(db.read).toHaveBeenCalledTimes(1); expect(db.state).toHaveBeenCalledTimes(1);
    now = 30_000;
    db.read.mockResolvedValueOnce([{ time: range.from, value: { avg: 70, min: 60, max: 80 } }]);
    expect((await cached.read(range))[0]?.value?.avg).toBe(70);
    await cached.state();
    expect(db.read).toHaveBeenCalledTimes(2); expect(db.state).toHaveBeenCalledTimes(2);
  });
  it('失敗した読み取りを保持せず、次の要求で復旧を確認する', async () => {
    const db = source(), cached = cacheReads(db);
    db.read.mockRejectedValueOnce(new Error('unavailable'));
    db.state.mockRejectedValueOnce(new Error('unavailable'));
    await expect(cached.read(range)).rejects.toThrow('unavailable');
    await expect(cached.state()).rejects.toThrow('unavailable');
    await expect(cached.read(range)).resolves.toHaveLength(1);
    await expect(cached.state()).resolves.toEqual(blankState());
  });
  it('任意期間の要求が増えても保持件数を制限する', async () => {
    const db = source(), cached = cacheReads(db, () => 0, 30_000, 1);
    await cached.read(range);
    await cached.read({ ...range, to: '2026-10-12T00:02:00Z' });
    await cached.read(range);
    expect(db.read).toHaveBeenCalledTimes(3);
  });
  it('心拍の集計キャッシュは粒度を区別し、並行要求・失敗・有効期限を扱う', async () => {
    let now = 0;
    const readDisplay = vi.fn(async (r: TimeRange, resolution: HeartResolution) => bucketHeartPoints(emptyPoints(r), r, resolution));
    const cached = cacheReads({ ...source(), readDisplay }, () => now);
    await Promise.all([cached.readDisplay!(range, '1h'), cached.readDisplay!(range, '1h'), cached.readDisplay!(range, '1d')]);
    expect(readDisplay).toHaveBeenCalledTimes(2);
    now = 30_000;
    readDisplay.mockRejectedValueOnce(new Error('unavailable'));
    await expect(cached.readDisplay!(range, '1h')).rejects.toThrow('unavailable');
    await expect(cached.readDisplay!(range, '1h')).resolves.toBeTruthy();
    expect(readDisplay).toHaveBeenCalledTimes(4);
  });
});
