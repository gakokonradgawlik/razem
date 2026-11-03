import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { openDatabase } from './index.js';

it('włącza WAL/FK/timeout; transakcja migracji cofa błąd i zachowuje dane po restarcie', () => {
  const directory = mkdtempSync(join(tmpdir(), 'razem-db-'));
  const path = join(directory, 'test.sqlite');
  let connection = openDatabase(path);
  try {
    expect(connection.sqlite.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    expect(connection.sqlite.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    expect(connection.sqlite.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });
    // Synthetic migration fixture; no domain schema is introduced ahead of RAZ-2.
    connection.db.run(sql`CREATE TABLE fixture (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    connection.db.run(sql`INSERT INTO fixture VALUES ('synthetic', 'retained')`);
    expect(() => connection.db.transaction((tx) => {
      tx.run(sql`ALTER TABLE fixture ADD COLUMN migrated INTEGER`);
      tx.run(sql`INSERT INTO missing_table VALUES (1)`);
    })).toThrow();
    expect(connection.sqlite.prepare('PRAGMA table_info(fixture)').all().map((c) => (c as { name: string }).name)).toEqual(['id', 'value']);
    connection.close();
    connection = openDatabase(path);
    expect(connection.db.get(sql`SELECT value FROM fixture WHERE id = 'synthetic'`)).toEqual({ value: 'retained' });
    expect(connection.sqlite.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  } finally { connection.close(); rmSync(directory, { recursive: true, force: true }); }
});
