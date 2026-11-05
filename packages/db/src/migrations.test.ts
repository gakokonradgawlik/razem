import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, MigrationError, assertSchemaCurrent, migrate, migrationStatus, migrations, openDatabase, schema } from './index.js';
import type { Database } from './index.js';

const HASH = '$argon2id$v=19$m=8,t=1,p=1$c3ludGhldGlj$c3ludGhldGlj';
const H = '00000000-0000-4000-8000-000000000001';
const A = '00000000-0000-4000-8000-0000000000aa';
const B = '00000000-0000-4000-8000-0000000000bb';
const C = '00000000-0000-4000-8000-0000000000cc';
const T = '2026-11-04T10:00:00.000Z';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'razem-mig-'));
  const path = join(dir, 'razem.sqlite');
  const handle = { db: openDatabase(path), path, dir };
  cleanup.push(() => { try { handle.db.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); });
  return handle;
}
function seedAccounts(db: Database) {
  db.sqlite.prepare('INSERT INTO households VALUES (?, ?, ?, ?)').run(H, 'Syntetyczny dom', 'Europe/Warsaw', T);
  const user = db.sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, 1, ?, ?)');
  user.run(A, H, 'a@example.test', 'Konto A', HASH, T, T);
  user.run(B, H, 'b@example.test', 'Konto B', HASH, T, T);
  db.sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)').run(C, A, 'a'.repeat(64), T, T, '2026-12-04T10:00:00.000Z');
}

