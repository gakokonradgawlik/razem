// Sync coordinator of the active app (no Background Sync, nothing runs in a closed PWA).
// Runs on start, on focus/visibilitychange, when the network comes back, after a local
// command and every 15 s while visible. One cycle at a time per account database across
// tabs (Web Locks, IndexedDB lease as fallback; the lease is renewed and verified before
// every request, and a cycle that lost it stops). Each cycle first asks the server who is
// signed in, and every push/pull names the expected account, which the server checks against
// the session of that same request (409 account_mismatch) — so a queue is never sent with,
// and a database never filled from, another account's session, even if the cookie changes
// mid-cycle. stop() (sign-out, account switch) aborts the running cycle.
import { MAX_PULL_PAGE, MAX_PUSH_BATCH, MAX_PUSH_BYTES } from '@razem/contracts';
import type { MeResponse } from '@razem/contracts';
import { ApiError } from '../api.js';
import type { Api } from '../api.js';
import type { LocalStore } from './store.js';

export type Connection =
  | 'unknown' | 'ok' | 'offline' | 'server_unavailable' | 'auth_required' | 'password_change'
  | 'upgrade_required' | 'account_mismatch';
/** Shared through the account database, so every tab shows the same truth. */
export type SyncStatus = { connection: Connection; lastSyncAt: string | null; lastAckAt: string | null; checkedAt: string | null };
export const INITIAL_STATUS: SyncStatus = { connection: 'unknown', lastSyncAt: null, lastAckAt: null, checkedAt: null };

export const SYNC_INTERVAL_MS = 15_000;
const LEASE_MS = 60_000;
const MAX_PUSH_ROUNDS = 50;
const MAX_PULL_PAGES = 500;

export type EngineOptions = {
  isOnline?: () => boolean;
  random?: () => number;
  /** null disables Web Locks (tests of the IndexedDB lease fallback). */
  locks?: LockManager | null;
  onAccountMismatch?: (me: MeResponse) => void;
  pullLimit?: number;
  pushBytes?: number;
  /** Clock of the IndexedDB lease (tests move it to simulate long requests and frozen tabs). */
  now?: () => number;
};

/** Ends a cycle without counting as a failure: the engine was stopped or another tab owns the queue now. */
class Halt extends Error { constructor(readonly reason: 'stopped' | 'lease_lost') { super(reason); } }

export type CycleOutcome = 'done' | 'skipped_locked' | 'failed';

export class SyncEngine {
  private running: Promise<CycleOutcome> | null = null;
  private again = false;
  private failures = 0;
  private nextAttemptAt = 0;
  private maxBatch = MAX_PUSH_BATCH;
  private readonly tabId = crypto.randomUUID();
  private detach: (() => void) | null = null;
  private stopped = false;
  private readonly abort = new AbortController();

  constructor(readonly store: LocalStore, private readonly api: Api, private readonly options: EngineOptions = {}) {}

  private online() { return this.options.isOnline ? this.options.isOnline() : typeof navigator === 'undefined' || navigator.onLine !== false; }

  async status(): Promise<SyncStatus> { return { ...INITIAL_STATUS, ...(await this.store.getMeta<SyncStatus>('status')) }; }
  private async setStatus(change: Partial<SyncStatus>) {
    try {
      await this.store.db.transaction('rw', this.store.db.meta, async () => {
        const current = { ...INITIAL_STATUS, ...(await this.store.getMeta<SyncStatus>('status')) };
        await this.store.setMeta('status', { ...current, ...change, checkedAt: new Date().toISOString() });
        const revision = await this.store.db.meta.get('revision');
        await this.store.db.meta.put({ key: 'revision', value: (Number(revision?.value) || 0) + 1 });
      });
    } catch { /* storage problems are reported by commands; status stays as it was */ }
  }

  /** Attach triggers of the active app. Returns nothing; call stop() on sign-out/switch. */
  start() {
    if (this.detach || typeof window === 'undefined') return;
    const trigger = () => { if (document.visibilityState !== 'hidden') this.request(true); };
    const offline = () => { void this.setStatus({ connection: 'offline' }); };
    window.addEventListener('online', trigger);
    window.addEventListener('offline', offline);
    window.addEventListener('focus', trigger);
    document.addEventListener('visibilitychange', trigger);
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') this.request(false); }, SYNC_INTERVAL_MS);
    this.detach = () => {
      window.removeEventListener('online', trigger); window.removeEventListener('offline', offline);
      window.removeEventListener('focus', trigger); document.removeEventListener('visibilitychange', trigger);
      clearInterval(timer);
    };
    this.request(true);
  }
  stop() { this.stopped = true; this.abort.abort(); this.detach?.(); this.detach = null; }
  /** Stops and waits until a cycle in progress has ended (and released its lease) — before the database is closed. */
  async stopAndSettle() { this.stop(); await this.running?.catch(() => undefined); }
  private clock() { return this.options.now ? this.options.now() : Date.now(); }
  private get account() { return this.store.scope.userId; }

