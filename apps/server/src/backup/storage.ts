import BetterSqlite3 from 'better-sqlite3';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { idSchema, instantSchema } from '@razem/contracts';
import { assertSchemaCurrent, migrationStatus, snapshotSqlite, verifySqlite } from '@razem/db';

const fileSchema = z.strictObject({ bytes: z.number().int().nonnegative().max(4 * 1024 ** 3), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const manifestSchema = z.strictObject({
  format: z.literal('razem-installation-backup'), formatVersion: z.literal(1),
  archiveId: idSchema, householdId: idSchema, createdAt: instantSchema,
  kind: z.enum(['daily', 'weekly']), schemaVersion: z.number().int().positive(),
  database: fileSchema, configuration: fileSchema.nullable(),
});
export type Manifest = z.infer<typeof manifestSchema>;
export const DATABASE_FILE = 'database.sqlite';
export const CONFIG_FILE = 'configuration.env';
export const MANIFEST_FILE = 'manifest.json';

/** Fail closed on symlinks, other owners and group/world access; never chmod someone else's directory. */
export function privatePath(path: string, directory: boolean): void {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || (s.mode & 0o077) !== 0
    || (process.getuid && s.uid !== process.getuid())) throw new Error('Wymagany własny chroniony katalog/plik (0700/0600), bez symlinków');
}
export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  privatePath(path, true);
}
export function writePrivate(path: string, data: string | Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}
export function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function digest(path: string) {
  // Read in bounded chunks: installation backups need not fit in RAM.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    for (;;) { const n = readSync(fd, buffer, 0, buffer.length, null); if (!n) break; hash.update(buffer.subarray(0, n)); bytes += n; }
    return { bytes, sha256: hash.digest('hex') };
  } finally { closeSync(fd); }
}

export function readConfiguration(path: string): Buffer {
  privatePath(path, false);
  if (statSync(path).size > 1024 * 1024) throw new Error('Konfiguracja przekracza 1 MiB');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(fd); } finally { closeSync(fd); }
}
function household(sqlite: BetterSqlite3.Database): string {
  const rows = sqlite.prepare('SELECT id FROM households').all() as { id: string }[];
  if (rows.length !== 1) throw new Error('Backup wymaga zainicjowanego gospodarstwa');
  return idSchema.parse(rows[0]!.id);
}
export function archiveName(m: Manifest): string {
  return `razem-${m.householdId}-${m.kind}-${m.createdAt.replace(/[:.]/g, '-')}-${m.archiveId}`;
}

/** Validate names, files, permissions, checksums, schema history, integrity and household identity. */
export function inspectBackup(path: string): Manifest {
  privatePath(path, true);
  privatePath(join(path, MANIFEST_FILE), false);
  const m = manifestSchema.parse(JSON.parse(readFileSync(join(path, MANIFEST_FILE), 'utf8')));
  const expected = [DATABASE_FILE, MANIFEST_FILE, ...(m.configuration ? [CONFIG_FILE] : [])].sort();
  if (JSON.stringify(readdirSync(path).sort()) !== JSON.stringify(expected)) throw new Error('Nieznana zawartość archiwum');
  for (const [name, entry] of [[DATABASE_FILE, m.database], [CONFIG_FILE, m.configuration]] as const) {
    if (!entry) continue;
    privatePath(join(path, name), false);
    const actual = digest(join(path, name));
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new Error('Suma kontrolna archiwum nie zgadza się');
  }
  const db = new BetterSqlite3(join(path, DATABASE_FILE), { readonly: true, fileMustExist: true });
  try {
    verifySqlite(db);
    const status = migrationStatus(db);
    if (status.current !== m.schemaVersion || household(db) !== m.householdId) throw new Error('Niezgodny schemat lub gospodarstwo');
  } finally { db.close(); }
  return m;
}

export function createBackup(source: string, directory: string, options: { configFile?: string; now?: Date; kind?: Manifest['kind'] } = {}): string {
  privatePath(source, false);
  privateDirectory(directory);
  const db = new BetterSqlite3(source, { fileMustExist: true });
  let path: string | undefined;
  try {
    assertSchemaCurrent(db);
    const id = household(db);
    const m: Manifest = { format: 'razem-installation-backup', formatVersion: 1, archiveId: randomUUID(), householdId: id,
      kind: options.kind ?? 'daily', createdAt: (options.now ?? new Date()).toISOString(), schemaVersion: migrationStatus(db).current,
      database: { bytes: 0, sha256: '' }, configuration: null };
    const candidate = join(directory, archiveName(m));
    mkdirSync(candidate, { mode: 0o700 });
    path = candidate;
    snapshotSqlite(db, join(path, DATABASE_FILE));
    m.database = digest(join(path, DATABASE_FILE));
    if (options.configFile) {
      writePrivate(join(path, CONFIG_FILE), readConfiguration(options.configFile));
      m.configuration = digest(join(path, CONFIG_FILE));
    }
    writePrivate(join(path, MANIFEST_FILE), JSON.stringify(manifestSchema.parse(m), null, 2));
    syncDirectory(path); syncDirectory(directory);
    inspectBackup(path);
    return path;
  } catch (error) {
    if (path) rmSync(path, { recursive: true, force: true });
    throw error;
  } finally { db.close(); }
}

