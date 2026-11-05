import { Temporal } from '@js-temporal/polyfill';
import type { z } from 'zod';
import type { taskDataSchema, recurrenceSchema, recurrenceSegmentSchema, SyncRecord } from './model.js';
import { localTimeToInstant } from './dates.js';

export type TaskData = z.infer<typeof taskDataSchema>;
export type Recurrence = z.infer<typeof recurrenceSchema>;
type Segment = Omit<z.infer<typeof recurrenceSegmentSchema>, 'until'> & { until?: string };
export type TaskDue = { occurrenceKey: string; dueDate: string | null; dueAt: string | null; timezone: string };
export const localDate = (instant: string, timezone: string) => Temporal.Instant.from(instant).toZonedDateTimeISO(timezone).toPlainDate().toString();
export const localTime = (instant: string, timezone: string) => Temporal.Instant.from(instant).toZonedDateTimeISO(timezone).toPlainTime().toString({ smallestUnit: 'minute' });

function segments(task: TaskData): Segment[] {
  const rule = task.recurrence;
  return rule ? [...(rule.history ?? []), { frequency: rule.frequency, interval: rule.interval, startDate: rule.startDate,
    ...(rule.until ? { until: rule.until } : {}), time: rule.time !== undefined ? rule.time : task.dueAt ? localTime(task.dueAt, task.timezone) : null, timezone: task.timezone }] : [];
}
function dateAt(rule: Segment, index: number): string {
  const start = Temporal.PlainDate.from(rule.startDate);
  return start.add(rule.frequency === 'monthly' ? { months: index * rule.interval }
    : { days: index * rule.interval * (rule.frequency === 'weekly' ? 7 : 1) }).toString();
}
function due(rule: Segment, key: string): TaskDue {
  return { occurrenceKey: key, dueDate: rule.time ? null : key, dueAt: rule.time ? localTimeToInstant(key, rule.time, rule.timezone) : null, timezone: rule.timezone };
}
/** Nominal local dates are keys, never UTC dates. Monthly arithmetic always starts at the original anchor. */
export function taskOccurrence(task: TaskData, key: string): TaskDue | null {
  for (const rule of segments(task)) {
    if (key < rule.startDate || (rule.until && key >= rule.until)) continue;
    const start = Temporal.PlainDate.from(rule.startDate), day = Temporal.PlainDate.from(key);
    const distance = rule.frequency === 'monthly' ? (day.year - start.year) * 12 + day.month - start.month
      : start.until(day, { largestUnit: 'day' }).days / (rule.frequency === 'weekly' ? 7 : 1);
    const index = distance / rule.interval;
    if (Number.isInteger(index) && dateAt(rule, index) === key) return due(rule, key);
  }
  return null;
}
/** Earliest outstanding occurrence, including old overdue dates; no generated records or unbounded horizon. */
export function nextTaskOccurrence(task: TaskData, completed: ReadonlySet<string>): TaskDue | null {
  for (const rule of segments(task)) {
    // At most completed.size + 1 candidates can be skipped across all segments.
    for (let index = 0; index <= completed.size; index++) {
      const key = dateAt(rule, index);
      if (rule.until && key >= rule.until) break;
      if (!completed.has(key)) return due(rule, key);
    }
  }
  return null;
}
export function taskOverdue(task: Pick<TaskData, 'dueDate' | 'dueAt' | 'timezone' | 'completedAt'>, now: string): boolean {
  return !task.completedAt && (task.dueAt ? Temporal.Instant.compare(task.dueAt, now) < 0
    : !!task.dueDate && task.dueDate < localDate(now, task.timezone));
}
/** Preserve every segment before `from`; replace only the future. null frequency stops future recurrence. */
export function rescheduleTask(task: TaskData, from: string, frequency: Recurrence['frequency'] | null, time: string | null, timezone = task.timezone): TaskData {
  const history = segments(task).filter((r) => r.startDate < from).map((r) => ({ ...r, until: r.until && r.until < from ? r.until : from }));
  if (!frequency) {
    const last = history.pop();
    if (!last) throw new RangeError('Brak wcześniejszego harmonogramu');
    return { ...task, dueDate: last.time ? null : last.startDate, dueAt: last.time ? localTimeToInstant(last.startDate, last.time, last.timezone) : null,
      timezone: last.timezone, recurrence: { frequency: last.frequency, interval: last.interval, startDate: last.startDate, until: last.until, time: last.time, history } };
  }
  return { ...task, completedAt: null, dueDate: time ? null : from, dueAt: time ? localTimeToInstant(from, time, timezone) : null, timezone,
    recurrence: { frequency, interval: task.recurrence?.frequency === frequency ? task.recurrence.interval : 1, startDate: from, time, history } };
}
const canonical = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const schedule = (task: TaskData) => canonical([task.dueDate, task.dueAt, task.timezone, task.recurrence]);
/** Used both before local commit and by the server; offline edits may arrive after the effective day. */
export function validTaskScheduleChange(before: TaskData, after: TaskData): boolean {
  if (!before.recurrence || schedule(before) === schedule(after)) return true;
  const next = after.recurrence;
  if (!next) return false;
  const stopped = !!next.until;
  const from = stopped ? next.until! : next.startDate;
  if (from <= before.recurrence.startDate) return false;
  // The server cannot use today's date: a valid offline command may be delivered days later.
  // Immutable history proves that all earlier dates retain their original schedule.
  const expected = rescheduleTask(before, from, stopped ? null : next.frequency, next.time !== undefined ? next.time : after.dueAt ? localTime(after.dueAt, after.timezone) : null, after.timezone);
  return schedule(expected) === schedule(after);
}
/** Stable ID across phones. Compute before opening an IndexedDB write transaction. */
export async function taskOccurrenceId(taskId: string, key: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`razem:task-occurrence:v1:${taskId}:${key}`))).slice(0, 16);
  bytes[6] = (bytes[6]! & 15) | 128; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Worker boundary: recipient IDs are derived from trusted household members, relative to owner. */
export function taskRecipients(task: Pick<SyncRecord, 'ownerId' | 'visibility'> & { data: Pick<TaskData, 'assignee'> }, members: readonly string[]): string[] {
  return members.filter((id) => task.visibility === 'private' ? id === task.ownerId
    : task.data.assignee === 'both' || (task.data.assignee === 'self' ? id === task.ownerId : id !== task.ownerId));
}
export function taskReminderAt(due: Pick<TaskDue, 'dueDate' | 'dueAt' | 'timezone'>): string | null {
  return due.dueAt ?? (due.dueDate ? localTimeToInstant(due.dueDate, '09:00', due.timezone) : null);
}
export type TaskSemanticEvent = {
  kind: 'task.created' | 'task.assigned' | 'task.schedule_changed' | 'task.completed' | 'task.reopened' | 'task.deleted' | 'task.restored';
  taskId: string; occurrenceKey: string | null; version: number; changedAt: string;
};