  /** Before every request (and before applying a pull page): still running and still the owner of the queue. */
  private async guard() {
    if (this.stopped) throw new Halt('stopped');
    if (this.lease && !(await this.lease.renew())) throw new Halt('lease_lost');
    if (this.stopped) throw new Halt('stopped');
  }

  /** Schedules a cycle. Periodic ticks respect the retry backoff; user/network events do not. */
  request(urgent: boolean) {
    if (this.stopped) return;
    if (!urgent && Date.now() < this.nextAttemptAt) return;
    if (urgent) this.nextAttemptAt = 0;
    if (this.running) { this.again = true; return; }
    void this.sync();
  }

  /** One full cycle (push, pull); concurrent callers share it and a follow-up runs if requested meanwhile. */
  async sync(): Promise<CycleOutcome> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      let outcome: CycleOutcome;
      do {
        this.again = false;
        outcome = await this.cycle();
      } while (this.again && outcome === 'done' && !this.stopped);
      return outcome;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  private async cycle(): Promise<CycleOutcome> {
    // navigator.onLine is only a hint (it can be wrong both ways): always try the real
    // server; "offline" is reported when the attempt fails and the device says it has no network.
    try {
      const result = await this.withLock(() => this.exchange());
      if (result === 'locked') return 'skipped_locked';
      this.failures = 0; this.nextAttemptAt = 0;
      return result;
    } catch (error) {
      // Stopped (account switch/sign-out) or lease taken over by another tab: nothing to report.
      if (error instanceof Halt || this.stopped) return 'skipped_locked';
      if (error instanceof ApiError && error.kind === 'account_mismatch') return this.mismatch();
      return this.fail(error);
    }
  }

  /** The session changed to another account during the cycle: pending changes stay, sync stops for this account. */
  private async mismatch(): Promise<CycleOutcome> {
    await this.setStatus({ connection: 'account_mismatch' });
    try {
      const me = await this.api.me();
      if (!this.stopped && me.user.id !== this.account) this.options.onAccountMismatch?.(me);
    } catch { /* reported on the next cycle */ }
    return 'failed';
  }

  private async fail(error: unknown): Promise<CycleOutcome> {
    const kind = error instanceof ApiError ? error.kind : 'storage';
    const connection: Connection = kind === 'authentication_required' ? 'auth_required'
      : kind === 'password_change_required' ? 'password_change'
        : kind === 'upgrade_required' ? 'upgrade_required'
          // An HTTP answer (5xx, proxy page) proves the network works: the server is the problem.
          : (kind === 'network' || kind === 'timeout') && !this.online() ? 'offline' : 'server_unavailable';
    this.failures += 1;
    // Exponential backoff with jitter for periodic retries: 2 s, 4 s, … up to 5 min.
    const delay = Math.min(300_000, 2_000 * 2 ** Math.min(this.failures - 1, 10));
    this.nextAttemptAt = Date.now() + delay * (0.5 + (this.options.random ?? Math.random)() * 0.5);
    if (error instanceof ApiError && error.kind === 'rate_limited' && error.retryAfterSeconds) this.nextAttemptAt = Date.now() + error.retryAfterSeconds * 1000;
    await this.setStatus({ connection });
    return 'failed';
  }

  private async exchange(): Promise<'done'> {
    await this.guard();
    const me = await this.api.me();
    if (this.stopped) throw new Halt('stopped');
    if (me.user.id !== this.store.scope.userId || me.household.id !== this.store.scope.householdId) {
      // The browser's session belongs to someone else: this queue must not be sent with it.
      await this.setStatus({ connection: 'account_mismatch' });
      this.options.onAccountMismatch?.(me);
      return 'done';
    }
    if (me.user.mustChangePassword) { await this.setStatus({ connection: 'password_change' }); return 'done'; }
    const deviceId = await this.store.deviceId();
    let pushedAny = await this.pushAll(deviceId);
    await this.pullAll();
    // Commands made during the pull go out in the same cycle.
    if ((await this.store.nextBatch(1, MAX_PUSH_BYTES)).entries.length > 0) pushedAny = (await this.pushAll(deviceId)) || pushedAny;
    const now = new Date().toISOString();
    await this.setStatus({ connection: 'ok', lastSyncAt: now, ...(pushedAny ? { lastAckAt: now } : {}) });
    return 'done';
  }

