import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MAX_PUSH_BYTES, SYNC_ACCOUNT_HEADER, apiErrorSchema } from '@razem/contracts';
import type { SyncOutcome, SyncService } from './service.js';

/**
 * /api/sync/push and /api/sync/pull. The auth hook (registerAuth) already rejected requests
 * without a valid session (401), with a temporary password (403) and failed CSRF checks (403/415).
 * Scope always comes from the session; deviceId only keys idempotency receipts.
 *
 * Every sync request names the account its local queue/database belongs to
 * (SYNC_ACCOUNT_HEADER). It is checked against the session of the same request, so the
 * binding is atomic with respect to a session switch: a cookie replaced by another
 * account's sign-in between two requests of a cycle gets 409 `account_mismatch` and nothing
 * is written or returned. The header grants nothing by itself; the session still decides.
 */
export function registerSync(app: FastifyInstance, sync: SyncService) {
  const scopeOf = (request: FastifyRequest) => {
    const user = request.auth!.user;
    return { userId: user.id, householdId: user.householdId };
  };
  const send = <T>(outcome: SyncOutcome<T>, reply: FastifyReply) =>
    outcome.ok ? outcome.body : reply.code(outcome.status).send(apiErrorSchema.parse({ error: outcome.error }));
  const boundTo = (request: FastifyRequest) => request.headers[SYNC_ACCOUNT_HEADER] === request.auth!.user.id;
  const mismatch = (reply: FastifyReply) => reply.code(409).send(apiErrorSchema.parse({ error: 'account_mismatch' }));

  app.post('/api/sync/push', { bodyLimit: MAX_PUSH_BYTES }, async (request, reply) =>
    boundTo(request) ? send(sync.push(scopeOf(request), request.body), reply) : mismatch(reply));
  app.get('/api/sync/pull', async (request, reply) =>
    boundTo(request) ? send(sync.pull(scopeOf(request), request.query), reply) : mismatch(reply));
}
