import { describe, expect, it } from 'vitest';
import { annualDate, canReadRecord, defaultVisibility, localTimeToInstant, monthlyDate,
  mutationSchema, mutationResultSchema, pullResponseSchema, pushRequestSchema,
  recordSchemaUnion, dateSchema, instantSchema, userSchema } from './index.js';

const id = '11111111-1111-4111-8111-111111111111';
const partner = '22222222-2222-4222-8222-222222222222';
const otherHouse = '33333333-3333-4333-8333-333333333333';
const now = '2026-11-04T10:00:00Z';
const create = { clientMutationId: id, entityId: id, entityType: 'note', command: 'create', baseVersion: 0, visibility: 'private', data: { title: 'Test syntetyczny', body: 'Treść testowa' } };
const note = { id, entityType: 'note', householdId: id, ownerId: id, visibility: 'private', version: 1, createdAt: now, updatedAt: now, deletedAt: null, data: create.data };

describe('granice kontraktu mutacji', () => {
  it('przyjmuje create i wersjonowane update/delete/restore', () => {
    expect(mutationSchema.parse(create)).toEqual(create);
    for (const command of ['update', 'delete', 'restore']) {
      expect(mutationSchema.safeParse({ clientMutationId: id, entityId: id, entityType: 'note', command, baseVersion: 1, ...(command === 'update' ? { patch: { body: 'Zmiana' } } : {}) }).success).toBe(true);
    }
  });
  it.each(['ownerId', 'householdId', 'version', 'createdAt'])('odrzuca pole serwerowe %s', (field) => {
    expect(mutationSchema.safeParse({ ...create, [field]: id }).success).toBe(false);
  });
  it('blokuje zmianę widoczności, pustą zmianę i wersję zerową przy update', () => {
    const update = { clientMutationId: id, entityId: id, entityType: 'note', command: 'update', baseVersion: 1 };
    for (const patch of [{ visibility: 'shared' }, {}, { ownerId: partner }]) {
      expect(mutationSchema.safeParse({ ...update, patch }).success).toBe(false);
    }
    expect(mutationSchema.safeParse({ ...update, baseVersion: 0, patch: { title: 'Zmiana' } }).success).toBe(false);
  });
  it('dziecko dziedziczy ACL i nie może zmieniać rodzica', () => {
    const item = { ...create, entityType: 'shopping_item', data: { listId: id, name: 'Test', quantity: '', note: '', checked: false, sortKey: 0 } };
    expect(mutationSchema.safeParse(item).success).toBe(false);
    const { visibility: _visibility, ...inherited } = item;
    expect(mutationSchema.safeParse(inherited).success).toBe(true);
    expect(mutationSchema.safeParse({ clientMutationId: id, entityId: id, entityType: 'shopping_item', command: 'update', baseVersion: 1, patch: { listId: partner } }).success).toBe(false);
  });
  it('ogranicza partie i odrzuca powtórzone identyfikatory', () => {
    expect(pushRequestSchema.safeParse({ protocolVersion: 2, deviceId: id, mutations: [create] }).success).toBe(true);
    for (const mutations of [[], [create, create], Array(101).fill(create)]) {
      expect(pushRequestSchema.safeParse({ protocolVersion: 2, deviceId: id, mutations }).success).toBe(false);
    }
  });
});

