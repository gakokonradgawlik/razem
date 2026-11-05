import BetterSqlite3 from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { migrate, migrationStatus, migrations, openDatabase, RecordRepository, SNAPSHOT_ORDER, verifySqlite } from '@razem/db';
import type { Database } from '@razem/db';
import { A, B, H, HASH, TIME, seedAccounts, seedDomain } from '../../../../tests/fixtures/installation.js';
import { runAdmin } from '../admin.js';
import { createBackup, inspectBackup, retainBackups, restoreBackup, restoreSnapshot, archiveName, writePrivate, digest } from './storage.js';
import { encryptBackup, restoreEncrypted } from './portable.js';

let directory: string, source: string, backups: string, database: Database;
const handles: (() => unknown | Promise<unknown>)[] = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'razem-backup-'));
  source = join(directory, 'live.sqlite'); backups = join(directory, 'backups');
  database = openDatabase(source); migrate(database.sqlite); seedAccounts(database); seedDomain(database);
  database.sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)').run(randomUUID(), A.userId, 'a'.repeat(64), TIME, TIME, '2026-12-05T10:00:00.000Z');
  const device = randomUUID();
  database.sqlite.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, ?)').run(device, A.userId, 'syntetyczne urządzenie', TIME, TIME);
  database.sqlite.prepare('INSERT INTO push_subscriptions (id,user_id,device_id,endpoint,p256dh,auth,expiration_time,created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)').run(randomUUID(), A.userId, device, 'https://push.example.test/synthetic', 'synthetic-p256dh', 'synthetic-auth', TIME);
});
afterEach(async () => {
  for (const close of handles.splice(0).reverse()) await close();
  database.close(); rmSync(directory, { recursive: true, force: true });
});
function open(path: string) { const db = openDatabase(path); handles.push(() => db.close()); return db; }
function protectedFile(name: string, content: string) { const path = join(directory, name); writePrivate(path, content); return path; }
function checkRestore(path: string) {
  const db = open(join(path, 'razem.sqlite'));
  verifySqlite(db.sqlite); expect(migrationStatus(db.sqlite).current).toBe(5);
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM push_subscriptions').get()).toEqual({ n: 0 });
  expect(db.sqlite.prepare('SELECT password_hash FROM users').all()).toEqual([{ password_hash: HASH }, { password_hash: HASH }]);
  expect(db.sqlite.prepare('SELECT cursor_key FROM sync_state').get()).not.toEqual(database.sqlite.prepare('SELECT cursor_key FROM sync_state').get());
  const repo = new RecordRepository(db);
  expect(repo.list(A, 'shopping_list').map((r) => r.entityType === 'shopping_list' ? r.data.name : '').sort()).toEqual(['PRIVATE_A', 'SHARED']);
  expect(repo.list(B, 'note').map((r) => r.entityType === 'note' ? r.data.title : '').sort()).toEqual(['PRIVATE_B', 'SHARED']);
  for (const type of ['shopping_item', 'task_occurrence', 'reminder'] as const) expect(repo.list(A, type)).toHaveLength(2);
  const privateB = new RecordRepository(database).list(B, 'note').find((r) => r.visibility === 'private')!;
  expect(repo.get(A, 'note', privateB.id)).toBeNull();
  expect(repo.update(A, { entityType: 'note', id: privateB.id, baseVersion: 1, patch: { body: 'forbidden' } })).toEqual({ status: 'error', code: 'not_found' });
  for (const scope of [A, B]) for (const type of SNAPSHOT_ORDER)
    expect(repo.list(scope, type, { includeDeleted: true })).toEqual(new RecordRepository(database).list(scope, type, { includeDeleted: true }));
  expect(lstatSync(join(path, 'razem.sqlite')).mode & 0o777).toBe(0o600);
  expect(lstatSync(path).mode & 0o777).toBe(0o700);
  return db;
}

