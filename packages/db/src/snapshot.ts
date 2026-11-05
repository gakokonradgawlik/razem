import BetterSqlite3 from 'better-sqlite3';
import { closeSync, fsyncSync, openSync, rmSync } from 'node:fs';

export function verifySqlite(sqlite: BetterSqlite3.Database): void {
  const rows = sqlite.pragma('integrity_check') as Array<{ integrity_check: string }>;
  if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok' || (sqlite.pragma('foreign_key_check') as unknown[]).length !== 0)
    throw new Error('Kopia SQLite nie przeszła kontroli integralności');
}

/** Never cp a live WAL database. The destination is exclusively reserved with mode 0600. */
export function snapshotSqlite(sqlite: BetterSqlite3.Database, destination: string): void {
  const fd = openSync(destination, 'wx', 0o600);
  closeSync(fd);
  try {
    sqlite.prepare('VACUUM INTO ?').run(destination);
    const copy = new BetterSqlite3(destination, { readonly: true, fileMustExist: true });
    try { verifySqlite(copy); } finally { copy.close(); }
    const output = openSync(destination, 'r');
    try { fsyncSync(output); } finally { closeSync(output); }
  } catch (error) {
    rmSync(destination, { force: true });
    throw error;
  }
}
