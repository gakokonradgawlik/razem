import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '@razem/db';
import type { Database } from '@razem/db';
import { buildApp } from '../app.js';
import { hashPassword, verifyPassword } from './passwords.js';
import type { Argon2Params } from './passwords.js';
import { AuthError, AuthService } from './service.js';
import type { AuthConfig, Authenticated, PasswordHasher } from './service.js';

// Deterministic interleavings: a gated hasher holds a chosen Argon2id call after it computed
// its result, so another operation can commit "during" Argon2id. Synthetic data only.
const FAST: Argon2Params = { memory: 1024, passes: 1, parallelism: 1 };
const SLOWER: Argon2Params = { memory: 2048, passes: 1, parallelism: 1 };
const A = 'a@example.test';
const TEMP_A = 'Tymczasowe-A-7e1c';
const TEMP_B = 'Tymczasowe-B-93fd';
const OWN_A = 'Wlasne haslo A 2026!';
const NEW_1 = 'Nowe haslo pierwsze 1';
const NEW_2 = 'Nowe haslo drugie 22';
const RESET = 'Reset-Syntetyczny-55';
const ORIGIN = 'https://razem.test';

interface Gate { reached: Promise<void>; release: () => void }
class GatedHasher implements PasswordHasher {
  private armed: Array<{ op: 'hash' | 'verify'; password: string; reached: () => void; wait: Promise<void> }> = [];
  pause(op: 'hash' | 'verify', password: string): Gate {
    let reached!: () => void;
    let release!: () => void;
    const reachedP = new Promise<void>((r) => { reached = r; });
    const wait = new Promise<void>((r) => { release = r; });
    this.armed.push({ op, password, reached, wait });
    return { reached: reachedP, release };
  }
  private async hold<T>(op: 'hash' | 'verify', password: string, result: T): Promise<T> {
    const index = this.armed.findIndex((g) => g.op === op && g.password === password);
    if (index < 0) return result;
    const [gate] = this.armed.splice(index, 1);
    gate!.reached();
    await gate!.wait;
    return result;
  }
  hash = async (password: string, params: Argon2Params) => this.hold('hash', password, await hashPassword(password, params));
  verify = async (password: string, phc: string) => this.hold('verify', password, await verifyPassword(password, phc));
}

