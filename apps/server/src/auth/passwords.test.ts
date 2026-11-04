import { expect, it } from 'vitest';
import { DEFAULT_ARGON2, argon2ParamsFromEnv, hashPassword, needsRehash, verifyPassword } from './passwords.js';

it('Argon2id z parametrami produkcyjnymi: format PHC, sól losowa, weryfikacja i NFC', async () => {
  const password = 'Syntetyczne hasło zażółć';
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  expect(first).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  expect(first).not.toBe(second);
  expect(first).not.toContain(password);
  expect(await verifyPassword(password, first)).toBe(true);
  expect(await verifyPassword(password.normalize('NFD'), first)).toBe(true);
  expect(await verifyPassword('Syntetyczne hasło zazolc', first)).toBe(false);
  expect(needsRehash(first, DEFAULT_ARGON2)).toBe(false);
  expect(needsRehash(first, { ...DEFAULT_ARGON2, passes: 4 })).toBe(true);
});

it('odrzuca podmienione lub nadmierne parametry hasha i niepoprawne ustawienia środowiska', async () => {
  const hash = await hashPassword('Syntetyczne-haslo-1', { memory: 1024, passes: 1, parallelism: 1 });
  expect(await verifyPassword('Syntetyczne-haslo-1', hash.replace('m=1024', 'm=99999999'))).toBe(false);
  expect(await verifyPassword('Syntetyczne-haslo-1', hash.replace('argon2id', 'argon2i'))).toBe(false);
  expect(await verifyPassword('Syntetyczne-haslo-1', 'plain-text')).toBe(false);
  expect(argon2ParamsFromEnv({})).toEqual(DEFAULT_ARGON2);
  expect(argon2ParamsFromEnv({ ARGON2_MEMORY_KIB: '131072' }).memory).toBe(131072);
  expect(() => argon2ParamsFromEnv({ ARGON2_MEMORY_KIB: '1024' })).toThrow(); // below OWASP minimum
  expect(() => argon2ParamsFromEnv({ ARGON2_PASSES: 'x' })).toThrow();
});