describe('prywatność i odpowiedzi sync', () => {
  it('projekcja konta odrzuca dane uwierzytelnienia', () => {
    const user = { id, householdId: id, login: 'synthetic-user', displayName: 'Test', mustChangePassword: true, createdAt: now };
    expect(userSchema.safeParse(user).success).toBe(true);
    expect(userSchema.safeParse({ ...user, passwordHash: 'synthetic-not-a-password' }).success).toBe(false);
    expect(userSchema.safeParse({ ...user, tokenHash: 'synthetic-not-a-token' }).success).toBe(false);
  });
  it('rozdziela konta i gospodarstwa, domyślna notatka jest prywatna', () => {
    const record = recordSchemaUnion.parse(note);
    expect(canReadRecord({ userId: id, householdId: id }, record)).toBe(true);
    expect(canReadRecord({ userId: partner, householdId: id }, record)).toBe(false);
    expect(canReadRecord({ userId: partner, householdId: id }, { ...record, visibility: 'shared' })).toBe(true);
    expect(canReadRecord({ userId: id, householdId: otherHouse }, { ...record, visibility: 'shared' })).toBe(false);
    expect(defaultVisibility('note')).toBe('private');
    expect(defaultVisibility('task')).toBe('shared');
  });
  it('błąd niedostępnego wpisu nie może ujawniać rekordu', () => {
    const error = { clientMutationId: id, entityId: id, entityType: 'note', status: 'error', code: 'not_found', retryable: false };
    expect(mutationResultSchema.safeParse(error).success).toBe(true);
    expect(mutationResultSchema.safeParse({ ...error, record: note }).success).toBe(false);
  });
  it('odrzuca ACK lub konflikt przypisany do innego rekordu', () => {
    for (const status of ['ack', 'conflict']) {
      expect(mutationResultSchema.safeParse({ clientMutationId: id, entityId: partner, entityType: 'note', status, state: { kind: 'record', record: note } }).success).toBe(false);
    }
  });
  it('ACK i conflict zawierają kanoniczną wersję; pull obsługuje tombstone i resync', () => {
    const state = { kind: 'record', record: note };
    for (const status of ['ack', 'conflict']) expect(mutationResultSchema.safeParse({ clientMutationId: id, entityId: id, entityType: 'note', status, state }).success).toBe(true);
    const page = { status: 'ok', protocolVersion: 2, mode: 'snapshot', watermark: 'opaque-watermark', changes: [state, { kind: 'tombstone', tombstone: { entityType: 'note', id: partner, version: 2, deletedAt: now } }], nextCursor: 'opaque-user-bound-cursor', hasMore: true };
    expect(pullResponseSchema.safeParse(page).success).toBe(true);
    expect(pullResponseSchema.safeParse({ ...page, nextCursor: '' }).success).toBe(false);
    expect(pullResponseSchema.safeParse({ ...page, changes: Array(201).fill(state) }).success).toBe(false);
    expect(pullResponseSchema.safeParse({ status: 'resync_required', reason: 'cursor_expired' }).success).toBe(true);
  });
});

describe('daty i reguły domenowe', () => {
  it('rozróżnia datę i chwilę UTC oraz odrzuca niemożliwą datę', () => {
    expect(dateSchema.safeParse('2026-02-29').success).toBe(false);
    expect(dateSchema.safeParse('2028-02-29').success).toBe(true);
    expect(instantSchema.safeParse('2026-11-04T10:00:00+01:00').success).toBe(false);
  });
  it('DST: luka do pierwszej istniejącej minuty, nakładanie do wcześniejszej chwili', () => {
    expect(localTimeToInstant('2026-03-29', '02:30')).toBe('2026-03-29T01:00:00Z');
    expect(localTimeToInstant('2026-10-25', '02:30')).toBe('2026-10-25T00:30:00Z');
    expect(localTimeToInstant('2026-11-04', '09:00')).toBe('2026-11-04T08:00:00Z');
  });
  it('nie traci oryginalnej reguły 29.02 i 31. dnia miesiąca', () => {
    expect(annualDate(2, 29, 2027)).toBe('2027-02-28');
    expect(annualDate(2, 29, 2028)).toBe('2028-02-29');
    expect(monthlyDate(31, 2026, 2)).toBe('2026-02-28');
    expect(monthlyDate(31, 2026, 3)).toBe('2026-03-31');
    expect(() => annualDate(2, 30, 2027)).toThrow();
    expect(() => monthlyDate(32, 2026, 3)).toThrow();
  });
  it('odrzuca prywatne przypisanie partnerowi i podwójny termin', () => {
    const task = { ...create, entityType: 'task', data: { title: 'Test', description: '', assignee: 'partner', dueDate: null, dueAt: null, completedAt: null, recurrence: null, timezone: 'Europe/Warsaw' } };
    expect(mutationSchema.safeParse(task).success).toBe(false);
    expect(mutationSchema.safeParse({ ...task, visibility: 'shared' }).success).toBe(true);
    expect(mutationSchema.safeParse({ ...task, visibility: 'shared', data: { ...task.data, dueDate: '2026-11-04', dueAt: now } }).success).toBe(false);
  });
  it('wymaga wyłącznego końca zakresu i poprawnej daty rocznej', () => {
    const event = { ...create, entityType: 'calendar_event', data: { title: 'Test', description: '', allDay: true, timezone: 'Europe/Warsaw', startDate: '2026-11-04', endDate: '2026-11-05', startAt: null, endAt: null } };
    expect(mutationSchema.safeParse(event).success).toBe(true);
    expect(mutationSchema.safeParse({ ...event, data: { ...event.data, endDate: '2026-11-04' } }).success).toBe(false);
    expect(mutationSchema.safeParse({ ...create, entityType: 'important_date', data: { name: 'Test', month: 2, day: 30, startYear: null, kind: 'other' } }).success).toBe(false);
  });
});
