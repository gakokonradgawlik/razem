// Local-first store of one account (RAZ-5). Every account/household has its own
// IndexedDB database, so a second person signing in on the same device never opens
// the previous account's records, outbox or conflicts.
import Dexie from 'dexie';
import type { DexieOptions, Table } from 'dexie';
import { idSchema } from '@razem/contracts';
import type { AccountScope, EntityType } from '@razem/contracts';
import type { z } from 'zod';
import type { serverStateSchema } from '@razem/contracts';

export type ServerState = z.infer<typeof serverStateSchema>;
export type Visibility = 'private' | 'shared';
export type Command = 'create' | 'update' | 'delete' | 'restore';

export function localDatabaseName(scope: AccountScope): string {
  return `razem:${idSchema.parse(scope.householdId)}:${idSchema.parse(scope.userId)}`;
}

/** The record as this device shows it: the server state plus the local changes still queued. */
export type LocalRecord = {
  id: string; entityType: EntityType; parentId: string | null;
  householdId: string; ownerId: string; visibility: Visibility;
  /** Server version the local view was derived from; 0 = not yet created on the server. */
  version: number;
  data: Record<string, unknown>;
  createdAt: string; updatedAt: string; deletedAt: string | null;
};

/**
 * One local intent waiting for the server. Entries keep the order (`seq`) of the user's
 * commands; `baseVersion: null` means "based on the result of my previous queued
 * mutation of this record" and is rebased to the server version when that one is ACKed.
 */
export type QueueEntry = {
  seq?: number;
  clientMutationId: string;
  entityType: EntityType; entityId: string; parentId: string | null;
  command: Command;
  visibility?: Visibility;
  data?: Record<string, unknown>;
  patch?: Record<string, unknown>;
  baseVersion: number | null;
  queuedAt: string; attempts: number;
  state: 'pending' | 'needs_action';
  /** Server error code of a change that cannot be retried as is (no user content). */
  error?: string;
};

/** Server state the queued local changes of a record were based on ("baza porównania"). */
export type BaseEntry = { id: string; state: ServerState | null };

export type ConflictEntry = {
  id: string; entityType: EntityType; entityId: string;
  /** Local view when the conflict was detected (null: only a local delete existed). */
  local: LocalRecord | null;
  base: ServerState | null;
  server: ServerState;
  /** The local intents that were rejected, in order. Kept until the user decides. */
  mutations: QueueEntry[];
  detectedAt: string;
};

export type MetaEntry = { key: string; value: unknown };

export class LocalDatabase extends Dexie {
  records!: Table<LocalRecord, string>;
  queue!: Table<QueueEntry, number>;
  bases!: Table<BaseEntry, string>;
  conflicts!: Table<ConflictEntry, string>;
  meta!: Table<MetaEntry, string>;
  /** IDs received during a full snapshot that is still being paged. */
  seen!: Table<{ id: string }, string>;

  constructor(scope: AccountScope, options?: DexieOptions) {
    super(localDatabaseName(scope), options);
    // v1: RAZ-3 scaffold. Never delete its outbox without moving it (upgrade test).
    this.version(1).stores({
      records: 'id, entityType, visibility',
      outbox: 'mutation.clientMutationId, queuedAt, state',
      conflicts: 'id', cursors: 'key',
    });
    this.version(2).stores({
      records: 'id, entityType, parentId',
      queue: '++seq, &clientMutationId, entityId, state',
      bases: 'id', conflicts: 'id, entityId', meta: 'key', seen: 'id',
      outbox: null, cursors: null,
    }).upgrade(async (tx) => {
      const legacyOutbox = await tx.table('outbox').toArray() as LegacyOutbox[];
      legacyOutbox.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
      for (const entry of legacyOutbox) {
        const m = entry.mutation;
        await tx.table('queue').add({
          clientMutationId: m.clientMutationId, entityType: m.entityType, entityId: m.entityId,
          parentId: parentOf(m.entityType, m.data ?? null), command: m.command,
          ...(m.visibility ? { visibility: m.visibility } : {}), ...(m.data ? { data: m.data } : {}), ...(m.patch ? { patch: m.patch } : {}),
          baseVersion: m.command === 'create' ? 0 : m.baseVersion,
          queuedAt: entry.queuedAt, attempts: entry.attempts, state: entry.state,
        } satisfies QueueEntry);
        // The device ID is part of the idempotency key: keep it, or retries would duplicate.
        if (!(await tx.table('meta').get('deviceId'))) await tx.table('meta').put({ key: 'deviceId', value: entry.deviceId });
      }
      const legacyConflicts = await tx.table('conflicts').toArray() as LegacyConflict[];
      for (const conflict of legacyConflicts) {
        await tx.table('conflicts').put({
          id: conflict.id, entityType: conflict.mutation.entityType, entityId: conflict.mutation.entityId,
          local: null, base: conflict.base ? { kind: 'record', record: conflict.base } : null, server: conflict.server,
          mutations: [], detectedAt: conflict.detectedAt,
        } as unknown as ConflictEntry);
      }
      const cursors = await tx.table('cursors').toArray() as { key: string; value: string }[];
      for (const cursor of cursors) await tx.table('meta').put({ key: cursor.key === 'pull' ? 'cursor' : `legacy:${cursor.key}`, value: cursor.value });
      await tx.table('records').toCollection().modify((record: LocalRecord) => {
        record.parentId = parentOf(record.entityType, record.data);
      });
    });
  }
}

type LegacyOutbox = { deviceId: string; queuedAt: string; attempts: number; state: 'pending' | 'needs_action'; mutation: {
  clientMutationId: string; entityId: string; entityType: EntityType; command: Command; baseVersion: number;
  visibility?: Visibility; data?: Record<string, unknown>; patch?: Record<string, unknown>;
} };
type LegacyConflict = { id: string; mutation: { entityType: EntityType; entityId: string }; base: unknown; server: ServerState; detectedAt: string };

/** Immutable parent reference of a child record (ACL is inherited from it). */
export function parentOf(entityType: EntityType, data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  const key = entityType === 'shopping_item' ? 'listId' : entityType === 'task_occurrence' ? 'taskId' : entityType === 'reminder' ? 'targetId' : null;
  const value = key ? data[key] : null;
  return typeof value === 'string' ? value : null;
}
