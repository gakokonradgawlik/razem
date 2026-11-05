import type { FastifyInstance } from 'fastify';
import { accountExportSchema, apiErrorSchema, SYNC_ACCOUNT_HEADER } from '@razem/contracts';
import { RecordRepository, SNAPSHOT_ORDER } from '@razem/db';
import type { Database } from '@razem/db';
import type { AuthService } from './auth/service.js';

export function registerExport(app: FastifyInstance, database: Database, auth: AuthService) {
  const records = new RecordRepository(database);
  app.get('/api/export', async (request, reply) => {
    const user = request.auth!.user;
    if (request.headers[SYNC_ACCOUNT_HEADER] !== user.id)
      return reply.code(409).send(apiErrorSchema.parse({ error: 'account_mismatch' }));
    // A single read transaction keeps parents, children and settings in the same snapshot.
    const data = database.sqlite.transaction(() => accountExportSchema.parse({
      format: 'razem-account', formatVersion: 1, exportedAt: new Date().toISOString(),
      account: { id: user.id, householdId: user.householdId, login: user.login, displayName: user.displayName },
      settings: auth.accounts.settings(user),
      records: SNAPSHOT_ORDER.flatMap((type) => records.list({ userId: user.id, householdId: user.householdId }, type, { includeDeleted: true })),
    }))();
    reply.header('Content-Disposition', 'attachment; filename="razem-konto.json"');
    return data;
  });
}
