import { createHash } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import type BetterSqlite3 from 'better-sqlite3';

export interface Migration { version: number; name: string; sql: string }

// Migrations are frozen literal SQL. Never edit an applied migration: its checksum is
// stored in schema_migrations and verified on every start. Add a new version instead.
// Times are UTC ISO strings `YYYY-MM-DDTHH:MM:SS.sssZ`; lexical order equals time order.

const accounts = `
CREATE TABLE households (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  timezone TEXT NOT NULL CHECK (length(timezone) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER households_single_installation BEFORE INSERT ON households
WHEN (SELECT count(*) FROM households) >= 1
BEGIN SELECT RAISE(ABORT, 'household_limit'); END;
CREATE TRIGGER households_id_immutable BEFORE UPDATE OF id ON households
BEGIN SELECT RAISE(ABORT, 'immutable_field'); END;

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  login TEXT NOT NULL UNIQUE CHECK (length(login) BETWEEN 1 AND 254 AND login = lower(trim(login))),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  password_hash TEXT NOT NULL CHECK (substr(password_hash, 1, 10) = '$argon2id$'),
  must_change_password INTEGER NOT NULL CHECK (must_change_password IN (0, 1)),
  password_changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX users_household_member ON users(household_id, id);
CREATE TRIGGER users_two_members BEFORE INSERT ON users
WHEN (SELECT count(*) FROM users WHERE household_id = NEW.household_id) >= 2
BEGIN SELECT RAISE(ABORT, 'member_limit'); END;
CREATE TRIGGER users_identity_immutable BEFORE UPDATE OF id, household_id, created_at ON users
BEGIN SELECT RAISE(ABORT, 'immutable_field'); END;
CREATE TRIGGER users_no_delete BEFORE DELETE ON users
BEGIN SELECT RAISE(ABORT, 'member_delete_forbidden'); END;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  previous_token_hash TEXT UNIQUE CHECK (previous_token_hash IS NULL OR length(previous_token_hash) = 64),
  previous_valid_until TEXT,
  created_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > created_at)
) STRICT;
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE devices (
  id TEXT NOT NULL CHECK (length(id) = 36),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
) STRICT;

-- Security audit trail: event kind and time only, never a password, token or IP.
CREATE TABLE auth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('bootstrap', 'login', 'logout', 'password_changed', 'password_reset', 'sessions_revoked', 'login_locked')),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX auth_events_user ON auth_events(user_id, created_at);

-- Keys are SHA-256 of 'login:<normalized>' or 'ip:<address>'; typed text is never stored.
CREATE TABLE auth_throttle (
  key_hash TEXT PRIMARY KEY NOT NULL CHECK (length(key_hash) = 64),
  failures INTEGER NOT NULL CHECK (failures >= 0),
  window_started_at TEXT NOT NULL,
  locked_until TEXT
) STRICT;
`;

const meta = `
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  owner_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'shared')),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL CHECK (updated_at >= created_at),
  deleted_at TEXT,`;
// Table constraints must follow the columns in SQLite DDL.
const ownerFk = `
  FOREIGN KEY (household_id, owner_id) REFERENCES users(household_id, id) ON DELETE RESTRICT`;

const guard = (table: string, extraImmutable: string[] = []) => {
  const cols = ['id', 'household_id', 'owner_id', 'visibility', 'created_at', ...extraImmutable];
  return `
CREATE TRIGGER ${table}_metadata_immutable BEFORE UPDATE ON ${table}
WHEN ${cols.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(' OR ')}
BEGIN SELECT RAISE(ABORT, 'immutable_field'); END;
CREATE TRIGGER ${table}_version_increases BEFORE UPDATE ON ${table}
WHEN NEW.version <= OLD.version
BEGIN SELECT RAISE(ABORT, 'version_must_increase'); END;
CREATE INDEX ${table}_acl ON ${table}(household_id, visibility, owner_id);`;
};

// A private child must belong to the parent's owner; shared children can be added by either member.
const privateChildOwner = (child: string, parent: string, column: string) => `
CREATE TRIGGER ${child}_private_owner BEFORE INSERT ON ${child}
WHEN NEW.visibility = 'private' AND NEW.owner_id IS NOT (SELECT owner_id FROM ${parent} WHERE id = NEW.${column})
BEGIN SELECT RAISE(ABORT, 'private_parent_owner'); END;`;

