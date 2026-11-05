import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PULL_PAGE, SYNC_ACCOUNT_HEADER, pullResponseSchema, pushResponseSchema } from '@razem/contracts';
import type { AccountScope, EntityType, PullResponse, PushResponse, SyncRecord } from '@razem/contracts';
import { SNAPSHOT_ORDER, migrate, openDatabase } from '@razem/db';
import type { Database, ServerState } from '@razem/db';
import { buildApp, syncServiceOf } from '../app.js';
import type { SyncService } from './service.js';
import { hashPassword } from '../auth/passwords.js';

// Synthetic household, accounts and content only.
const FAST = { memory: 1024, passes: 1, parallelism: 1 };
const ORIGIN = 'https://razem.test';
const H = '00000000-0000-4000-8000-000000000001';
const A_ID = '00000000-0000-4000-8000-0000000000aa';
const B_ID = '00000000-0000-4000-8000-0000000000bb';
const A: AccountScope = { userId: A_ID, householdId: H };
const B: AccountScope = { userId: B_ID, householdId: H };
const PASSWORD = { a: 'Syntetyczne haslo A 2026', b: 'Syntetyczne haslo B 2026' };
const DAY = 86_400_000;
const json = { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin' };

let dir: string;
let database: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
let sync: SyncService;
let now: number;
const clock = () => new Date(now);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'razem-sync-'));
  database = openDatabase(join(dir, 'razem.sqlite'));
  migrate(database.sqlite);
  now = Date.parse('2026-11-04T10:00:00.000Z');
  const T = new Date(now).toISOString();
  database.sqlite.prepare('INSERT INTO households VALUES (?, ?, ?, ?)').run(H, 'Syntetyczny dom', 'Europe/Warsaw', T);
  const user = database.sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, 0, ?, ?)');
  user.run(A_ID, H, 'a@example.test', 'Konto A', await hashPassword(PASSWORD.a, FAST), T, T);
  user.run(B_ID, H, 'b@example.test', 'Konto B', await hashPassword(PASSWORD.b, FAST), T, T);
  app = await buildApp({ database, publicOrigin: ORIGIN, auth: { argon2: FAST, clock }, sync: { clock } });
  sync = syncServiceOf(app);
});
afterEach(async () => {
  registry.length = 0;
  await app.close();
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

async function login(login: string, password: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: json, payload: { login, password } });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  return String(Array.isArray(raw) ? raw.at(-1) : raw).split(';')[0]!;
}

type Mut = Record<string, unknown>;
const registry: Device[] = [];
/** Moves the server clock; sessions idle longer than 30 days expire, so phones log in again (outbox/cursor kept). */
async function travel(ms: number) {
  now += ms;
  for (const device of registry) if (device.account) device.cookie = await login(device.account.login, device.account.password);
}
/** A synthetic phone: session cookie, device ID, local copy and pull cursor. */
class Device {
  readonly deviceId = randomUUID();
  cursor: string | undefined;
  readonly local = new Map<string, ServerState>();
  constructor(public cookie: string, readonly account?: { login: string; password: string }) { registry.push(this); }

  /** Account the session cookie belongs to (sent as SYNC_ACCOUNT_HEADER, like the PWA does). */
  async accountHeader(): Promise<Record<string, string>> {
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: this.cookie } });
    return me.statusCode === 200 ? { 'x-razem-protocol': '2', [SYNC_ACCOUNT_HEADER]: (me.json() as { user: { id: string } }).user.id } : {};
  }
  async pushRaw(payload: unknown, headers: Record<string, string> = {}) {
    return app.inject({ method: 'POST', url: '/api/sync/push', headers: { ...json, cookie: this.cookie, ...(await this.accountHeader()), ...headers }, payload: payload as never });
  }
  async push(...mutations: Mut[]): Promise<PushResponse['results']> {
    const response = await this.pushRaw({ protocolVersion: 2, deviceId: this.deviceId, mutations });
    expect(response.statusCode, response.body).toBe(200);
    return pushResponseSchema.parse(response.json()).results;
  }
  async pullPage(limit?: number): Promise<PullResponse> {
    const query = new URLSearchParams({ ...(this.cursor ? { cursor: this.cursor } : {}), ...(limit ? { limit: String(limit) } : {}) });
    const response = await app.inject({ method: 'GET', url: `/api/sync/pull?${query}`, headers: { cookie: this.cookie, ...(await this.accountHeader()) } });
    expect(response.statusCode, response.body).toBe(200);
    const body = pullResponseSchema.parse(response.json());
    if (body.status === 'resync_required') return body;
    // The local apply: page and cursor together; a higher version wins, a tombstone removes.
    for (const change of body.changes) {
      const id = change.kind === 'record' ? change.record : change.tombstone;
      const key = `${id.entityType}:${id.id}`;
      const known = this.local.get(key);
      const version = (s: ServerState) => s.kind === 'record' ? s.record.version : s.tombstone.version;
      if (!known || version(known) <= version(change)) this.local.set(key, change);
    }
    this.cursor = body.nextCursor;
    return body;
  }
  /** Pulls until no more pages; on resync_required clears the cache and bootstraps. */
  async sync(limit?: number, between?: () => Promise<void>) {
    for (let guard = 0; guard < 1000; guard++) {
      const page = await this.pullPage(limit);
      if (page.status === 'resync_required') { this.cursor = undefined; this.local.clear(); continue; }
      if (!page.hasMore) return;
      await between?.();
    }
    throw new Error('pull nie zakończył się');
  }
  records(): SyncRecord[] {
    return [...this.local.values()].flatMap((s) => s.kind === 'record' ? [s.record] : []).sort((x, y) => x.id.localeCompare(y.id));
  }
}

const devices = async () => {
  const accounts = { a: { login: 'a@example.test', password: PASSWORD.a }, b: { login: 'b@example.test', password: PASSWORD.b } };
  return { a: new Device(await login(accounts.a.login, accounts.a.password), accounts.a), b: new Device(await login(accounts.b.login, accounts.b.password), accounts.b) };
};
const create = (entityType: EntityType, data: Mut, visibility?: 'private' | 'shared', entityId = randomUUID()) =>
  ({ clientMutationId: randomUUID(), entityType, entityId, command: 'create', baseVersion: 0, ...(visibility ? { visibility } : {}), data });
