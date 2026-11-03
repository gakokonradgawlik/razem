import { expect, it } from 'vitest';
import { serverSettings } from './config.js';

it('produkcja: cookie Secure obowiązkowe, PUBLIC_ORIGIN musi być dokładnym originem HTTPS', () => {
  expect(serverSettings({}).secureCookies).toBe(true);
  expect(serverSettings({ COOKIE_SECURE: 'false' }).secureCookies).toBe(false);
  expect(() => serverSettings({ NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow();
  expect(serverSettings({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://razem.example' }).publicOrigin).toBe('https://razem.example');
  for (const origin of ['http://razem.example', 'https://razem.example/', 'https://razem.example/app', '*'])
    expect(() => serverSettings({ NODE_ENV: 'production', PUBLIC_ORIGIN: origin })).toThrow();
  expect(serverSettings({ TRUST_PROXY: '127.0.0.1' }).trustProxy).toBe('127.0.0.1');
  expect(serverSettings({ TRUST_PROXY: '' }).trustProxy).toBe(false);
});
