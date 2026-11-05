// Account lifecycle of the PWA: which account's local database is open, sign-in,
// re-authentication, account switch and logout. Only the identity of the last account
// (IDs, login, display name — no token, no content) is kept in localStorage, so the app
// opens offline on that account's data. Another account always gets its own database;
// the previous account's pending changes stay in its database for its next sign-in.
import { liveQuery } from 'dexie';
import type { DexieOptions } from 'dexie';
import { settingsSchema } from '@razem/contracts';
import type { MeResponse, Settings, SettingsPatch } from '@razem/contracts';
import { ApiError } from '../api.js';
import type { Api } from '../api.js';
import { LocalStore } from './store.js';
import type { StoreFailure, StoreResult } from './store.js';
import { INITIAL_STATUS, SyncEngine } from './sync.js';
import { requestPersistentStorage } from '../storage-persistence.js';
import type { EngineOptions, SyncStatus } from './sync.js';

export type Account = { userId: string; householdId: string; login: string; displayName: string; mustChangePassword: boolean };
export const ACCOUNT_KEY = 'razem:account';

export type Phase = 'starting' | 'signed_out' | 'ready' | 'storage_unavailable';
export type Snapshot = {
  phase: Phase; account: Account | null; status: SyncStatus;
  unsent: number; attention: number; revision: number;
  storage: 'ok' | 'full' | 'unavailable';
  settings?: Settings | undefined;
  /**
   * Identity of the open account database (changes on every activation, logout and
   * account switch). Screens, query results, forms and commands are bound to it: a value
   * from another generation never reads or writes the current account's database.
   */
  generation: number;
};

export type AuthResult = { ok: true } | { ok: false; reason: 'invalid_credentials' | 'rate_limited' | 'weak_password' | 'authentication_required' | 'unavailable' | 'pending_changes' | 'storage_unavailable'; retryAfterSeconds?: number };

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type ControllerOptions = {
  api: Api;
  storage?: KeyValue | undefined;
  dbOptions?: DexieOptions;
  engine?: EngineOptions;
  /** Attach browser triggers (focus/online/15 s). Off in tests, which call syncNow(). */
  autoSync?: boolean;
};

const accountOf = (me: MeResponse): Account => ({
  userId: me.user.id, householdId: me.household.id, login: me.user.login, displayName: me.user.displayName, mustChangePassword: me.user.mustChangePassword,
});

function authFailure(error: unknown): AuthResult {
  if (!(error instanceof ApiError)) return { ok: false, reason: 'unavailable' };
  switch (error.kind) {
    case 'invalid_credentials': return { ok: false, reason: 'invalid_credentials' };
    case 'rate_limited': return { ok: false, reason: 'rate_limited', ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) };
    case 'weak_password': return { ok: false, reason: 'weak_password' };
    case 'authentication_required': return { ok: false, reason: 'authentication_required' };
    default: return { ok: false, reason: 'unavailable' };
  }
}

export class AppController {
  private snapshot: Snapshot = { phase: 'starting', account: null, status: INITIAL_STATUS, unsent: 0, attention: 0, revision: 0, storage: 'ok', generation: 0 };
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  store: LocalStore | null = null;
  engine: SyncEngine | null = null;
  private unwatch: (() => void) | null = null;
  readonly api: Api;

  constructor(private readonly options: ControllerOptions) { this.api = options.api; }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private set(change: Partial<Snapshot>) { this.snapshot = { ...this.snapshot, ...change }; this.listeners.forEach((listener) => listener()); }

  private readAccount(): Account | null {
    try {
      const raw = this.options.storage?.getItem(ACCOUNT_KEY);
      if (!raw) return null;
      const value = JSON.parse(raw) as Account;
      return typeof value?.userId === 'string' && typeof value.householdId === 'string' ? value : null;
    } catch { return null; }
  }
  private writeAccount(account: Account | null) {
    try {
      if (account) this.options.storage?.setItem(ACCOUNT_KEY, JSON.stringify(account));
      else this.options.storage?.removeItem(ACCOUNT_KEY);
    } catch { /* identity hint only */ }
  }

