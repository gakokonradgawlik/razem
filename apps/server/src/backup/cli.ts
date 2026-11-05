import { dirname, resolve } from 'node:path';
import { createBackup, inspectBackup, retainBackups, restoreBackup, restoreSnapshot } from './storage.js';
import { encryptBackup, restoreEncrypted } from './portable.js';
import type { AdminIo } from '../admin.js';

export const BACKUP_COMMANDS = ['backup', 'backup-encrypt', 'restore'] as const;
const usage = `Backup: backup [--directory /data/backups] [--config-file /run/secrets/installation.env]
Szyfrowanie: backup-encrypt --archive <katalog-kopii> --output <nowy-plik> --password-file <plik-0600>
Restore: restore (--archive <katalog-kopii> | --encrypted <plik> | --snapshot <kopia-przed-migracją>) --target <nowy-katalog> [--password-file <plik-0600>] [--config-file <plik-0600> tylko snapshot]
Restore nigdy nie nadpisuje katalogu i nie uruchamia aplikacji. Wszystkie sesje i subskrypcje push są usuwane.\n`;

export async function runBackupCommand(argv: string[], io: AdminIo, databasePath: string): Promise<number> {
  const [command, ...rest] = argv;
  const allowed = command === 'backup' ? ['--directory', '--config-file'] : command === 'backup-encrypt'
    ? ['--archive', '--output', '--password-file'] : ['--archive', '--encrypted', '--snapshot', '--target', '--password-file', '--config-file'];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!, value = rest[i + 1];
    if (!allowed.includes(flag) || flags.has(flag) || !value || value.startsWith('--')) { io.error.write(usage); return 2; }
    flags.set(flag, resolve(value));
  }
  try {
    if (command === 'backup') {
      const directory = flags.get('--directory') ?? resolve(dirname(databasePath), 'backups');
      const configFile = flags.get('--config-file');
      const now = new Date();
      const archive = createBackup(databasePath, directory, { now, ...(configFile ? { configFile } : {}) });
      // A weekly copy is refreshed from the same immutable daily snapshot on every run.
      // Retention keeps one per UTC Monday–Sunday bucket, so missed Mondays are harmless.
      const manifest = inspectBackup(archive);
      createBackupFromDaily(archive, directory, now, configFile);
      const removed = retainBackups(directory, manifest.householdId);
      io.output.write(`Backup sprawdzony (integrity_check + FK); archiwum: ${archive}; usunięte własne kopie: ${removed.length}.\n`);
    } else if (command === 'backup-encrypt') {
      const archive = flags.get('--archive'), output = flags.get('--output'), password = flags.get('--password-file');
      if (!archive || !output || !password) { io.error.write(usage); return 2; }
      await encryptBackup(archive, output, password);
      io.output.write('Zapisano zaszyfrowane archiwum. Przenieś je poza serwer samodzielnie; hasło przechowuj osobno.\n');
    } else {
      const snapshot = flags.get('--snapshot'), configFile = flags.get('--config-file');
      const archive = flags.get('--archive'), encrypted = flags.get('--encrypted'), target = flags.get('--target'), password = flags.get('--password-file');
      if (!target || [archive, encrypted, snapshot].filter(Boolean).length !== 1 || (encrypted && !password) || (!encrypted && password) || (configFile && !snapshot)) { io.error.write(usage); return 2; }
      if (encrypted) await restoreEncrypted(encrypted, target, password!);
      else if (snapshot) restoreSnapshot(snapshot, target, configFile);
      else restoreBackup(archive!, target);
      io.output.write('Odtworzono izolowany katalog. Sesje odwołane, subskrypcje push usunięte; wymagane logowanie i ponowne włączenie push. Aplikacja nie została uruchomiona.\n');
    }
    return 0;
  } catch {
    io.error.write('Backup/restore nie powiódł się. Sprawdź uprawnienia, wolne miejsce, schemat i integralność; istniejący cel nie jest nadpisywany.\n');
    return 1;
  }
}

// Read the frozen daily snapshot rather than the live WAL source a second time.
function createBackupFromDaily(archive: string, directory: string, now: Date, configFile: string | undefined) {
  return createBackup(resolve(archive, 'database.sqlite'), directory, { now, kind: 'weekly', ...(configFile ? { configFile: resolve(archive, 'configuration.env') } : {}) });
}
