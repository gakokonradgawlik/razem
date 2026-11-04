import { and, eq, lte, max, sql } from 'drizzle-orm';
import type { Database } from './index.js';
import { devices, mutationReceipts, syncChanges, syncState } from './schema.js';

export type ReceiptRow = typeof mutationReceipts.$inferSelect;

/** Persistence for idempotency receipts, devices and journal retention. Holds no policy. */
export class SyncStore {
  constructor(readonly database: Database) {}
  private get db() { return this.database.db; }

  receipt(userId: string, deviceId: string, clientMutationId: string): ReceiptRow | undefined {
    return this.db.select().from(mutationReceipts).where(and(
      eq(mutationReceipts.userId, userId), eq(mutationReceipts.deviceId, deviceId), eq(mutationReceipts.clientMutationId, clientMutationId),
    )).get();
  }
  insertReceipt(row: ReceiptRow) { this.db.insert(mutationReceipts).values(row).run(); }
  pruneReceipts(now: string) { return this.db.delete(mutationReceipts).where(lte(mutationReceipts.expiresAt, now)).run().changes; }

  /** Records that the account used this device ID. A device ID never grants access by itself. */
  touchDevice(userId: string, deviceId: string, now: string) {
    this.db.insert(devices).values({ id: deviceId, userId, name: 'Urządzenie', createdAt: now, lastSeenAt: now })
      .onConflictDoUpdate({ target: [devices.userId, devices.id], set: { lastSeenAt: now } }).run();
  }

  state() {
    const row = this.db.select().from(syncState).where(eq(syncState.id, 1)).get();
    if (!row) throw new Error('Brak stanu synchronizacji (migracja v3)');
    return row;
  }

  /**
   * Drops journal entries changed before `changedBefore` and raises the floor: a cursor at or
   * below it can no longer be continued and must bootstrap again.
   */
  pruneJournal(changedBefore: string): number {
    return this.db.transaction(() => {
      const upTo = this.db.select({ seq: max(syncChanges.sequence) }).from(syncChanges)
        .where(sql`${syncChanges.changedAt} < ${changedBefore}`).get()?.seq ?? null;
      if (upTo === null) return 0;
      const removed = this.db.delete(syncChanges).where(lte(syncChanges.sequence, upTo)).run().changes;
      this.db.update(syncState).set({ journalFloor: sql`max(${syncState.journalFloor}, ${upTo})` }).where(eq(syncState.id, 1)).run();
      return removed;
    }, { behavior: 'immediate' });
  }
}
