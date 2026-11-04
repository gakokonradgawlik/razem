// Client data layer against the real server: offline commands, outbox, ACK/rebase,
// conflicts, re-auth, account separation, full resync, tabs, IndexedDB upgrade, quota.
import Dexie from 'dexie';
import { IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localDatabaseName } from '../local-db.js';
import { ACCOUNTS, HOUSEHOLD, Phone, startServer } from './test-harness.js';
import type { Server } from './test-harness.js';
import type { AppController } from './controller.js';
import type { LocalStore } from './store.js';

let server: Server;
const open: AppController[] = [];
beforeEach(async () => { server = await startServer(); });
afterEach(async () => {
  for (const tab of open.splice(0)) await tab.dispose();
  await server.close();
});

async function signedIn(phone: Phone, who: 'a' | 'b', engine = {}) {
  const tab = phone.tab(engine);
  open.push(tab);
  await tab.init();
  const result = await tab.login(ACCOUNTS[who].login, ACCOUNTS[who].password);
  expect(result).toEqual({ ok: true });
  await tab.syncNow();
  return tab;
}
const store = (tab: AppController): LocalStore => tab.store!;
const note = (title: string, body = '') => ({ title, body });
const ok = <T>(result: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!result.ok) throw new Error(`command failed: ${result.reason}`);
  return result.value;
};
const serverRow = (id: string, table = 'notes') => server.database.sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;

describe('lokalna transakcja i kolejka', () => {
  it('rekord i outbox powstają razem; awaria zapisu nie daje sukcesu; restart zachowuje kolejkę', async () => {
    const phone = new Phone(server);
    const tab = await signedIn(phone, 'a');
    phone.setOffline(true);
    const id = ok(await tab.command((s) => s.create('note', note('Lista prezentów', 'szal'), 'private')));
    expect(await store(tab).db.records.get(id)).toMatchObject({ version: 0, data: { title: 'Lista prezentów' } });
    expect(await store(tab).db.queue.toArray()).toEqual([expect.objectContaining({ entityId: id, command: 'create', state: 'pending' })]);

    // Quota error while writing the outbox entry: the whole transaction rolls back.
    const failQueue = () => { throw new DOMException('Brak miejsca', 'QuotaExceededError'); };
    store(tab).db.queue.hook('creating', failQueue);
    const full = await tab.command((s) => s.create('note', note('Nie zapisze się'), 'private'));
    expect(full).toEqual({ ok: false, reason: 'storage_full' });
    expect(tab.getSnapshot().storage).toBe('full');
    expect((await store(tab).db.records.toArray()).map((r) => r.data.title)).toEqual(['Lista prezentów']);
    const editFail = await tab.command((s) => s.update('note', id, { body: 'zmiana bez miejsca' }));
    expect(editFail).toEqual({ ok: false, reason: 'storage_full' });
    expect((await store(tab).db.records.get(id))!.data.body).toBe('szal');
    store(tab).db.queue.hook('creating').unsubscribe(failQueue);

    // The pending data can still be exported (only this account).
    const exported = await store(tab).exportPending(ACCOUNTS.a.login);
    expect(exported.changes).toEqual([expect.objectContaining({ command: 'create', content: { title: 'Lista prezentów', body: 'szal' } })]);
    expect(JSON.stringify(exported)).not.toContain(ACCOUNTS.a.password);

    // "Restart": the tab is gone, a new one opens the same device database offline.
    await tab.dispose(); open.splice(open.indexOf(tab), 1);
    const again = phone.tab(); open.push(again);
    await again.init();
    expect(again.getSnapshot()).toMatchObject({ phase: 'ready', unsent: 1, account: { userId: ACCOUNTS.a.id } });
    phone.setOffline(false);
    await again.syncNow();
    expect(again.getSnapshot()).toMatchObject({ unsent: 0, status: { connection: 'ok' } });
    expect(again.getSnapshot().status.lastAckAt).not.toBeNull();
    expect(serverRow(id)).toMatchObject({ title: 'Lista prezentów', version: 1, owner_id: ACCOUNTS.a.id });
  });

  it('niedostępny magazyn (np. tryb prywatny): stan widoczny, żaden zapis nie udaje sukcesu', async () => {
    const phone = new Phone(server);
    const broken = { open: () => { throw new DOMException('IndexedDB zablokowane', 'SecurityError'); }, deleteDatabase: phone.indexedDB.deleteDatabase.bind(phone.indexedDB), cmp: phone.indexedDB.cmp.bind(phone.indexedDB), databases: async () => [] };
    const { AppController } = await import('./controller.js');
    const { Api } = await import('../api.js');
    const tab = new AppController({ api: new Api(phone.network.fetcher), storage: phone.storage, dbOptions: { indexedDB: broken as unknown as IDBFactory, IDBKeyRange } });
    open.push(tab);
    expect(await tab.login(ACCOUNTS.a.login, ACCOUNTS.a.password)).toEqual({ ok: false, reason: 'storage_unavailable' });
    expect(tab.getSnapshot()).toMatchObject({ phase: 'storage_unavailable', storage: 'unavailable' });
    expect(await tab.command((s) => s.create('note', note('x'), 'private'))).toEqual({ ok: false, reason: 'storage_unavailable' });
  });

  it('zła treść nie trafia do kolejki; dziecko dziedziczy widoczność rodzica', async () => {
    const tab = await signedIn(new Phone(server), 'a');
    expect(await tab.command((s) => s.create('note', { title: '' , body: '' }, 'private'))).toEqual({ ok: false, reason: 'invalid' });
    const list = ok(await tab.command((s) => s.create('shopping_list', { name: 'Apteka' }, 'private')));
    const item = ok(await tab.command((s) => s.create('shopping_item', { listId: list, name: 'Witamina D', quantity: '', note: '', checked: false, sortKey: 1 })));
    expect(await store(tab).db.records.get(item)).toMatchObject({ visibility: 'private', ownerId: ACCOUNTS.a.id, parentId: list });
    expect(await tab.command((s) => s.update('shopping_item', item, { listId: crypto.randomUUID() }))).toEqual({ ok: false, reason: 'invalid' });
    expect(await store(tab).db.queue.count()).toBe(2);
  });
});