const update = (entityType: EntityType, entityId: string, baseVersion: number, patch: Mut) =>
  ({ clientMutationId: randomUUID(), entityType, entityId, command: 'update', baseVersion, patch });
const versioned = (command: 'delete' | 'restore', entityType: EntityType, entityId: string, baseVersion: number) =>
  ({ clientMutationId: randomUUID(), entityType, entityId, command, baseVersion });
const note = (title: string, body = 'treść syntetyczna') => ({ title, body });
const item = (listId: string, name = 'Mleko') => ({ listId, name, quantity: '1', note: '', checked: false, sortKey: 1 });
const task = (title: string, assignee = 'both') => ({ title, description: '', assignee, dueDate: '2026-11-05', dueAt: null, timezone: 'Europe/Warsaw', completedAt: null, recurrence: null });

/** Everything the account may read on the server, as the client should hold it after a full sync. */
function serverView(scope: AccountScope): SyncRecord[] {
  return SNAPSHOT_ORDER.flatMap((type) => sync.records.list(scope, type, { includeDeleted: true })).sort((x, y) => x.id.localeCompare(y.id));
}
const count = (sql: string, ...args: unknown[]) => (database.sqlite.prepare(sql).get(...args) as { n: number }).n;
const stateOf = (result: PushResponse['results'][number]) => {
  if (result.status === 'error') throw new Error(`oczekiwano stanu, jest ${result.code}`);
  return result.state;
};
const recordOf = (result: PushResponse['results'][number]) => {
  const state = stateOf(result);
  if (state.kind !== 'record') throw new Error('oczekiwano rekordu');
  return state.record;
};

describe('dwa urządzenia: zbieżność, prywatność i niezmienny zakres', () => {
  it('wspólne dane zbiegają się w obie strony, prywatne zostają u właściciela', async () => {
    const { a, b } = await devices();
    const list = create('shopping_list', { name: 'Zakupy wspólne' }, 'shared');
    const privList = create('shopping_list', { name: 'Prezent – tylko A' }, 'private');
    const privNote = create('note', note('Prywatna A', 'sekret syntetyczny A'), 'private');
    expect((await a.push(list, privList, privNote, create('shopping_item', item(list.entityId)), create('shopping_item', item(privList.entityId, 'Prywatny prezent'))))
      .map((r) => r.status)).toEqual(['ack', 'ack', 'ack', 'ack', 'ack']);
    const bTask = create('task', task('Wspólne zadanie B'), 'shared');
    const bPriv = create('note', note('Prywatna B'), 'private');
    await b.push(bTask, bPriv, create('shopping_item', item(list.entityId, 'Chleb')));
    await a.sync();
    await b.sync();
    // Concurrent edits of different shared records merge without conflict.
    const [aEdit] = await a.push(update('task', bTask.entityId, 1, { title: 'Zadanie poprawione przez A' }));
    const [bEdit] = await b.push(update('shopping_list', list.entityId, 1, { name: 'Zakupy sobota' }));
    expect([aEdit!.status, bEdit!.status]).toEqual(['ack', 'ack']);
    await a.sync();
    await b.sync();

    const shared = (records: SyncRecord[]) => records.filter((r) => r.visibility === 'shared');
    expect(shared(a.records())).toEqual(shared(b.records()));
    expect(shared(a.records())).toHaveLength(4);
    expect(a.records()).toEqual(serverView(A));
    expect(b.records()).toEqual(serverView(B));
    // A's private list, its item and note never reach B; B's private note never reaches A.
    const bIds = new Set(b.records().map((r) => r.id));
    for (const id of [privList.entityId, privNote.entityId]) expect(bIds.has(id)).toBe(false);
    expect(b.records().some((r) => r.ownerId === A_ID && r.visibility === 'private')).toBe(false);
    expect(a.records().some((r) => r.id === bPriv.entityId)).toBe(false);
    expect(JSON.stringify([...b.local.values()])).not.toContain('sekret syntetyczny A');
    expect(JSON.stringify([...b.local.values()])).not.toContain('Prywatny prezent');
    // Ownership is assigned by the server and survives the partner's edit.
    expect(a.records().find((r) => r.id === bTask.entityId)).toMatchObject({ ownerId: B_ID, version: 2, data: { title: 'Zadanie poprawione przez A' } });
  });

  it('nie da się zmienić widoczności, właściciela, gospodarstwa ani wersji; serwer nadaje metadane', async () => {
    const { a, b } = await devices();
    const shared = create('note', note('Wspólna'), 'shared');
    await a.push(shared);
    const attempts = [
      { visibility: 'private' }, { ownerId: B_ID }, { householdId: randomUUID() }, { version: 9 }, { deletedAt: null }, { createdAt: '2020-01-01T00:00:00.000Z' },
    ];
    for (const patch of attempts) {
      for (const device of [a, b]) {
        const [result] = await device.push(update('note', shared.entityId, 1, patch));
        expect(result).toMatchObject({ status: 'error', code: 'validation_error' });
      }
    }
    // Choosing an owner or household at create, or visibility for a child, is rejected.
    const [own] = await b.push({ ...create('note', note('x'), 'shared'), ownerId: A_ID });
    expect(own).toMatchObject({ status: 'error', code: 'validation_error' });
    const [child] = await a.push(create('shopping_item', item(randomUUID()), 'shared'));
    expect(child).toMatchObject({ status: 'error', code: 'validation_error' });
    expect(sync.records.get(A, 'note', shared.entityId)).toMatchObject({ ownerId: A_ID, householdId: H, visibility: 'shared', version: 1 });
    // A partner's edit of a shared record does not transfer ownership.
    const [edit] = await b.push(update('note', shared.entityId, 1, { body: 'B dopisuje' }));
    expect(recordOf(edit!)).toMatchObject({ ownerId: A_ID, visibility: 'shared', version: 2 });
  });
});

