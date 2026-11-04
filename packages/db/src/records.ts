import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import {
  canReadRecord, dataSchemas, entityTypeSchema, idSchema, recordSchemaUnion, validateDomain, visibilitySchema,
} from '@razem/contracts';
import type { AccountScope, EntityType, SyncRecord } from '@razem/contracts';
import type { Database } from './index.js';
import { domainTables, syncChanges } from './schema.js';

type Visibility = 'private' | 'shared';
type Meta = Pick<SyncRecord, 'householdId' | 'ownerId' | 'visibility'>;
type MetaColumns = {
  id: SQLiteColumn; householdId: SQLiteColumn; ownerId: SQLiteColumn; visibility: SQLiteColumn;
  version: SQLiteColumn; deletedAt: SQLiteColumn;
};
type DomainTable = SQLiteTable & MetaColumns;

/**
 * The single permission service. Every read and write of a domain record goes through
 * it: private records only for their owner, shared records only inside the household.
 * Scope (user and household) always comes from the authenticated session, never from input.
 */
export const accessPolicy = {
  canRead(scope: AccountScope, record: Meta): boolean { return canReadRecord(scope, record); },
  // In the MVP both members may edit shared records; private ones only their owner.
  canWrite(scope: AccountScope, record: Meta): boolean { return canReadRecord(scope, record); },
  readableFilter(table: MetaColumns, scope: AccountScope): SQL {
    return and(eq(table.householdId, scope.householdId), or(eq(table.visibility, 'shared'), eq(table.ownerId, scope.userId)))!;
  },
};

const metadataKeys = ['id', 'householdId', 'ownerId', 'visibility', 'version', 'createdAt', 'updatedAt', 'deletedAt'] as const;
const parentOf: Partial<Record<EntityType, (data: Record<string, unknown>) => { type: EntityType; id: unknown }>> = {
  shopping_item: (data) => ({ type: 'shopping_list', id: data.listId }),
  task_occurrence: (data) => ({ type: 'task', id: data.taskId }),
  reminder: (data) => ({ type: entityTypeSchema.parse(data.targetType), id: data.targetId }),
};
const immutableDataKeys = ['listId', 'taskId', 'occurrenceKey', 'targetType', 'targetId'];

export type RecordResult =
  | { status: 'ack'; record: SyncRecord }
  | { status: 'conflict'; record: SyncRecord }
  // not_found covers both "absent" and "not yours": callers learn nothing about existence.
  | { status: 'error'; code: 'not_found' | 'validation_error' };

export interface CreateInput { entityType: EntityType; id: string; visibility?: Visibility; data: Record<string, unknown> }
export interface UpdateInput { entityType: EntityType; id: string; baseVersion: number; patch: Record<string, unknown> }
export interface VersionedInput { entityType: EntityType; id: string; baseVersion: number }

const notFound = { status: 'error', code: 'not_found' } as const;
const invalid = { status: 'error', code: 'validation_error' } as const;

function strictData(type: EntityType, data: unknown, visibility: Visibility | undefined): Record<string, unknown> | null {
  const schema = (dataSchemas[type] as z.ZodObject).superRefine((value, ctx) => validateDomain(type, value, visibility, ctx));
  const parsed = schema.safeParse(data);
  return parsed.success ? parsed.data as Record<string, unknown> : null;
}

export class RecordRepository {
  constructor(private readonly database: Database, private readonly clock: () => Date = () => new Date()) {}

  private table(type: EntityType): DomainTable { return domainTables[type] as unknown as DomainTable; }