const domain = `
CREATE TABLE shopping_lists (${meta}
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),${ownerFk}
) STRICT;
CREATE UNIQUE INDEX shopping_lists_scope ON shopping_lists(id, household_id, visibility);
${guard('shopping_lists')}

CREATE TABLE shopping_items (${meta}
  list_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  quantity TEXT NOT NULL CHECK (length(quantity) <= 100),
  note TEXT NOT NULL CHECK (length(note) <= 2000),
  checked INTEGER NOT NULL CHECK (checked IN (0, 1)),
  sort_key REAL NOT NULL,${ownerFk},
  FOREIGN KEY (list_id, household_id, visibility) REFERENCES shopping_lists(id, household_id, visibility) ON DELETE CASCADE
) STRICT;
CREATE INDEX shopping_items_list ON shopping_items(list_id);
${guard('shopping_items', ['list_id'])}
${privateChildOwner('shopping_items', 'shopping_lists', 'list_id')}

CREATE TABLE tasks (${meta}
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL CHECK (length(description) <= 50000),
  assignee TEXT NOT NULL CHECK (assignee IN ('self', 'partner', 'both') AND (visibility = 'shared' OR assignee = 'self')),
  due_date TEXT,
  due_at TEXT,
  timezone TEXT NOT NULL,
  completed_at TEXT,
  recurrence TEXT CHECK (recurrence IS NULL OR json_valid(recurrence)),
  CHECK (due_date IS NULL OR due_at IS NULL),
  CHECK (recurrence IS NULL OR due_date IS NOT NULL OR due_at IS NOT NULL),${ownerFk}
) STRICT;
CREATE UNIQUE INDEX tasks_scope ON tasks(id, household_id, visibility);
${guard('tasks')}

CREATE TABLE task_occurrences (${meta}
  task_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL CHECK (length(occurrence_key) = 10),
  completed_at TEXT,${ownerFk},
  FOREIGN KEY (task_id, household_id, visibility) REFERENCES tasks(id, household_id, visibility) ON DELETE CASCADE,
  UNIQUE (task_id, occurrence_key)
) STRICT;
${guard('task_occurrences', ['task_id', 'occurrence_key'])}
${privateChildOwner('task_occurrences', 'tasks', 'task_id')}

CREATE TABLE calendar_events (${meta}
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL CHECK (length(description) <= 50000),
  all_day INTEGER NOT NULL CHECK (all_day IN (0, 1)),
  timezone TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  start_at TEXT,
  end_at TEXT,
  CHECK ((all_day = 1 AND start_date IS NOT NULL AND end_date IS NOT NULL AND end_date > start_date AND start_at IS NULL AND end_at IS NULL)
      OR (all_day = 0 AND start_at IS NOT NULL AND end_at IS NOT NULL AND end_at > start_at AND start_date IS NULL AND end_date IS NULL)),${ownerFk}
) STRICT;
${guard('calendar_events')}

CREATE TABLE important_dates (${meta}
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
  start_year INTEGER CHECK (start_year IS NULL OR start_year BETWEEN 1 AND 9999),
  kind TEXT NOT NULL CHECK (kind IN ('birthday', 'anniversary', 'other')),${ownerFk}
) STRICT;
${guard('important_dates')}

CREATE TABLE notes (${meta}
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body TEXT NOT NULL CHECK (length(body) <= 50000),${ownerFk}
) STRICT;
${guard('notes')}

CREATE TABLE reminders (${meta}
  target_type TEXT NOT NULL CHECK (target_type IN ('task', 'calendar_event', 'important_date')),
  target_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  minutes_before INTEGER NOT NULL CHECK (minutes_before BETWEEN 0 AND 525600),
  local_time TEXT CHECK (local_time IS NULL OR length(local_time) = 5),${ownerFk}
) STRICT;
CREATE INDEX reminders_target ON reminders(target_type, target_id);
${guard('reminders', ['target_type', 'target_id'])}
-- Polymorphic parent: same household and visibility, and the parent's owner when private.
CREATE TRIGGER reminders_parent_scope BEFORE INSERT ON reminders
WHEN NOT EXISTS (
  SELECT 1 FROM tasks p WHERE NEW.target_type = 'task' AND p.id = NEW.target_id
    AND p.household_id = NEW.household_id AND p.visibility = NEW.visibility
    AND (NEW.visibility = 'shared' OR p.owner_id = NEW.owner_id)
  UNION ALL
  SELECT 1 FROM calendar_events p WHERE NEW.target_type = 'calendar_event' AND p.id = NEW.target_id
    AND p.household_id = NEW.household_id AND p.visibility = NEW.visibility
    AND (NEW.visibility = 'shared' OR p.owner_id = NEW.owner_id)
  UNION ALL
  SELECT 1 FROM important_dates p WHERE NEW.target_type = 'important_date' AND p.id = NEW.target_id
    AND p.household_id = NEW.household_id AND p.visibility = NEW.visibility
    AND (NEW.visibility = 'shared' OR p.owner_id = NEW.owner_id)
)
BEGIN SELECT RAISE(ABORT, 'reminder_parent_scope'); END;
CREATE TRIGGER tasks_purge_reminders AFTER DELETE ON tasks
BEGIN DELETE FROM reminders WHERE target_type = 'task' AND target_id = OLD.id; END;
CREATE TRIGGER calendar_events_purge_reminders AFTER DELETE ON calendar_events
BEGIN DELETE FROM reminders WHERE target_type = 'calendar_event' AND target_id = OLD.id; END;
CREATE TRIGGER important_dates_purge_reminders AFTER DELETE ON important_dates
BEGIN DELETE FROM reminders WHERE target_type = 'important_date' AND target_id = OLD.id; END;

-- Journal: minimal ACL references only, never record content.
CREATE TABLE sync_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('shopping_list', 'shopping_item', 'task', 'task_occurrence', 'calendar_event', 'important_date', 'note', 'reminder')),
  entity_id TEXT NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'shared')),
  version INTEGER NOT NULL CHECK (version >= 1),
  changed_at TEXT NOT NULL
) STRICT;
CREATE INDEX sync_changes_scope ON sync_changes(household_id, sequence);
CREATE INDEX sync_changes_entity ON sync_changes(entity_type, entity_id);

CREATE TABLE mutation_receipts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  client_mutation_id TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL CHECK (length(payload_fingerprint) = 64),
  result TEXT NOT NULL CHECK (json_valid(result)),
  committed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, client_mutation_id)
) STRICT;
CREATE INDEX mutation_receipts_expiry ON mutation_receipts(expires_at);

CREATE TABLE preferences (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL,
  theme TEXT NOT NULL CHECK (theme IN ('system', 'light', 'dark')),
  push_enabled INTEGER NOT NULL CHECK (push_enabled IN (0, 1)),
  include_titles INTEGER NOT NULL CHECK (include_titles IN (0, 1)),
  shopping_notifications INTEGER NOT NULL CHECK (shopping_notifications IN (0, 1)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE CHECK (length(endpoint) <= 4096),
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  expiration_time INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id, device_id) REFERENCES devices(user_id, id) ON DELETE CASCADE,
  UNIQUE (user_id, device_id)
) STRICT;

CREATE TABLE reminder_dispatches (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deduplication_key TEXT NOT NULL UNIQUE CHECK (length(deduplication_key) BETWEEN 1 AND 512),
  scheduled_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'sent', 'failed')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  next_attempt_at TEXT,
  lease_until TEXT,
  sent_at TEXT
) STRICT;
CREATE INDEX reminder_dispatches_due ON reminder_dispatches(state, next_attempt_at);
`;

