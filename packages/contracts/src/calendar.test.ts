import { describe, expect, it } from 'vitest';
import { calendarRecipients, calendarReminderAt, eventDays, importantOccurrence, nextImportantOccurrence } from './calendar.js';
import { localTimeToInstant } from './dates.js';
import { mutationSchema } from './sync.js';
const event = { title: 'Test', description: '', allDay: false, timezone: 'Europe/Warsaw', startDate: null, endDate: null, startAt: '2026-12-31T22:30:00Z', endAt: '2027-01-01T00:00:00Z' };
const annual = { name: 'Rocznica', month: 2, day: 29, startYear: null, kind: 'anniversary' as const };
const reminder = { targetType: 'calendar_event' as const, targetId: '00000000-0000-4000-8000-000000000001', enabled: true, minutesBefore: 30, localTime: null };

describe('kalendarz — reguły wspólne', () => {
  it('Warszawa: wiosenna luka i jesienny overlap, koniec po rozwiązaniu DST', () => {
    expect(localTimeToInstant('2026-03-29', '02:30')).toBe('2026-03-29T01:00:00Z');
    expect(localTimeToInstant('2026-10-25', '02:30')).toBe('2026-10-25T00:30:00Z');
    expect(eventDays({ ...event, startAt: '2026-03-28T23:00:00Z', endAt: '2026-03-29T22:00:00Z' })).toEqual({ start: '2026-03-29', end: '2026-03-30' });
    expect(eventDays({ ...event, startAt: '2026-10-24T22:00:00Z', endAt: '2026-10-25T23:00:00Z' })).toEqual({ start: '2026-10-25', end: '2026-10-26' });
    const invalid = { ...event, startAt: localTimeToInstant('2026-03-29', '02:30'), endAt: localTimeToInstant('2026-03-29', '03:00') };
    expect(mutationSchema.safeParse({ clientMutationId: crypto.randomUUID(), entityId: crypto.randomUUID(), entityType: 'calendar_event', command: 'create', baseVersion: 0, visibility: 'shared', data: invalid }).success).toBe(false);
  });
  it('całodniowy wielodniowy zakres nie przesuwa się w żadnej strefie; wyłączny koniec', () => {
    for (const timezone of ['Pacific/Honolulu', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Europe/Warsaw']) {
      expect(eventDays({ ...event, allDay: true, startAt: null, endAt: null, startDate: '2026-12-30', endDate: '2027-01-03' }, timezone)).toEqual({ start: '2026-12-30', end: '2027-01-03' });
    }
    expect(eventDays({ ...event, endAt: '2026-12-31T23:00:00Z' })).toEqual({ start: '2026-12-31', end: '2027-01-01' });
    expect(eventDays(event, 'Pacific/Kiritimati')).toEqual({ start: '2027-01-01', end: '2027-01-02' });
  });
  it('29 lutego wraca po nieprzestępnym roku; bez roku brak licznika, przed startem brak wystąpienia', () => {
    expect(importantOccurrence(annual, 2027)).toEqual({ date: '2027-02-28', years: null });
    expect(importantOccurrence(annual, 2028)).toEqual({ date: '2028-02-29', years: null });
    expect(importantOccurrence({ ...annual, startYear: 2028 }, 2027)).toBeNull();
    expect(nextImportantOccurrence({ ...annual, startYear: 2020 }, '2027-12-31')).toEqual({ date: '2028-02-29', years: 8 });
    expect(nextImportantOccurrence({ ...annual, month: 1, day: 1 }, '2026-12-31')).toEqual({ date: '2027-01-01', years: null });
  });
  it('kontrakt workera: ustawienie czasu, obie zmiany DST, roczne wystąpienie i ACL bez cudzych kont', () => {
    expect(calendarReminderAt(event, reminder)).toBe('2026-12-31T22:00:00Z');
    for (const [day, expected] of [['2026-03-29','2026-03-29T07:00:00Z'], ['2026-10-25','2026-10-25T08:00:00Z']]) {
      expect(calendarReminderAt({ ...event, allDay: true, startDate: day!, endDate: day!, startAt: null, endAt: null }, { ...reminder, minutesBefore: 0, localTime: '09:00' })).toBe(expected);
    }
    expect(calendarReminderAt(annual, { ...reminder, minutesBefore: 0, localTime: '09:00' }, 2027)).toBe('2027-02-28T08:00:00Z');
    expect(calendarReminderAt(event, { ...reminder, enabled: false })).toBeNull();
    const target = { householdId: 'h', ownerId: 'a', visibility: 'private' as const, deletedAt: null };
    const members = [{ householdId: 'h', userId: 'a' }, { householdId: 'h', userId: 'b' }, { householdId: 'x', userId: 'c' }];
    expect(calendarRecipients(target, members)).toEqual(['a']);
    expect(calendarRecipients({ ...target, visibility: 'shared' }, members)).toEqual(['a','b']);
    expect(calendarRecipients({ ...target, deletedAt: '2026-01-01T00:00:00Z' }, members)).toEqual([]);
  });
});
