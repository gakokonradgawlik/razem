// Private JSON is streamed on stdin, never passed as an argument or logged.
import { AuthService } from '../apps/server/dist/auth/service.js';
import { openMigratedDatabase } from '../apps/server/dist/config.js';
import { argon2ParamsFromEnv } from '../apps/server/dist/auth/passwords.js';

let database;
try {
  ({ database } = openMigratedDatabase(process.env.DATABASE_PATH));
  const service = new AuthService(database, { argon2: argon2ParamsFromEnv() });
  if (!service.accounts.household()) {
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 16384) throw new Error();
    }
    await service.bootstrap(JSON.parse(raw));
    console.info('Razem: utworzono dwa konta; wymagana zmiana haseł przy logowaniu');
  } else if (service.accounts.memberCount() !== 2) throw new Error();
  else console.info('Razem: zachowano istniejące konta');
} catch {
  console.error('Razem: bootstrap nie powiódł się; wymagany poprawny prywatny JSON dwóch kont');
  process.exitCode = 1;
} finally { database?.close(); }
