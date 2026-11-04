import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { meResponseSchema } from '@razem/contracts';
import { migrate, openDatabase } from '@razem/db';
import type { Database } from '@razem/db';
import { buildApp } from './app.js';
import { runAdmin } from './admin.js';
import { AuthService } from './auth/service.js';
import type { AuthConfig } from './auth/service.js';

// Synthetic accounts and passwords only. Small Argon2id cost keeps tests fast; production
// parameters are covered in passwords.test.ts.
const FAST = { memory: 1024, passes: 1, parallelism: 1 };
const ORIGIN = 'https://razem.test';
const TEMP_A = 'Tymczasowe-A-7e1c';
const TEMP_B = 'Tymczasowe-B-93fd';
const OWN_A = 'Wlasne haslo A 2026!';
const DAY = 86_400_000;

let dir: string;
let dbPath: string;
let now: number;
const clock = () => new Date(now);
const auth: Partial<AuthConfig> = { argon2: FAST, clock };
const open: Array<{ close: () => unknown }> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'razem-auth-'));
  dbPath = join(dir, 'data', 'razem.sqlite');
  now = Date.parse('2026-11-04T10:00:00.000Z');
});
afterEach(async () => {
  for (const item of open.splice(0).reverse()) await item.close();
  rmSync(dir, { recursive: true, force: true });
});

function io(lines: string[]) {
  const input = new PassThrough();
  input.end(lines.map((l) => `${l}\n`).join(''));
  let out = '';
  let err = '';
  const sink = (fn: (s: string) => void) => new PassThrough().on('data', (c: Buffer) => fn(c.toString()));
  return { io: { input, output: sink((s) => { out += s; }), error: sink((s) => { err += s; }) }, text: () => out + err };
}
const admin = async (argv: string[], lines: string[] = []) => {
  const x = io(lines);
  const code = await runAdmin(argv, x.io, { env: { DATABASE_PATH: dbPath }, auth });
  await new Promise((r) => setImmediate(r));
  return { code, text: x.text() };
};
const bootstrapLines = ['Syntetyczny dom', '', 'a@example.test', 'Konto A', TEMP_A, 'B@Example.test ', 'Konto B', TEMP_B];

