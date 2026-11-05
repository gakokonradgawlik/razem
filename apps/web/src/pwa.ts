import { useSyncExternalStore } from 'react';

type PwaState = 'loading' | 'ready' | 'update' | 'unavailable';
let state: PwaState = 'loading';
const listeners = new Set<() => void>();
const set = (value: PwaState) => { state = value; listeners.forEach((listener) => listener()); };
export function usePwaState() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state);
}

/** Called once by the production entrypoint, never in the fixture app or dev server. */
export async function startPwa() {
  if (!('serviceWorker' in navigator)) { set('unavailable'); return; }
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    const inspect = () => {
      if (registration.waiting && registration.active) set('update');
      else if (registration.active?.state === 'activated') set('ready');
    };
    const watch = () => {
      registration.installing?.addEventListener('statechange', inspect);
      inspect();
    };
    registration.addEventListener('updatefound', watch);
    watch();
    // Recheck on resume/connection, including long-running tabs. Offline failure is expected.
    const update = () => { if (document.visibilityState === 'visible') void registration.update().catch(() => undefined); };
    window.addEventListener('online', update);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
  } catch { set('unavailable'); }
}

export function useStandalone() {
  const query = '(display-mode: standalone)';
  return useSyncExternalStore((listener) => {
    if (!window.matchMedia) return () => undefined;
    const media = window.matchMedia(query);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, () => window.matchMedia?.(query).matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true);
}
