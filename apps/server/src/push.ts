import type { FastifyInstance } from 'fastify';
import { idSchema, pushSubscribeSchema, pushTargetSchema, SYNC_ACCOUNT_HEADER } from '@razem/contracts';
import { PushSubscriptions, RecordRepository } from '@razem/db';
import type { Database, Vapid } from '@razem/db';

export function registerPush(app: FastifyInstance, database: Database, vapid?: Vapid) {
  const subscriptions = new PushSubscriptions(database);
  const records = new RecordRepository(database);
  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/api/push') && request.headers[SYNC_ACCOUNT_HEADER] !== request.auth?.user.id)
      return reply.code(409).send({ error: 'account_mismatch' });
  });
  app.get('/api/push/config', async () => ({ publicKey: vapid?.publicKey ?? null }));
  app.get('/api/push/devices/:id', async (request, reply) => {
    const device = idSchema.safeParse((request.params as { id: string }).id);
    if (!device.success) return reply.code(400).send({ error: 'invalid_request' });
    return { enabled: subscriptions.enabled(request.auth!.user.id, device.data, request.auth!.session.id) };
  });
  app.put('/api/push/subscription', { bodyLimit: 8192 }, async (request, reply) => {
    if (!vapid) return reply.code(503).send({ error: 'unavailable' });
    const input = pushSubscribeSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!subscriptions.subscribe(request.auth!.user.id, request.auth!.session.id, input.data))
      return reply.code(409).send({ error: 'invalid_request' });
    return { enabled: true };
  });
  app.delete('/api/push/devices/:id', async (request, reply) => {
    const device = idSchema.safeParse((request.params as { id: string }).id);
    if (!device.success) return reply.code(400).send({ error: 'invalid_request' });
    subscriptions.remove(request.auth!.user.id, device.data, request.auth!.session.id);
    return reply.code(204).send();
  });
  // Called again at click time. No record content is sent; sync remains the only data path.
  app.post('/api/push/resolve', async (request, reply) => {
    const input = pushTargetSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid_request' });
    const user = request.auth!.user;
    const record = records.get({ userId: user.id, householdId: user.householdId }, input.data.entityType, input.data.id);
    if (!record || record.deletedAt) return reply.code(404).send({ error: 'not_found' });
    const prefixes: Record<string, string> = { task: '/zadania/', calendar_event: '/kalendarz/', important_date: '/wazne-daty/', shopping_list: '/zakupy/' };
    if (record.entityType === 'shopping_item') {
      const parent = records.get({ userId: user.id, householdId: user.householdId }, 'shopping_list', record.data.listId);
      if (!parent || parent.deletedAt) return reply.code(404).send({ error: 'not_found' });
      return { path: `/zakupy/${record.data.listId}` };
    }
    const prefix = prefixes[record.entityType];
    if (!prefix) return reply.code(404).send({ error: 'not_found' });
    return { path: prefix + record.id };
  });
}
