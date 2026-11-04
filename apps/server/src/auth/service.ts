import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DEFAULT_TIMEZONE, loginSchema, passwordProblem, timezoneSchema, userSchema } from '@razem/contracts';
import { AccountRepository, MAX_MEMBERS, normalizeLogin } from '@razem/db';
import type { Database, SessionRow, UserRow } from '@razem/db';
import { DEFAULT_ARGON2, hashPassword, needsRehash, verifyPassword } from './passwords.js';
import type { Argon2Params } from './passwords.js';

const DAY = 24 * 60 * 60 * 1000;
export interface AuthConfig {
  sessionTtlMs: number;
  renewAfterMs: number;
  rotationGraceMs: number;
  argon2: Argon2Params;
  throttle: { accountFailures: number; ipFailures: number; windowMs: number; lockMs: number };
  clock: () => Date;
  /** Argon2id implementation; replaceable so tests can interleave operations deterministically. */
  passwords: PasswordHasher;
}
export interface PasswordHasher {
  hash(password: string, params: Argon2Params): Promise<string>;
  verify(password: string, phc: string): Promise<boolean>;
}
export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  sessionTtlMs: 30 * DAY, renewAfterMs: DAY, rotationGraceMs: 2 * 60 * 1000, argon2: DEFAULT_ARGON2,
  throttle: { accountFailures: 5, ipFailures: 20, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 },
  clock: () => new Date(),
  passwords: { hash: hashPassword, verify: verifyPassword },
};
/** Attempts when the stored hash changes during Argon2id only because of a concurrent rehash. */
const CREDENTIAL_ATTEMPTS = 3;

export type AuthErrorCode = 'invalid_credentials' | 'rate_limited' | 'weak_password' | 'invalid_request' | 'already_bootstrapped' | 'unknown_account'
  | 'session_revoked';
export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode, readonly detail?: string, readonly retryAfterSeconds?: number) { super(code); }
}

export interface MemberInput { login: string; displayName: string; temporaryPassword: string }
export interface BootstrapInput { householdName: string; timezone?: string; members: MemberInput[] }
export interface Authenticated { user: UserRow; session: SessionRow; rotatedToken?: string }

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const keyHash = (kind: 'login' | 'ip', value: string) => createHash('sha256').update(`${kind}:${value}`).digest('hex');

export function publicUser(user: UserRow) {
  return userSchema.parse({
    id: user.id, householdId: user.householdId, login: user.login, displayName: user.displayName,
    mustChangePassword: user.mustChangePassword, createdAt: user.createdAt,
  });
}

export class AuthService {
  readonly accounts: AccountRepository;
  readonly config: AuthConfig;
  private dummyHash: Promise<string> | undefined;

  constructor(database: Database, config: Partial<AuthConfig> = {}) {
    this.accounts = new AccountRepository(database);
    this.config = { ...DEFAULT_AUTH_CONFIG, ...config };
  }
  private now() { return this.config.clock(); }
  private iso(offsetMs = 0) { return new Date(this.now().getTime() + offsetMs).toISOString(); }

  /** Creates the only household and both members. Passwords are temporary and must be changed. */
  async bootstrap(input: BootstrapInput): Promise<{ householdId: string; userIds: string[] }> {
    if (this.accounts.household() || this.accounts.memberCount() > 0) throw new AuthError('already_bootstrapped');
    const name = input.householdName.trim();
    const timezone = input.timezone?.trim() || DEFAULT_TIMEZONE;
    if (!name || name.length > 200 || !timezoneSchema.safeParse(timezone).success) throw new AuthError('invalid_request', 'Nazwa gospodarstwa lub strefa');
    if (input.members.length !== MAX_MEMBERS) throw new AuthError('invalid_request', 'Wymagane dokładnie dwa konta');
    const members = input.members.map((member) => {
      const login = loginSchema.safeParse(member.login);
      const displayName = member.displayName.trim();
      if (!login.success) throw new AuthError('invalid_request', 'Niepoprawny login');
      if (!displayName || displayName.length > 200) throw new AuthError('invalid_request', 'Niepoprawna nazwa wyświetlana');
      const problem = passwordProblem(member.temporaryPassword, login.data);
      if (problem) throw new AuthError('weak_password', problem);
      return { login: login.data, displayName, password: member.temporaryPassword };
    });
    if (members[0]!.login === members[1]!.login) throw new AuthError('invalid_request', 'Loginy muszą się różnić');
    const hashes = await Promise.all(members.map((m) => this.config.passwords.hash(m.password, this.config.argon2)));
    const at = this.iso();
    const householdId = randomUUID();
    const userIds = members.map(() => randomUUID());
    this.accounts.transaction(() => {
      if (this.accounts.household()) throw new AuthError('already_bootstrapped');
      this.accounts.insertHousehold({ id: householdId, name, timezone, createdAt: at });
      members.forEach((member, index) => {
        this.accounts.insertUser({
          id: userIds[index]!, householdId, login: member.login, displayName: member.displayName, passwordHash: hashes[index]!,
          mustChangePassword: true, passwordChangedAt: at, createdAt: at,
        });
        this.accounts.event(userIds[index]!, 'bootstrap', at);
      });
    });
    return { householdId, userIds };
  }

