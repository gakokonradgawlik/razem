import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

function worker() {
  const events: Record<string, (event: unknown) => void> = {};
  const showNotification = vi.fn(async () => undefined), openWindow = vi.fn(async () => undefined);
  runInNewContext(readFileSync(new URL('../sw.js', import.meta.url), 'utf8').replace('__PRECACHE__', '[]'), {
    self: { addEventListener: (name: string, callback: (event: unknown) => void) => { events[name] = callback; },
      location: { origin: 'https://razem.test' }, registration: { showNotification }, clients: { matchAll: async () => [], openWindow } }, URL,
  });
  return { events, showNotification, openWindow };
}
it('SW zawsze pokazuje powiadomienie, także bez payloadu; tag scala powtórne dostarczenie', async () => {
  const w = worker();
  let work!: Promise<void>;
  w.events.push!({ data: { json: () => ({ body: 'Masz przypomnienie w Razem', tag: 'dedup', url: '/powiadomienie/task/00000000-0000-4000-8000-0000000000aa' }) }, waitUntil: (p: Promise<void>) => { work = p; } }); await work;
  expect(w.showNotification).toHaveBeenCalledWith('Razem', expect.objectContaining({ tag: 'dedup', body: 'Masz przypomnienie w Razem' }));
  w.events.push!({ data: { json: () => { throw new Error('bad payload'); } }, waitUntil: (p: Promise<void>) => { work = p; } }); await work;
  expect(w.showNotification).toHaveBeenCalledTimes(2); expect(w.showNotification.mock.calls[1]).toMatchObject(['Razem', { body: 'Masz przypomnienie w Razem', data: { url: '/' } }]);
});
it('kliknięcie prowadzi tylko pod własny origin i trasę sprawdzającą ACL, nigdy do URL z payloadu', async () => {
  const w = worker(); let work!: Promise<void>;
  for (const url of ['https://evil.test/phishing', '/api/export', '//evil.test', '/powiadomienie/task/00000000-0000-4000-8000-0000000000aa']) {
    w.events.notificationclick!({ notification: { close: vi.fn(), data: { url } }, waitUntil: (p: Promise<void>) => { work = p; } }); await work;
    expect(w.openWindow).toHaveBeenLastCalledWith('https://razem.test' + (url.startsWith('/powiadomienie/') ? url : '/'));
  }
});
