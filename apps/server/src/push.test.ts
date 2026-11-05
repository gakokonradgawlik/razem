import { randomUUID, createECDH } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import webpush from 'web-push';
import { migrate, openDatabase, RecordRepository, vapidFromEnv, webPushTransport } from '@razem/db';
import type { Database } from '@razem/db';
import { pushSubscribeSchema } from '@razem/contracts';
import { buildApp } from './app.js';
import { AuthService } from './auth/service.js';

let db: Database, app: Awaited<ReturnType<typeof buildApp>>, a: string, b: string;
const ORIGIN = 'https://razem.test', FAST = { memory: 1024, passes: 1, parallelism: 1 };
const keys = webpush.generateVAPIDKeys(), vapid = { ...keys, subject: 'mailto:admin@example.test' };
let cookieA: string, cookieB: string;
const device = randomUUID();
const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
const subscription = { endpoint: 'https://web.push.apple.com/synthetic', expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } };
const headers = (id = a, cookie = cookieA) => ({ cookie, origin: ORIGIN, 'content-type': 'application/json', 'x-razem-account': id });
const subscribe = (id = a, cookie = cookieA, dev = device, sub = subscription) => app.inject({ method: 'PUT', url: '/api/push/subscription', headers: headers(id, cookie), payload: { deviceId: dev, subscription: sub } });
beforeEach(async () => {
  db = openDatabase(':memory:'); migrate(db.sqlite);
  const auth = new AuthService(db, { argon2: FAST });
  const boot = await auth.bootstrap({ householdName: 'Test', timezone: 'Europe/Warsaw', members: [
    { login: 'alpha@example.test', displayName: 'A', temporaryPassword: 'Tymczasowe-A-2026!' }, { login: 'beta@example.test', displayName: 'B', temporaryPassword: 'Tymczasowe-B-2026!' },
  ] });
  a = boot.userIds[0]!; b = boot.userIds[1]!;
  db.sqlite.prepare('UPDATE users SET must_change_password=0').run();
  app = await buildApp({ database: db, auth: { argon2: FAST }, publicOrigin: ORIGIN, vapid });
  const ca = await auth.login('alpha@example.test', 'Tymczasowe-A-2026!', '127.0.0.1');
  const cb = await auth.login('beta@example.test', 'Tymczasowe-B-2026!', '127.0.0.1');
  cookieA = `__Host-razem_session=${ca.token}`; cookieB = `__Host-razem_session=${cb.token}`;
});
afterEach(async () => { vi.restoreAllMocks(); await app.close(); db.close(); });

it('HTTP: sesja, CSRF i powiązanie konta; subskrypcje per urządzenie, idempotencja i logout', async () => {
  expect((await app.inject({ url: '/api/push/config' })).statusCode).toBe(401);
  expect((await app.inject({ url: '/api/push/config', headers: headers() })).json()).toEqual({ publicKey: keys.publicKey });
  expect((await app.inject({ method: 'PUT', url: '/api/push/subscription', headers: { ...headers(), origin: 'https://obce.test' }, payload: { deviceId: device, subscription } })).statusCode).toBe(403);
  expect((await subscribe(b, cookieA)).statusCode).toBe(409);
  expect((await subscribe()).json()).toEqual({ enabled: true }); expect((await subscribe()).statusCode).toBe(200);
  expect(db.sqlite.prepare('SELECT count(*) n FROM push_subscriptions').get()).toEqual({ n: 1 });
  const status = await app.inject({ url: `/api/push/devices/${device}`, headers: headers(b, cookieB) });
  expect(status.json()).toEqual({ enabled: false });
  expect((await subscribe(b, cookieB)).statusCode).toBe(409); // endpoint cannot be stolen
  expect((await subscribe(a, cookieA, randomUUID(), { ...subscription, endpoint: 'https://fcm.googleapis.com/synthetic-2' })).statusCode).toBe(200);
  expect(db.sqlite.prepare('SELECT count(*) n FROM push_subscriptions').get()).toEqual({ n: 2 });
  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: headers(), payload: {} });
  expect(logout.statusCode).toBe(204); expect(db.sqlite.prepare('SELECT count(*) n FROM push_subscriptions').get()).toEqual({ n: 0 });
});

it('odpięcie usuwa tylko własne urządzenie bieżącej sesji; reset/revoke unieważnia subskrypcję', async () => {
  await subscribe();
  const second = randomUUID(); await subscribe(a, cookieA, second, { ...subscription, endpoint: 'https://web.push.apple.com/second' });
  expect((await app.inject({ method: 'DELETE', url: `/api/push/devices/${device}`, headers: headers(b, cookieB), payload: {} })).statusCode).toBe(204);
  expect(db.sqlite.prepare('SELECT count(*) n FROM push_subscriptions').get()).toEqual({ n: 2 });
  await app.inject({ method: 'DELETE', url: `/api/push/devices/${device}`, headers: headers(), payload: {} });
  expect(db.sqlite.prepare('SELECT device_id FROM push_subscriptions').all()).toEqual([{ device_id: second }]);
  db.sqlite.prepare('DELETE FROM sessions WHERE user_id=?').run(a);
  expect(db.sqlite.prepare('SELECT count(*) n FROM push_subscriptions').get()).toEqual({ n: 0 });
});