it('żywy WAL i równoczesny zapis w drugim wątku: spójna kopia, relacje/ACL i izolowany restore', async () => {
  database.sqlite.exec('CREATE TABLE backup_probe (id INTEGER PRIMARY KEY, payload TEXT NOT NULL) STRICT');
  const insert = database.sqlite.prepare('INSERT INTO backup_probe(payload) VALUES (?)');
  database.sqlite.transaction(() => { for (let i = 0; i < 512; i++) insert.run('S'.repeat(32768)); })();
  const modulePath = createRequire(import.meta.url).resolve('better-sqlite3');
  const writer = new Worker(`
    const { workerData, parentPort } = require('node:worker_threads');
    const DB = require(workerData.modulePath);
    const db = new DB(workerData.source); db.pragma('busy_timeout=5000');
    const insert = db.prepare('INSERT INTO backup_probe(payload) VALUES (?)');
    const timer = setInterval(() => { insert.run('concurrent'); parentPort.postMessage('written'); }, 1);
    parentPort.on('message', () => { clearInterval(timer); db.close(); parentPort.close(); });
  `, { eval: true, workerData: { source, modulePath } });
  handles.push(async () => { await writer.terminate(); });
  await once(writer, 'message');
  const before = (database.sqlite.prepare('SELECT count(*) AS n FROM backup_probe').get() as { n: number }).n;
  expect(existsSync(`${source}-wal`)).toBe(true);
  const archive = createBackup(source, backups);
  const after = (database.sqlite.prepare('SELECT count(*) AS n FROM backup_probe').get() as { n: number }).n;
  expect(after).toBeGreaterThan(before); // Commits really happened during VACUUM, outside this blocked JS thread.
  writer.postMessage('stop'); await once(writer, 'exit');
  const manifest = inspectBackup(archive);
  expect(manifest.schemaVersion).toBe(5);
  const frozen = new BetterSqlite3(join(archive, 'database.sqlite'), { readonly: true });
  const count = (frozen.prepare('SELECT count(*) AS n FROM backup_probe').get() as { n: number }).n;
  expect(count).toBeGreaterThanOrEqual(before); expect(count).toBeLessThanOrEqual(after); verifySqlite(frozen); frozen.close();
  const target = join(directory, 'isolated'); restoreBackup(archive, target); checkRestore(target);
  expect(database.sqlite.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 1 });
  expect(database.sqlite.prepare('SELECT count(*) AS n FROM push_subscriptions').get()).toEqual({ n: 1 });
  expect(lstatSync(join(archive, 'database.sqlite')).mode & 0o777).toBe(0o600);
  expect(lstatSync(archive).mode & 0o777).toBe(0o700);
});

it('szyfrowanie przenośne obejmuje konfigurację/VAPID; złe hasło i podmiana nie tworzą celu', async () => {
  const config = protectedFile('installation.env', 'VAPID_PRIVATE_KEY=synthetic-only-secret\nPUBLIC_ORIGIN=https://razem.example.test\n');
  const password = protectedFile('password', 'synthetic offline passphrase 2026');
  const wrong = protectedFile('wrong', 'synthetic incorrect passphrase 2026');
  const archive = createBackup(source, backups, { configFile: config });
  const output = join(directory, 'offsite.razem');
  await encryptBackup(archive, output, password);
  expect(lstatSync(output).mode & 0o777).toBe(0o600);
  expect(readFileSync(output).includes(Buffer.from('synthetic-only-secret'))).toBe(false);
  const target = join(directory, 'decrypted'); await restoreEncrypted(output, target, password);
  checkRestore(target); expect(readFileSync(join(target, 'configuration.env'), 'utf8')).toBe(readFileSync(config, 'utf8'));
  await expect(restoreEncrypted(output, join(directory, 'wrong-target'), wrong)).rejects.toThrow();
  expect(existsSync(join(directory, 'wrong-target'))).toBe(false);
  const changed = readFileSync(output); changed[changed.length - 20]! ^= 1;
  const tampered = join(directory, 'tampered'); writePrivate(tampered, changed);
  await expect(restoreEncrypted(tampered, join(directory, 'tampered-target'), password)).rejects.toThrow();
  expect(readdirSync(directory).filter((p) => p.startsWith('.razem-restore-'))).toEqual([]);
  const original = readFileSync(output);
  await expect(encryptBackup(archive, output, password)).rejects.toThrow(); expect(readFileSync(output)).toEqual(original);
});

