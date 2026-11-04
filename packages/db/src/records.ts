import { and, asc, eq, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import {
  canReadRecord, dataSchemas, entityTypeSchema, idSchema, recordSchemaUnion, tombstoneSchema, validateDomain, visibilitySchema,
} from '@razem/contracts';
import type { AccountScope, EntityType, SyncRecord } from '@razem/contracts';
import type { Database } from './index.js';
import { domainTables, syncChanges, taskOccurrences, tombstones } from './schema.js';

export type Tombstone = z.infer<typeof tombstoneSchema>;
export type ServerState = { kind: 'record'; record: SyncRecord } | { kind: 'tombstone'; tombstone: Tombstone };
/** Fixed order of the snapshot: parents before their children. */
export const SNAPSHOT_ORDER: readonly EntityType[] = [
  'shopping_list', 'shopping_item', 'task', 'task_occurrence', 'calendar_event', 'important_date', 'note', 'reminder',
];

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
  // The record was purged from the trash: old mutations never resurrect it.
  | { status: 'conflict'; tombstone: Tombstone }
  // not_found covers both "absent" and "not yours": callers learn nothing about existence.
  | { status: 'error'; code: 'not_found' | 'validation_error' | 'already_exists' };

export function resultState(result: Exclude<RecordResult, { status: 'error' }>): ServerState {
  return 'record' in result ? { kind: 'record', record: result.record } : { kind: 'tombstone', tombstone: result.tombstone };
}

export interface CreateInput { entityType: EntityType; id: string; visibility?: Visibility; data: Record<string, unknown> }
export interface UpdateInput { entityType: EntityType; id: string; baseVersion: number; patch: Record<string, unknown> }
export interface VersionedInput { entityType: EntityType; id: string; baseVersion: number }

const notFound = { status: 'error', code: 'not_found' } as const;
const invalid = { status: 'error', code: 'validation_error' } as const;
const alreadyExists = { status: 'error', code: 'already_exists' } as const;

/** Database constraints mirror the Zod rules; a violation is a permanent input error, never a 5xx retry loop. */
function isConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && String(error.code).startsWith('SQLITE_CONSTRAINT');
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

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

  /** Tombstone of a purged record, only when the account may read it. */
  tombstone(scope: AccountScope, type: EntityType, id: string): Tombstone | null {
    if (!idSchema.safeParse(id).success) return null;
    const row = this.database.db.select().from(tombstones).where(and(
      eq(tombstones.entityType, type), eq(tombstones.id, id), accessPolicy.readableFilter(tombstones as unknown as MetaColumns, scope),
    )).get();
    return row ? tombstoneSchema.parse({ entityType: row.entityType, id: row.id, version: row.version, deletedAt: row.deletedAt }) : null;
  }

  /** Current readable state: live or trashed record, else tombstone, else null (absent or not yours). */
  state(scope: AccountScope, type: EntityType, id: string): ServerState | null {
    const record = this.find(scope, type, id);
    if (record) return { kind: 'record', record };
    const tombstone = this.tombstone(scope, type, id);
    return tombstone ? { kind: 'tombstone', tombstone } : null;
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

  private journal(record: Pick<SyncRecord, 'entityType' | 'id' | 'householdId' | 'ownerId' | 'visibility' | 'version' | 'updatedAt'>) {
    this.database.db.insert(syncChanges).values({
      entityType: record.entityType, entityId: record.id, householdId: record.householdId, ownerId: record.ownerId,
      visibility: record.visibility, version: record.version, changedAt: record.updatedAt,
    }).run();
  }

  /** Purged IDs: readable ones answer with the tombstone, others like a missing record. */
  private tombstoned(scope: AccountScope, type: EntityType, id: string): RecordResult | null {
    const exists = this.database.db.select({ id: tombstones.id }).from(tombstones)
      .where(and(eq(tombstones.entityType, type), eq(tombstones.id, id))).get();
    if (!exists) return null;
    const visible = this.tombstone(scope, type, id);
    return visible ? { status: 'conflict', tombstone: visible } : notFound;
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
    return this.database.db.transaction((): RecordResult => {
      const table = this.table(type.data);
      const existing = this.database.db.select({ id: table.id }).from(table).where(eq(table.id, input.id)).get();
      if (existing) {
        const visible = this.find(scope, type.data, input.id);
        return visible ? { status: 'conflict', record: visible } as const : notFound;
      }
      const purged = this.tombstoned(scope, type.data, input.id);
      if (purged) return purged;
      if (type.data === 'task_occurrence') {
        // One completion per (task, nominal day): two phones never create two occurrences.
        const twin = this.database.db.select({ id: taskOccurrences.id }).from(taskOccurrences)
          .where(and(eq(taskOccurrences.taskId, String(data.taskId)), eq(taskOccurrences.occurrenceKey, String(data.occurrenceKey)))).get();
        if (twin) return alreadyExists;
      }
      const now = this.clock().toISOString();
      const record = recordSchemaUnion.parse({ id: input.id, entityType: type.data, ...meta, version: 1, createdAt: now, updatedAt: now, deletedAt: null, data });
      try {
        this.database.db.insert(table).values({ ...meta, ...data, id: input.id, version: 1, createdAt: now, updatedAt: now, deletedAt: null } as never).run();
      } catch (error) {
        if (isConstraintError(error)) return invalid;
        throw error;
      }
      this.journal(record);
      return { status: 'ack', record } as const;
    }, { behavior: 'immediate' });
  }

  private write(scope: AccountScope, input: VersionedInput, change: (current: SyncRecord) => Record<string, unknown> | 'conflict' | null,
    alreadyApplied?: (current: SyncRecord) => boolean): RecordResult {
    const type = entityTypeSchema.safeParse(input.entityType);
    if (!type.success || !Number.isSafeInteger(input.baseVersion) || input.baseVersion < 1) return invalid;
    return this.database.db.transaction((): RecordResult => {
      const current = this.find(scope, type.data, input.id);
      if (!current) return this.tombstoned(scope, type.data, input.id) ?? notFound;
      if (!accessPolicy.canWrite(scope, current)) return notFound;
      if (current.version !== input.baseVersion) {
        // A stale change whose effect is already the current state (e.g. the same item checked
        // on both phones) is acknowledged without a new version; anything else is a conflict.
        if (alreadyApplied?.(current)) return { status: 'ack', record: current } as const;
        return { status: 'conflict', record: current } as const;
      }
      const next = change(current);
      if (next === 'conflict') return { status: 'conflict', record: current } as const;
      if (!next) return invalid;
      const now = this.clock().toISOString();
      const table = this.table(type.data);
      const values = { ...next, version: current.version + 1, updatedAt: now < current.updatedAt ? current.updatedAt : now };
      let updated;
      try {
        updated = this.database.db.update(table).set(values as never)
          .where(and(eq(table.id, current.id), eq(table.version, current.version), accessPolicy.readableFilter(table, scope))).run();
      } catch (error) {
        if (isConstraintError(error)) return invalid;
        throw error;
      }
      if (updated.changes !== 1) return { status: 'conflict', record: current } as const;
      const record = this.find(scope, type.data, current.id)!;
      this.journal(record);
      return { status: 'ack', record } as const;
    }, { behavior: 'immediate' });
  }

  update(scope: AccountScope, input: UpdateInput): RecordResult {
    const noop = (current: SyncRecord) => {
      if (current.deletedAt !== null || typeof input.patch !== 'object' || input.patch === null) return false;
      const patch = (dataSchemas[current.entityType] as z.ZodObject).partial().safeParse(input.patch);
      const data = current.data as Record<string, unknown>;
      return patch.success && Object.keys(patch.data).length > 0
        && Object.entries(patch.data).every(([key, value]) => key in data && canonical(data[key]) === canonical(value));
    };
    return this.write(scope, input, (current) => {
      if (current.deletedAt !== null) return 'conflict';
      if (typeof input.patch !== 'object' || input.patch === null) return null;
      const keys = Object.keys(input.patch);
      if (keys.length === 0 || keys.some((key) => immutableDataKeys.includes(key))) return null;
      const patch = (dataSchemas[current.entityType] as z.ZodObject).partial().safeParse(input.patch);
      if (!patch.success) return null;
      const merged = strictData(current.entityType, { ...current.data, ...patch.data }, current.visibility);
      return merged ? patch.data as Record<string, unknown> : null;
    }, noop);
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

  /** Records of one snapshot page in SNAPSHOT_ORDER, keyset (type, id) after the given position; trash included. */
  snapshotPage(scope: AccountScope, after: { type: number; id: string | null }, limit: number, byteBudget = Infinity) {
    const records: SyncRecord[] = [];
    let bytes = 0;
    let position = { ...after };
    for (let typeIndex = after.type; typeIndex < SNAPSHOT_ORDER.length; typeIndex++) {
      const type = SNAPSHOT_ORDER[typeIndex]!;
      const table = this.table(type);
      const afterId = typeIndex === after.type ? after.id : null;
      const filter = afterId === null ? accessPolicy.readableFilter(table, scope) : and(accessPolicy.readableFilter(table, scope), gt(table.id, afterId));
      const rows = this.database.db.select().from(table).where(filter).orderBy(asc(table.id)).limit(limit - records.length + 1).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const record = this.toRecord(type, row);
        const size = Buffer.byteLength(JSON.stringify(record));
        if (records.length >= limit || (records.length > 0 && bytes + size > byteBudget)) return { records, next: position };
        records.push(record);
        bytes += size;
        position = { type: typeIndex, id: record.id };
      }
    }
    return { records, next: null };
  }

  /** Readable journal entries with after < sequence <= upTo, oldest first. */
  journalPage(scope: AccountScope, after: number, upTo: number, limit: number) {
    return this.database.db.select().from(syncChanges).where(and(
      gt(syncChanges.sequence, after), lte(syncChanges.sequence, upTo),
      accessPolicy.readableFilter(syncChanges as unknown as MetaColumns, scope),
    )).orderBy(asc(syncChanges.sequence)).limit(limit).all();
  }

  /** Highest journal sequence <= upTo that the account may read (0 when none). */
  maxReadableSequence(scope: AccountScope, upTo: number): number {
    return this.database.db.select({ max: sql<number | null>`max(${syncChanges.sequence})` }).from(syncChanges).where(and(
      lte(syncChanges.sequence, upTo), accessPolicy.readableFilter(syncChanges as unknown as MetaColumns, scope),
    )).get()?.max ?? 0;
  }

  maxSequence(): number {
    return this.database.db.select({ max: sql<number | null>`max(${syncChanges.sequence})` }).from(syncChanges).get()?.max ?? 0;
  }

  /**
   * Maintenance (no account scope): records in the trash since `deletedBefore` or earlier are
   * removed with their children and replaced by content-free tombstones, journaled as a new version.
   */
  purgeTrash(deletedBefore: string): number {
    return this.database.db.transaction(() => {
      let purged = 0;
      const now = this.clock().toISOString();
      for (const type of SNAPSHOT_ORDER) {
        const table = this.table(type);
        const rows = this.database.db.select().from(table)
          .where(and(isNotNull(table.deletedAt), lte(table.deletedAt, deletedBefore))).all() as Array<Record<string, unknown>>;
        for (const row of rows) purged += this.purgeRow(type, row, now);
      }
      return purged;
    }, { behavior: 'immediate' });
  }

  private purgeRow(type: EntityType, row: Record<string, unknown>, now: string): number {
    const table = this.table(type);
    const still = this.database.db.select({ id: table.id }).from(table).where(eq(table.id, String(row.id))).get();
    if (!still) return 0; // already purged as a child of another record
    let purged = 0;
    const children: Array<[EntityType, SQL]> = [];
    if (type === 'shopping_list') children.push(['shopping_item', eq(domainTables.shopping_item.listId, String(row.id))]);
    if (type === 'task') children.push(['task_occurrence', eq(domainTables.task_occurrence.taskId, String(row.id))]);
    if (type === 'task' || type === 'calendar_event' || type === 'important_date')
      children.push(['reminder', and(eq(domainTables.reminder.targetType, type), eq(domainTables.reminder.targetId, String(row.id)))!]);
    for (const [childType, filter] of children) {
      for (const child of this.database.db.select().from(this.table(childType)).where(filter).all() as Array<Record<string, unknown>>)
        purged += this.purgeRow(childType, child, now);
    }
    const meta = {
      entityType: type, id: String(row.id), householdId: String(row.householdId), ownerId: String(row.ownerId),
      visibility: visibilitySchema.parse(row.visibility), version: Number(row.version) + 1,
    };
    this.database.db.insert(tombstones).values({ ...meta, deletedAt: String(row.deletedAt ?? now), purgedAt: now }).run();
    this.database.db.delete(table).where(eq(table.id, meta.id)).run();
    this.journal({ ...meta, updatedAt: now });
    return purged + 1;
  }

  /** Journal entries visible to the account, for diagnostics and the future sync service. */
  journalSince(scope: AccountScope, sequence: number) {
    return this.database.db.select().from(syncChanges)
      .where(and(sql`${syncChanges.sequence} > ${sequence}`, accessPolicy.readableFilter(syncChanges as unknown as MetaColumns, scope)))
      .orderBy(syncChanges.sequence).all();
  }
}