/** Only recognized, intact archives of this installation are candidates, never arbitrary paths. */
export function retainBackups(directory: string, householdId: string): string[] {
  privatePath(directory, true);
  idSchema.parse(householdId);
  const candidates: { path: string; manifest: Manifest }[] = [];
  for (const entry of readdirSync(directory)) {
    if (!entry.startsWith(`razem-${householdId}-`)) continue;
    const path = join(directory, entry);
    try {
      const manifest = inspectBackup(path);
      if (manifest.householdId === householdId && entry === archiveName(manifest)) candidates.push({ path, manifest });
    } catch { /* Unknown/incomplete/tampered archives are never deleted by retention. */ }
  }
  const removed: string[] = [];
  for (const [kind, count] of [['daily', 7], ['weekly', 4]] as const) {
    const keep = new Set<string>();
    for (const item of candidates.filter((c) => c.manifest.kind === kind).sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt) || b.manifest.archiveId.localeCompare(a.manifest.archiveId))) {
      const date = new Date(item.manifest.createdAt);
      if (kind === 'weekly') date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
      const period = date.toISOString().slice(0, 10);
      if (!keep.has(period) && keep.size < count) { keep.add(period); continue; }
      rmSync(item.path, { recursive: true }); removed.push(item.path);
    }
  }
  syncDirectory(directory);
  return removed;
}

/** No overwrite mode: restore always creates a new directory, separate from any running installation. */
export function restoreBackup(backup: string, target: string): Manifest {
  const manifest = inspectBackup(backup);
  const destination = resolve(target);
  privatePath(dirname(destination), true);
  mkdirSync(destination, { mode: 0o700 }); // EEXIST, including an empty existing directory or symlink, is a hard refusal.
  try {
    const source = new BetterSqlite3(join(backup, DATABASE_FILE), { readonly: true, fileMustExist: true });
    try { snapshotSqlite(source, join(destination, 'razem.sqlite')); } finally { source.close(); }
    const db = new BetterSqlite3(join(destination, 'razem.sqlite'));
    try {
      db.pragma('foreign_keys = ON');
      db.transaction(() => {
        db.exec('DELETE FROM sessions; DELETE FROM auth_throttle;');
        if (manifest.schemaVersion >= 2) db.exec('DELETE FROM push_subscriptions;');
        if (manifest.schemaVersion >= 3) db.prepare('UPDATE sync_state SET cursor_key = ? WHERE id = 1').run(randomBytes(32).toString('hex'));
        db.exec("INSERT INTO auth_events(user_id, kind, created_at) SELECT id, 'sessions_revoked', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM users");
      })();
      verifySqlite(db);
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.pragma('journal_mode = DELETE');
    } finally { db.close(); }
    if (manifest.configuration) writePrivate(join(destination, CONFIG_FILE), readConfiguration(join(backup, CONFIG_FILE)));
    writePrivate(join(destination, 'restore.json'), JSON.stringify({ archiveId: manifest.archiveId, restoredAt: new Date().toISOString(), sessions: 'revoked', pushSubscriptions: 'removed', schemaVersion: manifest.schemaVersion }, null, 2));
    syncDirectory(destination); syncDirectory(dirname(destination));
    return manifest;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Migration snapshots have no manifest/configuration. Wrap a verified snapshot for the same isolated restore path. */
export function restoreSnapshot(snapshot: string, target: string, configFile?: string): Manifest {
  privatePath(snapshot, false);
  privatePath(dirname(resolve(target)), true);
  const db = new BetterSqlite3(snapshot, { readonly: true, fileMustExist: true });
  let stage: string | undefined;
  try {
    verifySqlite(db);
    const version = migrationStatus(db).current;
    if (version < 1) throw new Error('Brak znanej historii migracji');
    const id = household(db);
    stage = mkdtempSync(join(dirname(resolve(target)), '.razem-snapshot-'));
    snapshotSqlite(db, join(stage, DATABASE_FILE));
    let configuration: Manifest['configuration'] = null;
    if (configFile) {
      writePrivate(join(stage, CONFIG_FILE), readConfiguration(configFile));
      configuration = digest(join(stage, CONFIG_FILE));
    }
    const manifest: Manifest = { format: 'razem-installation-backup', formatVersion: 1, archiveId: randomUUID(), householdId: id,
      createdAt: new Date().toISOString(), kind: 'daily', schemaVersion: version, database: digest(join(stage, DATABASE_FILE)), configuration };
    writePrivate(join(stage, MANIFEST_FILE), JSON.stringify(manifest));
    return restoreBackup(stage, target);
  } finally { db.close(); if (stage) rmSync(stage, { recursive: true, force: true }); }
}