describe('dwa telefony offline', () => {
  it('tworzą i zmieniają dane offline, po powrocie zbiegają się bez duplikatów', async () => {
    const phoneA = new Phone(server), phoneB = new Phone(server);
    const a = await signedIn(phoneA, 'a'), b = await signedIn(phoneB, 'b');
    const list = ok(await a.command((s) => s.create('shopping_list', { name: 'Sobota' }, 'shared')));
    await a.syncNow(); await b.syncNow();
    expect((await store(b).list('shopping_list')).map((r) => r.data.name)).toEqual(['Sobota']);

    phoneA.setOffline(true); phoneB.setOffline(true);
    const milk = ok(await a.command((s) => s.create('shopping_item', { listId: list, name: 'Mleko', quantity: '2 l', note: '', checked: false, sortKey: 1 })));
    ok(await a.command((s) => s.update('shopping_item', milk, { quantity: '3 l' })));
    ok(await a.command((s) => s.update('shopping_item', milk, { checked: true })));
    ok(await a.command((s) => s.update('shopping_list', list, { name: 'Sobota – Biedronka' })));
    ok(await a.command((s) => s.update('shopping_list', list, { name: 'Sobota – Biedronka i targ' })));
    const bread = ok(await b.command((s) => s.create('shopping_item', { listId: list, name: 'Chleb', quantity: '', note: '', checked: false, sortKey: 2 })));
    const privateNote = ok(await b.command((s) => s.create('note', note('Tylko moje'), 'private')));
    await a.syncNow(); await b.syncNow();
    expect(a.getSnapshot().status.connection).toBe('offline');
    expect(a.getSnapshot().unsent).toBe(5);

    phoneA.setOffline(false); phoneB.setOffline(false);
    // Timeout after commit: the server applied A's first batch but the answer is lost.
    phoneA.network.losePushResponses = 1;
    await a.syncNow();
    expect(a.getSnapshot().status.connection).toBe('server_unavailable');
    expect(a.getSnapshot().unsent).toBeGreaterThan(0);
    await a.syncNow(); await b.syncNow(); await a.syncNow();

    for (const tab of [a, b]) {
      expect(tab.getSnapshot()).toMatchObject({ unsent: 0, attention: 0 });
      const items = (await store(tab).list('shopping_item', list)).map((r) => [r.data.name, r.data.quantity, r.data.checked, r.version]).sort();
      expect(items).toEqual([['Chleb', '', false, 1], ['Mleko', '3 l', true, 3]]);
      expect((await store(tab).get(list))!.data.name).toBe('Sobota – Biedronka i targ');
      expect((await store(tab).get(list))!.version).toBe(3);
    }
    expect(server.count('shopping_items')).toBe(2);
    expect(serverRow(milk, 'shopping_items')).toMatchObject({ version: 3, quantity: '3 l' });
    expect(serverRow(bread, 'shopping_items')).toMatchObject({ version: 1 });
    // A replayed mutation ID (lost answer) never produced a second effect.
    const sent = server.pushes.flat();
    expect(sent.length).toBeGreaterThan(new Set(sent).size);
    // The partner's private note never reaches A.
    expect(await store(a).get(privateNote)).toBeUndefined();
    expect(await store(a).db.records.get(privateNote)).toBeUndefined();
  });
});

