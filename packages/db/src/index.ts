import BetterSqlite3 from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export interface Database {
  sqlite: BetterSqlite3.Database;
  db: BetterSQLite3Database;
  close: () => void;
}

// No user tables or accounts yet: RAZ-2 owns the domain schema and migrations.
export function openDatabase(filename: string): Database {
  const sqlite = new BetterSqlite3(filename);
  try {
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const db = drizzle(sqlite);
    return { sqlite, db, close: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
