// Domain commands and sync bookkeeping of one account's local database.
// Invariants (architecture/sync.md):
// - a command changes the local record and appends its outbox entry in ONE Dexie
//   transaction; it resolves ok only after that transaction committed;
// - an outbox entry is deleted only after the server's ACK was stored;
// - a pulled server version never overwrites a record with local changes (dirty):
//   it only becomes the new base, so the queued intent meets the server version check;
// - conflicts keep the local intent, its base and the server state until the user decides.
import { calendarReminderId, taskOccurrence, taskOccurrenceId, taskDataSchema, validTaskScheduleChange, canReadRecord, IMMUTABLE_PARENT_FIELDS, mutationSchema, recordSchemaUnion } from '@razem/contracts';
import type { AccountScope, EntityType, Mutation, PullResponse, PushResponse, SyncRecord } from '@razem/contracts';
import type { CalendarSave } from '../services.js';
import { LocalDatabase, parentOf } from '../local-db.js';
import type { Command, ConflictEntry, LocalRecord, QueueEntry, ServerState, Visibility } from '../local-db.js';

/** account_changed: the command was started for an account that is no longer open here (controller). */
export type StoreFailure = 'storage_full' | 'storage_unavailable' | 'not_found' | 'invalid' | 'conflict_open' | 'account_changed';
export type StoreResult<T = undefined> = { ok: true; value: T } | { ok: false; reason: StoreFailure };
export type MutationResult = PushResponse['results'][number];
export type OkPull = Extract<PullResponse, { status: 'ok' }>;

const CHILD_TYPES: ReadonlySet<EntityType> = new Set(['shopping_item', 'task_occurrence', 'reminder']);
export const isChildType = (type: EntityType) => CHILD_TYPES.has(type);
const ALL = ['records', 'queue', 'bases', 'conflicts', 'meta', 'seen'] as const;

export function isQuotaError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const named = current as { name?: unknown; inner?: unknown; cause?: unknown };
    if (named.name === 'QuotaExceededError' || named.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
    current = named.inner ?? named.cause;
  }
  return false;
}

export function recordFromServer(record: SyncRecord): LocalRecord {
  return {
    id: record.id, entityType: record.entityType, parentId: parentOf(record.entityType, record.data),
    householdId: record.householdId, ownerId: record.ownerId, visibility: record.visibility, version: record.version,
    data: { ...record.data }, createdAt: record.createdAt, updatedAt: record.updatedAt, deletedAt: record.deletedAt,
  };
}
/** A local record as the server state it mirrors (only valid for records that are not dirty). */
function stateOf(record: LocalRecord): ServerState | null {
  if (record.version === 0) return null;
  const parsed = recordSchemaUnion.safeParse({
    id: record.id, entityType: record.entityType, householdId: record.householdId, ownerId: record.ownerId,
    visibility: record.visibility, version: record.version, createdAt: record.createdAt, updatedAt: record.updatedAt,
    deletedAt: record.deletedAt, data: record.data,
  });
  return parsed.success ? { kind: 'record', record: parsed.data } : null;
}
export const stateVersion = (state: ServerState) => state.kind === 'record' ? state.record.version : state.tombstone.version;
const stateId = (state: ServerState) => state.kind === 'record' ? state.record.id : state.tombstone.id;

/** Fields whose JSON value differs. */
export function diffData(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(after).filter(([key, value]) => JSON.stringify(before[key]) !== JSON.stringify(value)));
}

/** Validates complete record data exactly as the server does for a create (domain rules included). */
export function validData(entityType: EntityType, data: Record<string, unknown>, visibility: Visibility): boolean {
  const probe = { clientMutationId: crypto.randomUUID(), entityId: crypto.randomUUID(), entityType, command: 'create', baseVersion: 0,
    ...(isChildType(entityType) ? {} : { visibility }), data };
  return mutationSchema.safeParse(probe).success;
}

