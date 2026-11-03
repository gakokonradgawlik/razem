import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { apiErrorSchema, healthSchema } from '@razem/contracts';
import type { Database } from '@razem/db';

export async function buildApp(options: { database: Database; webRoot?: string }) {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
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

  // Fail closed until RAZ-2 (sessions) and RAZ-4 (sync service). Never trust a
  // deviceId, ownerId, cookie or request header as an authenticated account here.
  app.all('/api/*', async (_request, reply) => reply.code(401).send(apiErrorSchema.parse({ error: 'authentication_required' })));
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