const domainTableNames: Array<[string, string]> = [
  ['shopping_list', 'shopping_lists'], ['shopping_item', 'shopping_items'], ['task', 'tasks'],
  ['task_occurrence', 'task_occurrences'], ['calendar_event', 'calendar_events'], ['important_date', 'important_dates'],
  ['note', 'notes'], ['reminder', 'reminders'],
];

// RAZ-4: tombstones of records purged from the 30-day trash, sync state (cursor key and
// journal retention floor), and indexes for retention jobs. Tombstones keep ACL metadata
// only, never content, and block re-inserting a purged ID (no resurrection by old phones).
const syncServer = `
CREATE TABLE tombstones (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('shopping_list', 'shopping_item', 'task', 'task_occurrence', 'calendar_event', 'important_date', 'note', 'reminder')),
  id TEXT NOT NULL CHECK (length(id) = 36),
  household_id TEXT NOT NULL REFERENCES households(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'shared')),
  version INTEGER NOT NULL CHECK (version >= 1),
  deleted_at TEXT NOT NULL,
  purged_at TEXT NOT NULL,
  PRIMARY KEY (entity_type, id)
) STRICT;
CREATE INDEX tombstones_acl ON tombstones(household_id, visibility, owner_id);
CREATE TRIGGER tombstones_immutable BEFORE UPDATE ON tombstones
BEGIN SELECT RAISE(ABORT, 'immutable_field'); END;
${domainTableNames.map(([type, table]) => `
CREATE TRIGGER ${table}_not_tombstoned BEFORE INSERT ON ${table}
WHEN EXISTS (SELECT 1 FROM tombstones WHERE entity_type = '${type}' AND id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'tombstoned'); END;
CREATE INDEX ${table}_trash ON ${table}(deleted_at) WHERE deleted_at IS NOT NULL;`).join('')}

-- Single row. cursor_key: random 256-bit key generated in the database at install time;
-- encrypts and authenticates pull cursors. journal_floor: highest pruned journal sequence.
CREATE TABLE sync_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  cursor_key TEXT NOT NULL CHECK (length(cursor_key) = 64),
  journal_floor INTEGER NOT NULL CHECK (journal_floor >= 0)
) STRICT;
INSERT INTO sync_state (id, cursor_key, journal_floor) VALUES (1, lower(hex(randomblob(32))), 0);
CREATE TRIGGER sync_state_floor_monotonic BEFORE UPDATE OF journal_floor ON sync_state
WHEN NEW.journal_floor < OLD.journal_floor
BEGIN SELECT RAISE(ABORT, 'floor_must_increase'); END;
CREATE INDEX sync_changes_changed ON sync_changes(changed_at);
`;

