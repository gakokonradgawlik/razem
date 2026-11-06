import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  MAX_PULL_PAGE_BYTES, PROTOCOL_VERSION, RETENTION_DAYS, TRASH_DAYS,
  mutationResultSchema, mutationSchema, pullRequestSchema, pullResponseSchema, pushEnvelopeSchema, pushResponseSchema,
} from '@razem/contracts';
import type { AccountScope, EntityType, Mutation, PullResponse, PushResponse } from '@razem/contracts';
import { RecordRepository, SNAPSHOT_ORDER, SyncStore, resultState } from '@razem/db';
import type { Database, RecordResult, ServerState } from '@razem/db';

const DAY = 24 * 60 * 60 * 1000;
type MutationResult = z.infer<typeof mutationResultSchema>;
type ErrorCode = Extract<MutationResult, { status: 'error' }>['code'];

export interface SyncConfig {
  /** Server time only. Client clocks never order changes or resolve conflicts. */
  clock: () => Date;
  receiptRetentionMs: number;
  journalRetentionMs: number;
  trashRetentionMs: number;
  pullPageBytes: number;
}
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  clock: () => new Date(), receiptRetentionMs: RETENTION_DAYS * DAY, journalRetentionMs: RETENTION_DAYS * DAY,
  trashRetentionMs: TRASH_DAYS * DAY, pullPageBytes: MAX_PULL_PAGE_BYTES,
};

export type SyncOutcome<T> = { ok: true; body: T } | { ok: false; status: 400; error: 'invalid_request' | 'upgrade_required' };

/** Canonical JSON: object keys sorted recursively, so the fingerprint ignores key order only. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v);
}
export const fingerprint = (mutation: unknown) => createHash('sha256').update(canonicalJson(mutation)).digest('hex');

// Opaque cursor: AES-256-GCM with the per-installation key from sync_state. Encryption, not
// just a MAC, so a client cannot read sequence numbers and infer the partner's private activity.
const cursorPayload = z.discriminatedUnion('m', [
  // w: global watermark sequence; r: highest sequence readable by the account at w (public watermark).
  z.strictObject({ v: z.literal(1), m: z.literal('s'), u: z.uuid(), at: z.number().int(), w: z.number().int().nonnegative(),
    r: z.number().int().nonnegative(), t: z.number().int().min(0).max(SNAPSHOT_ORDER.length), i: z.uuid().nullable() }),
  z.strictObject({ v: z.literal(1), m: z.literal('d'), u: z.uuid(), at: z.number().int(), s: z.number().int().nonnegative() }),
]);
type CursorPayload = z.infer<typeof cursorPayload>;
const AAD = Buffer.from('razem-cursor-v1');
// Fixed plaintext length: the cursor size must not reveal how large the sequence numbers are.
const CURSOR_PLAINTEXT = 256;

const parentIdOf = (raw: Record<string, unknown>): string | null => {
  if (raw.command !== 'create' || typeof raw.data !== 'object' || raw.data === null) return null;
  const data = raw.data as Record<string, unknown>;
  const ref = raw.entityType === 'shopping_item' ? data.listId : raw.entityType === 'task_occurrence' ? data.taskId
    : raw.entityType === 'reminder' ? data.targetId : null;
  return typeof ref === 'string' ? ref : null;
};

/**
 * The only write path for domain records: every mutation goes through session scope, ACL,
 * domain validation and baseVersion in RecordRepository, and in the same SQLite transaction
 * the record, version, journal entry and idempotency receipt are committed together.
 */
export class SyncService {
  readonly records: RecordRepository;
  readonly store: SyncStore;
  readonly config: SyncConfig;
  private readonly key: Buffer;

  constructor(private readonly database: Database, config: Partial<SyncConfig> = {}) {
    this.config = { ...DEFAULT_SYNC_CONFIG, ...config };
    this.records = new RecordRepository(database, this.config.clock);
    this.store = new SyncStore(database);
    this.key = Buffer.from(this.store.state().cursorKey, 'hex');
  }
  private now() { return this.config.clock(); }

