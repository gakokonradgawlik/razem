import { expect, it, vi } from 'vitest';
import { requestPersistentStorage } from './storage-persistence.js';

it('requests persistence, handles refusal/unsupported/failure without rejecting', async () => {
  const persist = vi.fn(async () => true);
  expect(await requestPersistentStorage({ persisted: async () => false, persist })).toBe('granted');
  expect(persist).toHaveBeenCalledOnce();
  persist.mockClear();
  expect(await requestPersistentStorage({ persisted: async () => true, persist })).toBe('granted');
  expect(persist).not.toHaveBeenCalled();
  expect(await requestPersistentStorage({ persisted: async () => false, persist: async () => false })).toBe('denied');
  expect(await requestPersistentStorage({} as StorageManager)).toBe('unsupported');
  expect(await requestPersistentStorage({ persisted: async () => { throw new Error('blocked'); }, persist })).toBe('unavailable');
});