  /** Opens the last account offline-first; without one, asks the server whether a session exists. */
  async init() {
    const remembered = this.readAccount();
    if (remembered) { await this.activate(remembered); return; }
    try {
      const me = await this.api.me();
      await this.activate(accountOf(me));
    } catch { this.set({ phase: 'signed_out' }); }
  }

  private async activate(account: Account) {
    await this.deactivate();
    const generation = this.generation;
    const store = new LocalStore({ userId: account.userId, householdId: account.householdId }, this.options.dbOptions);
    try { await store.open(); await store.deviceId(); } catch {
      store.close();
      if (this.generation === generation) this.set({ phase: 'storage_unavailable', account, settings: undefined, storage: 'unavailable', generation });
      return;
    }
    if (this.generation !== generation) { store.close(); return; } // superseded by a newer activation/logout
    this.store = store;
    this.writeAccount(account);
    this.engine = new SyncEngine(store, this.api, { ...this.options.engine, onAccountMismatch: (me) => { void this.adopt(me); } });
    const subscription = liveQuery(async () => {
      return this.readCounts(store);
    }).subscribe({
      next: (value) => { if (this.store === store) this.set({ revision: value.revision, status: value.status, unsent: value.unsent, attention: value.attention }); },
      error: () => { if (this.store === store) this.set({ storage: 'unavailable' }); },
    });
    this.unwatch = () => subscription.unsubscribe();
    this.set({ phase: 'ready', account, storage: 'ok', generation, ...(await this.readCounts(store)) });
    if (this.store !== store) return;
    if (typeof navigator !== 'undefined') void requestPersistentStorage();
    if (this.options.autoSync) this.engine.start();
  }

  private async readCounts(store: LocalStore) {
    const counts = await store.counts();
    const status = { ...INITIAL_STATUS, ...(await store.getMeta<SyncStatus>('status')) };
    const revision = Number((await store.db.meta.get('revision'))?.value) || 0;
    const parsed = settingsSchema.safeParse(await store.getMeta('settings'));
    const settings = parsed.success && parsed.data.userId === store.scope.userId && parsed.data.household.id === store.scope.householdId ? parsed.data : undefined;
    return { ...counts, status, revision, settings };
  }

  private async deactivate() {
    // From now on nothing bound to the previous generation may touch a database.
    this.generation++;
    const engine = this.engine, store = this.store;
    this.engine = null; this.store = null;
    this.unwatch?.(); this.unwatch = null;
    // An interrupted cycle ends first, so its lease is released in a still open database
    // (otherwise the account's queue would wait for the lease to expire after re-login).
    await engine?.stopAndSettle();
    store?.close();
  }

  /** The server session belongs to another account (e.g. signed in in another tab): follow it. */
  private async adopt(me: MeResponse) {
    const account = accountOf(me);
    if (this.snapshot.account?.userId === account.userId) return;
    await this.activate(account);
    if (this.options.autoSync) this.engine?.request(true);
  }