  push(scope: AccountScope, body: unknown): SyncOutcome<PushResponse> {
    const envelope = pushEnvelopeSchema.safeParse(body);
    if (!envelope.success) return { ok: false, status: 400, error: 'invalid_request' };
    if (envelope.data.protocolVersion !== PROTOCOL_VERSION) return { ok: false, status: 400, error: 'upgrade_required' };
    const { deviceId } = envelope.data;
    this.database.db.transaction(() => this.store.touchDevice(scope.userId, deviceId, this.now().toISOString()), { behavior: 'immediate' });
    // Entities whose earlier mutation in this batch did not apply: later ones for the same record
    // (or children created under it) are not attempted and stay in the client's queue.
    const failed = new Set<string>();
    const results: MutationResult[] = [];
    for (const raw of envelope.data.mutations) {
      const identity = { clientMutationId: raw.clientMutationId, entityType: raw.entityType, entityId: raw.entityId };
      const parentId = parentIdOf(raw);
      if (failed.has(raw.entityId) || (parentId && failed.has(parentId))) {
        results.push({ ...identity, status: 'error', code: 'dependency_failed', retryable: false });
        failed.add(raw.entityId);
        continue;
      }
      const result = this.database.sqlite.transaction(() => this.applyOne(scope, deviceId, raw, identity)).immediate();
      if (result.status !== 'ack') failed.add(raw.entityId);
      results.push(result);
    }
    return { ok: true, body: pushResponseSchema.parse({ protocolVersion: PROTOCOL_VERSION, results }) };
  }

  /** Runs inside one IMMEDIATE transaction: receipt lookup, domain write, journal and receipt. */
  private applyOne(scope: AccountScope, deviceId: string, raw: Record<string, unknown>,
    identity: { clientMutationId: string; entityType: EntityType; entityId: string }): MutationResult {
    const print = fingerprint(raw);
    const previous = this.store.receipt(scope.userId, deviceId, identity.clientMutationId);
    if (previous) {
      // Lost ACK: the same mutation replays its committed result without a second effect.
      if (previous.payloadFingerprint === print) return mutationResultSchema.parse(previous.result);
      return { ...identity, status: 'error', code: 'mutation_id_reused', retryable: false };
    }
    const parsed = mutationSchema.safeParse(raw);
    const result: MutationResult = parsed.success ? this.toResult(identity, this.apply(scope, parsed.data))
      : { ...identity, status: 'error', code: 'validation_error', retryable: false };
    const now = this.now();
    this.store.insertReceipt({
      userId: scope.userId, deviceId, clientMutationId: identity.clientMutationId, payloadFingerprint: print,
      result, committedAt: now.toISOString(), expiresAt: new Date(now.getTime() + this.config.receiptRetentionMs).toISOString(),
    });
    return result;
  }

  private apply(scope: AccountScope, mutation: Mutation): RecordResult {
    const base = { entityType: mutation.entityType, id: mutation.entityId };
    switch (mutation.command) {
      case 'create': return this.records.create(scope, { ...base, data: mutation.data, ...('visibility' in mutation ? { visibility: mutation.visibility } : {}) });
      case 'update': return this.records.update(scope, { ...base, baseVersion: mutation.baseVersion, patch: mutation.patch });
      case 'delete': return this.records.remove(scope, { ...base, baseVersion: mutation.baseVersion });
      case 'restore': return this.records.restore(scope, { ...base, baseVersion: mutation.baseVersion });
    }
  }

  private toResult(identity: { clientMutationId: string; entityType: EntityType; entityId: string }, result: RecordResult): MutationResult {
    if (result.status === 'error') return { ...identity, status: 'error', code: result.code satisfies ErrorCode, retryable: false };
    return { ...identity, status: result.status, state: resultState(result) };
  }

  // ---- pull ----