it('retencja 7 różnych dni + 4 różnych tygodni usuwa tylko rozpoznane kopie tego gospodarstwa', () => {
  for (let week = 0; week < 6; week++) createBackup(source, backups, { now: new Date(Date.UTC(2026, 8, 7 + week * 7)), kind: 'weekly' });
  for (let day = 1; day <= 10; day++) createBackup(source, backups, { now: new Date(Date.UTC(2026, 9, day)) });
  createBackup(source, backups, { now: new Date('2026-10-10T15:00:00.000Z') }); // duplicate day
  const foreign = join(backups, 'unrelated.txt'); writePrivate(foreign, 'preserve');
  const invalid = join(backups, `razem-${H}-daily-invalid`); mkdirSync(invalid, { mode: 0o700 }); writePrivate(join(invalid, 'keep'), 'preserve');
  const symlink = join(backups, `razem-${H}-daily-link`); symlinkSync(directory, symlink);
  const foreignHousehold = '00000000-0000-4000-8000-0000000000ff';
  const foreignDir = join(backups, `razem-${foreignHousehold}-daily-preserve`); mkdirSync(foreignDir, { mode: 0o700 });
  const removed = retainBackups(backups, H); expect(removed).toHaveLength(6);
  const manifests = readdirSync(backups).filter((p) => p.startsWith(`razem-${H}-`) && !p.includes('invalid') && !p.endsWith('link')).map((p) => inspectBackup(join(backups, p)));
  expect(manifests.filter((m) => m.kind === 'daily')).toHaveLength(7);
  expect(manifests.filter((m) => m.kind === 'daily').map((m) => m.createdAt.slice(0, 10)).sort()).toEqual(Array.from({ length: 7 }, (_, i) => `2026-10-${String(i + 4).padStart(2, '0')}`));
  expect(manifests.filter((m) => m.kind === 'weekly')).toHaveLength(4);
  expect(existsSync(foreign)).toBe(true); expect(existsSync(invalid)).toBe(true); expect(lstatSync(symlink).isSymbolicLink()).toBe(true); expect(existsSync(foreignDir)).toBe(true);
  expect(retainBackups(backups, H)).toEqual([]);
});

it('restore odmawia istniejącego celu, symlinków, zbyt szerokich uprawnień i błędnych sum', () => {
  const archive = createBackup(source, backups), target = join(directory, 'existing');
  mkdirSync(target, { mode: 0o700 }); writePrivate(join(target, 'keep'), 'foreign installation');
  expect(() => restoreBackup(archive, target)).toThrow(); expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('foreign installation');
  const linked = join(directory, 'linked'); symlinkSync(target, linked);
  expect(() => restoreBackup(archive, linked)).toThrow();
  const wide = join(directory, 'wide'); mkdirSync(wide, { mode: 0o755 }); chmodSync(wide, 0o755);
  expect(() => createBackup(source, wide)).toThrow(); expect(() => restoreBackup(archive, join(wide, 'child'))).toThrow();
  chmodSync(join(archive, 'database.sqlite'), 0o644); expect(() => inspectBackup(archive)).toThrow(); chmodSync(join(archive, 'database.sqlite'), 0o600);
  const m = inspectBackup(archive); writeFileSync(join(archive, 'manifest.json'), JSON.stringify({ ...m, database: { ...m.database, sha256: '0'.repeat(64) } }));
  expect(() => restoreBackup(archive, join(directory, 'bad'))).toThrow(); expect(existsSync(join(directory, 'bad'))).toBe(false);
});