  async login(login: string, password: string): Promise<AuthResult> {
    let me: MeResponse;
    try { me = await this.api.login(login, password); } catch (error) { return authFailure(error); }
    const account = accountOf(me);
    if (this.store && this.snapshot.account?.userId === account.userId) {
      // Same account again (e.g. after an expired session): its queue goes out now.
      this.set({ account });
      this.writeAccount(account);
    } else {
      await this.activate(account);
    }
    if (this.snapshot.phase !== 'ready') return { ok: false, reason: 'storage_unavailable' };
    if (this.options.autoSync) void this.syncNow();
    return { ok: true };
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<AuthResult> {
    try {
      const me = await this.api.changePassword(currentPassword, newPassword);
      const account = accountOf(me);
      this.set({ account }); this.writeAccount(account);
      if (this.options.autoSync) void this.syncNow();
      return { ok: true };
    } catch (error) { return authFailure(error); }
  }

  /**
   * Logout. With unsent changes it refuses unless the user explicitly discards them
   * (after sending or exporting). Needs the server, so the session is really ended;
   * then this account's local database is deleted.
   */
  async logout(options: { discardPending: boolean }): Promise<AuthResult> {
    if (this.snapshot.unsent > 0 && !options.discardPending) return { ok: false, reason: 'pending_changes' };
    try { await this.api.logout(); } catch (error) {
      if (!(error instanceof ApiError && error.kind === 'authentication_required')) return { ok: false, reason: 'unavailable' };
    }
    const store = this.store;
    await this.deactivate();
    if (store) { try { await store.destroy(); } catch { /* best effort; DB name is account-scoped */ } }
    this.writeAccount(null);
    this.set({ phase: 'signed_out', account: null, status: INITIAL_STATUS, unsent: 0, attention: 0, revision: 0, settings: undefined, storage: 'ok', generation: this.generation });
    return { ok: true };
  }

  async syncNow() { await this.engine?.sync(); await this.refresh(); }

  async updateSettings(patch: SettingsPatch, generation: number): Promise<import('../services.js').ActionResult> {
    const store = this.storeFor(generation);
    if (!store) return { ok: false, reason: 'account_changed' };
    try {
      const settings = await this.api.settings(store.scope.userId, undefined, patch);
      if (this.storeFor(generation) !== store) return { ok: false, reason: 'account_changed' };
      if (settings.household.id !== store.scope.householdId) return { ok: false, reason: 'account_changed' };
      await store.db.transaction('rw', store.db.meta, async () => {
        await store.setMeta('settings', settings);
        await store.setMeta('revision', (Number(await store.getMeta('revision')) || 0) + 1);
      });
      await this.refresh();
      return { ok: true };
    } catch (error) {
      if (error instanceof ApiError) return error.kind === 'invalid_request' ? { ok: false, reason: 'invalid' }
        : error.kind === 'account_mismatch' ? { ok: false, reason: 'account_changed' } : authFailure(error);
      // The server may have saved the settings, but local persistence failed. No false success.
      return { ok: false, reason: 'storage_unavailable' };
    }
  }

  /** Re-reads counts and status now (the live query also does it, asynchronously). */
  async refresh() {
    const store = this.store;
    if (!store) return;
    try { const value = await this.readCounts(store); if (this.store === store) this.set(value); } catch { /* reported by commands */ }
  }

  /** The open store, only when it still belongs to the given generation (account). */
  storeFor(generation: number): LocalStore | null {
    return this.generation === generation && this.snapshot.generation === generation ? this.store : null;
  }

  /**
   * Runs a local command, maps storage failures to the visible state and nudges sync.
   * With `generation` (the screens always pass the one they were rendered for) a command
   * started for another account is refused instead of being written to the current one.
   */
  async command<T>(run: (store: LocalStore) => Promise<StoreResult<T>>, generation?: number): Promise<StoreResult<T>> {
    if (generation !== undefined && this.storeFor(generation) === null && this.store) return { ok: false, reason: 'account_changed' };
    const store = generation === undefined ? this.store : this.storeFor(generation);
    if (!store) return { ok: false, reason: 'storage_unavailable' };
    const result = await run(store);
    if (!result.ok && (result.reason === 'storage_full' || result.reason === 'storage_unavailable')) {
      this.set({ storage: result.reason === 'storage_full' ? 'full' : 'unavailable' });
    } else if (this.snapshot.storage !== 'ok') this.set({ storage: 'ok' });
    await this.refresh();
    if (result.ok && this.options.autoSync) this.engine?.request(true);
    return result;
  }

  async dispose() { await this.deactivate(); }
}

export type { StoreFailure };