  private encode(payload: CursorPayload): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv).setAAD(AAD);
    const json = JSON.stringify(payload);
    if (json.length > CURSOR_PLAINTEXT) throw new Error('cursor_too_long');
    const body = Buffer.concat([cipher.update(json.padEnd(CURSOR_PLAINTEXT, ' ')), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }
  private decode(cursor: string): CursorPayload | null {
    try {
      const raw = Buffer.from(cursor, 'base64url');
      if (raw.length < 29) return null;
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12)).setAAD(AAD);
      decipher.setAuthTag(raw.subarray(12, 28));
      const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString();
      const parsed = cursorPayload.safeParse(JSON.parse(json));
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  }
  /** Stable per (account, watermark), reveals no sequence number. */
  private watermark(userId: string, sequence: number) {
    return `w1.${createHmac('sha256', this.key).update(`watermark:${userId}:${sequence}`).digest('base64url')}`;
  }

  pull(scope: AccountScope, query: unknown): SyncOutcome<PullResponse> {
    const request = pullRequestSchema.safeParse(query);
    if (!request.success) return { ok: false, status: 400, error: 'invalid_request' };
    const { limit } = request.data;
    const now = this.now().getTime();
    // One read transaction per page: a consistent WAL snapshot of records and journal.
    return { ok: true, body: pullResponseSchema.parse(this.database.sqlite.transaction((): PullResponse => {
      if (request.data.cursor === undefined) {
        const watermark = this.records.maxSequence();
        return this.snapshotPage(scope, watermark, this.records.maxReadableSequence(scope, watermark), { type: 0, id: null }, limit);
      }
      const cursor = this.decode(request.data.cursor);
      if (!cursor || cursor.u !== scope.userId || cursor.at > now + DAY) return { status: 'resync_required', reason: 'cursor_invalid' };
      const seen = cursor.m === 's' ? cursor.w : cursor.s;
      if (now - cursor.at > this.config.journalRetentionMs || seen < this.store.state().journalFloor)
        return { status: 'resync_required', reason: 'cursor_expired' };
      return cursor.m === 's' ? this.snapshotPage(scope, cursor.w, cursor.r, { type: cursor.t, id: cursor.i }, limit) : this.deltaPage(scope, cursor.s, limit);
    }).deferred()) };
  }

  /**
   * Snapshot pages walk all readable records by (type, id). Changes made while paging are
   * not lost: their journal entries are newer than the watermark taken on the first page,
   * and the cursor after the last page continues as a delta from that watermark.
   */
  private snapshotPage(scope: AccountScope, watermark: number, readable: number, position: { type: number; id: string | null }, limit: number): PullResponse {
    const page = this.records.snapshotPage(scope, position, limit, this.config.pullPageBytes);
    const at = this.now().getTime();
    const changes = page.changes;
    const base = { status: 'ok', protocolVersion: PROTOCOL_VERSION, mode: 'snapshot', watermark: this.watermark(scope.userId, readable), changes } as const;
    if (page.next) return { ...base, hasMore: true, nextCursor: this.encode({ v: 1, m: 's', u: scope.userId, at, w: watermark, r: readable, t: page.next.type, i: page.next.id }) };
    const pendingDelta = this.records.journalPage(scope, watermark, this.records.maxSequence(), 1).length > 0;
    return { ...base, hasMore: pendingDelta, nextCursor: this.encode({ v: 1, m: 'd', u: scope.userId, at, s: watermark }) };
  }

  private deltaPage(scope: AccountScope, after: number, limit: number): PullResponse {
    const upTo = this.records.maxSequence();
    const rows = this.records.journalPage(scope, after, upTo, limit + 1);
    const changes: ServerState[] = [];
    const emitted = new Set<string>();
    let bytes = 0;
    let reached = after;
    let complete = true;
    for (const [index, row] of rows.entries()) {
      if (index >= limit) { complete = false; break; }
      const key = `${row.entityType}:${row.entityId}`;
      if (!emitted.has(key)) {
        // Current state, ACL-checked again; a later journal entry may repeat it (harmless, versioned).
        const state = this.records.state(scope, row.entityType as EntityType, row.entityId);
        if (state) {
          const size = Buffer.byteLength(JSON.stringify(state));
          if (changes.length > 0 && bytes + size > this.config.pullPageBytes) { complete = false; break; }
          changes.push(state);
          bytes += size;
        }
        emitted.add(key);
      }
      reached = row.sequence;
    }
    const next = complete ? upTo : reached;
    // The public watermark depends only on entries this account can read, never on the partner's private writes.
    return {
      status: 'ok', protocolVersion: PROTOCOL_VERSION, mode: 'delta', watermark: this.watermark(scope.userId, this.records.maxReadableSequence(scope, next)), changes,
      hasMore: !complete, nextCursor: this.encode({ v: 1, m: 'd', u: scope.userId, at: this.now().getTime(), s: next }),
    };
  }

  /** Retention: trash → tombstones after 30 days; receipts and journal after 90 days. Tombstones stay. */
  maintenance() {
    const now = this.now().getTime();
    const purged = this.records.purgeTrash(new Date(now - this.config.trashRetentionMs).toISOString());
    const receipts = this.database.db.transaction(() => this.store.pruneReceipts(new Date(now).toISOString()), { behavior: 'immediate' });
    const journal = this.store.pruneJournal(new Date(now - this.config.journalRetentionMs).toISOString());
    return { purged, receipts, journal };
  }
}