it('link z push ponownie sprawdza sesję/ACL i usunięcie; prywatne ID zwraca taki sam błąd jak brak', async () => {
  const account = { userId: a, householdId: new AuthService(db).accounts.userById(a)!.householdId };
  const repo = new RecordRepository(db);
  const created = repo.create(account, { id: randomUUID(), entityType: 'task', visibility: 'private', data: { title: 'SECRET A', description: '', assignee: 'self', dueDate: null, dueAt: null, timezone: 'Europe/Warsaw', completedAt: null, recurrence: null } });
  if (created.status !== 'ack') throw new Error('fixture');
  const resolve = (id: string, user = a, cookie = cookieA) => app.inject({ method: 'POST', url: '/api/push/resolve', headers: headers(user, cookie), payload: { entityType: 'task', id } });
  expect((await resolve(created.record.id)).json()).toEqual({ path: `/zadania/${created.record.id}` });
  const denied = await resolve(created.record.id, b, cookieB), missing = await resolve(randomUUID(), b, cookieB);
  expect([denied.statusCode, denied.body]).toEqual([missing.statusCode, missing.body]); expect(denied.body).not.toContain('SECRET');
  repo.remove(account, { id: created.record.id, entityType: 'task', baseVersion: 1 });
  expect((await resolve(created.record.id)).statusCode).toBe(404);
  db.sqlite.prepare('DELETE FROM sessions WHERE user_id=?').run(a);
  expect((await resolve(created.record.id)).statusCode).toBe(401);
});

it('endpointy LAN, przekierowania przez credentials, HTTP i podmiana pól są odrzucane przed transportem', async () => {
  for (const endpoint of ['http://web.push.apple.com/x', 'https://127.0.0.1/x', 'https://192.168.1.1/x', 'https://web.push.apple.com.evil.test/x', 'https://user:pass@web.push.apple.com/x', 'https://web.push.apple.com:444/x'])
    expect((await subscribe(a, cookieA, device, { ...subscription, endpoint })).statusCode).toBe(400);
  expect(pushSubscribeSchema.safeParse({ deviceId: device, userId: b, subscription }).success).toBe(false);
  const response = await subscribe();
  expect(response.body).not.toMatch(/endpoint|p256dh|auth|session|privateKey/);
});

it('VAPID walidowane bez ujawniania sekretów; transport szyfruje i podpisuje standardowy Web Push', async () => {
  expect(vapidFromEnv({})).toBeUndefined();
  expect(() => vapidFromEnv({ VAPID_PRIVATE_KEY: 'PRIVATE_DO_NOT_LOG' })).toThrow('Niepoprawna konfiguracja VAPID');
  expect(vapidFromEnv({ VAPID_SUBJECT: vapid.subject, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey })).toEqual(vapid);
  const spy = vi.spyOn(webpush, 'sendNotification').mockImplementation(async (sub, payload, options) => {
    const request = webpush.generateRequestDetails(sub, String(payload ?? ''), options);
    expect(request.headers.Authorization).toMatch(/^vapid t=/); expect(request.headers['Content-Encoding']).toBe('aes128gcm');
    expect(request.body?.toString()).not.toContain('Masz przypomnienie'); expect(options?.timeout).toBe(10000);
    return { statusCode: 201, headers: {}, body: '' };
  });
  await webPushTransport(vapid)({ id: randomUUID(), user_id: a, device_id: device, endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, expiration_time: null, created_at: new Date().toISOString(), session_id: null },
  { title: 'Razem', body: 'Masz przypomnienie w Razem', tag: 'test', url: '/' });
  expect(spy).toHaveBeenCalledTimes(1);
});

it('integracja HTTP sync → SQLite → worker → urządzenie: prywatność, retry mutacji i aktualna sesja', async () => {
  const { ReminderWorker } = await import('../../worker/src/worker.js');
  await subscribe(); await subscribe(b, cookieB, randomUUID(), { ...subscription, endpoint: 'https://web.push.apple.com/b' });
  await app.inject({ method: 'PATCH', url: '/api/settings', headers: headers(), payload: { taskAssignments: false } });
  const at = Date.now() + 1000, target = randomUUID();
  const mutation = { clientMutationId: randomUUID(), entityId: target, entityType: 'task', command: 'create', baseVersion: 0, visibility: 'private',
    data: { title: 'NEVER ON LOCKSCREEN', description: 'SECRET', assignee: 'self', dueDate: null, dueAt: new Date(at).toISOString(), timezone: 'Europe/Warsaw', completedAt: null, recurrence: null } };
  const payload = { protocolVersion: 2, deviceId: randomUUID(), mutations: [mutation] };
  for (let retry = 0; retry < 2; retry++) {
    const response = await app.inject({ method: 'POST', url: '/api/sync/push', headers: headers(), payload });
    expect(response.json().results[0].status).toBe('ack');
  }
  const send = vi.fn(async () => undefined);
  const worker = new ReminderWorker(db, send, () => new Date(at + 1000));
  await worker.tick(); await worker.tick(); expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]).toMatchObject([{ user_id: a }, { body: 'Masz przypomnienie w Razem', url: `/powiadomienie/task/${target}` }]);
  expect(db.sqlite.prepare('SELECT count(*) n FROM reminder_dispatches').get()).toEqual({ n: 1 });
});