async function server(extra: { publicOrigin?: string } = { publicOrigin: ORIGIN }) {
  const database: Database = openDatabase(dbPath);
  const app = await buildApp({ database, auth, ...extra });
  open.push(database, app);
  return { app, database };
}
type App = Awaited<ReturnType<typeof server>>['app'];
const json = { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
function sessionCookie(response: { headers: Record<string, unknown> }): string | undefined {
  const raw = response.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw as string[] : raw ? [String(raw)] : [];
  const last = list.at(-1);
  return last?.split(';')[0];
}
const login = (app: App, user: string, password: string, ip = '203.0.113.1') =>
  app.inject({ method: 'POST', url: '/api/auth/login', headers: json, payload: { login: user, password }, remoteAddress: ip });
const get = (app: App, url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

describe('bootstrap i reset CLI', () => {
  it.each([
    ['emoji', '😀😁😂😃'.repeat(64), '😄😅😆😉'.repeat(64)],
    ['NFD', 'a\u0301e\u0301i\u0301o\u0301'.repeat(64), 'u\u0301y\u0301c\u0301n\u0301'.repeat(64)],
  ])('CLI i HTTP: granica Unicode %s, bootstrap/reset → login → zmiana', async (_label, temporary, own) => {
    const lines = [...bootstrapLines];
    lines[4] = temporary;
    const boot = await admin(['bootstrap'], lines);
    expect(boot.code).toBe(0);
    expect(boot.text).not.toContain(temporary);
    const { app } = await server();
    for (const phase of ['bootstrap', 'reset']) {
      if (phase === 'reset') {
        const reset = await admin(['reset-password', 'a@example.test'], [temporary]);
        expect(reset.code).toBe(0);
        expect(reset.text).not.toContain(temporary);
      }
      const signed = await login(app, 'a@example.test', temporary.normalize('NFC'));
      expect(signed.statusCode).toBe(200);
      const cookie = sessionCookie(signed)!;
      expect((await get(app, '/api/me', cookie)).json().user.mustChangePassword).toBe(true);
      expect((await get(app, '/api/sync/pull', cookie)).statusCode).toBe(403);
      const changed = await app.inject({ method: 'POST', url: '/api/auth/password',
        headers: { ...json, cookie }, payload: { currentPassword: temporary, newPassword: own } });
      expect(changed.statusCode).toBe(200);
      expect((await get(app, '/api/me', sessionCookie(changed)!)).json().user.mustChangePassword).toBe(false);
      expect((await login(app, 'a@example.test', own.normalize('NFC'))).statusCode).toBe(200);
    }
    const over = temporary + 'x'; // 257 code points after NFC
    expect((await admin(['reset-password', 'a@example.test'], [over])).code).toBe(1);
    expect((await login(app, 'a@example.test', over)).statusCode).toBe(400);
    const cookie = sessionCookie(await login(app, 'a@example.test', own))!;
    for (const payload of [
      { currentPassword: own, newPassword: over },
      { currentPassword: over, newPassword: temporary },
    ]) {
      expect((await app.inject({ method: 'POST', url: '/api/auth/password',
        headers: { ...json, cookie }, payload })).statusCode).toBe(400);
    }
    expect((await login(app, 'a@example.test', own)).statusCode).toBe(200);
  });

  it('CLI bootstrap odrzuca 257 punktów kodowych po NFC bez zapisania kont', async () => {
    const lines = [...bootstrapLines];
    lines[4] = '😀😁😂😃'.repeat(64) + 'x';
    expect((await admin(['bootstrap'], lines)).code).toBe(1);
    expect((await admin(['status'])).text).toContain('konta: 0');
  });

  it('tworzy gospodarstwo i dwa konta bez drukowania haseł; wymusza zmianę; drugi bootstrap odmawia', async () => {
    const result = await admin(['bootstrap'], bootstrapLines);
    expect(result.code).toBe(0);
    expect(result.text).not.toContain(TEMP_A);
    expect(result.text).not.toContain(TEMP_B);
    const database = openDatabase(dbPath);
    open.push(database);
    const users = database.sqlite.prepare('SELECT login, must_change_password AS m, password_hash AS h FROM users ORDER BY login').all() as Array<{ login: string; m: number; h: string }>;
    expect(users.map((u) => [u.login, u.m])).toEqual([['a@example.test', 1], ['b@example.test', 1]]);
    expect(users.every((u) => u.h.startsWith('$argon2id$v=19$'))).toBe(true);
    expect(database.sqlite.prepare('SELECT timezone FROM households').get()).toEqual({ timezone: 'Europe/Warsaw' });
    expect((await admin(['bootstrap'], bootstrapLines)).code).toBe(1);
    expect(database.sqlite.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 2 });
  });

  it('odrzuca słabe hasło tymczasowe i jedno konto zamiast dwóch, niczego nie zapisując', async () => {
    const weak = await admin(['bootstrap'], ['Dom', '', 'a@example.test', 'A', 'krotkie', 'b@example.test', 'B', TEMP_B]);
    expect(weak.code).toBe(1);
    expect(weak.text).not.toContain('krotkie');
    const truncated = await admin(['bootstrap'], ['Dom', '', 'a@example.test', 'A', TEMP_A]);
    expect(truncated.code).toBe(1);
    expect((await admin(['status'])).text).toContain('konta: 0');
  });

  it('reset hasła odwołuje sesje, wymusza zmianę, zapisuje zdarzenie bez sekretu', async () => {
    await admin(['bootstrap'], bootstrapLines);
    const { app, database } = await server();
    const cookie = sessionCookie(await login(app, 'a@example.test', TEMP_A))!;
    expect((await get(app, '/api/me', cookie)).statusCode).toBe(200);
    const reset = await admin(['reset-password', 'A@example.test'], ['Reset-Syntetyczny-55']);
    expect(reset.code).toBe(0);
    expect(reset.text).not.toContain('Reset-Syntetyczny-55');
    expect((await get(app, '/api/me', cookie)).statusCode).toBe(401);
    expect((await login(app, 'a@example.test', TEMP_A)).statusCode).toBe(401);
    const fresh = await login(app, 'a@example.test', 'Reset-Syntetyczny-55');
    expect(meResponseSchema.parse(fresh.json()).user.mustChangePassword).toBe(true);
    const kinds = database.sqlite.prepare("SELECT kind FROM auth_events WHERE user_id = (SELECT id FROM users WHERE login = 'a@example.test') ORDER BY id").all();
    expect(kinds.map((k) => (k as { kind: string }).kind)).toEqual(['bootstrap', 'login', 'password_reset', 'login']);
    expect((await admin(['reset-password', 'nikt@example.test'], ['Reset-Syntetyczny-55'])).code).toBe(1);
    const revoke = await admin(['revoke-sessions', 'a@example.test']);
    expect(revoke.text).toContain('Odwołano sesje: 1');
    expect((await get(app, '/api/me', sessionCookie(fresh))).statusCode).toBe(401);
  });
});

describe('logowanie i sesje', () => {
  beforeEach(async () => { await admin(['bootstrap'], bootstrapLines); });

  it('brak publicznej rejestracji i konta demo; czysta baza nie ma kont', async () => {
    const { app, database } = await server();
    for (const url of ['/api/auth/register', '/api/auth/signup', '/api/users']) {
      expect((await app.inject({ method: 'POST', url, headers: json, payload: { login: 'x@example.test', password: 'Haslo-Rejestracji-1' } })).statusCode).toBe(401);
    }
    expect(database.sqlite.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 2 });
    for (const [user, password] of [['admin', 'admin'], ['demo', 'demo'], ['razem', 'razem']]) expect((await login(app, user!, password!)).statusCode).toBe(401);
    const emptyDir = mkdtempSync(join(tmpdir(), 'razem-empty-'));
    try {
      const empty = openDatabase(join(emptyDir, 'e.sqlite'));
      migrate(empty.sqlite);
      const emptyApp = await buildApp({ database: empty, auth, publicOrigin: ORIGIN });
      // Fresh installation: login fails until the administrator bootstraps via the local CLI.
      expect((await login(emptyApp, 'a@example.test', TEMP_A)).statusCode).toBe(401);
      expect(empty.sqlite.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 0 });
      await emptyApp.close();
      empty.close();
    } finally { rmSync(emptyDir, { recursive: true, force: true }); }
  });

  it('hasło tymczasowe: cookie HttpOnly/Secure/SameSite, dostęp tylko do zmiany hasła; zmiana rotuje sesję', async () => {
    const { app } = await server();
    const first = await login(app, 'a@example.test', TEMP_A);
    expect(first.statusCode).toBe(200);
    const header = String(first.headers['set-cookie']);
    expect(header).toMatch(/^__Host-razem_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict; Secure$/);
    expect(JSON.stringify(first.json())).not.toMatch(/argon|hash|token/i);
    const temp = sessionCookie(first)!;
    expect(meResponseSchema.parse((await get(app, '/api/me', temp)).json()).user).toMatchObject({ login: 'a@example.test', mustChangePassword: true });
    expect((await get(app, '/api/sync/pull', temp)).json()).toEqual({ error: 'password_change_required' });
    expect((await get(app, '/api/export', temp)).statusCode).toBe(403);
    // Second device of the same account, also on the temporary password.
    const otherDevice = sessionCookie(await login(app, 'a@example.test', TEMP_A))!;
    const change = (cookie: string, currentPassword: string, newPassword: string) =>
      app.inject({ method: 'POST', url: '/api/auth/password', headers: { ...json, cookie }, payload: { currentPassword, newPassword } });
    expect((await change(temp, 'zle-haslo-obecne', OWN_A)).statusCode).toBe(401);
    expect((await change(temp, TEMP_A, 'krotkie')).json()).toMatchObject({ error: 'weak_password' });
    expect((await change(temp, TEMP_A, TEMP_A)).json()).toMatchObject({ error: 'weak_password' });
    const changed = await change(temp, TEMP_A, OWN_A);
    expect(changed.statusCode).toBe(200);
    expect(meResponseSchema.parse(changed.json()).user.mustChangePassword).toBe(false);
    const own = sessionCookie(changed)!;
    expect(own).not.toBe(temp);
    expect((await get(app, '/api/me', temp)).statusCode).toBe(401);
    expect((await get(app, '/api/me', otherDevice)).statusCode).toBe(401);
    expect((await get(app, '/api/sync/pull', own)).statusCode).toBe(200); // authenticated with own password (RAZ-4)
    expect((await login(app, 'a@example.test', TEMP_A)).statusCode).toBe(401);
    expect((await login(app, 'A@EXAMPLE.TEST', OWN_A)).statusCode).toBe(200);
  });

  it('błędne hasło i nieznany login dają ten sam ogólny błąd; podrobione cookie nie działa', async () => {
    const { app } = await server();
    const wrong = await login(app, 'a@example.test', 'nie-to-haslo-123');
    const unknown = await login(app, 'nikt@example.test', 'nie-to-haslo-123');
    expect([wrong.statusCode, unknown.statusCode]).toEqual([401, 401]);
    expect(wrong.json()).toEqual({ error: 'invalid_credentials' });
    expect(unknown.json()).toEqual(wrong.json());
    for (const cookie of ['__Host-razem_session=' + 'A'.repeat(43), '__Host-razem_session=../../etc', 'razem_session=x', 'x-user-id=a']) {
      expect((await get(app, '/api/me', cookie)).statusCode).toBe(401);
    }
    const valid = sessionCookie(await login(app, 'b@example.test', TEMP_B))!;
    const me = meResponseSchema.parse((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: valid, 'x-user-id': 'a' } })).json());
    expect(me.user.login).toBe('b@example.test');
  });

  it('wygaśnięcie po 30 dniach bez aktywności, odnowienie najwyżej raz na dobę z rotacją i okresem łaski', async () => {
    const { app, database } = await server();
    const original = sessionCookie(await login(app, 'a@example.test', TEMP_A))!;
    now += 12 * 3_600_000;
    const early = await get(app, '/api/me', original);
    expect(early.statusCode).toBe(200);
    expect(early.headers['set-cookie']).toBeUndefined(); // no renewal within 24h
    now += 13 * 3_600_000;
    const renewed = await get(app, '/api/me', original);
    const rotated = sessionCookie(renewed)!;
    expect(rotated).toMatch(/^__Host-razem_session=/);
    expect(rotated).not.toBe(original);
    expect((await get(app, '/api/me', original)).statusCode).toBe(200); // parallel request in grace window
    now += 3 * 60_000;
    expect((await get(app, '/api/me', original)).statusCode).toBe(401);
    expect((await get(app, '/api/me', rotated)).statusCode).toBe(200);
    now += 29 * DAY; // within 30 days of the renewal
    const late = await get(app, '/api/me', rotated);
    expect(late.statusCode).toBe(200);
    const idle = sessionCookie(late)!;
    expect(idle).not.toBe(rotated);
    now += 30 * DAY + 1000;
    const expired = await get(app, '/api/me', idle);
    expect(expired.statusCode).toBe(401);
    expect(String(expired.headers['set-cookie'])).toContain('Max-Age=0');
    expect(database.sqlite.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('wylogowanie unieważnia tylko bieżącą sesję i czyści cookie', async () => {
    const { app } = await server();
    const phone = sessionCookie(await login(app, 'a@example.test', TEMP_A))!;
    const laptop = sessionCookie(await login(app, 'a@example.test', TEMP_A))!;
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: ORIGIN, cookie: phone } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/^__Host-razem_session=; Path=\/; Max-Age=0; HttpOnly; SameSite=Strict; Secure$/);
    expect((await get(app, '/api/me', phone)).statusCode).toBe(401);
    expect((await get(app, '/api/me', laptop)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: ORIGIN, cookie: phone } })).statusCode).toBe(401);
  });

  it('CSRF: mutacje tylko z własnego originu, same-origin i jako JSON', async () => {
    const { app } = await server();
    const cookie = sessionCookie(await login(app, 'a@example.test', TEMP_A))!;
    const attempts = [
      { 'content-type': 'application/json' },
      { 'content-type': 'application/json', origin: 'https://evil.example' },
      { 'content-type': 'application/json', origin: 'null' },
      { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'cross-site' },
      { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-site' },
    ];
    for (const headers of attempts) {
      expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { login: 'a@example.test', password: TEMP_A } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, cookie } })).statusCode).toBe(403);
    }
    const form = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN, 'content-type': 'text/plain' }, payload: '{"login":"a@example.test"}' });
    expect(form.statusCode).toBe(415);
    expect((await get(app, '/api/me', cookie)).statusCode).toBe(200); // session survived
    expect((await app.inject({ method: 'OPTIONS', url: '/api/auth/login', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } })).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('bez PUBLIC_ORIGIN akceptuje wyłącznie origin zgodny z hostem żądania', async () => {
    const { app } = await server({});
    const payload = { login: 'a@example.test', password: TEMP_A };
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'razem.lan', origin: 'http://razem.lan', 'content-type': 'application/json' }, payload });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'razem.lan', origin: 'http://evil.lan', 'content-type': 'application/json' }, payload });
    expect(bad.statusCode).toBe(403);
  });

  it('limit logowania: blokada konta po 5 błędach także dla poprawnego hasła, zwolnienie po czasie', async () => {
    const { app, database } = await server();
    for (let i = 0; i < 4; i++) expect((await login(app, 'a@example.test', `zle-haslo-${i}-xx`)).statusCode).toBe(401);
    const locked = await login(app, 'a@example.test', 'zle-haslo-5-xx');
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toEqual({ error: 'rate_limited' });
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await login(app, 'a@example.test', TEMP_A, '198.51.100.7')).statusCode).toBe(429); // other IP, same account
    expect((await login(app, 'b@example.test', TEMP_B)).statusCode).toBe(200); // partner unaffected
    now += 15 * 60_000 + 1000;
    expect((await login(app, 'a@example.test', TEMP_A)).statusCode).toBe(200);
    const rows = database.sqlite.prepare('SELECT key_hash FROM auth_throttle').all() as Array<{ key_hash: string }>;
    expect(rows.every((r) => /^[a-f0-9]{64}$/.test(r.key_hash))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('example.test');
  });

  it('limit per IP: 20 błędów z jednego adresu blokuje kolejne próby z niego', async () => {
    const { app } = await server();
    for (let i = 0; i < 19; i++) expect((await login(app, `zgadywany${i}@example.test`, 'nie-to-haslo-123', '192.0.2.9')).statusCode).toBe(401);
    expect((await login(app, 'zgadywany19@example.test', 'nie-to-haslo-123', '192.0.2.9')).statusCode).toBe(429);
    expect((await login(app, 'a@example.test', TEMP_A, '192.0.2.9')).statusCode).toBe(429);
    expect((await login(app, 'a@example.test', TEMP_A, '192.0.2.10')).statusCode).toBe(200);
  });

  it('przeterminowane liczniki prób są usuwane przy kolejnych błędach', async () => {
    const { app, database } = await server();
    for (let i = 0; i < 3; i++) await login(app, `stary${i}@example.test`, 'nie-to-haslo-123', `192.0.2.${i + 20}`);
    expect(database.sqlite.prepare('SELECT count(*) AS n FROM auth_throttle').get()).toEqual({ n: 6 });
    now += 16 * 60_000;
    await login(app, 'nowy@example.test', 'nie-to-haslo-123', '192.0.2.99');
    expect(database.sqlite.prepare('SELECT count(*) AS n FROM auth_throttle').get()).toEqual({ n: 2 });
  });

  it('baza, WAL i zdarzenia nie zawierają haseł ani tokenów; limity payloadu', async () => {
    const { app, database } = await server();
    const response = await login(app, 'a@example.test', TEMP_A);
    const token = sessionCookie(response)!.split('=')[1]!;
    await app.inject({ method: 'POST', url: '/api/auth/password', headers: { ...json, cookie: sessionCookie(response)! }, payload: { currentPassword: TEMP_A, newPassword: OWN_A } });
    const big = await app.inject({ method: 'POST', url: '/api/auth/login', headers: json, payload: { login: 'a@example.test', password: 'x'.repeat(10_000) } });
    expect(big.statusCode).toBe(413);
    database.sqlite.pragma('wal_checkpoint(PASSIVE)');
    for (const file of readdirSync(join(dir, 'data'))) {
      const bytes = readFileSync(join(dir, 'data', file)).toString('latin1');
      for (const secret of [TEMP_A, TEMP_B, OWN_A, token]) expect(bytes.includes(secret), `${file}`).toBe(false);
    }
  });
});

describe('serwis bez HTTP', () => {
  it('bootstrap odrzuca trzecie konto i identyczne loginy', async () => {
    const database = openDatabase(dbPath);
    open.push(database);
    migrate(database.sqlite);
    const service = new AuthService(database, auth);
    const member = (login: string) => ({ login, displayName: 'X', temporaryPassword: TEMP_A });
    await expect(service.bootstrap({ householdName: 'D', members: [member('a@x.test')] })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.bootstrap({ householdName: 'D', members: [member('a@x.test'), member('A@x.test')] })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(service.bootstrap({ householdName: 'D', members: [member('a@x.test'), member('b@x.test'), member('c@x.test')] })).rejects.toMatchObject({ code: 'invalid_request' });
    await service.bootstrap({ householdName: 'D', members: [member('a@x.test'), member('b@x.test')] });
    await expect(service.bootstrap({ householdName: 'D', members: [member('c@x.test'), member('d@x.test')] })).rejects.toMatchObject({ code: 'already_bootstrapped' });
  });
});
