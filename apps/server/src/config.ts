import { resolve } from 'node:path';
import { migrate, openDatabase } from '@razem/db';

export interface ServerSettings {
  production: boolean;
  databasePath: string;
  host: string;
  port: number;
  secureCookies: boolean;
  publicOrigin?: string;
  trustProxy: boolean | string;
}

export function serverSettings(env: NodeJS.ProcessEnv = process.env): ServerSettings {
  const production = env.NODE_ENV === 'production';
  // Insecure cookies are a development convenience for plain-http localhost only.
  if (production && env.COOKIE_SECURE === 'false') throw new Error('COOKIE_SECURE=false jest niedozwolone w produkcji');
  let publicOrigin: string | undefined;
  if (env.PUBLIC_ORIGIN) {
    const url = new URL(env.PUBLIC_ORIGIN);
    if (url.origin !== env.PUBLIC_ORIGIN || (production && url.protocol !== 'https:' && url.hostname !== '127.0.0.1')) throw new Error('Niepoprawny PUBLIC_ORIGIN');
    publicOrigin = url.origin;
  }
  const proxy = env.TRUST_PROXY?.trim();
  return {
    production,
    databasePath: resolve(env.DATABASE_PATH ?? './data/razem.sqlite'),
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 3100),
    secureCookies: env.COOKIE_SECURE !== 'false',
    ...(publicOrigin ? { publicOrigin } : {}),
    trustProxy: !proxy || proxy === 'false' ? false : proxy === 'true' ? true : proxy,
  };
}

export function openMigratedDatabase(path: string) {
  const database = openDatabase(path);
  try {
    const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
    const migration = migrate(database.sqlite, { backupPath: (version) => `${path}.pre-migration-v${version}-${stamp()}.bak` });
    return { database, migration };
  } catch (error) {
    database.close();
    throw error;
  }
}
