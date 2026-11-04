import type { FastifyInstance } from 'fastify';
import { MAX_PUSH_BYTES, apiErrorSchema } from '@razem/contracts';
import type { SyncOutcome, SyncService } from './service.js';

/**
 * /api/sync/push and /api/sync/pull. The auth hook (registerAuth) already rejected requests
 * without a valid session (401), with a temporary password (403) and failed CSRF checks (403/415).
 * Scope always comes from the session; deviceId only keys idempotency receipts.
 */
export function registerSync(app: FastifyInstance, sync: SyncService) {
  const scopeOf = (request: { auth: { user: { id: string; householdId: string } } | null }) => {
    const user = request.auth!.user;
    return { userId: user.id, householdId: user.householdId };
  };
  const send = <T>(outcome: SyncOutcome<T>, reply: import('fastify').FastifyReply) =>
    outcome.ok ? outcome.body : reply.code(outcome.status).send(apiErrorSchema.parse({ error: outcome.error }));

  app.post('/api/sync/push', { bodyLimit: MAX_PUSH_BYTES }, async (request, reply) => send(sync.push(scopeOf(request), request.body), reply));
  app.get('/api/sync/pull', async (request, reply) => send(sync.pull(scopeOf(request), request.query), reply));
}