  private toRecord(type: EntityType, row: Record<string, unknown>): SyncRecord {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) if (!(metadataKeys as readonly string[]).includes(key)) data[key] = value;
    const record: Record<string, unknown> = { entityType: type, data };
    for (const key of metadataKeys) record[key] = row[key];
    return recordSchemaUnion.parse(record);
  }

  private find(scope: AccountScope, type: EntityType, id: string): SyncRecord | null {
    if (!idSchema.safeParse(id).success) return null;
    const table = this.table(type);
    const row = this.database.db.select().from(table)
      .where(and(eq(table.id, id), accessPolicy.readableFilter(table, scope))).get() as Record<string, unknown> | undefined;
    return row ? this.toRecord(type, row) : null;
  }

  /** Returns the record (also soft-deleted) only when the account may read it. */
  get(scope: AccountScope, type: EntityType, id: string): SyncRecord | null { return this.find(scope, type, id); }

  list(scope: AccountScope, type: EntityType, options: { includeDeleted?: boolean } = {}): SyncRecord[] {
    const table = this.table(type);
    const filter = options.includeDeleted ? accessPolicy.readableFilter(table, scope)
      : and(accessPolicy.readableFilter(table, scope), isNull(table.deletedAt));
    return (this.database.db.select().from(table).where(filter).orderBy(table.id).all() as Array<Record<string, unknown>>)
      .map((row) => this.toRecord(type, row));
  }

  private journal(record: SyncRecord) {
    this.database.db.insert(syncChanges).values({
      entityType: record.entityType, entityId: record.id, householdId: record.householdId, ownerId: record.ownerId,
      visibility: record.visibility, version: record.version, changedAt: record.updatedAt,
    }).run();
  }

  create(scope: AccountScope, input: CreateInput): RecordResult {
    const type = entityTypeSchema.safeParse(input.entityType);
    if (!type.success || !idSchema.safeParse(input.id).success) return invalid;
    const parentRef = parentOf[type.data];
    let meta: Meta;
    if (parentRef) {
      // Children never choose their scope: they inherit the parent's household and visibility.
      if (input.visibility !== undefined || typeof input.data !== 'object' || input.data === null) return invalid;
      const ref = parentRef(input.data);
      const parentId = idSchema.safeParse(ref.id);
      if (!parentId.success) return invalid;
      const parent = this.find(scope, ref.type, parentId.data);
      if (!parent || parent.deletedAt !== null) return notFound;
      meta = { householdId: parent.householdId, visibility: parent.visibility, ownerId: parent.visibility === 'private' ? parent.ownerId : scope.userId };
    } else {
      const visibility = visibilitySchema.safeParse(input.visibility);
      if (!visibility.success) return invalid;
      meta = { householdId: scope.householdId, ownerId: scope.userId, visibility: visibility.data };
    }
    if (!accessPolicy.canWrite(scope, meta)) return notFound;
    const data = strictData(type.data, input.data, meta.visibility);
    if (!data) return invalid;
    return this.database.db.transaction(() => {
      const table = this.table(type.data);
      const existing = this.database.db.select({ id: table.id }).from(table).where(eq(table.id, input.id)).get();
      if (existing) {
        const visible = this.find(scope, type.data, input.id);
        return visible ? { status: 'conflict', record: visible } as const : notFound;
      }
      const now = this.clock().toISOString();
      const record = recordSchemaUnion.parse({ id: input.id, entityType: type.data, ...meta, version: 1, createdAt: now, updatedAt: now, deletedAt: null, data });
      this.database.db.insert(table).values({ ...meta, ...data, id: input.id, version: 1, createdAt: now, updatedAt: now, deletedAt: null } as never).run();
      this.journal(record);
      return { status: 'ack', record } as const;
    }, { behavior: 'immediate' });
  }

  private write(scope: AccountScope, input: VersionedInput, change: (current: SyncRecord) => Record<string, unknown> | 'conflict' | null): RecordResult {
    const type = entityTypeSchema.safeParse(input.entityType);
    if (!type.success || !Number.isSafeInteger(input.baseVersion) || input.baseVersion < 1) return invalid;
    return this.database.db.transaction(() => {
      const current = this.find(scope, type.data, input.id);
      if (!current || !accessPolicy.canWrite(scope, current)) return notFound;
      if (current.version !== input.baseVersion) return { status: 'conflict', record: current } as const;
      const next = change(current);
      if (next === 'conflict') return { status: 'conflict', record: current } as const;
      if (!next) return invalid;
      const now = this.clock().toISOString();
      const table = this.table(type.data);
      const values = { ...next, version: current.version + 1, updatedAt: now < current.updatedAt ? current.updatedAt : now };
      const updated = this.database.db.update(table).set(values as never)
        .where(and(eq(table.id, current.id), eq(table.version, current.version), accessPolicy.readableFilter(table, scope))).run();
      if (updated.changes !== 1) return { status: 'conflict', record: current } as const;
      const record = this.find(scope, type.data, current.id)!;
      this.journal(record);
      return { status: 'ack', record } as const;
    }, { behavior: 'immediate' });
  }

  update(scope: AccountScope, input: UpdateInput): RecordResult {
    return this.write(scope, input, (current) => {
      if (current.deletedAt !== null) return 'conflict';
      if (typeof input.patch !== 'object' || input.patch === null) return null;
      const keys = Object.keys(input.patch);
      if (keys.length === 0 || keys.some((key) => immutableDataKeys.includes(key))) return null;
      const patch = (dataSchemas[current.entityType] as z.ZodObject).partial().safeParse(input.patch);
      if (!patch.success) return null;
      const merged = strictData(current.entityType, { ...current.data, ...patch.data }, current.visibility);
      return merged ? patch.data as Record<string, unknown> : null;
    });
  }

  remove(scope: AccountScope, input: VersionedInput): RecordResult {
    return this.write(scope, input, (current) => current.deletedAt !== null ? 'conflict' : { deletedAt: this.clock().toISOString() });
  }

  restore(scope: AccountScope, input: VersionedInput): RecordResult {
    return this.write(scope, input, (current) => {
      if (current.deletedAt === null) return 'conflict';
      const ref = parentOf[current.entityType]?.(current.data);
      if (ref) {
        const parent = this.find(scope, ref.type, String(ref.id));
        if (!parent || parent.deletedAt !== null) return 'conflict';
      }
      return { deletedAt: null };
    });
  }

  /** Journal entries visible to the account, for diagnostics and the future sync service. */
  journalSince(scope: AccountScope, sequence: number) {
    return this.database.db.select().from(syncChanges)
      .where(and(sql`${syncChanges.sequence} > ${sequence}`, accessPolicy.readableFilter(syncChanges as unknown as MetaColumns, scope)))
      .orderBy(syncChanges.sequence).all();
  }
}
