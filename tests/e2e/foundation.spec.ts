import { test, expect } from '@playwright/test';
import { healthSchema } from '../../packages/contracts/src/index.js';

test('zbudowany ekran, realne HTTP API i dwa odizolowane konteksty', async ({ browser, request }) => {
  const response = await request.get('/readyz');
  expect(response.status()).toBe(200);
  expect(healthSchema.parse(await response.json()).status).toBe('ok');
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    for (const context of contexts) {
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Dzisiaj', level: 1 })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Główna nawigacja' })).toBeVisible();
      const denied = await context.request.get('http://127.0.0.1:4317/api/sync/pull');
      expect(denied.status()).toBe(401);
      expect(await denied.json()).toEqual({ error: 'authentication_required' });
    }
    const first = contexts[0]!;
    const second = contexts[1]!;
    await first.addCookies([{ name: 'isolation-fixture', value: 'synthetic', url: 'http://127.0.0.1:4317' }]);
    expect((await second.cookies()).some((cookie) => cookie.name === 'isolation-fixture')).toBe(false);
  } finally { await Promise.all(contexts.map((context) => context.close())); }
});
