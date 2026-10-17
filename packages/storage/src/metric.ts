import { randomUUID } from 'node:crypto';
import { type Firestore, type Transaction } from '@google-cloud/firestore';
import { z } from 'zod';
import { blankState, type SyncState, type SyncErrorCode } from '@healthcheck/core';

const stateSchema = z.object({
  lastAttemptAt: z.string().nullable(), lastSuccessAt: z.string().nullable(),
  lastRange: z.object({ from: z.string(), to: z.string() }).nullable(), dataThrough: z.string().nullable(),
  completedRanges: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
  error: z.object({ code: z.enum(['reauth-required', 'access-denied', 'upstream-unavailable', 'invalid-upstream-data', 'storage-error']), at: z.string() }).nullable(),
});
const LEASE_MS = 10 * 60_000;
export class LeaseBusyError extends Error { constructor() { super('別の同期が実行中です。'); } }
export class LeaseExpiredError extends Error { constructor() { super('同期ロックの有効期限が切れました。保存は更新していません。'); } }

export class MetricStore {
  readonly emulator: boolean;
  constructor(readonly db: Firestore, protected readonly clock: () => number, private readonly metric: 'heart-rate' | 'sleep') {
    this.emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  }
  protected stateRef() { return this.db.doc(`syncState/${this.metric}`); }
  protected leaseRef() { return this.db.doc(`jobLease/${this.metric}`); }
  async state(): Promise<SyncState> {
    const doc = await this.stateRef().get();
    return doc.exists ? stateSchema.parse(doc.data()) : blankState();
  }
  async acquire(): Promise<string> {
    const owner = randomUUID(), now = this.clock();
    await this.db.runTransaction(async tx => {
      const [lock, state] = await tx.getAll(this.leaseRef(), this.stateRef());
      if (!lock || !state) throw new Error('同期状態を読み取れません。');
      if (lock.exists && Number(lock.get('expiresAt')) > now) throw new LeaseBusyError();
      tx.set(this.leaseRef(), { owner, expiresAt: now + LEASE_MS });
      tx.set(this.stateRef(), { ...blankState(), ...state.data(), lastAttemptAt: new Date(now).toISOString() });
    });
    return owner;
  }
  protected async checkLease(tx: Transaction, owner: string) {
    const doc = await tx.get(this.leaseRef());
    if (!doc.exists || doc.get('owner') !== owner || Number(doc.get('expiresAt')) <= this.clock()) throw new LeaseExpiredError();
  }
  async fail(owner: string, code: SyncErrorCode): Promise<void> {
    await this.db.runTransaction(async tx => {
      const lock = await tx.get(this.leaseRef());
      if (!lock.exists || lock.get('owner') !== owner) return;
      const state = await tx.get(this.stateRef());
      const at = new Date(this.clock()).toISOString();
      tx.set(this.stateRef(), { ...blankState(), ...state.data(), lastAttemptAt: at, error: { code, at } });
      tx.delete(this.leaseRef());
    });
  }
}