describe('konflikty', () => {
  async function sharedNote() {
    const phoneA = new Phone(server), phoneB = new Phone(server);
    const a = await signedIn(phoneA, 'a'), b = await signedIn(phoneB, 'b');
    const id = ok(await a.command((s) => s.create('note', note('Plan wakacji', 'Góry'), 'shared')));
    await a.syncNow(); await b.syncNow();
    return { phoneA, phoneB, a, b, id };
  }

  it('pokazuje obie wersje; scalenie i ponowne sprawdzenie wersji', async () => {
    const { phoneB, a, b, id } = await sharedNote();
    phoneB.setOffline(true);
    ok(await a.command((s) => s.update('note', id, { body: 'Góry, Tatry' })));
    await a.syncNow();
    ok(await b.command((s) => s.update('note', id, { body: 'Góry, Bieszczady' })));
    // Pull of the new server version does not overwrite B's dirty record.
    phoneB.setOffline(false);
    await b.syncNow();
    expect(b.getSnapshot().attention).toBe(1);
    const [item] = await store(b).attention();
    expect(item).toMatchObject({ kind: 'conflict', entityId: id, title: 'Plan wakacji' });
    const conflict = (await store(b).conflict(item!.id))!;
    expect(conflict.local!.data.body).toBe('Góry, Bieszczady');
    expect(conflict.server).toMatchObject({ kind: 'record', record: { version: 2, data: { body: 'Góry, Tatry' } } });
    expect(conflict.base).toMatchObject({ kind: 'record', record: { version: 1 } });
    expect((await store(b).get(id))!.data.body).toBe('Góry, Bieszczady');
    expect(await b.command((s) => s.update('note', id, { body: 'x' }))).toEqual({ ok: false, reason: 'conflict_open' });

    // Merge, but A changes the note again before B sends it → a new, visible conflict.
    ok(await b.command((s) => s.resolve(conflict.id, { choice: 'merge', data: { title: 'Plan wakacji', body: 'Tatry, potem Bieszczady' } })));
    ok(await a.command((s) => s.update('note', id, { title: 'Plan wakacji 2027' })));
    await a.syncNow();
    await b.syncNow();
    const [second] = await store(b).attention();
    expect(second).toMatchObject({ kind: 'conflict' });
    const again = (await store(b).conflict(second!.id))!;
    expect(again.server).toMatchObject({ record: { version: 3, data: { title: 'Plan wakacji 2027' } } });
    expect(again.local!.data.body).toBe('Tatry, potem Bieszczady');
    ok(await b.command((s) => s.resolve(again.id, { choice: 'merge', data: { title: 'Plan wakacji 2027', body: 'Tatry, potem Bieszczady' } })));
    await b.syncNow(); await a.syncNow();
    expect(serverRow(id)).toMatchObject({ version: 4, title: 'Plan wakacji 2027', body: 'Tatry, potem Bieszczady' });
    expect((await store(a).get(id))!.data).toEqual({ title: 'Plan wakacji 2027', body: 'Tatry, potem Bieszczady' });
    expect(b.getSnapshot()).toMatchObject({ unsent: 0, attention: 0 });
  });

  it('usunięcie kontra edycja zachowuje treść; przywrócenie z moją wersją', async () => {
    const { phoneB, a, b, id } = await sharedNote();
    phoneB.setOffline(true);
    ok(await a.command((s) => s.remove('note', id)));
    await a.syncNow();
    ok(await b.command((s) => s.update('note', id, { body: 'Ważna treść dopisana offline' })));
    phoneB.setOffline(false);
    await b.syncNow();
    const [item] = await store(b).attention();
    const conflict = (await store(b).conflict(item!.id))!;
    expect(conflict.server).toMatchObject({ kind: 'record', record: { deletedAt: expect.any(String) } });
    expect(conflict.local!.data.body).toBe('Ważna treść dopisana offline');
    // Not silently resurrected: the server record stays in the trash until B decides.
    expect(serverRow(id)!.deleted_at).not.toBeNull();
    ok(await b.command((s) => s.resolve(conflict.id, { choice: 'mine' })));
    await b.syncNow(); await a.syncNow();
    expect(serverRow(id)).toMatchObject({ deleted_at: null, body: 'Ważna treść dopisana offline' });
    expect((await store(a).get(id))!.deletedAt).toBeNull();
  });

  it('lokalne usunięcie kontra zdalna edycja: wybór wersji z serwera zachowuje wpis', async () => {
    const { phoneB, a, b, id } = await sharedNote();
    phoneB.setOffline(true);
    ok(await a.command((s) => s.update('note', id, { body: 'Nowa treść A' })));
    await a.syncNow();
    ok(await b.command((s) => s.remove('note', id)));
    expect(await store(b).list('note')).toEqual([]);
    phoneB.setOffline(false);
    await b.syncNow();
    const [item] = await store(b).attention();
    ok(await b.command((s) => s.resolve(item!.id, { choice: 'server' })));
    expect((await store(b).get(id))).toMatchObject({ deletedAt: null, data: { body: 'Nowa treść A' } });
    await b.syncNow();
    expect(serverRow(id)).toMatchObject({ deleted_at: null, version: 2 });
  });

  it('wpis trwale usunięty (tombstone) nie wraca; moja treść może zostać nowym wpisem', async () => {
    const { phoneB, a, b, id } = await sharedNote();
    phoneB.setOffline(true);
    ok(await a.command((s) => s.remove('note', id)));
    await a.syncNow();
    ok(await b.command((s) => s.update('note', id, { body: 'Dopisane po 31 dniach' })));
    server.clock.now += 31 * 86_400_000;
    server.sync.maintenance();
    expect(serverRow(id)).toBeUndefined();
    phoneB.setOffline(false);
    // Sessions expired after 31 days: B keeps the queue and signs in again.
    await b.syncNow();
    expect(b.getSnapshot()).toMatchObject({ status: { connection: 'auth_required' }, unsent: 1 });
    expect(await b.login(ACCOUNTS.b.login, ACCOUNTS.b.password)).toEqual({ ok: true });
    await b.syncNow();
    const [item] = await store(b).attention();
    const conflict = (await store(b).conflict(item!.id))!;
    expect(conflict.server.kind).toBe('tombstone');
    ok(await b.command((s) => s.resolve(conflict.id, { choice: 'mine' })));
    await b.syncNow();
    const notes = await store(b).list('note');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.id).not.toBe(id);
    expect(notes[0]!.data.body).toBe('Dopisane po 31 dniach');
    expect(serverRow(notes[0]!.id)).toMatchObject({ version: 1 });
  });

  it('to samo odhaczenie na obu telefonach nie tworzy konfliktu', async () => {
    const phoneA = new Phone(server), phoneB = new Phone(server);
    const a = await signedIn(phoneA, 'a'), b = await signedIn(phoneB, 'b');
    const list = ok(await a.command((s) => s.create('shopping_list', { name: 'Dom' }, 'shared')));
    const item = ok(await a.command((s) => s.create('shopping_item', { listId: list, name: 'Kawa', quantity: '', note: '', checked: false, sortKey: 1 })));
    await a.syncNow(); await b.syncNow();
    phoneB.setOffline(true);
    ok(await a.command((s) => s.update('shopping_item', item, { checked: true })));
    ok(await b.command((s) => s.update('shopping_item', item, { checked: true })));
    await a.syncNow();
    phoneB.setOffline(false);
    await b.syncNow();
    expect(b.getSnapshot()).toMatchObject({ unsent: 0, attention: 0 });
    expect((await store(b).get(item))).toMatchObject({ version: 2, data: { checked: true } });
  });
});