it('starsza zainstalowana PWA zachowuje strict kontrakt ustawień i eksportu; rozszerzenie wymaga nagłówka', async () => {
  for (const url of ['/api/settings', '/api/export']) {
    const old = await app.inject({ url, headers: headers() });
    const oldSettings = url === '/api/settings' ? old.json() : old.json().settings;
    expect(oldSettings.notifications).toEqual({ includeTitles: false, shoppingNotifications: false });
    const current = await app.inject({ url, headers: { ...headers(), 'x-razem-notifications': '1' } });
    const settings = url === '/api/settings' ? current.json() : current.json().settings;
    expect(settings.notifications).toMatchObject({ taskReminders: true, taskReminderTime: '09:00', taskMinutesBefore: 0, taskAssignments: true });
  }
});

it('HTTP sync z retry: autor z sesji, domyślne przypisanie both i zakupy nie powiadamiają autora', async () => {
  const { ReminderWorker } = await import('../../worker/src/worker.js');
  await subscribe(); await subscribe(b, cookieB, randomUUID(), { ...subscription, endpoint: 'https://web.push.apple.com/b' });
  for (const [id, cookie] of [[a, cookieA], [b, cookieB]]) {
    expect((await app.inject({ method: 'PATCH', url: '/api/settings', headers: headers(id, cookie), payload: { shoppingNotifications: true } })).statusCode).toBe(200);
  }
  const target = randomUUID(), list = randomUUID();
  const payload = { protocolVersion: 2, deviceId: randomUUID(), mutations: [
    { clientMutationId: randomUUID(), entityId: target, entityType: 'task', command: 'create', baseVersion: 0, visibility: 'shared',
      data: { title: 'Wspólne', description: '', assignee: 'both', dueDate: null, dueAt: null, timezone: 'Europe/Warsaw', completedAt: null, recurrence: null } },
    { clientMutationId: randomUUID(), entityId: list, entityType: 'shopping_list', command: 'create', baseVersion: 0, visibility: 'shared', data: { name: 'Zakupy' } },
  ] };
  for (let retry = 0; retry < 2; retry++) {
    const response = await app.inject({ method: 'POST', url: '/api/sync/push', headers: headers(), payload });
    expect(response.json().results.map((r: { status: string }) => r.status)).toEqual(['ack', 'ack']);
    expect(response.body).not.toMatch(/actorId|actor_id|previousAssignee|previous_assignee/);
  }
  const send = vi.fn(async () => undefined), worker = new ReminderWorker(db, send);
  await worker.tick(); await worker.tick();
  expect(send.mock.calls).toEqual([
    [expect.objectContaining({ user_id: b }), expect.any(Object)],
    [expect.objectContaining({ user_id: b }), expect.any(Object)],
  ]);
  const pull = await app.inject({ url: '/api/sync/pull', headers: { ...headers(b, cookieB), 'x-razem-protocol': '2' } });
  expect(pull.statusCode).toBe(200); expect(pull.body).not.toMatch(/actorId|actor_id|previousAssignee|previous_assignee/);
});

it('zmiana konta przez login odpina push poprzedniej sesji przeglądarki, zachowując inne urządzenie', async () => {
  await subscribe();
  const auth = new AuthService(db, { argon2: FAST });
  const other = await auth.login('alpha@example.test', 'Tymczasowe-A-2026!', '127.0.0.1');
  const otherCookie = `__Host-razem_session=${other.token}`;
  await subscribe(a, otherCookie, randomUUID(), { ...subscription, endpoint: 'https://web.push.apple.com/other-device' });
  expect(db.sqlite.prepare('SELECT count(*) n FROM push_subscriptions').get()).toEqual({ n: 2 });
  const result = await app.inject({ method: 'POST', url: '/api/auth/login', headers: headers(), payload: { login: 'beta@example.test', password: 'Tymczasowe-B-2026!' } });
  expect(result.statusCode).toBe(200);
  expect(db.sqlite.prepare('SELECT endpoint FROM push_subscriptions').all()).toEqual([{ endpoint: 'https://web.push.apple.com/other-device' }]);
  expect((await app.inject({ url: '/api/me', headers: headers() })).statusCode).toBe(200);
});