  private async pushAll(deviceId: string): Promise<boolean> {
    let acked = false;
    for (let round = 0; round < MAX_PUSH_ROUNDS; round++) {
      const batch = await this.store.nextBatch(this.maxBatch, this.options.pushBytes ?? MAX_PUSH_BYTES - 16 * 1024);
      if (batch.entries.length === 0) break;
      await this.guard();
      await this.store.markAttempt(batch.entries);
      let response;
      try {
        response = await this.api.push({ protocolVersion: 1, deviceId, mutations: batch.mutations }, this.account, this.abort.signal);
      } catch (error) {
        if (error instanceof ApiError && (error.kind === 'payload_too_large' || error.kind === 'invalid_request') && batch.entries.length > 1) {
          this.maxBatch = Math.max(1, Math.floor(batch.entries.length / 2));
          continue;
        }
        if (error instanceof ApiError && (error.kind === 'payload_too_large' || error.kind === 'invalid_request')) {
          // A single change the server refuses as a whole: needs the user, never an endless retry.
          await this.store.db.queue.where('clientMutationId').equals(batch.entries[0]!.clientMutationId)
            .modify({ state: 'needs_action', error: error.kind === 'payload_too_large' ? 'payload_too_large' : 'validation_error' });
          continue;
        }
        throw error;
      }
      const { acked: count } = await this.store.applyResults(response.results);
      if (count > 0) acked = true;
      this.maxBatch = MAX_PUSH_BATCH;
    }
    return acked;
  }

  private async pullAll() {
    let cursor = await this.store.getMeta<string>('cursor');
    let started = false;
    if (!cursor) { await this.store.beginSnapshot(); started = true; }
    let resyncs = 0;
    for (let pages = 0; pages < MAX_PULL_PAGES; pages++) {
      await this.guard();
      const page = await this.api.pull(cursor, this.options.pullLimit ?? MAX_PULL_PAGE, this.account, this.abort.signal);
      await this.guard();
      if (page.status === 'resync_required') {
        // Full resync: pending changes and conflicts are kept; only the clean cache is replaced.
        if (++resyncs > 2) throw new ApiError('server');
        await this.store.beginSnapshot();
        cursor = undefined; started = true;
        continue;
      }
      await this.store.applyPull(page, started);
      started = false;
      cursor = page.nextCursor;
      if (!page.hasMore) return;
    }
  }

  // ---------- Cross-tab lock ----------

  private lease: { renew(): Promise<boolean> } | null = null;

  private async withLock<T>(body: () => Promise<T>): Promise<T | 'locked'> {
    const name = `razem-sync:${this.store.db.name}`;
    const locks = this.options.locks === undefined ? (typeof navigator !== 'undefined' ? navigator.locks : undefined) : this.options.locks;
    if (locks) {
      return locks.request(name, { ifAvailable: true }, async (lock) => lock ? body() : 'locked' as const);
    }
    // Fallback: a lease row in the account database, taken in a read-write transaction.
    // Each take gets its own token; renewal succeeds only while the row still carries it, so
    // a tab whose lease expired (e.g. frozen in the background) and was taken over — even if
    // the other tab already finished and released it — never continues its old cycle.
    const meta = this.store.db.meta;
    type Lease = { owner: string; token: string; until: number };
    const token = crypto.randomUUID();
    const read = async () => (await meta.get('syncLease'))?.value as Lease | undefined;
    const write = () => meta.put({ key: 'syncLease', value: { owner: this.tabId, token, until: this.clock() + LEASE_MS } satisfies Lease });
    const taken = await this.store.db.transaction('rw', meta, async () => {
      const held = await read();
      if (held && held.until > this.clock()) return false;
      await write();
      return true;
    });
    if (!taken) return 'locked';
    this.lease = {
      renew: () => this.store.db.transaction('rw', meta, async () => {
        if ((await read())?.token !== token) return false;
        await write();
        return true;
      }).catch(() => false),
    };
    try { return await body(); } finally {
      this.lease = null;
      await this.store.db.transaction('rw', meta, async () => {
        if ((await read())?.token === token) await meta.delete('syncLease');
      }).catch(() => undefined);
    }
  }
}