describe('sesja i konta', () => {
  it('401 i niedostępny serwer zachowują kolejkę; ponowne logowanie wysyła; inne konto jej nie widzi', async () => {
    const phone = new Phone(server);
    const tab = await signedIn(phone, 'a');
    // Server down (proxy 502) and a timeout: nothing lost, no false "synced".
    phone.network.outage = 502;
    const id = ok(await tab.command((s) => s.create('note', note('Hasło do wifi u rodziców'), 'private')));
    await tab.syncNow();
    expect(tab.getSnapshot()).toMatchObject({ unsent: 1, status: { connection: 'server_unavailable' } });
    phone.network.outage = null; phone.network.timeout = true;
    await tab.syncNow();
    expect(tab.getSnapshot()).toMatchObject({ unsent: 1, status: { connection: 'server_unavailable' } });
    phone.network.timeout = false;

    // Session revoked on the server → 401: the queue waits for a sign-in.
    server.database.sqlite.prepare('DELETE FROM sessions WHERE user_id = ?').run(ACCOUNTS.a.id);
    await tab.syncNow();
    expect(tab.getSnapshot()).toMatchObject({ unsent: 1, status: { connection: 'auth_required' } });
    expect(serverRow(id)).toBeUndefined();

    // Partner signs in on the same device: own empty database, does not see or send A's queue.
    expect(await tab.login(ACCOUNTS.b.login, ACCOUNTS.b.password)).toEqual({ ok: true });
    await tab.syncNow();
    expect(tab.getSnapshot()).toMatchObject({ account: { userId: ACCOUNTS.b.id }, unsent: 0 });
    expect(await store(tab).db.records.count()).toBe(0);
    expect(serverRow(id)).toBeUndefined();
    expect(store(tab).db.name).toBe(localDatabaseName({ userId: ACCOUNTS.b.id, householdId: HOUSEHOLD }));

    // A again: the same queue goes out once.
    expect(await tab.login(ACCOUNTS.a.login, ACCOUNTS.a.password)).toEqual({ ok: true });
    await tab.syncNow();
    expect(tab.getSnapshot()).toMatchObject({ account: { userId: ACCOUNTS.a.id }, unsent: 0, status: { connection: 'ok' } });
    expect(serverRow(id)).toMatchObject({ owner_id: ACCOUNTS.a.id, visibility: 'private' });
  });

  it('kolejka nie jest wysyłana sesją innego konta (logowanie w innej karcie)', async () => {
    const phone = new Phone(server);
    const tabA = await signedIn(phone, 'a');
    phone.setOffline(true);
    const id = ok(await tabA.command((s) => s.create('note', note('Prywatne A'), 'private')));
    phone.setOffline(false);
    // Another tab signs in as B: the browser's cookie now belongs to B.
    await phone.network.fetcher('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: ACCOUNTS.b.login, password: ACCOUNTS.b.password }) });
    await tabA.syncNow();
    expect(serverRow(id)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tabA.getSnapshot().account?.userId).toBe(ACCOUNTS.b.id);
    expect(await store(tabA).get(id)).toBeUndefined();
  });

  it('wylogowanie z oczekującymi zmianami wymaga decyzji, potem czyści dane konta', async () => {
    const phone = new Phone(server);
    const tab = await signedIn(phone, 'a');
    phone.network.outage = 503;
    ok(await tab.command((s) => s.create('note', note('Niewysłana'), 'private')));
    phone.network.outage = null;
    expect(await tab.logout({ discardPending: false })).toEqual({ ok: false, reason: 'pending_changes' });
    phone.setOffline(true);
    expect(await tab.logout({ discardPending: true })).toEqual({ ok: false, reason: 'unavailable' });
    phone.setOffline(false);
    expect(await tab.logout({ discardPending: true })).toEqual({ ok: true });
    expect(tab.getSnapshot()).toMatchObject({ phase: 'signed_out', account: null });
    expect(phone.storage.getItem('razem:account')).toBeNull();
    const databases = await phone.indexedDB.databases();
    expect(databases.map((d) => d.name)).not.toContain(localDatabaseName({ userId: ACCOUNTS.a.id, householdId: HOUSEHOLD }));
  });
});

describe('pełna resynchronizacja, stronicowanie, karty i migracja', () => {
  it('stronicowany bootstrap z zapisem w trakcie stronicowania nie gubi zmian', async () => {
    const phoneA = new Phone(server), phoneB = new Phone(server);
    const a = await signedIn(phoneA, 'a');
    for (let n = 1; n <= 9; n++) ok(await a.command((s) => s.create('note', note(`Wspólna ${n}`), 'shared')));
    await a.syncNow();
    let pulls = 0;
    phoneB.network.beforePull = async () => {
      // Between snapshot pages 2 and 3: a write the snapshot itself does not contain.
      if (++pulls !== 3) return;
      ok(await a.command((s) => s.create('note', note('Dodana podczas stronicowania'), 'shared')));
      await a.syncNow();
    };
    const b = await signedIn(phoneB, 'b', { pullLimit: 2 });
    phoneB.network.beforePull = null;
    const titles = (await store(b).list('note')).map((r) => r.data.title).sort();
    expect(titles).toHaveLength(10);
    expect(titles).toContain('Dodana podczas stronicowania');
    expect(phoneB.network.requests.filter((r) => r.startsWith('GET /api/sync/pull')).length).toBeGreaterThanOrEqual(6);
  });

  it('nieważny cursor → pełny resync zachowuje oczekujące zmiany i konflikty, usuwa nieaktualny cache', async () => {
    const phone = new Phone(server);
    const tab = await signedIn(phone, 'a');
    const kept = ok(await tab.command((s) => s.create('note', note('Na serwerze'), 'shared')));
    await tab.syncNow();
    const stale = { ...(await store(tab).db.records.get(kept))!, id: crypto.randomUUID(), data: { title: 'Już niewidoczny', body: '' }, version: 4 };
    await store(tab).db.records.put(stale);
    phone.network.outage = 503;
    const pending = ok(await tab.command((s) => s.create('note', note('Czeka na wysłanie'), 'private')));
    phone.network.outage = null;
    await store(tab).setMeta('cursor', 'nieprawidlowy-cursor');
    await tab.syncNow();
    expect(await store(tab).db.records.get(stale.id)).toBeUndefined();
    expect(await store(tab).get(kept)).toBeDefined();
    expect(serverRow(pending)).toMatchObject({ title: 'Czeka na wysłanie' });
    expect(await store(tab).getMeta('snapshotActive')).toBe(false);
    expect(tab.getSnapshot()).toMatchObject({ unsent: 0, status: { connection: 'ok' } });

    // Resync while a change is still queued: kept and sent afterwards.
    phone.setOffline(true);
    ok(await tab.command((s) => s.update('note', kept, { body: 'edytowane offline' })));
    phone.setOffline(false);
    await store(tab).beginSnapshot();
    await tab.syncNow();
    expect(serverRow(kept)).toMatchObject({ body: 'edytowane offline', version: 2 });
  });

  it('dwie karty: jedna kolejka naraz, bez podwójnej wysyłki; druga widzi wynik (Web Locks i lease)', async () => {
    for (const locks of [undefined, null] as const) {
      const phone = new Phone(server);
      const first = await signedIn(phone, 'a', locks === null ? { locks: null } : {});
      const second = phone.tab(locks === null ? { locks: null } : {}); open.push(second);
      await second.init();
      phone.setOffline(true);
      const ids = [] as string[];
      for (let n = 0; n < 5; n++) ids.push(ok(await (n % 2 ? first : second).command((s) => s.create('note', note(`Karta ${n}`), 'private'))));
      phone.setOffline(false);
      server.pushes.length = 0;
      const outcomes = await Promise.all([first.engine!.sync(), second.engine!.sync(), first.engine!.sync()]);
      expect(outcomes).toContain('done');
      const sent = server.pushes.flat();
      expect(new Set(sent).size).toBe(sent.length);
      await first.syncNow(); await second.syncNow();
      for (const id of ids) expect(serverRow(id)).toMatchObject({ version: 1 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(second.getSnapshot()).toMatchObject({ unsent: 0, status: { connection: 'ok' } });
      await first.logout({ discardPending: true });
    }
  });

  it('upgrade IndexedDB v1 → v2 zachowuje oczekujące zmiany, deviceId i cursor', async () => {
    const phone = new Phone(server);
    const scope = { userId: ACCOUNTS.a.id, householdId: HOUSEHOLD };
    const legacy = new Dexie(localDatabaseName(scope), { indexedDB: phone.indexedDB, IDBKeyRange });
    legacy.version(1).stores({ records: 'id, entityType, visibility', outbox: 'mutation.clientMutationId, queuedAt, state', conflicts: 'id', cursors: 'key' });
    const deviceId = crypto.randomUUID(), noteId = crypto.randomUUID(), mutationId = crypto.randomUUID();
    const now = new Date().toISOString();
    await legacy.table('records').put({ id: noteId, entityType: 'note', householdId: HOUSEHOLD, ownerId: ACCOUNTS.a.id, visibility: 'private', version: 0, createdAt: now, updatedAt: now, deletedAt: null, data: { title: 'Sprzed aktualizacji', body: '' } });
    await legacy.table('outbox').put({ deviceId, queuedAt: now, attempts: 2, state: 'pending', mutation: { clientMutationId: mutationId, entityId: noteId, entityType: 'note', command: 'create', baseVersion: 0, visibility: 'private', data: { title: 'Sprzed aktualizacji', body: '' } } });
    legacy.close();

    const tab = phone.tab(); open.push(tab);
    expect(await tab.login(ACCOUNTS.a.login, ACCOUNTS.a.password)).toEqual({ ok: true });
    expect(await store(tab).deviceId()).toBe(deviceId);
    expect(await store(tab).db.queue.toArray()).toEqual([expect.objectContaining({ clientMutationId: mutationId, attempts: 2, baseVersion: 0 })]);
    await tab.syncNow();
    expect(serverRow(noteId)).toMatchObject({ title: 'Sprzed aktualizacji', version: 1 });
    expect(server.pushes.flat()).toContain(mutationId);
    expect(tab.getSnapshot().unsent).toBe(0);
  });

  it('odrzucona zmiana (walidacja serwera) czeka na decyzję zamiast pętli retry', async () => {
    const phone = new Phone(server);
    const tab = await signedIn(phone, 'a');
    const id = ok(await tab.command((s) => s.create('note', note('Poprawna'), 'shared')));
    await tab.syncNow();
    // A queued entry the server rejects (not_found): simulated by an entity unknown to the server.
    await store(tab).db.queue.add({ clientMutationId: crypto.randomUUID(), entityType: 'note', entityId: crypto.randomUUID(), parentId: null, command: 'update', patch: { body: 'x' }, baseVersion: 1, queuedAt: new Date().toISOString(), attempts: 0, state: 'pending' });
    ok(await tab.command((s) => s.update('note', id, { body: 'dalej działa' })));
    await tab.syncNow();
    const items = await store(tab).attention();
    expect(items).toEqual([expect.objectContaining({ kind: 'rejected', error: 'not_found' })]);
    expect(serverRow(id)).toMatchObject({ body: 'dalej działa' });
    const before = server.pushes.length;
    await tab.syncNow();
    expect(server.pushes.length).toBe(before);
    ok(await tab.command((s) => s.discardRejected(items[0]!.id)));
    expect(tab.getSnapshot().attention).toBe(0);
  });
});
