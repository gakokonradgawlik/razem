import { afterEach, expect, it } from 'vitest';
import { migrate, openDatabase } from '@razem/db';
import { healthSchema } from '@razem/contracts';
import { buildApp } from './app.js';

const resources: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of resources.splice(0)) await dispose(); });
async function fixture() {
  const database = openDatabase(':memory:');
  migrate(database.sqlite);
  const app = await buildApp({ database });
  resources.push(async () => { await app.close(); database.close(); });
  return { app, database };
}
it('rzeczywiste API zwraca health i readiness zgodne z kontraktem', async () => {
  const { app } = await fixture();
  for (const path of ['/healthz', '/readyz']) {
    const response = await app.inject({ method: 'GET', url: path });
    expect(response.statusCode).toBe(200);
    expect(healthSchema.parse(response.json()).status).toBe('ok');
    expect(response.headers['cache-control']).toBe('no-store');
  }
});
it('bez sesji żaden endpoint danych nie ujawnia wpisów, niezależnie od podanego konta', async () => {
  const { app } = await fixture();
  for (const identity of ['synthetic-a', 'synthetic-b']) {
    for (const [method, url] of [['GET', '/api/me'], ['GET', '/api/sync/pull'], ['POST', '/api/sync/push'], ['GET', '/api/export'], ['GET', '/api/notes/guessed-id']] as const) {
      // Same-origin requests: CSRF passes, so the 401 proves the session check itself.
      const response = await app.inject({ method, url, headers: { 'x-user-id': identity, cookie: `__Host-razem_session=${identity}`, origin: 'http://localhost:80' } });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'authentication_required' });
    }
  }
});
it('błędy parsera nie odbijają treści ani sekretów klienta', async () => {
  const { app } = await fixture();
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json', origin: 'http://localhost:80' }, payload: '{"synthetic-secret"' });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: 'invalid_request' });
});
