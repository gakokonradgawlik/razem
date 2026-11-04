import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { apiErrorSchema, healthSchema } from '@razem/contracts';
import type { Database } from '@razem/db';
import { registerAuth } from './auth/http.js';
import { AuthService } from './auth/service.js';
import type { AuthConfig } from './auth/service.js';
import { registerSync } from './sync/http.js';
import { SyncService } from './sync/service.js';
import type { SyncConfig } from './sync/service.js';

export interface AppOptions {
  database: Database;
  webRoot?: string;
  auth?: Partial<AuthConfig>;
  /** Defaults to true; only a non-production dev server may set false. */
  secureCookies?: boolean;
  publicOrigin?: string;
  trustProxy?: boolean | string;
  sync?: Partial<SyncConfig>;
  /** Retention job interval (trash purge, receipts, journal); 0 disables it (tests call maintenance()). */
  maintenanceIntervalMs?: number;
}

const syncServices = new WeakMap<FastifyInstance, SyncService>();
/** The app's sync service, for the retention job and tests; HTTP is the only client path. */
export function syncServiceOf(app: FastifyInstance): SyncService {
  const sync = syncServices.get(app);
  if (!sync) throw new Error('Brak serwisu synchronizacji');
  return sync;
}

export async function buildApp(options: AppOptions) {
  // logger off: request logs could carry cookies, URLs or payloads. Only fixed messages are printed.
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, trustProxy: options.trustProxy ?? false });
  const auth = new AuthService(options.database, options.auth);
  const sync = new SyncService(options.database, options.sync);
  if (options.maintenanceIntervalMs) {
    const run = () => { try { sync.maintenance(); } catch { console.error('Razem: retencja synchronizacji nie powiodła się'); } };
    const timer = setInterval(run, options.maintenanceIntervalMs);
    timer.unref();
    app.addHook('onReady', async () => run());
    app.addHook('onClose', async () => clearInterval(timer));
  }
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  });
  app.get('/healthz', async () => healthSchema.parse({ status: 'ok', service: 'razem', protocolVersion: 1 }));
  app.get('/readyz', async (_request, reply) => {
    try {
      options.database.sqlite.prepare('SELECT 1').get();
      return healthSchema.parse({ status: 'ok', service: 'razem', protocolVersion: 1 });
    } catch {
      return reply.code(503).send(apiErrorSchema.parse({ error: 'unavailable' }));
    }
  });

  // Sessions (RAZ-2) guard every /api route; domain data only through the sync service (RAZ-4).
  // Never trust a deviceId, ownerId or request header as an account: only the session cookie.
  registerAuth(app, {
    service: auth, secureCookies: options.secureCookies ?? true,
    ...(options.publicOrigin ? { publicOrigin: options.publicOrigin } : {}),
  });
  registerSync(app, sync);
  app.all('/api/*', async (_request, reply) => reply.code(404).send(apiErrorSchema.parse({ error: 'not_found' })));
  app.setErrorHandler((error, _request, reply) => {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    const client = status >= 400 && status < 500;
    reply.code(client ? status : 500)
      .send(apiErrorSchema.parse({ error: status === 413 ? 'payload_too_large' : client ? 'invalid_request' : 'unavailable' }));
  });
  if (options.webRoot) {
    await app.register(fastifyStatic, { root: options.webRoot });
  }
  app.setNotFoundHandler(async (request, reply) => {
    // SPA fallback never masks unknown API routes or missing static assets.
    if (options.webRoot && request.method === 'GET' && !request.url.startsWith('/api') && !request.url.split('?')[0]?.includes('.')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send(apiErrorSchema.parse({ error: 'not_found' }));
  });
  syncServices.set(app, sync);
  return app;
}