export function toMutation(entry: QueueEntry, baseVersion: number): Mutation | null {
  const common = { clientMutationId: entry.clientMutationId, entityId: entry.entityId, entityType: entry.entityType };
  const candidate = entry.command === 'create'
    ? { ...common, command: 'create', baseVersion: 0, ...(entry.visibility ? { visibility: entry.visibility } : {}), data: entry.data }
    : entry.command === 'update' ? { ...common, command: 'update', baseVersion, patch: entry.patch }
      : { ...common, command: entry.command, baseVersion };
  const parsed = mutationSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export type PendingExport = {
  format: 'razem-pending-changes'; formatVersion: 1; exportedAt: string; account: { login: string };
  note: string;
  changes: { queuedAt: string; command: Command; entityType: EntityType; entityId: string; state: string; content: Record<string, unknown> | null }[];
  conflicts: { entityType: EntityType; entityId: string; mine: Record<string, unknown> | null; server: Record<string, unknown> | null; detectedAt: string }[];
};

export type Attention =
  | { kind: 'conflict'; id: string; entityType: EntityType; entityId: string; title: string; detectedAt: string }
  | { kind: 'rejected'; id: string; entityType: EntityType; entityId: string; title: string; error: string; queuedAt: string };

export type Resolution = { choice: 'server' } | { choice: 'mine' } | { choice: 'merge'; data: Record<string, unknown> };

export function titleOf(data: Record<string, unknown> | null | undefined): string {
  const value = data?.title ?? data?.name;
  return typeof value === 'string' && value.trim() ? value : 'Wpis bez nazwy';
}

export class LocalStore {
  readonly db: LocalDatabase;
  constructor(readonly scope: AccountScope, options?: ConstructorParameters<typeof LocalDatabase>[1]) {
    this.db = new LocalDatabase(scope, options);
  }

  /** Runs a read-write transaction over the whole store and bumps the change revision for other tabs and views. */
  private async write<T>(body: () => Promise<T>): Promise<T> {
    return this.db.transaction('rw', [...ALL], async () => {
      const value = await body();
      const revision = await this.db.meta.get('revision');
      await this.db.meta.put({ key: 'revision', value: (Number(revision?.value) || 0) + 1 });
      return value;
    });
  }
  private async guarded<T>(body: () => Promise<StoreResult<T>>): Promise<StoreResult<T>> {
    try { return await this.write(body); } catch (error) {
      if (error instanceof Abort) return { ok: false, reason: error.reason };
      return { ok: false, reason: isQuotaError(error) ? 'storage_full' : 'storage_unavailable' };
    }
  }

  async open() { await this.db.open(); return this; }
  close() { this.db.close(); }

  async deviceId(): Promise<string> {
    const found = await this.db.meta.get('deviceId');
    if (typeof found?.value === 'string') return found.value;
    return this.db.transaction('rw', this.db.meta, async () => {
      const again = await this.db.meta.get('deviceId');
      if (typeof again?.value === 'string') return again.value;
      const id = crypto.randomUUID();
      await this.db.meta.put({ key: 'deviceId', value: id });
      return id;
    });
  }
  async getMeta<T>(key: string): Promise<T | undefined> { return (await this.db.meta.get(key))?.value as T | undefined; }
  async setMeta(key: string, value: unknown) { await this.db.meta.put({ key, value }); }

  // ---------- Queries ----------

  private async shoppingParentActive(record: LocalRecord): Promise<boolean> {
    if (!isChildType(record.entityType)) return true;
    const parent = record.parentId ? await this.db.records.get(record.parentId) : undefined;
    return !!parent && parent.entityType === (record.entityType === 'reminder' ? record.data.targetType : record.entityType === 'task_occurrence' ? 'task' : 'shopping_list') && parent.deletedAt === null && canReadRecord(this.scope, parent);
  }

  async list(entityType: EntityType, parentId?: string): Promise<LocalRecord[]> {
    const rows = parentId ? await this.db.records.where('parentId').equals(parentId).toArray() : await this.db.records.where('entityType').equals(entityType).toArray();
    const visible = rows.filter((row) => row.entityType === entityType && row.deletedAt === null && canReadRecord(this.scope, row));
    return (await Promise.all(visible.map(async (row) => await this.shoppingParentActive(row) ? row : null))).filter((row) => row !== null);
  }
  async trash(): Promise<LocalRecord[]> {
    const rows = await this.db.records.toArray();
    const visible = rows.filter((row) => row.deletedAt !== null && (!isChildType(row.entityType) || row.entityType === 'shopping_item') && canReadRecord(this.scope, row));
    return (await Promise.all(visible.map(async (row) => await this.shoppingParentActive(row) ? row : null))).filter((row) => row !== null)
      .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  }
  async get(id: string): Promise<LocalRecord | undefined> {
    const row = await this.db.records.get(id);
    return row && canReadRecord(this.scope, row) && await this.shoppingParentActive(row) ? row : undefined;
  }
  async pendingCount(): Promise<number> { return this.db.queue.count(); }
  async counts() {
    const [queue, rejected, conflicts] = await Promise.all([
      this.db.queue.count(), this.db.queue.where('state').equals('needs_action').count(), this.db.conflicts.count(),
    ]);
    const conflictChanges = (await this.db.conflicts.toArray()).reduce((sum, conflict) => sum + Math.max(1, conflict.mutations.length), 0);
    return { unsent: queue + conflictChanges, attention: rejected + conflicts };
  }

  // ---------- Commands ----------

  async create(entityType: EntityType, data: Record<string, unknown>, visibility?: Visibility): Promise<StoreResult<string>> {
    return this.createWithId(entityType, crypto.randomUUID(), data, visibility);
  }

  private async createWithId(entityType: EntityType, id: string, data: Record<string, unknown>, visibility?: Visibility): Promise<StoreResult<string>> {
    return this.guarded(async () => {
      const parentId = parentOf(entityType, data);
      let owner = this.scope.userId;
      let scopeVisibility: Visibility = visibility ?? 'shared';
      if (isChildType(entityType)) {
        const parent = parentId ? await this.db.records.get(parentId) : undefined;
        if (!parent || parent.deletedAt !== null || !canReadRecord(this.scope, parent)) throw new Abort('not_found');
        if (entityType === 'reminder' && parent.entityType !== data.targetType) throw new Abort('not_found');
        if (entityType === 'shopping_item' && parent.entityType !== 'shopping_list') throw new Abort('not_found');
        if (entityType === 'task_occurrence' && (parent.entityType !== 'task' || !taskOccurrence(taskDataSchema.parse(parent.data), String(data.occurrenceKey)))) throw new Abort('invalid');
        scopeVisibility = parent.visibility;
        if (parent.visibility === 'private') owner = parent.ownerId;
      } else if (!visibility) throw new Abort('invalid');
      if (!validData(entityType, data, scopeVisibility)) throw new Abort('invalid');
      const now = new Date().toISOString();
      await this.db.records.add({
        id, entityType, parentId, householdId: this.scope.householdId, ownerId: owner, visibility: scopeVisibility,
        version: 0, data: { ...data }, createdAt: now, updatedAt: now, deletedAt: null,
      });
      await this.enqueue({ entityType, entityId: id, parentId, command: 'create', data: { ...data }, ...(isChildType(entityType) ? {} : { visibility: scopeVisibility }) }, 0);
      return { ok: true, value: id };
    });
  }

  async update(entityType: EntityType, id: string, patch: Record<string, unknown>): Promise<StoreResult> {
    return this.guarded(async () => {
      const record = await this.editable(entityType, id);
      const merged = { ...record.data, ...patch };
      const changed = diffData(record.data, merged);
      if (Object.keys(changed).length === 0) return { ok: true, value: undefined };
      if (Object.keys(changed).some((key) => ['listId', 'taskId', 'occurrenceKey', 'targetType', 'targetId'].includes(key))) throw new Abort('invalid');
      if (!validData(entityType, merged, record.visibility)) throw new Abort('invalid');
      if (entityType === 'task' && !validTaskScheduleChange(taskDataSchema.parse(record.data), taskDataSchema.parse(merged))) throw new Abort('invalid');
      const base = await this.baseFor(record);
      await this.db.records.put({ ...record, data: merged, updatedAt: new Date().toISOString() });
      await this.enqueue({ entityType, entityId: id, parentId: record.parentId, command: 'update', patch: changed }, base);
      return { ok: true, value: undefined };
    });
  }

  /** Parent, reminder configuration and both intents commit together, including on quota failure. */
  async saveCalendar(input: CalendarSave): Promise<StoreResult> {
    const id = input.id ?? crypto.randomUUID();
    const reminderId = await calendarReminderId(id);
    return this.guarded(async () => {
      const result = input.id ? await this.update(input.entityType, id, input.data)
        : await this.createWithId(input.entityType, id, input.data, input.visibility);
      if (!result.ok) throw new Abort(result.reason);
      const reminders = (await this.db.records.where('parentId').equals(id).toArray()).filter((r) => r.entityType === 'reminder' && r.deletedAt === null);
      const data = { targetType: input.entityType, targetId: id, ...input.reminder };
      // Keep legacy reminder IDs; disable any additional legacy configurations explicitly.
      const existing = reminders[0];
      if (existing || input.reminder.enabled) {
        const saved = existing ? await this.update('reminder', existing.id, input.reminder)
          : await this.createWithId('reminder', reminderId, data);
        if (!saved.ok) throw new Abort(saved.reason);
      }
      for (const extra of reminders.slice(1)) {
        const saved = await this.update('reminder', extra.id, { enabled: false });
        if (!saved.ok) throw new Abort(saved.reason);
      }
      return { ok: true, value: undefined };
    });
  }

  /** Complete/reopen one nominal date in the same local transaction as its outbox entry. */
  async setTaskOccurrence(taskId: string, key: string, completed: boolean): Promise<StoreResult> {
    const id = await taskOccurrenceId(taskId, key);
    return this.guarded(async () => {
      const parent = await this.editable('task', taskId);
      const existing = (await this.db.records.where('parentId').equals(taskId).toArray())
        .find((r) => r.entityType === 'task_occurrence' && r.data.occurrenceKey === key && r.deletedAt === null);
      if (!existing && !taskOccurrence(taskDataSchema.parse(parent.data), key)) throw new Abort('invalid');
      if (!!existing?.data.completedAt === completed) return { ok: true, value: undefined };
      const completedAt = completed ? new Date().toISOString() : null;
      const result = existing ? await this.update('task_occurrence', existing.id, { completedAt })
        : await this.createWithId('task_occurrence', id, { taskId, occurrenceKey: key, completedAt });
      if (!result.ok) throw new Abort(result.reason);
      return { ok: true, value: undefined };
    });
  }

  async remove(entityType: EntityType, id: string): Promise<StoreResult> {
    return this.guarded(async () => {
      const record = await this.editable(entityType, id);
      const base = await this.baseFor(record);
      const now = new Date().toISOString();
      await this.db.records.put({ ...record, deletedAt: now, updatedAt: now });
      await this.enqueue({ entityType, entityId: id, parentId: record.parentId, command: 'delete' }, base);
      return { ok: true, value: undefined };
    });
  }

  async restore(entityType: EntityType, id: string): Promise<StoreResult> {
    return this.guarded(async () => {
      const record = await this.db.records.get(id);
      if (!record || record.entityType !== entityType || record.deletedAt === null || !canReadRecord(this.scope, record)) throw new Abort('not_found');
      if (!(await this.shoppingParentActive(record))) throw new Abort('not_found');
      if (await this.db.conflicts.where('entityId').equals(id).count()) throw new Abort('conflict_open');
      const base = await this.baseFor(record);
      await this.db.records.put({ ...record, deletedAt: null, updatedAt: new Date().toISOString() });
      await this.enqueue({ entityType, entityId: id, parentId: record.parentId, command: 'restore' }, base);
      return { ok: true, value: undefined };
    });
  }

  private async editable(entityType: EntityType, id: string): Promise<LocalRecord> {
    const record = await this.db.records.get(id);
    if (!record || record.entityType !== entityType || record.deletedAt !== null || !canReadRecord(this.scope, record)) throw new Abort('not_found');
    if (!(await this.shoppingParentActive(record))) throw new Abort('not_found');
    if (await this.db.conflicts.where('entityId').equals(id).count()) throw new Abort('conflict_open');
    return record;
  }

  /** Base of a new local intent: the server version, or null = chained after my previous queued change. */
  private async baseFor(record: LocalRecord): Promise<number | null> {
    if (await this.db.queue.where('entityId').equals(record.id).count()) return null;
    // First local change of a clean record: remember the server state it is based on.
    await this.db.bases.put({ id: record.id, state: stateOf(record) });
    return record.version;
  }

  private async enqueue(entry: Omit<QueueEntry, 'clientMutationId' | 'queuedAt' | 'attempts' | 'state' | 'baseVersion'>, baseVersion: number | null) {
    await this.db.queue.add({ ...entry, clientMutationId: crypto.randomUUID(), baseVersion, queuedAt: new Date().toISOString(), attempts: 0, state: 'pending' });
  }

  // ---------- Push ----------

  /**
   * Next batch to send: queue order, at most one mutation per record per round (the next
   * one needs the ACKed version as its base) and nothing behind a change that waits for
   * the user (conflict / rejected) for the same record or its parent.
   */
  async nextBatch(maxCount: number, maxBytes: number): Promise<{ entries: QueueEntry[]; mutations: Mutation[] }> {
    const queue = await this.db.queue.orderBy('seq').toArray();
    const conflicted = new Set((await this.db.conflicts.toArray()).map((conflict) => conflict.entityId));
    const blocked = new Set(conflicted);
    const waiting = new Set<string>();
    // Legacy queues may contain a child before its parent (equal queuedAt, UUID
    // order during migration). Wait until the parent is included or ACKed.
    const pendingCreate = new Set(queue.filter((entry) => entry.command === 'create').map((entry) => entry.entityId));
    const entries: QueueEntry[] = [], mutations: Mutation[] = [];
    let bytes = 64;
    for (const entry of queue) {
      const parentBlocked = entry.parentId !== null && (blocked.has(entry.parentId) || pendingCreate.has(entry.parentId));
      if (entry.state === 'needs_action' || blocked.has(entry.entityId) || (entry.command === 'create' && parentBlocked)) {
        blocked.add(entry.entityId);
        continue;
      }
      if (waiting.has(entry.entityId) || entries.length >= maxCount) {
        waiting.add(entry.entityId);
        if (entry.command === 'create') pendingCreate.add(entry.entityId);
        continue;
      }
      const record = await this.db.records.get(entry.entityId);
      const base = entry.baseVersion ?? record?.version ?? 0;
      const mutation = toMutation(entry, base);
      if (!mutation) {
        // Cannot be expressed as a valid mutation (should not happen): needs the user, never loops.
        await this.db.queue.update(entry.seq!, { state: 'needs_action', error: 'validation_error' });
        blocked.add(entry.entityId);
        continue;
      }
      const size = new TextEncoder().encode(JSON.stringify(mutation)).length + 1;
      if (bytes + size > maxBytes && entries.length > 0) {
        waiting.add(entry.entityId);
        if (entry.command === 'create') pendingCreate.add(entry.entityId);
        continue;
      }
      bytes += size;
      entries.push(entry); mutations.push(mutation);
      if (entry.command === 'create') pendingCreate.delete(entry.entityId);
      waiting.add(entry.entityId);
    }
    return { entries, mutations };
  }

  async markAttempt(entries: QueueEntry[]) {
    await this.db.transaction('rw', this.db.queue, async () => {
      for (const entry of entries) await this.db.queue.where('clientMutationId').equals(entry.clientMutationId).modify((row) => { row.attempts += 1; });
    });
  }

  /** Applies per-mutation results atomically. Returns whether a pull should follow (adopted server copies). */
  async applyResults(results: MutationResult[]): Promise<{ acked: number; needsPull: boolean }> {
    return this.write(async () => {
      let acked = 0, needsPull = false;
      for (const result of results) {
        const entry = await this.db.queue.where('clientMutationId').equals(result.clientMutationId).first();
        if (!entry) continue; // already handled by another tab
        if (result.status === 'ack') {
          acked++;
          await this.db.queue.delete(entry.seq!);
          await this.afterAck(entry, result.state);
        } else if (result.status === 'conflict') {
          if (await this.autoResolved(entry, result.state)) { acked++; continue; }
          await this.toConflict(entry, result.state);
        } else if (result.code === 'dependency_failed') {
          // Its parent/previous change did not go through in this batch; it waits, no attempt lost.
        } else if (result.code === 'already_exists' && entry.command === 'create') {
          // Same natural key exists on the server (task occurrence of that day): adopt the server copy.
          await this.dropEntity(entry.entityId, true);
          needsPull = true;
        } else {
          await this.db.queue.update(entry.seq!, { state: 'needs_action', error: result.code });
        }
      }
      return { acked, needsPull };
    });
  }

  private async remaining(entityId: string) { return this.db.queue.where('entityId').equals(entityId).sortBy('seq'); }

  private async afterAck(entry: QueueEntry, state: ServerState) {
    const rest = await this.remaining(entry.entityId);
    const version = stateVersion(state);
    if (rest.length === 0 && !(await this.db.conflicts.where('entityId').equals(entry.entityId).count())) {
      await this.db.bases.delete(entry.entityId);
      await this.adopt(state);
      return;
    }
    // Rebase: the next chained change of this record is now based on the ACKed version.
    const next = rest[0];
    if (next && next.baseVersion === null) await this.db.queue.update(next.seq!, { baseVersion: version });
    await this.db.bases.put({ id: entry.entityId, state });
    const record = await this.db.records.get(entry.entityId);
    if (record && record.version < version) await this.db.records.put({ ...record, version, ...(state.kind === 'record' ? { createdAt: state.record.createdAt } : {}) });
  }

  /** Stale delete/restore whose effect the server already has: nothing to decide. */
  private async autoResolved(entry: QueueEntry, state: ServerState): Promise<boolean> {
    const rest = await this.remaining(entry.entityId);
    if (rest.length !== 1) return false;
    const deletedOnServer = state.kind === 'tombstone' || state.record.deletedAt !== null;
    if (entry.command !== 'delete' || !deletedOnServer) return false;
    await this.db.queue.delete(entry.seq!);
    await this.db.bases.delete(entry.entityId);
    await this.adopt(state);
    return true;
  }

  private async toConflict(entry: QueueEntry, server: ServerState) {
    const chain = await this.remaining(entry.entityId);
    const base = (await this.db.bases.get(entry.entityId))?.state ?? null;
    const local = (await this.db.records.get(entry.entityId)) ?? null;
    for (const item of chain) await this.db.queue.delete(item.seq!);
    await this.db.bases.put({ id: entry.entityId, state: server });
    const existing = await this.db.conflicts.where('entityId').equals(entry.entityId).first();
    await this.db.conflicts.put({
      id: existing?.id ?? crypto.randomUUID(), entityType: entry.entityType, entityId: entry.entityId, local, base: existing?.base ?? base,
      server, mutations: [...(existing?.mutations ?? []), ...chain], detectedAt: new Date().toISOString(),
    } satisfies ConflictEntry);
  }

  /** Makes the server state the local view (record, trash item or gone). */
  private async adopt(state: ServerState) {
    if (state.kind === 'tombstone') { await this.purgeLocal(state.tombstone.id); return; }
    if (!canReadRecord(this.scope, state.record)) { await this.purgeLocal(state.record.id); return; }
    await this.db.records.put(recordFromServer(state.record));
  }

  private async purgeLocal(id: string) {
    await this.db.records.delete(id);
    // Children of a permanently removed record go too, unless they carry local changes.
    for (const child of await this.db.records.where('parentId').equals(id).toArray()) {
      if (!(await this.isDirty(child.id))) await this.purgeLocal(child.id);
    }
  }

  private async isDirty(id: string) {
    return (await this.db.queue.where('entityId').equals(id).count()) > 0 || (await this.db.conflicts.where('entityId').equals(id).count()) > 0;
  }

  /** Removes all local intents of a record (and of children created under it locally); restores the server view. */
  private async dropEntity(entityId: string, discardLocal: boolean) {
    for (const item of await this.remaining(entityId)) await this.db.queue.delete(item.seq!);
    await this.db.conflicts.where('entityId').equals(entityId).delete();
    const base = await this.db.bases.get(entityId);
    await this.db.bases.delete(entityId);
    if (base?.state) await this.adopt(base.state);
    else if (discardLocal) {
      const record = await this.db.records.get(entityId);
      if (record && record.version === 0) {
        await this.db.records.delete(entityId);
        // Local children of a record that never reached the server cannot be sent either.
        for (const child of await this.db.records.where('parentId').equals(entityId).toArray()) if (child.version === 0) await this.dropEntity(child.id, true);
      }
    }
  }

  // ---------- Pull ----------

  /** Applies one pull page and its cursor in a single transaction. */
  async applyPull(page: OkPull, snapshotStarted: boolean): Promise<void> {
    await this.write(async () => {
      const inSnapshot = snapshotStarted || (await this.getMeta<boolean>('snapshotActive')) === true;
      if (inSnapshot && page.mode === 'delta') await this.finishSnapshot();
      for (const change of page.changes) {
        const id = stateId(change);
        if (page.mode === 'snapshot') await this.db.seen.put({ id });
        if (change.kind === 'record' && !canReadRecord(this.scope, change.record)) continue;
        if (await this.isDirty(id)) {
          const base = await this.db.bases.get(id);
          if (!base?.state || stateVersion(base.state) <= stateVersion(change)) await this.db.bases.put({ id, state: change });
          const conflict = await this.db.conflicts.where('entityId').equals(id).first();
          if (conflict && stateVersion(conflict.server) < stateVersion(change)) await this.db.conflicts.put({ ...conflict, server: change });
          continue;
        }
        const local = await this.db.records.get(id);
        if (local && local.version > stateVersion(change)) continue; // never go back in time
        await this.adopt(change);
      }
      await this.db.meta.put({ key: 'cursor', value: page.nextCursor });
      if (page.mode === 'snapshot' && !page.hasMore) await this.finishSnapshot();
    });
  }

  async beginSnapshot() {
    await this.write(async () => {
      await this.db.seen.clear();
      await this.db.meta.delete('cursor');
      await this.db.meta.put({ key: 'snapshotActive', value: true });
    });
  }

  /** End of a full snapshot: drop clean cached records the server no longer returns. Pending/conflicts stay. */
  private async finishSnapshot() {
    if ((await this.getMeta<boolean>('snapshotActive')) !== true) return;
    const seen = new Set((await this.db.seen.toArray()).map((row) => row.id));
    for (const record of await this.db.records.toArray()) {
      if (record.version === 0 || seen.has(record.id)) continue;
      if (await this.isDirty(record.id)) continue;
      await this.db.records.delete(record.id);
    }
    await this.db.seen.clear();
    await this.db.meta.put({ key: 'snapshotActive', value: false });
  }

  // ---------- Conflicts and rejected changes ----------

  async attention(): Promise<Attention[]> {
    const conflicts = await this.db.conflicts.toArray();
    const rejected = await this.db.queue.where('state').equals('needs_action').toArray();
    const titleFor = async (entityId: string, fallback?: Record<string, unknown> | null) => titleOf((await this.db.records.get(entityId))?.data ?? fallback);
    return [
      ...await Promise.all(conflicts.map(async (conflict) => ({
        kind: 'conflict' as const, id: conflict.id, entityType: conflict.entityType, entityId: conflict.entityId,
        title: titleOf(conflict.local?.data ?? (conflict.server.kind === 'record' ? conflict.server.record.data : null)), detectedAt: conflict.detectedAt,
      }))),
      ...await Promise.all(rejected.map(async (entry) => ({
        kind: 'rejected' as const, id: entry.clientMutationId, entityType: entry.entityType, entityId: entry.entityId,
        title: await titleFor(entry.entityId, entry.data), error: entry.error ?? 'validation_error', queuedAt: entry.queuedAt,
      }))),
    ];
  }
  async conflict(id: string): Promise<ConflictEntry | undefined> { return this.db.conflicts.get(id); }

  /**
   * Resolves a conflict with a NEW mutation based on the current server version; the server
   * checks that version again, so a change made meanwhile produces a new visible conflict.
   */
  async resolve(conflictId: string, resolution: Resolution): Promise<StoreResult> {
    return this.guarded(async () => {
      const conflict = await this.db.conflicts.get(conflictId);
      if (!conflict) throw new Abort('not_found');
      const server = conflict.server, local = conflict.local;
      const entityId = conflict.entityId, entityType = conflict.entityType;
      await this.db.conflicts.delete(conflictId);
      if (resolution.choice === 'server' || !local) {
        await this.db.bases.delete(entityId);
        await this.adopt(server);
        return { ok: true, value: undefined };
      }
      // A merge only chooses content: parent references/keys are fixed at creation, so they always
      // come from the record itself, whatever the screen sent (or left out).
      const fixedFrom = server.kind === 'record' ? { ...local.data, ...server.record.data } : local.data;
      const wanted = resolution.choice === 'merge'
        ? { ...resolution.data, ...Object.fromEntries(IMMUTABLE_PARENT_FIELDS.filter((key) => key in fixedFrom).map((key) => [key, fixedFrom[key]])) }
        : local.data;
      const localDeleted = local.deletedAt !== null;
      if (!localDeleted && !validData(entityType, wanted, local.visibility)) throw new Abort('invalid');
      const now = new Date().toISOString();
      if (server.kind === 'tombstone') {
        // Removed for good elsewhere. Never resurrect the ID; keep my content as a new record.
        await this.db.bases.delete(entityId);
        await this.purgeLocal(entityId);
        if (localDeleted) return { ok: true, value: undefined };
        const parentId = parentOf(entityType, wanted);
        if (isChildType(entityType)) {
          const parent = parentId ? await this.db.records.get(parentId) : undefined;
          if (!parent || parent.deletedAt !== null) throw new Abort('not_found');
        }
        const id = crypto.randomUUID();
        await this.db.records.add({ ...local, id, version: 0, data: { ...wanted }, createdAt: now, updatedAt: now, deletedAt: null });
        await this.enqueue({ entityType, entityId: id, parentId, command: 'create', data: { ...wanted }, ...(isChildType(entityType) ? {} : { visibility: local.visibility }) }, 0);
        return { ok: true, value: undefined };
      }
      const current = server.record;
      await this.db.bases.put({ id: entityId, state: server });
      if (localDeleted) {
        if (current.deletedAt !== null) { await this.db.bases.delete(entityId); await this.adopt(server); return { ok: true, value: undefined }; }
        await this.db.records.put({ ...recordFromServer(current), deletedAt: now, updatedAt: now });
        await this.enqueue({ entityType, entityId, parentId: local.parentId, command: 'delete' }, current.version);
        return { ok: true, value: undefined };
      }
      let base: number | null = current.version;
      if (current.deletedAt !== null) {
        // Deleted elsewhere (in the trash) but edited here: restore, then apply my content.
        await this.enqueue({ entityType, entityId, parentId: local.parentId, command: 'restore' }, base);
        base = null;
      }
      const patch = diffData(current.data, wanted);
      await this.db.records.put({ ...recordFromServer(current), data: { ...current.data, ...patch }, deletedAt: null, updatedAt: now });
      if (Object.keys(patch).length > 0) await this.enqueue({ entityType, entityId, parentId: local.parentId, command: 'update', patch }, base);
      else if (base !== null) { await this.db.bases.delete(entityId); await this.adopt(server); }
      return { ok: true, value: undefined };
    });
  }

  /** Discards a change the server rejected, with everything queued after it for the same record. */
  async discardRejected(clientMutationId: string): Promise<StoreResult> {
    return this.guarded(async () => {
      const entry = await this.db.queue.where('clientMutationId').equals(clientMutationId).first();
      if (!entry || entry.state !== 'needs_action') throw new Abort('not_found');
      await this.dropEntity(entry.entityId, true);
      return { ok: true, value: undefined };
    });
  }

  // ---------- Export ----------

  /** Everything not yet confirmed by the server, as a file the user can keep. Only this account. */
  async exportPending(login: string): Promise<PendingExport> {
    const queue = await this.db.queue.orderBy('seq').toArray();
    const conflicts = await this.db.conflicts.toArray();
    return {
      format: 'razem-pending-changes', formatVersion: 1, exportedAt: new Date().toISOString(), account: { login },
      note: 'Zmiany zapisane tylko na tym urządzeniu, jeszcze niepotwierdzone przez serwer.',
      changes: await Promise.all(queue.map(async (entry) => ({
        queuedAt: entry.queuedAt, command: entry.command, entityType: entry.entityType, entityId: entry.entityId, state: entry.state,
        content: (await this.db.records.get(entry.entityId))?.data ?? entry.data ?? entry.patch ?? null,
      }))),
      conflicts: conflicts.map((conflict) => ({
        entityType: conflict.entityType, entityId: conflict.entityId, mine: conflict.local?.data ?? null,
        server: conflict.server.kind === 'record' ? conflict.server.record.data : null, detectedAt: conflict.detectedAt,
      })),
    };
  }

  /** Deletes this account's local database (after an explicit logout decision). */
  async destroy() { await this.db.delete(); }
}

class Abort extends Error {
  constructor(readonly reason: StoreFailure) { super(reason); }
}