describe('idempotencja i atomowość', () => {
  it('powtórzenie po zgubionym ACK odtwarza wynik bez drugiego rekordu; inny payload pod tym samym ID odrzucony', async () => {
    const { a } = await devices();
    const mutation = create('note', note('Raz'), 'private');
    const first = await a.push(mutation);
    // Lost response: the phone sends the same batch again (also with another key order).
    const reordered = Object.fromEntries(Object.entries(mutation).reverse());
    const again = await a.push(reordered);
    expect(again).toEqual(first);
    expect(count('SELECT count(*) AS n FROM notes')).toBe(1);
    expect(count('SELECT count(*) AS n FROM sync_changes WHERE entity_id = ?', mutation.entityId)).toBe(1);
    expect(count('SELECT count(*) AS n FROM mutation_receipts')).toBe(1);
    // Same clientMutationId, different content: rejected, nothing written.
    for (const changed of [{ ...mutation, data: note('Podmieniona') }, { ...mutation, entityId: randomUUID() }, { ...mutation, visibility: 'shared' }]) {
      const [reused] = await a.push(changed);
      expect(reused).toEqual({ clientMutationId: mutation.clientMutationId, entityType: 'note', entityId: changed.entityId, status: 'error', code: 'mutation_id_reused', retryable: false });
    }
    expect(sync.records.get(A, 'note', mutation.entityId)).toMatchObject({ version: 1, visibility: 'private', data: { title: 'Raz' } });
    expect(count('SELECT count(*) AS n FROM notes')).toBe(1);
    // Replaying an update does not bump the version again.
    const edit = update('note', mutation.entityId, 1, { body: 'druga' });
    expect(recordOf((await a.push(edit))[0]!).version).toBe(2);
    expect(recordOf((await a.push(edit))[0]!).version).toBe(2);
    expect(sync.records.get(A, 'note', mutation.entityId)!.version).toBe(2);
  });

  it('receipt i zmiana danych w jednej transakcji: awaria przy receipt lub journalu nie zostawia połowy', async () => {
    const { a } = await devices();
    for (const table of ['mutation_receipts', 'sync_changes']) {
      database.sqlite.exec(`CREATE TEMP TRIGGER fail_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic_failure'); END`);
      const mutation = create('note', note(`Awaria ${table}`), 'shared');
      const failed = await a.pushRaw({ protocolVersion: 2, deviceId: a.deviceId, mutations: [mutation] });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({ error: 'unavailable' }); // no SQL or content in the body
      expect(count('SELECT count(*) AS n FROM notes WHERE id = ?', mutation.entityId)).toBe(0);
      expect(count('SELECT count(*) AS n FROM sync_changes WHERE entity_id = ?', mutation.entityId)).toBe(0);
      expect(count('SELECT count(*) AS n FROM mutation_receipts WHERE client_mutation_id = ?', mutation.clientMutationId)).toBe(0);
      database.sqlite.exec(`DROP TRIGGER temp.fail_${table}`);
      // The phone kept the outbox entry and retries after the 5xx: exactly one effect.
      expect((await a.push(mutation))[0]!.status).toBe('ack');
      expect((await a.push(mutation))[0]!.status).toBe('ack');
      expect(count('SELECT count(*) AS n FROM notes WHERE id = ?', mutation.entityId)).toBe(1);
      expect(count('SELECT count(*) AS n FROM sync_changes WHERE entity_id = ?', mutation.entityId)).toBe(1);
    }
  });

  it('awaria w połowie partii: zatwierdzone mutacje mają receipt, ponowienie całej partii nie dubluje', async () => {
    const { a } = await devices();
    const first = create('note', note('Pierwsza'), 'private');
    const second = create('note', note('Druga'), 'private');
    database.sqlite.exec(`CREATE TEMP TRIGGER fail_second BEFORE INSERT ON notes WHEN NEW.id = '${second.entityId}' BEGIN SELECT RAISE(FAIL, 'synthetic_failure'); END`);
    // RAISE(FAIL) is a constraint error → permanent validation_error, not a 5xx retry loop.
    const results = await a.push(first, second);
    expect(results.map((r) => r.status)).toEqual(['ack', 'error']);
    database.sqlite.exec('DROP TRIGGER temp.fail_second');
    database.sqlite.exec(`CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON mutation_receipts BEGIN SELECT RAISE(ABORT, 'synthetic_failure'); END`);
    const third = create('note', note('Trzecia'), 'private');
    expect((await a.pushRaw({ protocolVersion: 2, deviceId: a.deviceId, mutations: [first, third] })).statusCode).toBe(500);
    database.sqlite.exec('DROP TRIGGER temp.fail_receipt');
    expect((await a.push(first, third)).map((r) => r.status)).toEqual(['ack', 'ack']);
    expect(count('SELECT count(*) AS n FROM notes')).toBe(2);
  });

  it('klucz idempotencji zawiera konto: te same deviceId i mutationId partnera nie dają jego wyniku', async () => {
    const { a, b } = await devices();
    const mutation = create('note', note('Prywatna A', 'sekret A'), 'private');
    await a.push(mutation);
    const response = await b.pushRaw({ protocolVersion: 2, deviceId: a.deviceId, mutations: [mutation] });
    expect(response.statusCode).toBe(200);
    // B's own decision: the ID belongs to someone else's private record → not_found, no content.
    expect(pushResponseSchema.parse(response.json()).results[0]).toMatchObject({ status: 'error', code: 'not_found' });
    expect(response.body).not.toContain('sekret A');
    expect(count('SELECT count(*) AS n FROM devices WHERE id = ?', a.deviceId)).toBe(2);
  });
});

