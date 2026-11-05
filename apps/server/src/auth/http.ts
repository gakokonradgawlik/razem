import type { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { apiErrorSchema, householdSchema, loginRequestSchema, meResponseSchema, passwordChangeRequestSchema, settingsPatchSchema, settingsSchema, SYNC_ACCOUNT_HEADER } from '@razem/contracts';
import { AuthError, publicUser } from './service.js';
import type { AuthService, Authenticated } from './service.js';

export interface HttpAuthOptions {
  service: AuthService;
  /** Secure cookies (`__Host-` prefix). Only a non-production dev server may disable it. */
  secureCookies: boolean;
  /** Exact origin of the PWA, e.g. https://razem.example. Fallback: the request's own origin. */
  publicOrigin?: string;
}

declare module 'fastify' {
  interface FastifyRequest { auth: Authenticated | null }
}

type ErrorCode = z.infer<typeof apiErrorSchema>['error'];
const fail = (reply: FastifyReply, status: number, error: ErrorCode) => reply.code(status).send(apiErrorSchema.parse({ error }));
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Endpoints usable with a temporary password; everything else needs an own password first.
const TEMPORARY_PASSWORD_ROUTES = new Set(['/api/me', '/api/auth/password', '/api/auth/logout']);

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export function registerAuth(app: FastifyInstance, options: HttpAuthOptions) {
  const { service } = options;
  const cookieName = options.secureCookies ? '__Host-razem_session' : 'razem_session';
  const maxAge = Math.floor(service.config.sessionTtlMs / 1000);
  const cookie = (token: string, age: number) => [
    `${cookieName}=${token}`, 'Path=/', `Max-Age=${age}`, 'HttpOnly', 'SameSite=Strict', ...(options.secureCookies ? ['Secure'] : []),
  ].join('; ');
  const setSession = (reply: FastifyReply, token: string) => reply.header('Set-Cookie', cookie(token, maxAge));
  const clearSession = (reply: FastifyReply) => reply.header('Set-Cookie', cookie('', 0));

  const allowedOrigin = (request: FastifyRequest) => options.publicOrigin ?? `${request.protocol}://${request.host}`;

  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/')) return;
    // CSRF: state-changing API calls only from our own origin, as JSON, never cross-site.
    if (!SAFE_METHODS.has(request.method)) {
      const site = request.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin') return fail(reply, 403, 'forbidden');
      if (request.headers.origin !== allowedOrigin(request)) return fail(reply, 403, 'forbidden');
      const type = request.headers['content-type'];
      if (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0'
        && !(type ?? '').toLowerCase().startsWith('application/json')) return fail(reply, 415, 'invalid_request');
    }
    if (path === '/api/auth/login') return;
    const auth = service.authenticate(readCookie(request.headers.cookie, cookieName));
    if (!auth) {
      if (request.headers.cookie?.includes(`${cookieName}=`)) clearSession(reply);
      return fail(reply, 401, 'authentication_required');
    }
    request.auth = auth;
    if (auth.rotatedToken) setSession(reply, auth.rotatedToken);
    if (auth.user.mustChangePassword && !TEMPORARY_PASSWORD_ROUTES.has(path)) return fail(reply, 403, 'password_change_required');
  });

  const authError = (reply: FastifyReply, error: unknown) => {
    if (!(error instanceof AuthError)) throw error;
    if (error.code === 'rate_limited') {
      reply.header('Retry-After', String(error.retryAfterSeconds ?? 60));
      return fail(reply, 429, 'rate_limited');
    }
    if (error.code === 'weak_password') return reply.code(400).send(apiErrorSchema.parse({ error: 'weak_password', message: error.detail }));
    if (error.code === 'invalid_credentials') return fail(reply, 401, 'invalid_credentials');
    if (error.code === 'session_revoked') { clearSession(reply); return fail(reply, 401, 'authentication_required'); }
    return fail(reply, 400, 'invalid_request');
  };

  const me = (auth: Pick<Authenticated, 'user'>) => {
    const household = service.accounts.householdById(auth.user.householdId)!;
    return meResponseSchema.parse({
      user: publicUser(auth.user),
      household: householdSchema.parse({ id: household.id, name: household.name, timezone: household.timezone }),
    });
  };

  app.post('/api/auth/login', { bodyLimit: 4096 }, async (request, reply) => {
    const body = loginRequestSchema.safeParse(request.body);
    if (!body.success) return fail(reply, 400, 'invalid_request');
    try {
      const { token, user } = await service.login(body.data.login, body.data.password, request.ip);
      setSession(reply, token);
      return me({ user });
    } catch (error) { return authError(reply, error); }
  });

  app.post('/api/auth/logout', { bodyLimit: 1024 }, async (request, reply) => {
    const expected = request.headers[SYNC_ACCOUNT_HEADER];
    if (expected !== undefined && expected !== request.auth!.user.id) return fail(reply, 409, 'account_mismatch');
    service.logout(request.auth!);
    clearSession(reply);
    return reply.code(204).send();
  });

  app.post('/api/auth/password', { bodyLimit: 4096 }, async (request, reply) => {
    const body = passwordChangeRequestSchema.safeParse(request.body);
    if (!body.success) return fail(reply, 400, 'invalid_request');
    try {
      const { token, user } = await service.changePassword(request.auth!, body.data.currentPassword, body.data.newPassword);
      setSession(reply, token);
      return me({ user });
    } catch (error) { return authError(reply, error); }
  });

  app.get('/api/me', async (request) => me(request.auth!));

  // Bound to the account of this request, including when another tab changed the cookie.
  app.get('/api/settings', async (request, reply) => {
    if (request.headers[SYNC_ACCOUNT_HEADER] !== request.auth!.user.id) return fail(reply, 409, 'account_mismatch');
    return settingsSchema.parse(service.accounts.settings(request.auth!.user));
  });
  app.patch('/api/settings', { bodyLimit: 4096 }, async (request, reply) => {
    if (request.headers[SYNC_ACCOUNT_HEADER] !== request.auth!.user.id) return fail(reply, 409, 'account_mismatch');
    const patch = settingsPatchSchema.safeParse(request.body);
    if (!patch.success) return fail(reply, 400, 'invalid_request');
    return settingsSchema.parse(service.accounts.updateSettings(request.auth!.user, patch.data, new Date().toISOString()));
  });
}
