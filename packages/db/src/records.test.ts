import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountScope } from '@razem/contracts';
import { RecordRepository, migrate, openDatabase } from './index.js';
import type { Database, RecordResult } from './index.js';

// Synthetic accounts only; no household member data.
const HASH = '$argon2id$v=19$m=8,t=1,p=1$c3ludGhldGlj$c3ludGhldGlj';
const H = '00000000-0000-4000-8000-000000000001';
const A: AccountScope = { userId: '00000000-0000-4000-8000-0000000000aa', householdId: H };
const B: AccountScope = { userId: '00000000-0000-4000-8000-0000000000bb', householdId: H };
const FOREIGN: AccountScope = { userId: A.userId, householdId: '00000000-0000-4000-8000-0000000000ff' };
let n = 0;
const uuid = () => `30000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const T = '2026-11-04T10:00:00.000Z';

let database: Database;
let repo: RecordRepository;
beforeEach(() => {
  database = openDatabase(':memory:');
  migrate(database.sqlite);
  database.sqlite.prepare('INSERT INTO households VALUES (?, ?, ?, ?)').run(H, 'Syntetyczny dom', 'Europe/Warsaw', T);
  const user = database.sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, 0, ?, ?)');
  user.run(A.userId, H, 'a@example.test', 'Konto A', HASH, T, T);
  user.run(B.userId, H, 'b@example.test', 'Konto B', HASH, T, T);
  let tick = 0;
  repo = new RecordRepository(database, () => new Date(Date.parse(T) + 1000 * tick++));
});
afterEach(() => database.close());

function ack(result: RecordResult) {
  if (result.status !== 'ack') throw new Error(`oczekiwano ack, jest ${JSON.stringify(result)}`);
  return result.record;
}
const NOT_FOUND = { status: 'error', code: 'not_found' };
const INVALID = { status: 'error', code: 'validation_error' };
const note = (title = 'Prywatna notatka A') => ({ title, body: 'sekretna treść syntetyczna' });
const list = (name = 'Zakupy') => ({ name });
const item = (listId: string) => ({ listId, name: 'Mleko', quantity: '1', note: '', checked: false, sortKey: 1 });

describe('serwis uprawnień: konta A/B', () => {
  it('serwer nadaje owner/household/wersję; B czyta wspólne, nie widzi prywatnych A', () => {
    const shared = ack(repo.create(A, { entityType: 'shopping_list', id: uuid(), visibility: 'shared', data: list() }));
    const priv = ack(repo.create(A, { entityType: 'note', id: uuid(), visibility: 'private', data: note() }));
    expect(shared).toMatchObject({ ownerId: A.userId, householdId: H, version: 1, deletedAt: null });
    expect(repo.get(B, 'shopping_list', shared.id)?.data).toEqual({ name: 'Zakupy' });
    expect(repo.get(B, 'note', priv.id)).toBeNull();
    expect(repo.get(A, 'note', priv.id)?.data).toHaveProperty('title', 'Prywatna notatka A');
    expect(repo.list(B, 'note')).toEqual([]);
    expect(repo.list(B, 'shopping_list').map((r) => r.id)).toEqual([shared.id]);
    expect(repo.get(FOREIGN, 'shopping_list', shared.id)).toBeNull();
    // Journal visible to B has no reference to A's private note.
    expect(repo.journalSince(B, 0).map((c) => c.entityId)).toEqual([shared.id]);
    expect(repo.journalSince(A, 0).map((c) => c.entityId)).toEqual([shared.id, priv.id]);
  });

  it('B nie modyfikuje, nie usuwa ani nie przywraca prywatnych A; odpowiedź identyczna jak dla braku', () => {
    const priv = ack(repo.create(A, { entityType: 'note', id: uuid(), visibility: 'private', data: note() }));
    const missing = uuid();
    for (const id of [priv.id, missing]) {
      expect(repo.update(B, { entityType: 'note', id, baseVersion: 1, patch: { title: 'przejęte' } })).toEqual(NOT_FOUND);
      expect(repo.remove(B, { entityType: 'note', id, baseVersion: 1 })).toEqual(NOT_FOUND);
      expect(repo.restore(B, { entityType: 'note', id, baseVersion: 1 })).toEqual(NOT_FOUND);
    }
    // Reusing the ID of A's private record does not reveal or overwrite it.
    expect(repo.create(B, { entityType: 'note', id: priv.id, visibility: 'shared', data: note('kopia B') })).toEqual(NOT_FOUND);
    expect(repo.get(A, 'note', priv.id)).toMatchObject({ version: 1, visibility: 'private', data: { title: 'Prywatna notatka A' } });
  });

  it('podmiana owner_id/household_id/visibility w danych lub patchu jest odrzucana', () => {
    const shared = ack(repo.create(A, { entityType: 'note', id: uuid(), visibility: 'shared', data: note('Wspólna') }));
    for (const extra of [{ ownerId: B.userId }, { householdId: FOREIGN.householdId }, { visibility: 'private' }, { version: 99 }]) {
      expect(repo.create(B, { entityType: 'note', id: uuid(), visibility: 'shared', data: { ...note(), ...extra } })).toEqual(INVALID);
      expect(repo.update(B, { entityType: 'note', id: shared.id, baseVersion: 1, patch: extra })).toEqual(INVALID);
    }
    expect(repo.create(B, { entityType: 'note', id: uuid(), data: note() })).toEqual(INVALID); // visibility is required
    expect(repo.get(A, 'note', shared.id)).toMatchObject({ ownerId: A.userId, visibility: 'shared', version: 1 });
  });

  it('elementy dziedziczą zakres listy; podmiana list_id nie daje dostępu do prywatnej listy partnera', () => {
    const privList = ack(repo.create(A, { entityType: 'shopping_list', id: uuid(), visibility: 'private', data: list('Prywatna A') }));
    const sharedList = ack(repo.create(B, { entityType: 'shopping_list', id: uuid(), visibility: 'shared', data: list() }));
    const privItem = ack(repo.create(A, { entityType: 'shopping_item', id: uuid(), data: item(privList.id) }));
    expect(privItem).toMatchObject({ visibility: 'private', ownerId: A.userId });
    // B guesses the list ID: same response as for a missing list.
    expect(repo.create(B, { entityType: 'shopping_item', id: uuid(), data: item(privList.id) })).toEqual(NOT_FOUND);
    expect(repo.create(B, { entityType: 'shopping_item', id: uuid(), data: item(uuid()) })).toEqual(NOT_FOUND);
    // A child cannot choose its own scope.
    expect(repo.create(A, { entityType: 'shopping_item', id: uuid(), visibility: 'shared', data: item(privList.id) })).toEqual(INVALID);
    const sharedItem = ack(repo.create(A, { entityType: 'shopping_item', id: uuid(), data: item(sharedList.id) }));
    expect(sharedItem).toMatchObject({ visibility: 'shared', householdId: H });
    // Moving an item to another list (e.g. from shared into partner's private) is rejected.
    expect(repo.update(B, { entityType: 'shopping_item', id: sharedItem.id, baseVersion: 1, patch: { listId: privList.id } })).toEqual(INVALID);
    expect(repo.get(B, 'shopping_item', privItem.id)).toBeNull();
    expect(repo.get(B, 'shopping_item', sharedItem.id)?.data).toHaveProperty('name', 'Mleko');
    expect(ack(repo.update(B, { entityType: 'shopping_item', id: sharedItem.id, baseVersion: 1, patch: { checked: true } })).version).toBe(2);
  });

  it('przypomnienie i wystąpienie zadania dziedziczą zakres rodzica; prywatne zadanie tylko self', () => {
    expect(repo.create(A, { entityType: 'task', id: uuid(), visibility: 'private', data: {
      title: 'Prywatne', description: '', assignee: 'partner', dueDate: '2026-11-05', dueAt: null, timezone: 'Europe/Warsaw', completedAt: null, recurrence: null,
    } })).toEqual(INVALID);
    const task = ack(repo.create(A, { entityType: 'task', id: uuid(), visibility: 'private', data: {
      title: 'Prywatne', description: '', assignee: 'self', dueDate: '2026-11-05', dueAt: null, timezone: 'Europe/Warsaw', completedAt: null, recurrence: null,
    } }));
    expect(repo.update(A, { entityType: 'task', id: task.id, baseVersion: 1, patch: { assignee: 'both' } })).toEqual(INVALID);
    const reminder = { targetType: 'task', targetId: task.id, enabled: true, minutesBefore: 0, localTime: '09:00' };
    expect(repo.create(B, { entityType: 'reminder', id: uuid(), data: reminder })).toEqual(NOT_FOUND);
    expect(repo.create(B, { entityType: 'task_occurrence', id: uuid(), data: { taskId: task.id, occurrenceKey: '2026-11-05', completedAt: T } })).toEqual(NOT_FOUND);
    expect(ack(repo.create(A, { entityType: 'reminder', id: uuid(), data: reminder }))).toMatchObject({ visibility: 'private', ownerId: A.userId });
  });

  it('wersje: zła baseVersion daje konflikt, usunięcie i przywrócenie są wersjonowane', () => {
    const shared = ack(repo.create(A, { entityType: 'note', id: uuid(), visibility: 'shared', data: note('Wspólna') }));
    const edited = ack(repo.update(B, { entityType: 'note', id: shared.id, baseVersion: 1, patch: { body: 'B' } }));
    expect(edited.version).toBe(2);
    expect(repo.update(A, { entityType: 'note', id: shared.id, baseVersion: 1, patch: { body: 'A' } })).toMatchObject({ status: 'conflict', record: { version: 2, data: { body: 'B' } } });
    const removed = ack(repo.remove(A, { entityType: 'note', id: shared.id, baseVersion: 2 }));
    expect(removed.deletedAt).not.toBeNull();
    expect(repo.list(B, 'note')).toEqual([]);
    expect(repo.update(B, { entityType: 'note', id: shared.id, baseVersion: 3, patch: { body: 'po usunięciu' } })).toMatchObject({ status: 'conflict' });
    expect(ack(repo.restore(B, { entityType: 'note', id: shared.id, baseVersion: 3 }))).toMatchObject({ version: 4, deletedAt: null });
    expect(repo.journalSince(A, 0).map((c) => c.version)).toEqual([1, 2, 3, 4]);
  });
});

it('zdarzenia przypisań/terminów/ukończeń są atomowe i bez treści; odrzucone zmiany niczego nie emitują', () => {
  const data = { title: 'Tytuł prywatny', description: 'Opis prywatny', assignee: 'self', dueDate: '2026-11-05', dueAt: null, timezone: 'Europe/Warsaw', completedAt: null, recurrence: null };
  const id = uuid();
  const created = ack(repo.create(A, { entityType: 'task', id, visibility: 'private', data }));
  expect(repo.update(A, { entityType: 'task', id, baseVersion: created.version, patch: { assignee: 'partner' } })).toEqual(INVALID);
  const events = () => database.sqlite.prepare('SELECT * FROM task_events ORDER BY sequence').all();
  expect(events()).toHaveLength(2);
  expect(JSON.stringify(events())).not.toContain('Tytuł prywatny');
  expect(JSON.stringify(events())).not.toContain('Opis prywatny');
  ack(repo.update(A, { entityType: 'task', id, baseVersion: 1, patch: { completedAt: T } }));
  expect(repo.update(A, { entityType: 'task', id, baseVersion: 1, patch: { completedAt: '2026-11-04T10:00:01Z' } }).status).toBe('ack');
  expect(events()).toHaveLength(3);
  expect(repo.update(A, { entityType: 'task', id, baseVersion: 1, patch: { title: 'Stara edycja' } }).status).toBe('conflict');
  expect(events()).toHaveLength(3);
  database.sqlite.exec("CREATE TRIGGER fail_task_event BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT, 'test_failure'); END;");
  const before = repo.maxSequence();
  expect(() => repo.update(A, { entityType: 'task', id, baseVersion: 2, patch: { completedAt: null } })).toThrow(/test_failure/);
  expect(repo.get(A, 'task', id)).toMatchObject({ version: 2, data: { completedAt: T } });
  expect(repo.maxSequence()).toBe(before);
  expect(events()).toHaveLength(3);
});