describe('konflikty, usuwanie i tombstones', () => {
  it('konflikt wersji zwraca aktualną wersję, bez cichego nadpisania (nie LWW)', async () => {
    const { a, b } = await devices();
    const shared = create('note', note('Wspólna', 'baza'), 'shared');
    await a.push(shared);
    expect((await b.push(update('note', shared.entityId, 1, { body: 'wersja B' })))[0]!.status).toBe('ack');
    // A edits offline from v1 later in wall time; it must not win just by being later.
    now += 60_000;
    const [conflict] = await a.push(update('note', shared.entityId, 1, { body: 'wersja A' }));
    expect(conflict).toMatchObject({ status: 'conflict', state: { kind: 'record', record: { version: 2, data: { body: 'wersja B' } } } });
    expect(sync.records.get(A, 'note', shared.entityId)!.data).toEqual({ title: 'Wspólna', body: 'wersja B' });
    // Resolution: a new mutation on the current version.
    const [resolved] = await a.push(update('note', shared.entityId, 2, { body: 'wersja B\nwersja A' }));
    expect(recordOf(resolved!)).toMatchObject({ version: 3 });
    // The same check on both phones is an idempotent effect, acknowledged without a new version.
    const list = create('shopping_list', { name: 'Lista' }, 'shared');
    const milk = create('shopping_item', item(list.entityId));
    await a.push(list, milk);
    await a.push(update('shopping_item', milk.entityId, 1, { checked: true }));
    const [same] = await b.push(update('shopping_item', milk.entityId, 1, { checked: true }));
    expect(same).toMatchObject({ status: 'ack', state: { record: { version: 2, data: { checked: true } } } });
    // But a stale edit with different content is a conflict.
    const [rename] = await b.push(update('shopping_item', milk.entityId, 1, { checked: true, name: 'Mleko 2%' }));
    expect(rename!.status).toBe('conflict');
  });

  it('nieaktualna edycja treści równa bieżącemu stanowi to konflikt, nie ACK (tylko odhaczenie jest idempotentne)', async () => {
    const { a, b } = await devices();
    const shared = create('note', { title: 'T1', body: 'A' }, 'shared');
    await a.push(shared);
    await a.push(update('note', shared.entityId, 1, { title: 'T2', body: 'B' }));
    // B edited on top of T1 and happened to type the same body – still a conflict.
    const [body] = await b.push(update('note', shared.entityId, 1, { body: 'B' }));
    expect(body).toMatchObject({ status: 'conflict', state: { record: { version: 2, data: { title: 'T2', body: 'B' } } } });
    const [title] = await b.push(update('note', shared.entityId, 1, { title: 'T2' }));
    expect(title!.status).toBe('conflict');
    const [both] = await b.push(update('note', shared.entityId, 1, { title: 'T2', body: 'B' }));
    expect(both!.status).toBe('conflict');
    expect(sync.records.get(A, 'note', shared.entityId)!.version).toBe(2);

    const list = create('shopping_list', { name: 'Lista' }, 'shared');
    const milk = create('shopping_item', item(list.entityId));
    await a.push(list, milk);
    await a.push(update('shopping_item', milk.entityId, 1, { checked: true, name: 'Mleko 2%' }));
    // Mixed check-off + content equal to the current state: conflict.
    const [mixed] = await b.push(update('shopping_item', milk.entityId, 1, { checked: true, name: 'Mleko 2%' }));
    expect(mixed).toMatchObject({ status: 'conflict', state: { record: { version: 2 } } });
    // Pure check-off equal to the current state: idempotent ACK without a new version.
    const checkOnly = update('shopping_item', milk.entityId, 1, { checked: true });
    const [check] = await b.push(checkOnly);
    expect(check).toMatchObject({ status: 'ack', state: { record: { version: 2 } } });
    // Replay of the same mutation returns the stored receipt result.
    const [replay] = await b.push(checkOnly);
    expect(replay).toEqual(check);
    expect(sync.records.get(A, 'shopping_item', milk.entityId)!.version).toBe(2);

    // Task completion: same rule.
    const task = create('task', { title: 'Śmieci', description: '', assignee: 'both', dueDate: null, dueAt: null,
      timezone: 'Europe/Warsaw', completedAt: null, recurrence: null }, 'shared');
    await a.push(task);
    const done = '2026-01-02T10:00:00.000Z';
    await a.push(update('task', task.entityId, 1, { completedAt: done }));
    expect((await b.push(update('task', task.entityId, 1, { completedAt: done })))[0]!.status).toBe('ack');
    expect((await b.push(update('task', task.entityId, 1, { completedAt: done, title: 'Śmieci' })))[0]!.status).toBe('conflict');
  });

  it('usunięcie kontra edycja: konflikt z aktualnym stanem, bez wskrzeszenia; restore jako wersjonowana mutacja', async () => {
    const { a, b } = await devices();
    const shared = create('note', note('Do usunięcia'), 'shared');
    await a.push(shared);
    await a.push(versioned('delete', 'note', shared.entityId, 1));
    const [edit] = await b.push(update('note', shared.entityId, 1, { body: 'edycja offline B' }));
    expect(edit).toMatchObject({ status: 'conflict', state: { kind: 'record', record: { version: 2 } } });
    expect(recordOf(edit!).deletedAt).not.toBeNull();
    // Even with the current version an edit does not resurrect a record in the trash.
    expect((await b.push(update('note', shared.entityId, 2, { body: 'edycja po usunięciu' })))[0]!.status).toBe('conflict');
    // Edit against delete the other way round: a stale delete does not remove the edit.
    const other = create('note', note('Edytowana'), 'shared');
    await a.push(other);
    await b.push(update('note', other.entityId, 1, { body: 'B edytuje' }));
    expect((await a.push(versioned('delete', 'note', other.entityId, 1)))[0]).toMatchObject({ status: 'conflict', state: { record: { deletedAt: null, version: 2 } } });
    // Trash: restore by either member using the current version.
    const [restored] = await b.push(versioned('restore', 'note', shared.entityId, 2));
    expect(recordOf(restored!)).toMatchObject({ version: 3, deletedAt: null, data: { body: 'treść syntetyczna' } });
    expect(sync.records.get(A, 'note', shared.entityId)!.data).toMatchObject({ body: 'treść syntetyczna' });
  });

  it('po 30 dniach kosz → tombstone; stare mutacje (create/update/delete/restore) nie wskrzeszają rekordu', async () => {
    const { a, b } = await devices();
    const list = create('shopping_list', { name: 'Stara lista' }, 'shared');
    const milk = create('shopping_item', item(list.entityId));
    const privNote = create('note', note('Prywatna do kosza', 'sekret'), 'private');
    await a.push(list, milk, privNote);
    await b.sync();
    await a.push(versioned('delete', 'shopping_list', list.entityId, 1), versioned('delete', 'note', privNote.entityId, 1));
    await travel(29 * DAY);
    expect(sync.maintenance().purged).toBe(0);
    await travel(2 * DAY);
    expect(sync.maintenance().purged).toBe(3); // list, its item and the note
    expect(count('SELECT count(*) AS n FROM shopping_lists')).toBe(0);
    expect(count('SELECT count(*) AS n FROM shopping_items')).toBe(0);
    // Tombstones carry metadata only.
    const columns = Object.keys(database.sqlite.prepare('SELECT * FROM tombstones').get() as object);
    expect(columns.sort()).toEqual(['deleted_at', 'entity_type', 'household_id', 'id', 'owner_id', 'purged_at', 'version', 'visibility']);
    // B's old phone receives the tombstones in delta, not A's private one.
    await b.sync();
    expect(b.local.get(`shopping_list:${list.entityId}`)).toMatchObject({ kind: 'tombstone', tombstone: { version: 3 } });
    expect(b.local.get(`shopping_item:${milk.entityId}`)).toMatchObject({ kind: 'tombstone' });
    expect([...b.local.keys()].some((k) => k.includes(privNote.entityId))).toBe(false);
    // An old phone replays create/update/restore for the purged record.
    const results = await b.push(
      { ...list, clientMutationId: randomUUID() }, update('shopping_item', milk.entityId, 1, { checked: true }),
      versioned('restore', 'shopping_list', list.entityId, 2), versioned('delete', 'shopping_list', list.entityId, 3),
    );
    expect(results.map((r) => r.status)).toEqual(['conflict', 'conflict', 'error', 'error']);
    expect(stateOf(results[0]!)).toMatchObject({ kind: 'tombstone', tombstone: { id: list.entityId, version: 3 } });
    expect(results.slice(2).map((r) => r.status === 'error' && r.code)).toEqual(['dependency_failed', 'dependency_failed']);
    expect((await b.push(versioned('restore', 'shopping_list', list.entityId, 3)))[0]!.status).toBe('conflict');
    expect(count('SELECT count(*) AS n FROM shopping_lists')).toBe(0);
    // The database itself refuses to re-insert a purged ID.
    expect(() => database.sqlite.prepare("INSERT INTO shopping_lists VALUES (?, ?, ?, 'shared', 1, ?, ?, NULL, 'x')").run(list.entityId, H, A_ID, 'a', 'a')).toThrow(/tombstoned/);
    // B guessing A's purged private ID learns nothing.
    const [guess] = await b.push(versioned('restore', 'note', privNote.entityId, 2));
    const [missing] = await b.push(versioned('restore', 'note', randomUUID(), 2));
    expect([guess!.status === 'error' && guess!.code, missing!.status === 'error' && missing!.code]).toEqual(['not_found', 'not_found']);
  });

  it('operacje zależne: po konflikcie lub błędzie kolejne mutacje tego rekordu i jego dzieci nie są wykonywane', async () => {
    const { a, b } = await devices();
    const shared = create('note', note('Zależności'), 'shared');
    await a.push(shared);
    await b.push(update('note', shared.entityId, 1, { body: 'B' }));
    const badList = create('shopping_list', { name: '' }, 'shared'); // invalid: empty name
    const results = await a.push(
      update('note', shared.entityId, 1, { body: 'A1' }), update('note', shared.entityId, 2, { body: 'A2 na bazie A1' }),
      badList, create('shopping_item', item(badList.entityId)), create('note', note('Niezależna'), 'private'),
    );
    expect(results.map((r) => r.status === 'error' ? r.code : r.status)).toEqual(['conflict', 'dependency_failed', 'validation_error', 'dependency_failed', 'ack']);
    expect(sync.records.get(A, 'note', shared.entityId)!.data).toMatchObject({ body: 'B' });
    // dependency_failed leaves no receipt: the client may rebase and resend the same ID.
    const dependent = results[1]!;
    expect(count('SELECT count(*) AS n FROM mutation_receipts WHERE client_mutation_id = ?', dependent.clientMutationId)).toBe(0);
    // Operations on the same record apply in order within one batch.
    const fresh = create('note', note('Kolejność'), 'private');
    const chain = await a.push(fresh, update('note', fresh.entityId, 1, { body: '1' }), update('note', fresh.entityId, 2, { body: '2' }), versioned('delete', 'note', fresh.entityId, 3));
    expect(chain.map((r) => r.status)).toEqual(['ack', 'ack', 'ack', 'ack']);
    expect(sync.records.get(A, 'note', fresh.entityId)).toMatchObject({ version: 4, data: { body: '2' } });
  });

  it('ukończenie tego samego wystąpienia na dwóch telefonach tworzy jeden rekord', async () => {
    const { a, b } = await devices();
    const t = create('task', { ...task('Cykliczne'), recurrence: { frequency: 'daily', interval: 1, startDate: '2026-11-05' } }, 'shared');
    await a.push(t);
    const occurrence = (id: string) => ({ taskId: t.entityId, occurrenceKey: '2026-11-05', completedAt: new Date(now).toISOString(), _id: id });
    const [first] = await a.push(create('task_occurrence', (({ _id, ...d }) => d)(occurrence('a'))));
    const [second] = await b.push(create('task_occurrence', (({ _id, ...d }) => d)(occurrence('b'))));
    expect(first!.status).toBe('ack');
    expect(second).toMatchObject({ status: 'error', code: 'already_exists' });
    expect(count('SELECT count(*) AS n FROM task_occurrences')).toBe(1);
  });
});