  /** Administrator reset (local CLI): temporary password, forced change, all sessions revoked. */
  async resetPassword(login: string, temporaryPassword: string): Promise<void> {
    const user = this.accounts.userByLogin(login);
    if (!user) throw new AuthError('unknown_account');
    const problem = passwordProblem(temporaryPassword, user.login);
    if (problem) throw new AuthError('weak_password', problem);
    const hash = await this.config.passwords.hash(temporaryPassword, this.config.argon2);
    const at = this.iso();
    // The administrator wins over anything that happened meanwhile: the reset is unconditional
    // and revokes every session, including ones issued while Argon2id was running.
    this.accounts.transaction(() => {
      this.accounts.setPassword(user.id, hash, true, at);
      this.accounts.deleteUserSessions(user.id);
      this.accounts.event(user.id, 'password_reset', at);
    });
  }

  revokeSessions(login: string): number {
    const user = this.accounts.userByLogin(login);
    if (!user) throw new AuthError('unknown_account');
    const at = this.iso();
    return this.accounts.transaction(() => {
      const removed = this.accounts.deleteUserSessions(user.id);
      this.accounts.event(user.id, 'sessions_revoked', at);
      return removed;
    });
  }

  private lockedFor(keys: string[]): number {
    const now = this.now().getTime();
    let wait = 0;
    for (const key of keys) {
      const row = this.accounts.throttle(key);
      if (row?.lockedUntil) wait = Math.max(wait, Date.parse(row.lockedUntil) - now);
    }
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  private registerFailure(key: string, limit: number): boolean {
    const { windowMs, lockMs } = this.config.throttle;
    const now = this.now().getTime();
    const row = this.accounts.throttle(key);
    const fresh = !row || now - Date.parse(row.windowStartedAt) >= windowMs || (row.lockedUntil !== null && Date.parse(row.lockedUntil) <= now);
    const failures = fresh ? 1 : row.failures + 1;
    const locked = failures >= limit;
    this.accounts.saveThrottle({
      keyHash: key, failures, windowStartedAt: fresh ? new Date(now).toISOString() : row.windowStartedAt,
      lockedUntil: locked ? new Date(now + lockMs).toISOString() : null,
    });
    return locked;
  }

  async login(login: string, password: string, ip: string): Promise<{ token: string; user: UserRow }> {
    const normalized = normalizeLogin(login);
    const accountKey = keyHash('login', normalized);
    const ipKey = keyHash('ip', ip);
    const wait = this.lockedFor([accountKey, ipKey]);
    if (wait > 0) throw new AuthError('rate_limited', undefined, wait);
    const { hash, verify } = this.config.passwords;
    for (let attempt = 1; ; attempt++) {
      const user = this.accounts.userByLogin(normalized);
      // Unknown logins still pay the full Argon2id cost: no timing oracle for existence.
      this.dummyHash ??= hash(newToken(), this.config.argon2);
      const valid = await verify(password, user?.passwordHash ?? await this.dummyHash);
      if (!user || !valid) {
        const at = this.iso();
        const locked = this.accounts.transaction(() => {
          this.accounts.pruneThrottle(this.iso(-this.config.throttle.windowMs), at);
          const accountLocked = this.registerFailure(accountKey, this.config.throttle.accountFailures);
          const ipLocked = this.registerFailure(ipKey, this.config.throttle.ipFailures);
          if (accountLocked && user) this.accounts.event(user.id, 'login_locked', at);
          return accountLocked || ipLocked;
        });
        if (locked) throw new AuthError('rate_limited', undefined, Math.ceil(this.config.throttle.lockMs / 1000));
        throw new AuthError('invalid_credentials');
      }
      const rehash = needsRehash(user.passwordHash, this.config.argon2) ? await hash(password, this.config.argon2) : null;
      const token = newToken();
      const at = this.iso();
      const outcome = this.accounts.transaction(() => {
        // The password was verified against a snapshot. It only counts if that hash is still
        // the stored one: a reset or change committed during Argon2id voids this attempt.
        const current = this.accounts.userById(user.id);
        if (!current || current.passwordHash !== user.passwordHash) return 'stale' as const;
        // Another request may have locked the account or IP meanwhile.
        if (this.lockedFor([accountKey, ipKey]) > 0) return 'locked' as const;
        this.accounts.clearThrottle(accountKey);
        this.accounts.deleteExpiredSessions(at);
        if (rehash) this.accounts.setPassword(user.id, rehash, current.mustChangePassword, current.passwordChangedAt);
        this.accounts.insertSession(this.sessionRow(user.id, token, at));
        this.accounts.event(user.id, 'login', at);
        return 'ok' as const;
      });
      if (outcome === 'ok') return { token, user: this.accounts.userById(user.id)! };
      if (outcome === 'locked') throw new AuthError('rate_limited', undefined, this.lockedFor([accountKey, ipKey]) || 1);
      // Stale: verify again against the current hash (a reset makes the old password fail and count).
      if (attempt >= CREDENTIAL_ATTEMPTS) throw new AuthError('invalid_credentials');
    }
  }

  private sessionRow(userId: string, token: string, at: string): SessionRow {
    return {
      id: randomUUID(), userId, tokenHash: tokenHash(token), previousTokenHash: null, previousValidUntil: null,
      createdAt: at, renewedAt: at, expiresAt: this.iso(this.config.sessionTtlMs),
    };
  }

  /**
   * Resolves a session cookie. Rolling expiry: at most once a day the session is extended
   * and its token rotated; the previous token stays valid for a short grace period so
   * parallel requests from the same device do not fail.
   */
  authenticate(token: string | undefined): Authenticated | null {
    if (!token || !TOKEN_RE.test(token)) return null;
    const hash = tokenHash(token);
    const now = this.iso();
    const session = this.accounts.sessionByTokenHash(hash, now);
    if (!session) return null;
    if (session.expiresAt <= now) { this.accounts.deleteSession(session.id); return null; }
    const user = this.accounts.userById(session.userId);
    if (!user) return null;
    const isCurrent = session.tokenHash === hash;
    if (isCurrent && this.now().getTime() - Date.parse(session.renewedAt) >= this.config.renewAfterMs) {
      const rotatedToken = newToken();
      const values = {
        tokenHash: tokenHash(rotatedToken), previousTokenHash: hash, previousValidUntil: this.iso(this.config.rotationGraceMs),
        renewedAt: now, expiresAt: this.iso(this.config.sessionTtlMs),
      };
      if (this.accounts.rotateSession(session.id, hash, values) === 1) return { user, session: { ...session, ...values }, rotatedToken };
    }
    return { user, session };
  }

  /** Session and account as currently stored; the snapshot in `auth` may be outdated. */
  private liveAccount(auth: Authenticated): UserRow {
    const session = this.accounts.sessionById(auth.session.id);
    const user = session && session.expiresAt > this.iso() ? this.accounts.userById(session.userId) : undefined;
    if (!user || user.id !== auth.user.id) throw new AuthError('session_revoked');
    return user;
  }

  async changePassword(auth: Authenticated, currentPassword: string, newPassword: string): Promise<{ token: string; user: UserRow }> {
    const { hash, verify } = this.config.passwords;
    for (let attempt = 1; ; attempt++) {
      const user = this.liveAccount(auth);
      if (!await verify(currentPassword, user.passwordHash)) {
        this.liveAccount(auth); // revoked meanwhile → 401 rather than a wrong-password answer
        throw new AuthError('invalid_credentials');
      }
      const problem = passwordProblem(newPassword, user.login)
        ?? (newPassword.normalize('NFC') === currentPassword.normalize('NFC') ? 'Nowe hasło musi różnić się od obecnego' : null);
      if (problem) throw new AuthError('weak_password', problem);
      const newHash = await hash(newPassword, this.config.argon2);
      const token = newToken();
      const at = this.iso();
      const outcome = this.accounts.transaction(() => {
        // Re-check at commit: the authorising session must still exist and be valid, and the
        // password must still be the one just verified. A reset, revoke, logout or another
        // change during Argon2id rejects this request without writing anything.
        const session = this.accounts.sessionById(auth.session.id);
        if (!session || session.expiresAt <= at || session.userId !== user.id) return 'revoked' as const;
        const current = this.accounts.userById(user.id);
        if (!current || current.passwordHash !== user.passwordHash) return 'stale' as const;
        this.accounts.setPassword(user.id, newHash, false, at);
        // Every other device must log in again; this one continues with a fresh session.
        this.accounts.deleteUserSessions(user.id);
        this.accounts.insertSession(this.sessionRow(user.id, token, at));
        this.accounts.event(user.id, 'password_changed', at);
        return 'ok' as const;
      });
      if (outcome === 'ok') return { token, user: this.accounts.userById(user.id)! };
      if (outcome === 'revoked') throw new AuthError('session_revoked');
      // Session intact but hash replaced: only a rehash at login does that; verify again.
      if (attempt >= CREDENTIAL_ATTEMPTS) throw new AuthError('invalid_credentials');
    }
  }

  logout(auth: Authenticated): void {
    const at = this.iso();
    this.accounts.transaction(() => {
      this.accounts.deleteSession(auth.session.id);
      this.accounts.event(auth.user.id, 'logout', at);
    });
  }
}
