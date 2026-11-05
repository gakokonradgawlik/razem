import { Temporal } from '@js-temporal/polyfill';
import type { z } from 'zod';
import { annualDate, DEFAULT_TIMEZONE, localTimeToInstant } from './dates.js';
import { canReadRecord } from './model.js';
import type { AccountScope, calendarEventDataSchema, importantDateDataSchema, reminderDataSchema, SyncRecord } from './model.js';

type Event = z.infer<typeof calendarEventDataSchema>;
type ImportantDate = z.infer<typeof importantDateDataSchema>;
type Reminder = z.infer<typeof reminderDataSchema>;

/** Inclusive first and exclusive last display day. Date-only ranges never enter a timezone conversion. */
export function eventDays(event: Event, timezone = DEFAULT_TIMEZONE): { start: string; end: string } {
  if (event.allDay) return { start: event.startDate!, end: event.endDate! };
  const start = Temporal.Instant.from(event.startAt!).toZonedDateTimeISO(timezone).toPlainDate();
  // Subtract a nanosecond so an event ending at midnight is absent on the next day.
  const last = Temporal.Instant.from(event.endAt!).subtract({ nanoseconds: 1 }).toZonedDateTimeISO(timezone).toPlainDate();
  return { start: start.toString(), end: last.add({ days: 1 }).toString() };
}
export function importantOccurrence(date: ImportantDate, year: number): { date: string; years: number | null } | null {
  if (date.startYear !== null && year < date.startYear) return null;
  return { date: annualDate(date.month, date.day, year), years: date.startYear === null ? null : year - date.startYear };
}
export function nextImportantOccurrence(date: ImportantDate, from: string) {
  const year = Math.max(Temporal.PlainDate.from(from).year, date.startYear ?? 1);
  const current = importantOccurrence(date, year)!;
  return current.date >= from ? current : importantOccurrence(date, year + 1)!;
}
/** Worker contract: trusted members only, parent ACL, and a deleted target never schedules a dispatch. */
export function calendarRecipients(target: Pick<SyncRecord, 'householdId' | 'ownerId' | 'visibility' | 'deletedAt'>, members: readonly AccountScope[]): string[] {
  return target.deletedAt ? [] : members.filter((member) => canReadRecord(member, target)).map((member) => member.userId);
}
/** Important dates use the household timezone; timed events retain their own IANA zone. */
export function calendarReminderAt(target: Event | ImportantDate, reminder: Reminder, occurrenceYear?: number, timezone = DEFAULT_TIMEZONE): string | null {
  if (!reminder.enabled) return null;
  let at: string;
  if ('allDay' in target) {
    at = target.allDay ? localTimeToInstant(target.startDate!, reminder.localTime ?? '09:00', target.timezone) : target.startAt!;
  } else {
    if (occurrenceYear === undefined) return null;
    const occurrence = importantOccurrence(target, occurrenceYear);
    if (!occurrence) return null;
    at = localTimeToInstant(occurrence.date, reminder.localTime ?? '09:00', timezone);
  }
  return Temporal.Instant.from(at).subtract({ minutes: reminder.minutesBefore }).toString();
}
/** One configuration per target across devices. Compute before opening the IndexedDB transaction. */
export async function calendarReminderId(targetId: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`razem:calendar-reminder:v1:${targetId}`))).slice(0, 16);
  bytes[6] = (bytes[6]! & 15) | 128; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
