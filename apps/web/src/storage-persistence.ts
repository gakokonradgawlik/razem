export type Persistence = 'unknown' | 'granted' | 'denied' | 'unsupported' | 'unavailable';
let state: Persistence = 'unknown';
const listeners = new Set<() => void>();
export const persistenceSnapshot = () => state;
export const subscribePersistence = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Failure is informational: it must never stop opening the database or saving a command. */
export async function requestPersistentStorage(storage: Pick<StorageManager, 'persist' | 'persisted'> | undefined = navigator.storage): Promise<Persistence> {
  try {
    state = !storage?.persist ? 'unsupported'
      : (await storage.persisted?.()) || (await storage.persist()) ? 'granted' : 'denied';
  } catch { state = 'unavailable'; }
  listeners.forEach((listener) => listener());
  return state;
}
