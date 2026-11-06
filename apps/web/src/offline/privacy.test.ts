import { afterEach, beforeEach, expect, it } from 'vitest';
import type { EntityType } from '@razem/contracts';
import { RecordRepository } from '@razem/db';
import { A, B, seedDomain } from '../../../../tests/fixtures/installation.js';
import { ACCOUNTS, ORIGIN, Phone, startServer } from './test-harness.js';
import type { Server } from './test-harness.js';
import type { AppController } from './controller.js';

let server: Server;
const tabs: AppController[] = [];
beforeEach(async () => { server = await startServer(); });
afterEach(async () => { for (const tab of tabs.splice(0)) await tab.dispose(); await server.close(); });

// Exercise the same real HTTP ACL through every entity, including inherited scopes.
// Comparing guessed IDs with absent IDs detects existence/version leaks as well as content leaks.
it.each(['a', 'b'] as const)('%s: osiem typów private partnera nie wycieka przez snapshot/deltę, konflikt, kosz, eksport ani link push', async (who) => {
  const seeded = seedDomain(server.database);
  const owner = who === 'a' ? B : A;
  const hidden = seeded.filter((r) => r.ownerId === owner.userId && r.visibility === 'private');
  expect(new Set(hidden.map((r) => r.entityType)).size).toBe(8);
  const phone = new Phone(server), tab = phone.tab(); tabs.push(tab); await tab.init();
  expect(await tab.login(ACCOUNTS[who].login, ACCOUNTS[who].password)).toEqual({ ok: true });
  await tab.syncNow();
  const account = ACCOUNTS[who].id;
  const headers = { cookie: phone.network.cookie!, origin: ORIGIN, 'x-razem-account': account, 'x-razem-protocol': '2' };
  const secretLabel = who === 'a' ? 'PRIVATE_B' : 'PRIVATE_A';
  const noLeak = (value: unknown) => {
    const text = JSON.stringify(value);
    for (const secret of [secretLabel, ...hidden.map((r) => r.id), ...Object.values(ACCOUNTS).map((a) => a.password), 'password_hash', 'token_hash', 'cursor_key']) expect(text).not.toContain(secret);
  };
  const patches: Record<EntityType, Record<string, unknown>> = {
    shopping_list: { name: 'Próba' }, shopping_item: { checked: true }, task: { title: 'Próba' },
    task_occurrence: { completedAt: null }, calendar_event: { title: 'Próba' },
    important_date: { name: 'Próba' }, note: { body: 'Próba' }, reminder: { enabled: false },
  };
  let delta: string | undefined;
  for (const phase of ['live', 'trash', 'tombstone']) {
    if (phase === 'trash') {
      const repo = new RecordRepository(server.database);
      // Children first: also verify that trash/restore cannot bypass inherited ACL.
      for (const record of [...hidden].reverse()) {
        const current = repo.get(owner, record.entityType, record.id)!;
        expect(repo.remove(owner, { entityType: record.entityType, id: record.id, baseVersion: current.version }).status).toBe('ack');
      }
    }
    if (phase === 'tombstone') {
      server.clock.now += 31 * 86_400_000; server.sync.maintenance();
      expect(await tab.login(ACCOUNTS[who].login, ACCOUNTS[who].password)).toEqual({ ok: true });
      headers.cookie = phone.network.cookie!;
    }
    let cursor: string | undefined;
    do {
      const page = await tab.api.pull(cursor, 2, account);
      expect(page.status).toBe('ok'); noLeak(page);
      if (page.status !== 'ok') throw new Error('Unexpected resync');
      cursor = page.hasMore ? page.nextCursor : undefined;
      if (!cursor && phase === 'live') delta = page.nextCursor;
    } while (cursor);
    if (phase !== 'live') noLeak(await tab.api.pull(delta, 200, account));
    noLeak(await tab.api.exportAccount(account));
    await tab.syncNow();
    noLeak(await tab.store!.db.records.toArray()); noLeak(await tab.store!.trash());
    noLeak(await tab.store!.attention()); noLeak(await tab.store!.exportPending(ACCOUNTS[who].login));
    for (const record of hidden) {
      expect(await tab.store!.get(record.id)).toBeUndefined();
      for (const command of ['update', 'delete', 'restore'] as const) {
        for (const baseVersion of [1, 999]) {
          const results = [];
          for (const entityId of [record.id, crypto.randomUUID()]) {
            const response = await server.app.inject({ method: 'POST', url: '/api/sync/push', headers, payload: {
              protocolVersion: 2, deviceId: crypto.randomUUID(), mutations: [{
                clientMutationId: crypto.randomUUID(), entityType: record.entityType, entityId, command, baseVersion,
                ...(command === 'update' ? { patch: patches[record.entityType] } : {}),
              }],
            } });
            expect(response.statusCode).toBe(200);
            const { entityId: echoed, clientMutationId: _correlation, ...result } = response.json().results[0];
            expect(echoed).toBe(entityId); // Only the ID already supplied by the caller may be echoed.
            expect(result).toMatchObject({ status: 'error', code: 'not_found' });
            noLeak(result); results.push(result);
          }
          expect(results[0]).toEqual(results[1]);
        }
      }
      const resolutions = [];
      for (const id of [record.id, crypto.randomUUID()]) {
        const response = await server.app.inject({ method: 'POST', url: '/api/push/resolve', headers, payload: { entityType: record.entityType, id } });
        expect(response.statusCode).toBe(404); noLeak(response.json()); resolutions.push(response.json());
      }
      expect(resolutions[0]).toEqual(resolutions[1]);
    }
  }
});
