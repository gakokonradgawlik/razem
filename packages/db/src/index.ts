import BetterSqlite3 from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export interface Database {
  sqlite: BetterSqlite3.Database;
  db: BetterSQLite3Database;
  path: string;
  close: () => void;
}

export const BUSY_TIMEOUT_MS = 5000;

/**
 * Opens SQLite on a persistent local directory (0700) with a 0600 file, WAL,
 * foreign keys and busy_timeout. Does not migrate: call migrate() explicitly.
 */
export function openDatabase(filename: string): Database {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const sqlite = new BetterSqlite3(filename);
  try {
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    sqlite.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA synchronous = NORMAL;`);
    const db = drizzle(sqlite);
    return { sqlite, db, path: filename, close: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export * from './migrations.js';
export * as schema from './schema.js';
export * from './accounts.js';
export * from './records.js';
export * from './sync-store.js';
export * from './snapshot.js';
export * from './push.js';