describe('pull: snapshot, delta, retencja', () => {
  it('stronicowany bootstrap podczas równoczesnych zapisów niczego nie pomija', async () => {
    const { a, b } = await devices();
    const lists = Array.from({ length: 12 }, (_, i) => create('shopping_list', { name: `Lista ${i}` }, 'shared'));
    const notes = Array.from({ length: 12 }, (_, i) => create('note', note(`Notatka ${i}`), i % 2 ? 'private' : 'shared'));
    await a.push(...lists, ...notes, ...lists.slice(0, 6).map((l) => create('shopping_item', item(l.entityId))));
    const toPurge = notes[2]!;
    await a.push(versioned('delete', 'note', toPurge.entityId, 1));
    let step = 0;
    const sorted = [...lists].sort((x, y) => x.entityId.localeCompare(y.entityId));
    // Between pages: new records, edits of already-sent ones, delete, restore and a trash purge.
    await b.sync(5, async () => {
      step++;
      if (step === 1) await a.push(update('shopping_list', sorted[0]!.entityId, 1, { name: 'Zmieniona po stronie 1' }), create('note', note('Nowa w trakcie'), 'shared'));
      if (step === 2) await b.push(versioned('delete', 'shopping_list', sorted[1]!.entityId, 1), create('shopping_list', { name: 'Nowa B' }, 'shared', '00000000-0000-4000-8000-000000000000'));
      if (step === 3) { await travel(31 * DAY); sync.maintenance(); }
      if (step === 4) await a.push(create('note', note('Prywatna w trakcie'), 'private'), versioned('restore', 'shopping_list', sorted[1]!.entityId, 2));
    });
    expect(step).toBeGreaterThan(4);
    // After the snapshot the cursor continues from the watermark: all changes arrived.
    await b.sync(5);
    expect(b.records()).toEqual(serverView(B));
    expect(b.local.get(`note:${toPurge.entityId}`)).toMatchObject({ kind: 'tombstone' });
    expect(b.records().find((r) => r.id === sorted[0]!.entityId)!.data).toEqual({ name: 'Zmieniona po stronie 1' });
    expect(b.records().some((r) => r.visibility === 'private')).toBe(false);
    await a.sync(MAX_PULL_PAGE);
    expect(a.records()).toEqual(serverView(A));
  });

  it('kosz w snapshot; delta po edycji; brak zmian = pusta strona z nextCursor', async () => {
    const { a, b } = await devices();
    const shared = create('note', note('W koszu'), 'shared');
    await a.push(shared, versioned('delete', 'note', shared.entityId, 1));
    await b.sync();
    expect(b.records()[0]).toMatchObject({ id: shared.entityId, version: 2 });
    expect(b.records()[0]!.deletedAt).not.toBeNull();
    const empty = await b.pullPage();
    expect(empty).toMatchObject({ status: 'ok', mode: 'delta', changes: [], hasMore: false });
    expect(empty.status === 'ok' && empty.nextCursor.length).toBeGreaterThan(0);
  });

  it('prywatne zapisy partnera nie zmieniają stron, liczników, watermarku ani długości cursora', async () => {
    const { a, b } = await devices();
    await a.push(create('note', note('Wspólna'), 'shared'));
    await b.sync();
    const before = await b.pullPage();
    for (let i = 0; i < 120; i++) await a.push(create('note', note(`Prywatna ${i}`, 'sekret'), 'private'));
    const after = await b.pullPage();
    if (before.status !== 'ok' || after.status !== 'ok') throw new Error('oczekiwano ok');
    expect(after.changes).toEqual([]);
    expect(after.hasMore).toBe(false);
    expect(after.watermark).toBe(before.watermark);
    expect(after.nextCursor.length).toBe(before.nextCursor.length);
    // A fresh bootstrap of B has the same size and watermark as before A's private activity.
    const fresh = new Device(b.cookie);
    await fresh.sync(1);
    expect(fresh.records()).toEqual(b.records());
  });

  it('cursor starszy od retencji lub sprzed przyciętego journala wymaga pełnego snapshotu; obcy/zmieniony cursor odrzucony', async () => {
    const { a, b } = await devices();
    await a.push(create('note', note('Stara'), 'shared'));
    await b.sync();
    const oldCursor = b.cursor!;
    // Journal pruned beyond B's position (e.g. after a long offline period).
    await a.push(create('note', note('Nowsza'), 'shared'));
    sync.store.pruneJournal(new Date(now + 1).toISOString());
    expect(await b.pullPage()).toEqual({ status: 'resync_required', reason: 'cursor_expired' });
    // Bootstrap again: pending outbox lives on the phone; the snapshot has the full state.
    b.cursor = undefined;
    b.local.clear();
    await b.sync();
    expect(b.records()).toEqual(serverView(B));
    // Age limit: a cursor issued more than 90 days ago.
    const fresh = b.cursor!;
    await travel(91 * DAY);
    b.cursor = fresh;
    expect(await b.pullPage()).toEqual({ status: 'resync_required', reason: 'cursor_expired' });
    // Cursors are bound to the account and authenticated.
    a.cursor = fresh;
    expect(await a.pullPage()).toEqual({ status: 'resync_required', reason: 'cursor_invalid' });
    const tampered = oldCursor.slice(0, -2) + (oldCursor.endsWith('A') ? 'BB' : 'AA');
    for (const cursor of [tampered, 'nie-cursor', 'A'.repeat(200)]) {
      b.cursor = cursor;
      expect(await b.pullPage()).toEqual({ status: 'resync_required', reason: 'cursor_invalid' });
    }
    // Retention job: receipts expire after 90 days too, tombstones stay.
    expect(count('SELECT count(*) AS n FROM mutation_receipts')).toBeGreaterThan(0);
    sync.maintenance();
    expect(count('SELECT count(*) AS n FROM mutation_receipts')).toBe(0);
  });

  it('retencja usuwa cały journal: świeży wielostronicowy bootstrap kończy się, kolejny pull to pusta delta, późniejszy zapis dociera', async () => {
    const { a, b } = await devices();
    const list = randomUUID();
    await a.push(create('shopping_list', { name: 'Zakupy' }, 'shared', list), create('shopping_item', item(list, 'Chleb')),
      create('note', note('Wspólna'), 'shared'), create('note', note('Prywatna A', 'sekret'), 'private'));
    await travel(91 * DAY);
    sync.maintenance();
    // The whole journal is gone, the domain records stay; the floor is above zero.
    expect(count('SELECT count(*) AS n FROM sync_changes')).toBe(0);
    expect(sync.store.state().journalFloor).toBeGreaterThan(0);
    expect(serverView(B)).toHaveLength(3);
    // Fresh bootstrap, one record per page: the issued cursors are continuable, no resync loop.
    const fresh = new Device(b.cookie);
    const pages: PullResponse[] = [];
    for (let guard = 0; guard < 10; guard++) {
      const page = await fresh.pullPage(1);
      pages.push(page);
      expect(page.status).toBe('ok');
      if (page.status !== 'ok' || !page.hasMore) break;
    }
    expect(pages).toHaveLength(3);
    expect(fresh.records()).toEqual(serverView(B));
    // The next pull is a valid empty delta, repeatedly.
    for (let i = 0; i < 2; i++) {
      const empty = await fresh.pullPage(1);
      expect(empty).toMatchObject({ status: 'ok', mode: 'delta', changes: [], hasMore: false });
    }
    // A single-page bootstrap after the prune is continuable too.
    const single = new Device(b.cookie);
    await single.sync();
    expect(await single.pullPage()).toMatchObject({ status: 'ok', mode: 'delta', changes: [] });
    // A later write reaches both cursors as a delta (no resync_required).
    const [added] = await a.push(create('note', note('Po retencji'), 'shared'));
    for (const device of [fresh, single]) {
      const page = await device.pullPage(1);
      expect(page).toMatchObject({ status: 'ok', mode: 'delta', hasMore: false });
      expect(device.records()).toEqual(serverView(B));
      expect(device.records().map((r) => r.id)).toContain(recordOf(added!).id);
    }
    expect(sync.store.state().journalFloor).toBeLessThan(sync.records.maxSequence());
  });
});

