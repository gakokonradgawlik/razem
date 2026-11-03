import { and, count, eq, gt, isNotNull, lte, or } from 'drizzle-orm';
import type { Database } from './index.js';
import { authEvents, authThrottle, households, sessions, users } from './schema.js';
import type { AuthEventKind } from './schema.js';

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type HouseholdRow = typeof households.$inferSelect;

export const MAX_MEMBERS = 2;
export const normalizeLogin = (login: string) => login.trim().toLowerCase();

/** Persistence for accounts, sessions and login throttling. Holds no policy. */
export class AccountRepository {
  constructor(readonly database: Database) {}
  private get db() { return this.database.db; }

  transaction<T>(fn: () => T): T { return this.db.transaction(fn, { behavior: 'immediate' }); }

  household(): HouseholdRow | undefined { return this.db.select().from(households).get(); }
  householdById(id: string): HouseholdRow | undefined { return this.db.select().from(households).where(eq(households.id, id)).get(); }
  memberCount(): number { return this.db.select({ n: count() }).from(users).get()?.n ?? 0; }
  insertHousehold(row: HouseholdRow) { this.db.insert(households).values(row).run(); }
  insertUser(row: UserRow) { this.db.insert(users).values({ ...row, login: normalizeLogin(row.login) }).run(); }
  userByLogin(login: string): UserRow | undefined { return this.db.select().from(users).where(eq(users.login, normalizeLogin(login))).get(); }
  userById(id: string): UserRow | undefined { return this.db.select().from(users).where(eq(users.id, id)).get(); }
  setPassword(userId: string, passwordHash: string, mustChangePassword: boolean, at: string) {
    return this.db.update(users).set({ passwordHash, mustChangePassword, passwordChangedAt: at }).where(eq(users.id, userId)).run().changes;
  }

  event(userId: string | null, kind: AuthEventKind, at: string) { this.db.insert(authEvents).values({ userId, kind, createdAt: at }).run(); }
  events(userId: string) { return this.db.select().from(authEvents).where(eq(authEvents.userId, userId)).orderBy(authEvents.id).all(); }

  insertSession(row: SessionRow) { this.db.insert(sessions).values(row).run(); }
  /** Current token, or the previous one during its short rotation grace window. */
  sessionByTokenHash(hash: string, now: string): SessionRow | undefined {
    return this.db.select().from(sessions).where(or(
      eq(sessions.tokenHash, hash),
      and(eq(sessions.previousTokenHash, hash), isNotNull(sessions.previousValidUntil), gt(sessions.previousValidUntil, now)),
    )).get();
  }
  rotateSession(id: string, fromHash: string, values: Pick<SessionRow, 'tokenHash' | 'previousTokenHash' | 'previousValidUntil' | 'renewedAt' | 'expiresAt'>) {
    return this.db.update(sessions).set(values).where(and(eq(sessions.id, id), eq(sessions.tokenHash, fromHash))).run().changes;
  }
  deleteSession(id: string) { return this.db.delete(sessions).where(eq(sessions.id, id)).run().changes; }
  deleteUserSessions(userId: string) { return this.db.delete(sessions).where(eq(sessions.userId, userId)).run().changes; }
  deleteExpiredSessions(now: string) { return this.db.delete(sessions).where(lte(sessions.expiresAt, now)).run().changes; }
  sessionsOf(userId: string) { return this.db.select().from(sessions).where(eq(sessions.userId, userId)).all(); }

  throttle(keyHash: string) { return this.db.select().from(authThrottle).where(eq(authThrottle.keyHash, keyHash)).get(); }
  saveThrottle(row: typeof authThrottle.$inferSelect) {
    this.db.insert(authThrottle).values(row).onConflictDoUpdate({ target: authThrottle.keyHash, set: row }).run();
  }
  clearThrottle(keyHash: string) { this.db.delete(authThrottle).where(eq(authThrottle.keyHash, keyHash)).run(); }
}