it('nieznana/zmieniona historia blokuje restore także po przeliczeniu SHA; snapshot v1 odtwarza się bez migracji', () => {
  const archive = createBackup(source, backups);
  const manifest = inspectBackup(archive), file = join(archive, 'database.sqlite');
  const frozen = new BetterSqlite3(file);
  frozen.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 4").run(); frozen.close();
  writeFileSync(join(archive, 'manifest.json'), JSON.stringify({ ...manifest, database: digest(file) }));
  expect(() => inspectBackup(archive)).toThrow(/Suma kontrolna migracji/);
  const changed = new BetterSqlite3(file);
  changed.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 4').run(createHash('sha256').update(migrations[3]!.sql).digest('hex'));
  changed.prepare('INSERT INTO schema_migrations VALUES (6, ?, ?, ?)').run('future', 'unknown', TIME); changed.close();
  writeFileSync(join(archive, 'manifest.json'), JSON.stringify({ ...manifest, database: digest(file) }));
  expect(() => restoreBackup(archive, join(directory, 'future'))).toThrow(/nieznaną migrację 6/); expect(existsSync(join(directory, 'future'))).toBe(false);
  const old = open(join(directory, 'old.sqlite')); migrate(old.sqlite, { list: migrations.slice(0, 1) }); seedAccounts(old);
  const pre = join(directory, 'pre-v1.sqlite'); migrate(old.sqlite, { backupPath: () => pre });
  const preDb = new BetterSqlite3(pre, { readonly: true }); verifySqlite(preDb); expect(migrationStatus(preDb).current).toBe(1); preDb.close();
  const target = join(directory, 'rollback-v1'); restoreSnapshot(pre, target);
  const restored = open(join(target, 'razem.sqlite')); expect(migrationStatus(restored.sqlite).current).toBe(1);
  expect(restored.sqlite.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 2 });
  expect(restored.sqlite.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  expect(readdirSync(directory).some((p) => p.startsWith('.razem-snapshot-'))).toBe(false);
});

async function admin(args: string[]) {
  const input = new PassThrough(); input.end(); let output = '';
  const sink = new PassThrough().on('data', (chunk) => { output += String(chunk); });
  const code = await runAdmin(args, { input, output: sink, error: sink }, { env: { DATABASE_PATH: source } });
  return { code, output };
}
it('CLI backup + encrypt + restore działa bez migracji źródła i bez drukowania konfiguracji/hasła', async () => {
  const config = protectedFile('configuration.env', 'VAPID_PRIVATE_KEY=synthetic-configuration-secret');
  const password = protectedFile('password', 'synthetic-password-file-secret');
  expect((await admin(['backup', '--directory', backups, '--config-file', config])).code).toBe(0);
  const manifests = readdirSync(backups).map((p) => inspectBackup(join(backups, p)));
  expect(manifests.map((m) => m.kind).sort()).toEqual(['daily', 'weekly']);
  const archive = join(backups, archiveName(manifests[0]!)), output = join(directory, 'portable');
  const encrypted = await admin(['backup-encrypt', '--archive', archive, '--output', output, '--password-file', password]);
  expect(encrypted.code).toBe(0); expect(encrypted.output).not.toContain('synthetic-configuration-secret'); expect(encrypted.output).not.toContain('synthetic-password-file-secret');
  expect((await admin(['restore', '--encrypted', output, '--target', join(directory, 'cli-target'), '--password-file', password])).code).toBe(0);
  checkRestore(join(directory, 'cli-target'));
  expect((await admin(['restore', '--archive', archive, '--target', directory])).code).toBe(1);
  expect((await admin(['backup', '--unknown', directory])).code).toBe(2);
});
