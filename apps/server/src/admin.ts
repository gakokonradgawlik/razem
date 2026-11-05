import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import { Writable } from 'node:stream';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { DEFAULT_TIMEZONE } from '@razem/contracts';
import { migrationStatus } from '@razem/db';
import { argon2ParamsFromEnv, hashPassword } from './auth/passwords.js';
import { AuthError, AuthService } from './auth/service.js';
import type { AuthConfig } from './auth/service.js';
import { openMigratedDatabase, serverSettings } from './config.js';
import { BACKUP_COMMANDS, runBackupCommand } from './backup/cli.js';

// Local administrator CLI. Passwords are read from stdin only (hidden on a terminal),
// never accepted as arguments or environment variables and never printed.

export interface AdminIo { input: Readable & { isTTY?: boolean }; output: Writable; error: Writable }

class Prompter {
  private muted = false;
  private readonly rl: Interface;
  private readonly lines: AsyncIterator<string>;
  constructor(private readonly io: AdminIo) {
    const sink = new Writable({ write: (chunk, encoding, done) => { if (!this.muted) io.error.write(chunk, encoding); done(); } });
    this.rl = createInterface({ input: io.input, output: sink, terminal: Boolean(io.input.isTTY) });
    this.lines = this.rl[Symbol.asyncIterator]();
  }
  async ask(question: string, hidden = false): Promise<string> {
    this.io.error.write(question);
    this.muted = hidden;
    const next = await this.lines.next();
    this.muted = false;
    if (hidden && this.io.input.isTTY) this.io.error.write('\n');
    if (next.done) throw new AuthError('invalid_request', 'Brak danych na wejściu');
    return next.value;
  }
  async password(label: string): Promise<string> {
    const first = await this.ask(`${label}: `, true);
    // Interactive entry is confirmed; piped synthetic input is a single line.
    if (this.io.input.isTTY && first !== await this.ask('Powtórz hasło: ', true)) throw new AuthError('invalid_request', 'Hasła nie są identyczne');
    return first;
  }
  close() { this.rl.close(); }
}

const USAGE = `Użycie: razem-admin <polecenie>
  bootstrap                utwórz gospodarstwo i dwa konta (hasła tymczasowe ze stdin)
  reset-password <login>   ustaw hasło tymczasowe ze stdin, odwołaj sesje
  revoke-sessions <login>  wyloguj konto na wszystkich urządzeniach
  migrate                  zastosuj oczekujące migracje (z kopią przed zmianą)
  status                   wersja schematu i liczba kont
  backup [opcje]           lokalna kopia + retencja 7 dziennych i 4 tygodniowe
  backup-encrypt [opcje]   zaszyfruj kopię do samodzielnego przeniesienia
  restore [opcje]          odtwórz wyłącznie do nowego katalogu
  measure-argon2           zmierz czas Argon2id dla bieżących parametrów
`;

export async function runAdmin(argv: string[], io: AdminIo, options: { env?: NodeJS.ProcessEnv; auth?: Partial<AuthConfig> } = {}): Promise<number> {
  const env = options.env ?? process.env;
  const [command, argument] = argv;
  const say = (line: string) => io.output.write(`${line}\n`);
  if (!command || command === 'help' || command === '--help') { io.error.write(USAGE); return command ? 0 : 2; }
  if (BACKUP_COMMANDS.some((c) => c === command)) return runBackupCommand(argv, io, serverSettings(env).databasePath);
  if (!['bootstrap', 'reset-password', 'revoke-sessions', 'migrate', 'status', 'measure-argon2'].includes(command)) {
    io.error.write(USAGE);
    return 2;
  }
  const authConfig = { argon2: argon2ParamsFromEnv(env), ...options.auth };
  if (command === 'measure-argon2') {
    const started = performance.now();
    await hashPassword('pomiar-syntetyczny-hasla', authConfig.argon2);
    const ms = Math.round(performance.now() - started);
    say(`Argon2id m=${authConfig.argon2.memory} KiB, t=${authConfig.argon2.passes}, p=${authConfig.argon2.parallelism}: ${ms} ms`);
    say('Cel: 100–1000 ms na serwerze przy zachowaniu limitu pamięci kontenera.');
    return 0;
  }
  const { database, migration } = openMigratedDatabase(serverSettings(env).databasePath);
  const prompter = new Prompter(io);
  try {
    if (migration.applied.length > 0) say(`Zastosowano migracje: ${migration.applied.join(', ')}${migration.backup ? ' (kopia przed migracją zapisana obok bazy)' : ''}`);
    const service = new AuthService(database, authConfig);
    switch (command) {
      case 'migrate':
        if (migration.applied.length === 0) say('Schemat aktualny');
        return 0;
      case 'status': {
        const status = migrationStatus(database.sqlite);
        say(`Schemat ${status.current}/${status.latest}; gospodarstwo: ${service.accounts.household() ? 'tak' : 'nie'}; konta: ${service.accounts.memberCount()}`);
        return 0;
      }
      case 'bootstrap': {
        if (service.accounts.household()) throw new AuthError('already_bootstrapped');
        io.error.write('Tworzenie gospodarstwa i dwóch kont. Hasła są tymczasowe; każda osoba ustawi własne przy pierwszym logowaniu.\n');
        const householdName = await prompter.ask('Nazwa gospodarstwa: ');
        const timezone = await prompter.ask(`Strefa czasowa [${DEFAULT_TIMEZONE}]: `);
        const members = [];
        for (const label of ['Pierwsze konto', 'Drugie konto']) {
          io.error.write(`${label}\n`);
          const login = await prompter.ask('  Login (e-mail lub nazwa): ');
          const displayName = await prompter.ask('  Wyświetlana nazwa: ');
          const temporaryPassword = await prompter.password('  Hasło tymczasowe (min. 12 znaków)');
          members.push({ login, displayName, temporaryPassword });
        }
        await service.bootstrap({ householdName, timezone, members });
        say('Utworzono gospodarstwo i dwa konta. Przekaż hasła tymczasowe osobiście; nie zapisuj ich w plikach.');
        return 0;
      }
      case 'reset-password': {
        if (!argument) { io.error.write(USAGE); return 2; }
        const temporaryPassword = await prompter.password('Nowe hasło tymczasowe (min. 12 znaków)');
        await service.resetPassword(argument, temporaryPassword);
        say('Hasło zresetowane; wszystkie sesje konta odwołane, zmiana hasła wymagana przy logowaniu.');
        return 0;
      }
      case 'revoke-sessions': {
        if (!argument) { io.error.write(USAGE); return 2; }
        say(`Odwołano sesje: ${service.revokeSessions(argument)}`);
        return 0;
      }
    }
    return 2;
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
    const messages: Record<string, string> = {
      already_bootstrapped: 'Gospodarstwo już istnieje; użyj reset-password dla istniejących kont.',
      unknown_account: 'Nie znaleziono konta.',
      weak_password: `Hasło odrzucone: ${error.detail ?? 'zbyt słabe'}.`,
      invalid_request: `Niepoprawne dane: ${error.detail ?? ''}`,
    };
    io.error.write(`Błąd: ${messages[error.code] ?? error.code}\n`);
    return 1;
  } finally {
    prompter.close();
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runAdmin(process.argv.slice(2), { input: process.stdin, output: process.stdout, error: process.stderr });
  } catch {
    // No stack traces: they could include file paths with data or input fragments.
    process.stderr.write('Błąd: operacja nie powiodła się\n');
    process.exitCode = 1;
  }
}
