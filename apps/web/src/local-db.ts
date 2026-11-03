import Dexie from 'dexie';
import type { Table } from 'dexie';
import { z } from 'zod';
import { idSchema, outboxEntrySchema, localConflictSchema } from '@razem/contracts';
import type { SyncRecord, AccountScope } from '@razem/contracts';

export function localDatabaseName(scope: AccountScope): string {
  return `razem:${idSchema.parse(scope.householdId)}:${idSchema.parse(scope.userId)}`;
}

// Schema scaffold only. No anonymous/global database is opened by the screen.
// RAZ-5 adds atomic domain commands and the sync coordinator.
export class LocalDatabase extends Dexie {
  records!: Table<SyncRecord, string>;
  outbox!: Table<z.infer<typeof outboxEntrySchema>, string>;
  conflicts!: Table<z.infer<typeof localConflictSchema>, string>;
  cursors!: Table<{ key: string; value: string }, string>;

  constructor(scope: AccountScope) {
    super(localDatabaseName(scope));
    this.version(1).stores({
      records: 'id, entityType, visibility',
      outbox: 'mutation.clientMutationId, queuedAt, state',
      conflicts: 'id', cursors: 'key',
    });
  }
}
