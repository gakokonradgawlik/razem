// Test-only: the real Fastify + SQLite server (RAZ-4) and synthetic "phones" whose
// PWA data layer (Dexie on fake-indexeddb) talks to it through app.inject().
// Synthetic household, accounts and content only. Never imported by the app bundle.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { migrate, openDatabase } from '@razem/db';
import type { Database } from '@razem/db';
import { buildApp, syncServiceOf } from '../../../server/src/app.js';
import { hashPassword } from '../../../server/src/auth/passwords.js';
import { Api } from '../api.js';
import type { Fetcher } from '../api.js';
import { AppController } from './controller.js';
import type { EngineOptions } from './sync.js';

const FAST = { memory: 1024, passes: 1, parallelism: 1 };
export const ORIGIN = 'https://razem.test';
export const HOUSEHOLD = '00000000-0000-4000-8000-000000000001';
export const ACCOUNTS = {
  a: { id: '00000000-0000-4000-8000-0000000000aa', login: 'a@example.test', password: 'Syntetyczne haslo A 2026' },
  b: { id: '00000000-0000-4000-8000-0000000000bb', login: 'b@example.test', password: 'Syntetyczne haslo B 2026' },
};

export type Server = Awaited<ReturnType<typeof startServer>>;
export async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'razem-client-'));
  const database: Database = openDatabase(join(dir, 'razem.sqlite'));
  migrate(database.sqlite);
  const clock = { now: Date.now() };
  const T = new Date(clock.now).toISOString();
  database.sqlite.prepare('INSERT INTO households VALUES (?, ?, ?, ?)').run(HOUSEHOLD, 'Syntetyczny dom', 'Europe/Warsaw', T);
  const user = database.sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, 0, ?, ?)');
  user.run(ACCOUNTS.a.id, HOUSEHOLD, ACCOUNTS.a.login, 'Konto A', await hashPassword(ACCOUNTS.a.password, FAST), T, T);
  user.run(ACCOUNTS.b.id, HOUSEHOLD, ACCOUNTS.b.login, 'Konto B', await hashPassword(ACCOUNTS.b.password, FAST), T, T);
  const time = () => new Date(clock.now);
  const app = await buildApp({ database, publicOrigin: ORIGIN, auth: { argon2: FAST, clock: time }, sync: { clock: time } });
  const pushes: string[][] = [];
  return {
    app, database, clock, pushes, sync: syncServiceOf(app),
    count(table: string, where = '1') { return (database.sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n; },
    async close() { await app.close(); database.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Browser-like network of one device: cookie jar, offline switch and failure injection. */
export class Network {
  cookie: string | undefined;
  offline = false;
  /** Next N push responses are lost AFTER the server committed (timeout after commit). */
  losePushResponses = 0;
  /** Server/proxy unavailable: every request answers with this status. */
  outage: number | null = null;
  timeout = false;
  /** Called before each pull request (e.g. to write on the server during paging). */
  beforePull: (() => Promise<void>) | null = null;
  /** Called before a push is sent / after any response arrived (the caller's code has not seen it yet). */
  beforePush: (() => Promise<void>) | null = null;
  afterResponse: ((request: string) => Promise<void>) | null = null;
  /** Push requests in flight now and at most at any moment (parallel sending of one queue). */
  pushesInFlight = 0;
  maxPushesInFlight = 0;
  requests: string[] = [];
  constructor(private readonly server: Server) {}

  readonly fetcher: Fetcher = async (url, init) => {
    const isPush = url === '/api/sync/push';
    if (isPush) { this.pushesInFlight++; this.maxPushesInFlight = Math.max(this.maxPushesInFlight, this.pushesInFlight); }
    let response: Response;
    try { response = await this.send(url, init); } finally { if (isPush) this.pushesInFlight--; }
    if (this.afterResponse) await this.afterResponse(`${init.method ?? 'GET'} ${url.split('?')[0]}`);
    return response;
  };

  private async send(url: string, init: RequestInit): Promise<Response> {
    this.requests.push(`${init.method ?? 'GET'} ${url.split('?')[0]}`);
    if (this.offline) throw new TypeError('Failed to fetch');
    if (this.timeout) throw new DOMException('The operation timed out.', 'TimeoutError');
    if (this.outage) return new Response('<html>Bad gateway</html>', { status: this.outage, headers: { 'content-type': 'text/html' } });
    if (url.startsWith('/api/sync/pull') && this.beforePull) await this.beforePull();
    if (url === '/api/sync/push' && this.beforePush) await this.beforePush();
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>), origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
    if (this.cookie) headers.cookie = this.cookie;
    const body = typeof init.body === 'string' ? init.body : undefined;
    if (url === '/api/sync/push' && body) this.server.pushes.push((JSON.parse(body) as { mutations: { clientMutationId: string }[] }).mutations.map((m) => m.clientMutationId));
    const response = await this.server.app.inject({ method: (init.method ?? 'GET') as 'GET', url, headers, ...(body !== undefined ? { payload: body } : {}) });
    const raw = response.headers['set-cookie'];
    for (const line of Array.isArray(raw) ? raw : raw ? [String(raw)] : []) {
      const pair = line.split(';')[0]!;
      this.cookie = /Max-Age=0/i.test(line) || pair.endsWith('=') ? undefined : pair;
    }
    if (url === '/api/sync/push' && this.losePushResponses > 0) { this.losePushResponses--; throw new TypeError('Network connection was lost'); }
    const out = new Headers({ 'content-type': String(response.headers['content-type'] ?? 'application/json') });
    if (response.headers['retry-after']) out.set('retry-after', String(response.headers['retry-after']));
    return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode, headers: out });
  }

  /** Signs this device's browser in as someone else (as another tab would): the cookie changes. */
  async signInElsewhere(account: { login: string; password: string }) {
    const hook = this.afterResponse; this.afterResponse = null;
    try {
      const response = await this.send('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: account.login, password: account.password }) });
      if (!response.ok) throw new Error(`login failed ${response.status}`);
    } finally { this.afterResponse = hook; }
  }
}

export class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}

/** One physical device: IndexedDB, localStorage and network shared by its tabs. */
export class Phone {
  readonly indexedDB = new IDBFactory();
  readonly storage = new MemoryStorage();
  readonly network: Network;
  online = true;
  constructor(server: Server) { this.network = new Network(server); }

  /** A tab of the PWA on this device. */
  tab(engine: EngineOptions = {}) {
    return new AppController({
      api: new Api(this.network.fetcher), storage: this.storage,
      dbOptions: { indexedDB: this.indexedDB, IDBKeyRange },
      engine: { isOnline: () => this.online && !this.network.offline, ...engine },
    });
  }
  setOffline(offline: boolean) { this.online = !offline; this.network.offline = offline; }
}