export const migrations: readonly Migration[] = [
  { version: 1, name: 'accounts_sessions', sql: accounts },
  { version: 2, name: 'domain_sync_push', sql: domain },
  { version: 3, name: 'sync_tombstones_state', sql: syncServer },
];
export const LATEST_SCHEMA_VERSION = migrations.length;

export class MigrationError extends Error {}

const checksum = (m: Migration) => createHash('sha256').update(m.sql).digest('hex');

function ensureLedger(sqlite: BetterSqlite3.Database) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);
}

export interface MigrationStatus { current: number; latest: number; pending: number[] }

export function migrationStatus(sqlite: BetterSqlite3.Database, list: readonly Migration[] = migrations): MigrationStatus {
  const exists = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  const applied = exists
    ? sqlite.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as Array<{ version: number; name: string; checksum: string }>
    : [];
  for (const row of applied) {
    const known = list.find((m) => m.version === row.version);
    if (!known) throw new MigrationError(`Baza ma nieznaną migrację ${row.version}; użyj nowszej wersji aplikacji`);
    if (checksum(known) !== row.checksum) throw new MigrationError(`Suma kontrolna migracji ${row.version} nie zgadza się`);
  }
  const current = applied.at(-1)?.version ?? 0;
  if (applied.some((row, index) => row.version !== index + 1)) throw new MigrationError('Nieciągła historia migracji');
  return { current, latest: list.at(-1)?.version ?? 0, pending: list.filter((m) => m.version > current).map((m) => m.version) };
}

export interface MigrateOptions {
  /** Database file; when set and existing data is upgraded, a consistent copy is written first. */
  backupPath?: (fromVersion: number) => string;
  now?: () => Date;
  list?: readonly Migration[];
}

/**
 * Applies pending migrations, each in its own IMMEDIATE transaction, verifies FK integrity
 * before commit and records the checksum. Fails closed on unknown or altered history.
 */
export function migrate(sqlite: BetterSqlite3.Database, options: MigrateOptions = {}): { applied: number[]; backup?: string } {
  const list = options.list ?? migrations;
  const now = options.now ?? (() => new Date());
  ensureLedger(sqlite);
  const status = migrationStatus(sqlite, list);
  if (status.pending.length === 0) return { applied: [] };
  let backup: string | undefined;
  if (status.current > 0 && options.backupPath) {
    backup = options.backupPath(status.current);
    if (existsSync(backup)) throw new MigrationError('Plik kopii przed migracją już istnieje');
    sqlite.prepare('VACUUM INTO ?').run(backup);
    chmodSync(backup, 0o600);
  }
  const applied: number[] = [];
  for (const migration of list.filter((m) => status.pending.includes(m.version))) {
    sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      const violations = sqlite.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) throw new MigrationError(`Migracja ${migration.version} narusza klucze obce`);
      sqlite.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.name, checksum(migration), now().toISOString());
    }).immediate();
    applied.push(migration.version);
  }
  return backup ? { applied, backup } : { applied };
}

/** For processes that must not migrate (worker): refuse to run against another schema. */
export function assertSchemaCurrent(sqlite: BetterSqlite3.Database): void {
  const status = migrationStatus(sqlite);
  if (status.current !== status.latest) throw new MigrationError(`Schemat bazy ${status.current}, oczekiwano ${status.latest}`);
}