describe('HTTP: 401/403/409/5xx, payload, zgadywanie ID i list_id', () => {
  it('401 bez sesji, 403 CSRF i hasło tymczasowe, 415 typ treści — dla push i pull', async () => {
    const { a } = await devices();
    const body = { protocolVersion: 2, deviceId: a.deviceId, mutations: [create('note', note('x'), 'private')] };
    const noSession = await app.inject({ method: 'POST', url: '/api/sync/push', headers: json, payload: body });
    expect([noSession.statusCode, noSession.json()]).toEqual([401, { error: 'authentication_required' }]);
    expect((await app.inject({ method: 'GET', url: '/api/sync/pull' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/sync/pull', headers: { cookie: '__Host-razem_session=podrobione' } })).statusCode).toBe(401);
    expect((await a.pushRaw(body, { origin: 'https://evil.test' })).statusCode).toBe(403);
    expect((await a.pushRaw(body, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await a.pushRaw(JSON.stringify(body), { 'content-type': 'text/plain' })).statusCode).toBe(415);
    database.sqlite.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(A_ID);
    expect((await a.pushRaw(body)).json()).toEqual({ error: 'password_change_required' });
    expect((await app.inject({ method: 'GET', url: '/api/sync/pull', headers: { cookie: a.cookie } })).statusCode).toBe(403);
    expect(count('SELECT count(*) AS n FROM notes')).toBe(0);
  });

  it('409 account_mismatch: żądanie sync musi wskazać konto sesji tego samego żądania', async () => {
    const { a, b } = await devices();
    const body = { protocolVersion: 2, deviceId: a.deviceId, mutations: [create('note', note('Prywatna A', 'treść A'), 'private')] };
    // Queue of A sent with B's cookie (cookie switched by a sign-in in another tab).
    const pushWithB = await app.inject({ method: 'POST', url: '/api/sync/push', headers: { ...json, cookie: b.cookie, [SYNC_ACCOUNT_HEADER]: A_ID }, payload: body });
    expect([pushWithB.statusCode, pushWithB.json()]).toEqual([409, { error: 'account_mismatch' }]);
    const noHeader = await app.inject({ method: 'POST', url: '/api/sync/push', headers: { ...json, cookie: a.cookie }, payload: body });
    expect([noHeader.statusCode, noHeader.json()]).toEqual([409, { error: 'account_mismatch' }]);
    expect(count('SELECT count(*) AS n FROM notes')).toBe(0);
    expect(count('SELECT count(*) AS n FROM mutation_receipts')).toBe(0);
    // Pull of B's data into A's database is refused the same way.
    const pullWithB = await app.inject({ method: 'GET', url: '/api/sync/pull', headers: { cookie: b.cookie, [SYNC_ACCOUNT_HEADER]: A_ID } });
    expect([pullWithB.statusCode, pullWithB.json()]).toEqual([409, { error: 'account_mismatch' }]);
    // Bound correctly: accepted.
    expect((await a.push(...body.mutations)).map((r) => r.status)).toEqual(['ack']);
  });

  it('błędny payload: 400 dla koperty, 413 ponad limit, element z błędem nie blokuje pozostałych', async () => {
    const { a } = await devices();
    const ok = create('note', note('Poprawna'), 'private');
    const cases: Array<[unknown, number, string]> = [
      ['{"protocolVersion":1,', 400, 'invalid_request'],
      [{ protocolVersion: 2, mutations: [ok] }, 400, 'invalid_request'],
      [{ protocolVersion: 2, deviceId: 'nie-uuid', mutations: [ok] }, 400, 'invalid_request'],
      [{ protocolVersion: 2, deviceId: a.deviceId, mutations: [] }, 400, 'invalid_request'],
      [{ protocolVersion: 2, deviceId: a.deviceId, mutations: Array.from({ length: 101 }, () => create('note', note('x'), 'private')) }, 400, 'invalid_request'],
      [{ protocolVersion: 2, deviceId: a.deviceId, mutations: [ok, ok] }, 400, 'invalid_request'],
      [{ protocolVersion: 2, deviceId: a.deviceId, mutations: [{ ...ok, clientMutationId: 'x' }] }, 400, 'invalid_request'],
      [{ protocolVersion: 2, deviceId: a.deviceId, mutations: [ok], ownerId: B_ID }, 400, 'invalid_request'],
      [{ protocolVersion: 99, deviceId: a.deviceId, mutations: [ok] }, 400, 'upgrade_required'],
      [{ protocolVersion: 2, deviceId: a.deviceId, mutations: [create('note', note('x'.repeat(200), 'y'.repeat(1_100_000)), 'private')] }, 413, 'payload_too_large'],
    ];
    for (const [payload, status, error] of cases) {
      const response = await a.pushRaw(payload);
      expect([response.statusCode, response.json()], JSON.stringify(payload).slice(0, 80)).toEqual([status, { error }]);
    }
    expect(count('SELECT count(*) AS n FROM notes')).toBe(0);
    // One malformed element gets its own validation_error; valid ones in the batch apply.
    const results = await a.push(
      { ...create('note', note('Zła'), 'private'), command: 'drop' }, create('note', { title: 'x', body: 1 }, 'private'),
      create('calendar_event', { title: 'Zły zakres', description: '', allDay: true, timezone: 'Europe/Warsaw', startDate: '2026-11-05', endDate: '2026-11-05', startAt: null, endAt: null }, 'shared'),
      ok,
    );
    expect(results.map((r) => r.status === 'error' ? r.code : r.status)).toEqual(['validation_error', 'validation_error', 'validation_error', 'ack']);
    // Pull query validation.
    for (const query of ['limit=0', 'limit=201', 'limit=abc', 'cursor=']) {
      expect((await app.inject({ method: 'GET', url: `/api/sync/pull?${query}`, headers: { cookie: a.cookie, ...(await a.accountHeader()) } })).statusCode).toBe(400);
    }
  });

  it('zgadywanie ID prywatnego wpisu partnera daje tę samą odpowiedź co brak rekordu; bez treści', async () => {
    const { a, b } = await devices();
    const priv = create('note', note('Prywatna A', 'sekret syntetyczny A'), 'private');
    const privList = create('shopping_list', { name: 'Prywatna lista A' }, 'private');
    await a.push(priv, privList);
    const missing = randomUUID();
    const strip = (r: PushResponse['results'][number]) => ({ ...r, clientMutationId: undefined, entityId: undefined });
    for (const make of [
      (id: string) => update('note', id, 1, { body: 'przejęte' }), (id: string) => versioned('delete', 'note', id, 1),
      (id: string) => versioned('restore', 'note', id, 1), (id: string) => update('note', id, 7, { title: 'v7' }),
    ]) {
      const [guessed] = await b.push(make(priv.entityId));
      const [absent] = await b.push(make(missing));
      expect(strip(guessed!)).toEqual(strip(absent!));
      expect(guessed).toMatchObject({ status: 'error', code: 'not_found', retryable: false });
    }
    // list_id swap: item under A's private list behaves like a missing list; moving is rejected.
    const [intoPrivate] = await b.push(create('shopping_item', item(privList.entityId)));
    const [intoMissing] = await b.push(create('shopping_item', item(randomUUID())));
    expect(strip(intoPrivate!)).toEqual(strip(intoMissing!));
    expect(intoPrivate).toMatchObject({ status: 'error', code: 'not_found' });
    const sharedList = create('shopping_list', { name: 'Wspólna' }, 'shared');
    const sharedItem = create('shopping_item', item(sharedList.entityId));
    await b.push(sharedList, sharedItem);
    expect((await b.push(update('shopping_item', sharedItem.entityId, 1, { listId: privList.entityId })))[0]).toMatchObject({ status: 'error', code: 'validation_error' });
    expect(sync.records.get(B, 'shopping_item', sharedItem.entityId)).toMatchObject({ visibility: 'shared', data: { listId: sharedList.entityId } });
    expect(count('SELECT count(*) AS n FROM shopping_items WHERE list_id = ?', privList.entityId)).toBe(0);
    // Nothing of A's private records in B's responses, pulls or receipts.
    await b.sync();
    const bReceipts = (database.sqlite.prepare('SELECT result FROM mutation_receipts WHERE user_id = ?').all(B_ID) as Array<{ result: string }>).map((r) => r.result).join();
    for (const text of [JSON.stringify([...b.local.values()]), bReceipts]) {
      expect(text).not.toContain('sekret syntetyczny A');
      expect(text).not.toContain('Prywatna lista A');
    }
    expect(A_ID).toBeTruthy();
  });

  it('409 konfliktu jest wynikiem elementu w odpowiedzi 200; awaria bazy daje 500 bez szczegółów', async () => {
    const { a, b } = await devices();
    const shared = create('note', note('Wspólna'), 'shared');
    await a.push(shared);
    await b.push(update('note', shared.entityId, 1, { body: 'B' }));
    const response = await a.pushRaw({ protocolVersion: 2, deviceId: a.deviceId, mutations: [update('note', shared.entityId, 1, { body: 'A' })] });
    expect(response.statusCode).toBe(200);
    expect(pushResponseSchema.parse(response.json()).results[0]!.status).toBe('conflict');
    database.sqlite.exec(`CREATE TEMP TRIGGER fail_devices BEFORE UPDATE ON devices BEGIN SELECT RAISE(ABORT, 'synthetic sql detail'); END`);
    const broken = await a.pushRaw({ protocolVersion: 2, deviceId: a.deviceId, mutations: [create('note', note('x'), 'private')] });
    expect([broken.statusCode, broken.body]).toEqual([500, JSON.stringify({ error: 'unavailable' })]);
  });
});

it('sync v1 wymaga aktualizacji przed zapisem lub zwróceniem danych; v2 odczytuje stare rekordy', async () => {
  const { a } = await devices();
  const legacy = create('task', { ...task('Stary klient'), recurrence: { frequency: 'daily', interval: 1, startDate: '2026-11-05' } }, 'shared');
  const before = count('SELECT count(*) AS n FROM mutation_receipts');
  const rejected = await a.pushRaw({ protocolVersion: 1, deviceId: a.deviceId, mutations: [legacy] });
  expect(rejected.statusCode).toBe(400); expect(rejected.json()).toEqual({ error: 'upgrade_required' });
  expect(count('SELECT count(*) AS n FROM mutation_receipts')).toBe(before);
  expect(count('SELECT count(*) AS n FROM tasks')).toBe(0);
  for (const protocol of [undefined, '1']) {
    const r = await app.inject({ method: 'GET', url: '/api/sync/pull', headers: { cookie: a.cookie, [SYNC_ACCOUNT_HEADER]: A_ID, ...(protocol ? { 'x-razem-protocol': protocol } : {}) } });
    expect(r.statusCode).toBe(400); expect(r.json()).toEqual({ error: 'upgrade_required' });
  }
  expect((await a.push(legacy))[0]?.status).toBe('ack');
  await a.sync();
  expect(a.records()).toMatchObject([{ data: { title: 'Stary klient', recurrence: { frequency: 'daily' } } }]);
});