describe('migracje', () => {
  it('od zera: wszystkie tabele, WAL/FK/busy_timeout, plik 0600 i katalog 0700', () => {
    const { db, path, dir } = tempDb();
    rmSync(dir, { recursive: true }); // openDatabase must create a missing persistent directory itself
    db.close();
    const fresh = openDatabase(path);
    cleanup.push(() => fresh.close());
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(migrate(fresh.sqlite)).toEqual({ applied: migrations.map((m) => m.version) });
    expect(fresh.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(fresh.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(fresh.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(migrationStatus(fresh.sqlite)).toEqual({ current: LATEST_SCHEMA_VERSION, latest: LATEST_SCHEMA_VERSION, pending: [] });
    expect(migrate(fresh.sqlite).applied).toEqual([]);
    expect(() => assertSchemaCurrent(fresh.sqlite)).not.toThrow();
  });

  it('schemat Drizzle odpowiada kolumnom utworzonym przez migracje', () => {
    const { db } = tempDb();
    migrate(db.sqlite);
    for (const table of Object.values(schema).filter((v) => typeof v === 'object' && v !== null && Symbol.for('drizzle:IsDrizzleTable') in v)) {
      const t = table as Parameters<typeof getTableName>[0];
      const actual = (db.sqlite.prepare(`PRAGMA table_info(${getTableName(t)})`).all() as Array<{ name: string }>).map((c) => c.name).sort();
      const expected = Object.values(getTableColumns(t)).map((c) => c.name).sort();
      expect(actual, getTableName(t)).toEqual(expected);
    }
  });

  it('aktualizacja istniejącej bazy v1 zachowuje dane, FK i wersje oraz tworzy kopię 0600', () => {
    const { db, path, dir } = tempDb();
    migrate(db.sqlite, { list: migrations.slice(0, 1) });
    seedAccounts(db);
    db.close();
    const reopened = openDatabase(path);
    cleanup.push(() => reopened.close());
    expect(migrationStatus(reopened.sqlite).pending).toEqual([2, 3, 4, 5]);
    const backup = join(dir, 'pre-v1.sqlite');
    const result = migrate(reopened.sqlite, { backupPath: (v) => join(dir, `pre-v${v}.sqlite`) });
    expect(result).toEqual({ applied: [2, 3, 4, 5], backup });
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(reopened.sqlite.prepare('SELECT id, login FROM users ORDER BY login').all()).toEqual([{ id: A, login: 'a@example.test' }, { id: B, login: 'b@example.test' }]);
    expect(reopened.sqlite.prepare('SELECT user_id FROM sessions').get()).toEqual({ user_id: A });
    expect(reopened.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(reopened.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    expect((reopened.sqlite.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map((r) => r.version)).toEqual([1, 2, 3, 4, 5]);
    // The member limit survives the upgrade.
    expect(() => reopened.sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(C, H, 'c@example.test', 'Trzecie', HASH, T, T)).toThrow(/member_limit/);
    // The copy is a consistent v1 database with the same rows.
    const copy = openDatabase(backup);
    cleanup.push(() => copy.close());
    expect(migrationStatus(copy.sqlite).current).toBe(1);
    expect(copy.sqlite.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 2 });
  });

  it('aktualizacja v2 → v3 (RAZ-4) zachowuje rekordy i journal, tworzy klucz cursora i blokadę wskrzeszenia', () => {
    const { db, dir } = tempDb();
    migrate(db.sqlite, { list: migrations.slice(0, 2) });
    seedAccounts(db);
    const N = '30000000-0000-4000-8000-000000000001';
    db.sqlite.prepare("INSERT INTO notes VALUES (?, ?, ?, 'private', 1, ?, ?, NULL, 'Syntetyczna', '')").run(N, H, A, T, T);
    db.sqlite.prepare("INSERT INTO sync_changes (entity_type, entity_id, household_id, owner_id, visibility, version, changed_at) VALUES ('note', ?, ?, ?, 'private', 1, ?)").run(N, H, A, T);
    const result = migrate(db.sqlite, { backupPath: (v) => join(dir, `pre-v${v}.sqlite`) });
    expect(result.applied).toEqual([3, 4, 5]);
    expect(db.sqlite.prepare('SELECT id, version FROM notes').all()).toEqual([{ id: N, version: 1 }]);
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM sync_changes').get()).toEqual({ n: 1 });
    const state = db.sqlite.prepare('SELECT cursor_key, journal_floor FROM sync_state').all() as Array<{ cursor_key: string; journal_floor: number }>;
    expect(state).toHaveLength(1);
    expect(state[0]!.cursor_key).toMatch(/^[0-9a-f]{64}$/);
    expect(state[0]!.journal_floor).toBe(0);
    expect(() => db.sqlite.prepare('INSERT INTO sync_state VALUES (2, ?, 0)').run('0'.repeat(64))).toThrow(/CHECK/);
    expect(() => db.sqlite.prepare('UPDATE sync_state SET journal_floor = -1').run()).toThrow();
    db.sqlite.prepare("INSERT INTO tombstones VALUES ('note', ?, ?, ?, 'private', 2, ?, ?)").run(N.replace('1', '2'), H, A, T, T);
    expect(() => db.sqlite.prepare("INSERT INTO notes VALUES (?, ?, ?, 'private', 1, ?, ?, NULL, 'x', '')").run(N.replace('1', '2'), H, A, T, T)).toThrow(/tombstoned/);
    expect(() => db.sqlite.prepare('UPDATE tombstones SET version = 3').run()).toThrow(/immutable_field/);
    expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
    // Each installation gets its own random cursor key.
    const other = tempDb();
    migrate(other.db.sqlite);
    expect((other.db.sqlite.prepare('SELECT cursor_key FROM sync_state').get() as { cursor_key: string }).cursor_key).not.toBe(state[0]!.cursor_key);
  });

  it('baza fundamentu RAZ-1 (bez tabel) przechodzi na najnowszy schemat', () => {
    const { db } = tempDb();
    db.sqlite.exec("CREATE TABLE fixture (id TEXT PRIMARY KEY); INSERT INTO fixture VALUES ('synthetic')");
    migrate(db.sqlite);
    expect(db.sqlite.prepare('SELECT id FROM fixture').get()).toEqual({ id: 'synthetic' });
    expect(migrationStatus(db.sqlite).current).toBe(LATEST_SCHEMA_VERSION);
  });

  it('błędna migracja wycofuje się w całości; zmieniona lub nieznana historia blokuje start', () => {
    const { db } = tempDb();
    migrate(db.sqlite, { list: migrations.slice(0, 1) });
    seedAccounts(db);
    const broken = [...migrations.slice(0, 1), { version: 2, name: 'broken', sql: 'CREATE TABLE half (id TEXT); INSERT INTO missing VALUES (1);' }];
    expect(() => migrate(db.sqlite, { list: broken })).toThrow();
    expect(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeUndefined();
    expect(migrationStatus(db.sqlite).current).toBe(1);
    const fkBreaking = [...migrations.slice(0, 1), { version: 2, name: 'fk', sql: `PRAGMA defer_foreign_keys = ON; CREATE TABLE orphan (user_id TEXT REFERENCES users(id)); INSERT INTO orphan VALUES ('missing');` }];
    expect(() => migrate(db.sqlite, { list: fkBreaking })).toThrow(/klucze obce/);
    expect(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'orphan'").get()).toBeUndefined();
    migrate(db.sqlite);
    expect(migrationStatus(db.sqlite).current).toBe(LATEST_SCHEMA_VERSION);
    db.sqlite.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 2').run('0'.repeat(64));
    expect(() => migrate(db.sqlite)).toThrow(/Suma kontrolna/);
    expect(() => migrationStatus(db.sqlite)).toThrow(MigrationError);
    db.sqlite.prepare("INSERT INTO schema_migrations VALUES (99, 'future', 'x', ?)").run(T);
    expect(() => assertSchemaCurrent(db.sqlite)).toThrow(MigrationError);
  });

  it('nie nadpisuje istniejącej kopii przed migracją', () => {
    const { db, dir } = tempDb();
    migrate(db.sqlite, { list: migrations.slice(0, 1) });
    const target = join(dir, 'exists.sqlite');
    migrate(db.sqlite, { list: migrations.slice(0, 1) }); // no-op
    db.sqlite.prepare('VACUUM INTO ?').run(target);
    expect(() => migrate(db.sqlite, { backupPath: () => target })).toThrow(/już istnieje/);
    expect(existsSync(target)).toBe(true);
    expect(migrationStatus(db.sqlite).current).toBe(1);
  });
});

describe('ograniczenia bazy', () => {
  function ready() { const { db } = tempDb(); migrate(db.sqlite); seedAccounts(db); return db; }
  const insertList = (db: Database, id: string, owner: string, visibility: string) =>
    db.sqlite.prepare('INSERT INTO shopping_lists VALUES (?, ?, ?, ?, 1, ?, ?, NULL, ?)').run(id, H, owner, visibility, T, T, 'Lista');
  const L1 = '10000000-0000-4000-8000-000000000001';
  const I1 = '20000000-0000-4000-8000-000000000001';

  it('jedno gospodarstwo, dwóch członków, niezmienne przypisanie i brak usuwania kont', () => {
    const db = ready();
    expect(() => db.sqlite.prepare('INSERT INTO households VALUES (?, ?, ?, ?)').run(C, 'Drugi', 'Europe/Warsaw', T)).toThrow(/household_limit/);
    expect(() => db.sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(C, H, 'c@example.test', 'C', HASH, T, T)).toThrow(/member_limit/);
    expect(() => db.sqlite.prepare('UPDATE users SET household_id = ? WHERE id = ?').run(C, A)).toThrow(/immutable_field/);
    expect(() => db.sqlite.prepare('DELETE FROM users WHERE id = ?').run(A)).toThrow(/member_delete_forbidden/);
    expect(() => db.sqlite.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run('plain-text', A)).toThrow(/CHECK/);
    expect(() => db.sqlite.prepare("UPDATE users SET login = 'Upper@Example.test' WHERE id = ?").run(A)).toThrow(/CHECK/);
  });

  it('owner/household/visibility niezmienne, wersja rośnie, element dziedziczy zakres listy', () => {
    const db = ready();
    insertList(db, L1, A, 'private');
    for (const set of [`owner_id = '${B}'`, "visibility = 'shared'", `household_id = '${C}'`])
      expect(() => db.sqlite.prepare(`UPDATE shopping_lists SET ${set}, version = 2 WHERE id = ?`).run(L1)).toThrow(/immutable_field|FOREIGN KEY/);
    expect(() => db.sqlite.prepare("UPDATE shopping_lists SET name = 'x' WHERE id = ?").run(L1)).toThrow(/version_must_increase/);
    const item = db.sqlite.prepare("INSERT INTO shopping_items VALUES (?, ?, ?, ?, 1, ?, ?, NULL, ?, 'Mleko', '', '', 0, 1)");
    expect(() => item.run(I1, H, A, 'shared', T, T, L1)).toThrow(/FOREIGN KEY/); // scope differs from list
    expect(() => item.run(I1, H, B, 'private', T, T, L1)).toThrow(/private_parent_owner/); // partner in a private list
    item.run(I1, H, A, 'private', T, T, L1);
    expect(() => db.sqlite.prepare('UPDATE shopping_items SET list_id = ?, version = 2 WHERE id = ?').run(L1.replace('1', '2'), I1)).toThrow(/immutable_field/);
    expect(() => db.sqlite.prepare('INSERT INTO shopping_lists VALUES (?, ?, ?, ?, 1, ?, ?, NULL, ?)').run(C, H, C, 'shared', T, T, 'Obcy')).toThrow(/FOREIGN KEY/);
  });

  it('wystąpienie zadania unikalne, prywatne zadanie tylko dla siebie, przypomnienie w zakresie rodzica', () => {
    const db = ready();
    const task = db.sqlite.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, 1, ?, ?, NULL, 'Zadanie', '', ?, '2026-11-05', NULL, 'Europe/Warsaw', NULL, NULL)");
    expect(() => task.run(L1, H, A, 'private', T, T, 'partner')).toThrow(/CHECK/);
    task.run(L1, H, A, 'shared', T, T, 'both');
    const occ = db.sqlite.prepare("INSERT INTO task_occurrences VALUES (?, ?, ?, 'shared', 1, ?, ?, NULL, ?, '2026-11-05', NULL)");
    occ.run(I1, H, B, T, T, L1);
    expect(() => occ.run(C, H, A, T, T, L1)).toThrow(/UNIQUE/);
    const reminder = db.sqlite.prepare("INSERT INTO reminders VALUES (?, ?, ?, ?, 1, ?, ?, NULL, 'task', ?, 1, 30, NULL)");
    expect(() => reminder.run(C, H, A, 'private', T, T, L1)).toThrow(/reminder_parent_scope/);
    reminder.run(C, H, B, 'shared', T, T, L1);
    db.sqlite.prepare('DELETE FROM tasks WHERE id = ?').run(L1);
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM reminders').get()).toEqual({ n: 0 });
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM task_occurrences').get()).toEqual({ n: 0 });
  });
});

it('v3 → v4 zachowuje szablony, ukończenia i journal; nowe zdarzenia są bez treści', () => {
  const { db, dir } = tempDb();
  migrate(db.sqlite, { list: migrations.slice(0, 3) });
  seedAccounts(db);
  db.sqlite.prepare("INSERT INTO tasks VALUES (?, ?, ?, 'shared', 7, ?, ?, NULL, 'Stary szablon', '', 'both', '2026-01-31', NULL, 'Europe/Warsaw', NULL, ?)")
    .run(C, H, A, T, T, JSON.stringify({ frequency: 'monthly', interval: 1, startDate: '2026-01-31' }));
  db.sqlite.prepare("INSERT INTO task_occurrences VALUES (?, ?, ?, 'shared', 2, ?, ?, NULL, ?, '2026-01-31', ?)").run(B, H, A, T, T, C, T);
  db.sqlite.prepare("INSERT INTO sync_changes(entity_type,entity_id,household_id,owner_id,visibility,version,changed_at) VALUES ('task',?,?,?,'shared',7,?)").run(C,H,A,T);
  const backup = join(dir, 'pre-v3.sqlite');
  expect(migrate(db.sqlite, { backupPath: () => backup })).toEqual({ applied: [4, 5], backup });
  expect(db.sqlite.prepare('SELECT version, recurrence FROM tasks').get()).toEqual({ version: 7, recurrence: JSON.stringify({ frequency: 'monthly', interval: 1, startDate: '2026-01-31' }) });
  expect(db.sqlite.prepare('SELECT version, completed_at FROM task_occurrences').get()).toEqual({ version: 2, completed_at: T });
  expect(db.sqlite.prepare('SELECT count(*) n FROM sync_changes').get()).toEqual({ n: 1 });
  expect(db.sqlite.prepare('SELECT count(*) n FROM task_events').get()).toEqual({ n: 0 });
  expect(db.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
  expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
});

it('kalendarz v2 → aktualny: date-only, 29.02 bez roku, przypomnienie i ACL przeżywają upgrade', () => {
  const { db, dir } = tempDb(); migrate(db.sqlite, { list: migrations.slice(0, 2) }); seedAccounts(db);
  const E = '40000000-0000-4000-8000-000000000001', D = '40000000-0000-4000-8000-000000000002', R = '40000000-0000-4000-8000-000000000003';
  db.db.insert(schema.calendarEvents).values({ id: E, householdId: H, ownerId: A, visibility: 'private', version: 1, createdAt: T, updatedAt: T, deletedAt: null,
    title: 'Wyjazd', description: '', allDay: true, timezone: 'Pacific/Kiritimati', startDate: '2026-12-30', endDate: '2027-01-03', startAt: null, endAt: null }).run();
  db.db.insert(schema.importantDates).values({ id: D, householdId: H, ownerId: A, visibility: 'shared', version: 1, createdAt: T, updatedAt: T, deletedAt: null,
    name: 'Bez roku', month: 2, day: 29, startYear: null, kind: 'anniversary' }).run();
  db.db.insert(schema.reminders).values({ id: R, householdId: H, ownerId: A, visibility: 'private', version: 1, createdAt: T, updatedAt: T, deletedAt: null,
    targetType: 'calendar_event', targetId: E, enabled: true, minutesBefore: 0, localTime: '09:00' }).run();
  const before = ['calendar_events', 'important_dates', 'reminders'].map((table) => db.sqlite.prepare(`SELECT * FROM ${table}`).all());
  migrate(db.sqlite, { backupPath: (v) => join(dir, `calendar-pre-v${v}.sqlite`) });
  expect(['calendar_events', 'important_dates', 'reminders'].map((table) => db.sqlite.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
  expect(db.sqlite.pragma('foreign_key_check')).toEqual([]); expect(db.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
  expect(() => db.sqlite.prepare("UPDATE reminders SET visibility = 'shared' WHERE id = ?").run(R)).toThrow();
});

it('niespójne FK w snapshotcie blokuje migrację przed SQL; nie pozostawia błędnego archiwum', () => {
  const { db, dir } = tempDb();
  migrate(db.sqlite, { list: migrations.slice(0, 3) }); seedAccounts(db);
  db.sqlite.pragma('foreign_keys = OFF');
  db.sqlite.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, ?)').run(C, C, 'syntetyczny osierocony rekord', T, T);
  const backup = join(dir, 'invalid-pre-v3.sqlite');
  expect(() => migrate(db.sqlite, { backupPath: () => backup })).toThrow(/integralności/);
  expect(existsSync(backup)).toBe(false);
  expect(migrationStatus(db.sqlite).current).toBe(3);
  expect(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'task_events'").get()).toBeUndefined();
});

it('v4 → v5 zachowuje domenę, sesje i preferencje; unieważnia niesprawdzone stare subskrypcje i pusty szkielet dispatch', () => {
  const { db, dir } = tempDb(); migrate(db.sqlite, { list: migrations.slice(0, 4) }); seedAccounts(db);
  db.sqlite.prepare("INSERT INTO notes VALUES (?,?,?,'private',1,?,?,NULL,'SECRET','')").run(C, H, A, T, T);
  db.sqlite.prepare("INSERT INTO preferences VALUES (?,'Europe/Warsaw','dark',1,1,1,?)").run(A, T);
  db.sqlite.prepare("INSERT INTO devices VALUES (?,?,'Test',?,?)").run(C, A, T, T);
  db.sqlite.prepare("INSERT INTO push_subscriptions VALUES (?,?,?,'https://web.push.apple.com/legacy','synthetic','synthetic',NULL,?)").run(C, A, C, T);
  const before = db.sqlite.prepare('SELECT * FROM notes').all();
  const backup = join(dir, 'pre-v4.sqlite'); expect(migrate(db.sqlite, { backupPath: () => backup })).toEqual({ applied: [5], backup });
  expect(db.sqlite.prepare('SELECT * FROM notes').all()).toEqual(before);
  expect(db.sqlite.prepare('SELECT count(*) n FROM sessions').get()).toEqual({ n: 1 });
  expect(db.sqlite.prepare('SELECT include_titles,shopping_notifications,task_reminders,task_reminder_time,task_minutes_before FROM preferences').get())
    .toEqual({ include_titles: 1, shopping_notifications: 1, task_reminders: 1, task_reminder_time: '09:00', task_minutes_before: 0 });
  expect(db.sqlite.prepare('SELECT count(*) n FROM push_subscriptions').get()).toEqual({ n: 0 });
  expect(db.sqlite.pragma('foreign_key_check')).toEqual([]); expect(db.sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
});