let dir: string;
let database: Database;
let hasher: GatedHasher;
let service: AuthService;
const config = (): Partial<AuthConfig> => ({ argon2: FAST, passwords: hasher });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'razem-races-'));
  database = openDatabase(join(dir, 'data', 'razem.sqlite'));
  migrate(database.sqlite);
  hasher = new GatedHasher();
  service = new AuthService(database, config());
  await service.bootstrap({
    householdName: 'Syntetyczny dom',
    members: [
      { login: A, displayName: 'Konto A', temporaryPassword: TEMP_A },
      { login: 'b@example.test', displayName: 'Konto B', temporaryPassword: TEMP_B },
    ],
  });
  const first = await service.login(A, TEMP_A, '203.0.113.1');
  await service.changePassword(service.authenticate(first.token)!, TEMP_A, OWN_A);
});
afterEach(() => {
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

const userA = () => service.accounts.userByLogin(A)!;
const sessionsA = () => service.accounts.sessionsOf(userA().id);
async function device(password = OWN_A): Promise<{ token: string; auth: Authenticated }> {
  const { token } = await service.login(A, password, '203.0.113.9');
  return { token, auth: service.authenticate(token)! };
}
async function rejectsWith(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AuthError);
  expect((error as AuthError).code).toBe(code);
}
/** The only password that logs in now (checked with a fresh login, then cleaned up). */
async function onlyValidPassword(expected: string, rejected: string[]) {
  for (const password of rejected) await rejectsWith(service.login(A, password, '198.51.100.1'), 'invalid_credentials');
  const { token } = await service.login(A, expected, '198.51.100.1');
  expect(service.authenticate(token)).not.toBeNull();
}

describe('login przeplatany z resetem/zmianą hasła podczas Argon2id', () => {
  it('reset w trakcie weryfikacji starego hasła: brak sesji, hasło po resecie', async () => {
    const gate = hasher.pause('verify', OWN_A);
    const pending = service.login(A, OWN_A, '203.0.113.1');
    await gate.reached;
    await service.resetPassword(A, RESET);
    gate.release();
    await rejectsWith(pending, 'invalid_credentials');
    expect(sessionsA()).toEqual([]);
    expect(userA().mustChangePassword).toBe(true);
    await onlyValidPassword(RESET, [OWN_A]);
  });

  it('zmiana hasła na innym urządzeniu w trakcie logowania: stare hasło nie daje sesji', async () => {
    const other = await device();
    const gate = hasher.pause('verify', OWN_A);
    const pending = service.login(A, OWN_A, '203.0.113.1');
    await gate.reached;
    const changed = await service.changePassword(other.auth, OWN_A, NEW_1);
    gate.release();
    await rejectsWith(pending, 'invalid_credentials');
    expect(sessionsA().map((s) => s.tokenHash)).toEqual([service.authenticate(changed.token)!.session.tokenHash]);
    await onlyValidPassword(NEW_1, [OWN_A]);
  });

  it('rehash przy logowaniu nie przywraca hasła sprzed resetu', async () => {
    const upgraded = new AuthService(database, { argon2: SLOWER, passwords: hasher });
    const gate = hasher.pause('hash', OWN_A); // the rehash of the old password
    const pending = upgraded.login(A, OWN_A, '203.0.113.1');
    await gate.reached;
    await service.resetPassword(A, RESET);
    const resetHash = userA().passwordHash;
    gate.release();
    await rejectsWith(pending, 'invalid_credentials');
    expect(userA().passwordHash).toBe(resetHash);
    expect(sessionsA()).toEqual([]);
    await onlyValidPassword(RESET, [OWN_A]);
  });

  it('równoległy rehash przez drugie logowanie nie odrzuca poprawnego hasła', async () => {
    const upgraded = new AuthService(database, { argon2: SLOWER, passwords: hasher });
    const gate = hasher.pause('hash', OWN_A);
    const first = upgraded.login(A, OWN_A, '203.0.113.1');
    await gate.reached;
    const second = await upgraded.login(A, OWN_A, '203.0.113.2'); // rehashes and commits first
    gate.release();
    const result = await first; // stale snapshot → verified again against the new hash
    expect(upgraded.authenticate(result.token)).not.toBeNull();
    expect(upgraded.authenticate(second.token)).not.toBeNull();
    expect(userA().passwordHash).toContain('m=2048');
  });
});

describe('zmiana hasła przeplatana z resetem, odwołaniem, wylogowaniem i drugą zmianą', () => {
  for (const stage of ['verify', 'hash'] as const) {
    const password = stage === 'verify' ? OWN_A : NEW_1;

    it(`reset CLI w trakcie ${stage}: odmowa bez zapisu, obowiązuje hasło z resetu`, async () => {
      const { auth } = await device();
      const gate = hasher.pause(stage, password);
      const pending = service.changePassword(auth, OWN_A, NEW_1);
      await gate.reached;
      await service.resetPassword(A, RESET);
      const resetHash = userA().passwordHash;
      gate.release();
      await rejectsWith(pending, 'session_revoked');
      expect(userA().passwordHash).toBe(resetHash);
      expect(userA().mustChangePassword).toBe(true);
      expect(sessionsA()).toEqual([]);
      await onlyValidPassword(RESET, [NEW_1, OWN_A]);
    });

    it(`revoke-sessions w trakcie ${stage}: odmowa, hasło bez zmian, brak nowej sesji`, async () => {
      const { auth } = await device();
      const before = userA().passwordHash;
      const gate = hasher.pause(stage, password);
      const pending = service.changePassword(auth, OWN_A, NEW_1);
      await gate.reached;
      expect(service.revokeSessions(A)).toBeGreaterThan(0);
      gate.release();
      await rejectsWith(pending, 'session_revoked');
      expect(userA().passwordHash).toBe(before);
      expect(sessionsA()).toEqual([]);
      await onlyValidPassword(OWN_A, [NEW_1]);
    });

    it(`wylogowanie tej sesji w trakcie ${stage}: odmowa, hasło bez zmian`, async () => {
      const { auth } = await device();
      const before = userA().passwordHash;
      const gate = hasher.pause(stage, password);
      const pending = service.changePassword(auth, OWN_A, NEW_1);
      await gate.reached;
      service.logout(auth);
      gate.release();
      await rejectsWith(pending, 'session_revoked');
      expect(userA().passwordHash).toBe(before);
      expect(sessionsA().some((s) => s.id === auth.session.id)).toBe(false);
      await onlyValidPassword(OWN_A, [NEW_1]);
    });

    it(`druga zmiana hasła z innego urządzenia w trakcie ${stage}: wygrywa zatwierdzona`, async () => {
      const slow = await device();
      const fast = await device();
      const gate = hasher.pause(stage, password);
      const pending = service.changePassword(slow.auth, OWN_A, NEW_1);
      await gate.reached;
      const winner = await service.changePassword(fast.auth, OWN_A, NEW_2);
      gate.release();
      await rejectsWith(pending, 'session_revoked');
      expect(sessionsA().map((s) => s.tokenHash)).toEqual([service.authenticate(winner.token)!.session.tokenHash]);
      expect(userA().mustChangePassword).toBe(false);
      await onlyValidPassword(NEW_2, [NEW_1, OWN_A]);
    });
  }

  it('dwie równoległe zmiany z tej samej sesji: zapisuje się tylko pierwsza', async () => {
    const { auth } = await device();
    const gate = hasher.pause('hash', NEW_1);
    const pending = service.changePassword(auth, OWN_A, NEW_1);
    await gate.reached;
    await service.changePassword(auth, OWN_A, NEW_2);
    gate.release();
    await rejectsWith(pending, 'session_revoked');
    await onlyValidPassword(NEW_2, [NEW_1, OWN_A]);
  });
});

describe('HTTP: zmiana hasła po odwołaniu sesji w trakcie Argon2id', () => {
  it('zwraca 401 authentication_required, czyści cookie i niczego nie zapisuje', async () => {
    const app = await buildApp({ database, auth: config(), publicOrigin: ORIGIN });
    try {
      const headers = { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
      const loginResponse = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { login: A, password: OWN_A } });
      expect(loginResponse.statusCode).toBe(200);
      const cookie = String(loginResponse.headers['set-cookie']).split(';')[0]!;
      const before = userA().passwordHash;
      const gate = hasher.pause('hash', NEW_1);
      const pending = app.inject({
        method: 'POST', url: '/api/auth/password', headers: { ...headers, cookie },
        payload: { currentPassword: OWN_A, newPassword: NEW_1 },
      });
      await gate.reached;
      service.revokeSessions(A);
      gate.release();
      const response = await pending;
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: 'authentication_required' });
      expect(String(response.headers['set-cookie'])).toContain('Max-Age=0');
      expect(userA().passwordHash).toBe(before);
      expect(sessionsA()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
