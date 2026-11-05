import { useEffect, useRef, useState } from 'react';
import { Api } from './api.js';
import { useStandalone } from './pwa.js';
import { Button, Notice, ScreenHeader } from './ui/components.js';
import { Link, navigate, useParam } from './router.js';
import { useServices } from './services.js';
import { entityTypeSchema } from '@razem/contracts';

export function pushSupport(standalone: boolean): 'install' | 'unsupported' | 'denied' | 'ready' {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && !standalone) return 'install';
  if (!window.isSecureContext || !('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) return 'unsupported';
  return Notification.permission === 'denied' ? 'denied' : 'ready';
}
function deviceId() {
  const key = 'razem:push-device';
  let value = localStorage.getItem(key);
  if (!value) { value = crypto.randomUUID(); localStorage.setItem(key, value); }
  return value;
}
function applicationKey(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}

/** Permission changes are checked throughout the signed-in app, including on resume. */
export function usePushPermissionMonitor(account?: string) {
  useEffect(() => {
    if (!account || !('Notification' in window)) return;
    let active = true;
    let permission: PermissionStatus | undefined;
    const check = () => {
      if (!active || Notification.permission !== 'denied') return;
      try {
        const device = localStorage.getItem('razem:push-device');
        if (device) void new Api().removePush(account, device).catch(() => undefined);
      } catch { /* unavailable storage; no subscription can be registered here */ }
    };
    window.addEventListener('focus', check); window.addEventListener('online', check); document.addEventListener('visibilitychange', check);
    check();
    if (navigator.permissions?.query) void navigator.permissions.query({ name: 'notifications' }).then((status) => {
      if (active) { permission = status; status.addEventListener('change', check); }
    }).catch(() => undefined);
    return () => { active = false; window.removeEventListener('focus', check); window.removeEventListener('online', check); document.removeEventListener('visibilitychange', check); permission?.removeEventListener('change', check); };
  }, [account]);
}

/** Only the explicit button calls requestPermission/subscribe; inspection never prompts. */
export function PushOptIn({ account, api = new Api() }: { account: string; api?: Api }) {
  const standalone = useStandalone();
  const [support, setSupport] = useState(() => pushSupport(standalone));
  const [ready, setReady] = useState<{ registration: ServiceWorkerRegistration; key: string; device: string }>();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Sprawdzanie powiadomień na tym urządzeniu…');
  const alive = useRef(true);
  // Keep the same client across rerenders, including pending permission prompts.
  const client = useRef(api).current;
  useEffect(() => {
    alive.current = true;
    let active = true;
    let permission: PermissionStatus | undefined;
    const inspect = async () => {
      const state = pushSupport(standalone); setSupport(state);
      if (state === 'install' || state === 'unsupported') return;
      try {
        const device = deviceId();
        if (state === 'denied') {
          await client.removePush(account, device);
          if (active) { setEnabled(false); setReady(undefined); }
          return;
        }
        const registration = await navigator.serviceWorker.getRegistration('/');
        if (!registration?.active) { if (active) setMessage('Otwórz zainstalowaną aplikację ponownie online, aby przygotować powiadomienia.'); return; }
        const config = await client.pushConfig(account);
        const status = await client.pushStatus(account, device);
        const subscription = await registration.pushManager.getSubscription();
        if (!active) return;
        setReady(config.publicKey ? { registration, key: config.publicKey, device } : undefined);
        setEnabled(status.enabled && !!subscription && Notification.permission === 'granted');
        setMessage(!config.publicKey ? 'Powiadomienia wymagają konfiguracji na serwerze.' : status.enabled && subscription ? 'Powiadomienia na tym urządzeniu są włączone.' : 'Powiadomienia na tym urządzeniu są wyłączone.');
        if (status.enabled && (!subscription || Notification.permission !== 'granted')) await client.removePush(account, device);
      } catch { if (active) setMessage('Nie udało się sprawdzić powiadomień. Połącz się z serwerem i zaloguj ponownie, jeśli sesja wygasła.'); }
    };
    const resume = () => { void inspect(); };
    void inspect();
    window.addEventListener('focus', resume); window.addEventListener('online', resume); document.addEventListener('visibilitychange', resume);
    if (navigator.permissions?.query) void navigator.permissions.query({ name: 'notifications' }).then((status) => {
      if (!active) return; permission = status; status.addEventListener('change', resume);
    }).catch(() => undefined);
    return () => { active = false; alive.current = false; window.removeEventListener('focus', resume); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume); permission?.removeEventListener('change', resume); };
  }, [account, standalone, client]);
  const enable = async () => {
    if (!ready || pushSupport(standalone) !== 'ready') return;
    // Must run synchronously in this click handler, before any network awaits.
    const permission = Notification.requestPermission();
    setBusy(true);
    try {
      if (await permission !== 'granted') { if (alive.current) { setSupport(Notification.permission === 'denied' ? 'denied' : 'ready'); setMessage('Nie udzielono zgody. Powiadomienia pozostają wyłączone.'); } return; }
      if (!alive.current) return;
      const old = await ready.registration.pushManager.getSubscription();
      if (!alive.current) return;
      if (old) await old.unsubscribe();
      if (!alive.current) return;
      const sub = await ready.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationKey(ready.key) });
      if (!alive.current) { await sub.unsubscribe(); return; }
      const json = sub.toJSON();
      try {
        await client.subscribePush(account, { deviceId: ready.device, subscription: { endpoint: sub.endpoint, expirationTime: sub.expirationTime, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' } } });
      } catch (error) { await sub.unsubscribe(); throw error; }
      if (alive.current) { setEnabled(true); setMessage('Powiadomienia na tym urządzeniu są włączone.'); }
    } catch { if (alive.current) setMessage('Nie udało się włączyć powiadomień. Sprawdź połączenie i spróbuj ponownie.'); }
    finally { if (alive.current) setBusy(false); }
  };
  const disable = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      await client.removePush(account, ready.device);
      if (!alive.current) return;
      const sub = await ready.registration.pushManager.getSubscription();
      if (!alive.current) return;
      await sub?.unsubscribe();
      if (alive.current) { setEnabled(false); setMessage('Powiadomienia na tym urządzeniu są wyłączone.'); }
    } catch { if (alive.current) setMessage('Nie udało się wyłączyć powiadomień. Sprawdź połączenie i spróbuj ponownie.'); }
    finally { if (alive.current) setBusy(false); }
  };
  if (support === 'install') return <Notice>Na iPhonie dodaj Razem przez Udostępnij → Do ekranu początkowego, a potem otwórz ikoną, aby włączyć powiadomienia.</Notice>;
  if (support === 'unsupported') return <Notice>Ta przeglądarka nie obsługuje powiadomień lub połączenie nie jest bezpieczne. Na iPhonie użyj aktualnego iOS i zainstalowanej aplikacji.</Notice>;
  if (support === 'denied') return <Notice tone="warning">Zgoda na powiadomienia jest wyłączona. Zmień ją w ustawieniach powiadomień Razem na telefonie, a potem wróć do aplikacji.</Notice>;
  return <div className="group"><Notice role="status">{message}</Notice><Button type="button" disabled={busy || !ready} onClick={() => void (enabled ? disable() : enable())}>{enabled ? 'Wyłącz powiadomienia na tym urządzeniu' : 'Włącz powiadomienia'}</Button></div>;
}

/** A notification never opens cached details until the current server session passes ACL. */
export function PushLinkScreen() {
  const services = useServices();
  const type = useParam('type'), id = useParam('id');
  const account = services.settings?.userId;
  const [message, setMessage] = useState('Sprawdzanie dostępu do wpisu…');
  useEffect(() => {
    let active = true;
    const run = async () => {
      const parsed = entityTypeSchema.safeParse(type);
      if (!account || !parsed.success) { setMessage('Zaloguj się i połącz z serwerem, aby otworzyć powiadomienie.'); return; }
      try {
        const path = await new Api().resolvePush(account, parsed.data, id);
        if (active) navigate(path, { replace: true });
      } catch { if (active) setMessage('Wpis jest niedostępny lub nie masz połączenia. Sprawdź sesję i spróbuj ponownie.'); }
    };
    void run(); return () => { active = false; };
  }, [account, id, type]);
  return <><ScreenHeader title="Powiadomienie" /><Notice>{message}</Notice><Link to={`/logowanie?powiadomienie=${encodeURIComponent(`/powiadomienie/${type}/${id}`)}`} className="button button--plain button--block">Zaloguj się</Link><Link to="/" className="button button--plain button--block">Dzisiaj</Link></>;
}
