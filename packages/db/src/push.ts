import { randomUUID } from 'node:crypto';
import webpush from 'web-push';
import type { PushSubscribe } from '@razem/contracts';
import type { Database } from './index.js';

export type Vapid = { subject: string; publicKey: string; privateKey: string };
/** No key generation at startup: subscriptions must keep the same application key. */
export function vapidFromEnv(env: NodeJS.ProcessEnv = process.env): Vapid | undefined {
  const { VAPID_SUBJECT: subject, VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = env;
  if (!subject && !publicKey && !privateKey) return undefined;
  try {
    if (!subject || !publicKey || !privateKey) throw new Error();
    webpush.getVapidHeaders('https://web.push.apple.com', subject, publicKey, privateKey, 'aes128gcm');
    return { subject, publicKey, privateKey };
  } catch { throw new Error('Niepoprawna konfiguracja VAPID'); }
}
export type Subscription = {
  id: string; user_id: string; device_id: string; endpoint: string; p256dh: string; auth: string;
  expiration_time: number | null; created_at: string; session_id: string | null;
};
export class PushSubscriptions {
  constructor(private readonly database: Database) {}
  enabled(user: string, device: string, session: string) {
    return !!this.database.sqlite.prepare('SELECT 1 FROM push_subscriptions WHERE user_id=? AND device_id=? AND session_id=?').get(user, device, session);
  }
  subscribe(user: string, session: string, input: PushSubscribe, now = new Date().toISOString()): boolean {
    return this.database.sqlite.transaction(() => {
      const sql = this.database.sqlite;
      // An endpoint is a capability. Never move it silently to a different account/session.
      const existing = sql.prepare('SELECT user_id,session_id FROM push_subscriptions WHERE endpoint=?').get(input.subscription.endpoint) as Pick<Subscription, 'user_id' | 'session_id'> | undefined;
      if (existing && (existing.user_id !== user || existing.session_id !== session)) return false;
      sql.prepare("INSERT INTO devices VALUES (?,?,'Powiadomienia',?,?) ON CONFLICT(user_id,id) DO UPDATE SET last_seen_at=excluded.last_seen_at").run(input.deviceId, user, now, now);
      const previous = sql.prepare('SELECT * FROM push_subscriptions WHERE user_id=? AND device_id=?').get(user, input.deviceId) as Subscription | undefined;
      if (previous && previous.endpoint === input.subscription.endpoint && previous.p256dh === input.subscription.keys.p256dh && previous.auth === input.subscription.keys.auth && previous.session_id === session) {
        sql.prepare('UPDATE push_subscriptions SET expiration_time=? WHERE id=?').run(input.subscription.expirationTime, previous.id);
        return true;
      }
      sql.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND device_id=?').run(user, input.deviceId);
      sql.prepare('INSERT INTO push_subscriptions (id,user_id,device_id,endpoint,p256dh,auth,expiration_time,created_at,session_id) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), user, input.deviceId, input.subscription.endpoint, input.subscription.keys.p256dh, input.subscription.keys.auth, input.subscription.expirationTime, now, session);
      return true;
    }).immediate();
  }
  remove(user: string, device: string, session: string) {
    this.database.sqlite.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND device_id=? AND session_id=?').run(user, device, session);
  }
}
export type PushMessage = { title: string; body: string; tag: string; url: string };
export type PushTransport = (subscription: Subscription, message: PushMessage) => Promise<void>;
export function webPushTransport(vapid: Vapid): PushTransport {
  return async (subscription, message) => {
    await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify(message), {
      vapidDetails: vapid, TTL: 3600, urgency: 'normal', timeout: 10_000,
    });
  };
}
