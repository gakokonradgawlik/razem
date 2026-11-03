import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { apiErrorSchema, healthSchema } from '@razem/contracts';
import type { Database } from '@razem/db';
import { registerAuth } from './auth/http.js';
import { AuthService } from './auth/service.js';
import type { AuthConfig } from './auth/service.js';

export interface AppOptions {
  database: Database;
  webRoot?: string;
  auth?: Partial<AuthConfig>;
  /** Defaults to true; only a non-production dev server may set false. */
  secureCookies?: boolean;
  publicOrigin?: string;
  trustProxy?: boolean | string;
}

export async function buildApp(options: AppOptions) {
  // logger off: request logs could carry cookies, URLs or payloads. Only fixed messages are printed.
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, trustProxy: options.trustProxy ?? false });
  const auth = new AuthService(options.database, options.auth);
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

  // Sessions (RAZ-2) guard every /api route; data endpoints arrive with the sync service (RAZ-4).
  // Never trust a deviceId, ownerId or request header as an account: only the session cookie.
  registerAuth(app, {
    service: auth, secureCookies: options.secureCookies ?? true,
    ...(options.publicOrigin ? { publicOrigin: options.publicOrigin } : {}),
  });
  app.all('/api/*', async (_request, reply) => reply.code(404).send(apiErrorSchema.parse({ error: 'not_found' })));
  app.setErrorHandler((error, _request, reply) => {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    reply.code(status >= 400 && status < 500 ? status : 500)
      .send(apiErrorSchema.parse({ error: status >= 400 && status < 500 ? 'invalid_request' : 'unavailable' }));
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
  return app;
}
