import { expect, it } from 'vitest';
import { nextTaskOccurrence, taskOccurrence, taskOverdue, rescheduleTask, validTaskScheduleChange, taskReminderAt, taskOccurrenceId, taskRecipients, localTimeToInstant, taskDataSchema, mutationSchema } from './index.js';
import type { TaskData } from './index.js';

const task = (startDate = '2026-01-31', frequency: 'daily' | 'weekly' | 'monthly' = 'monthly', time: string | null = null): TaskData => ({
  title: 'Rachunki', description: '', assignee: 'both', dueDate: time ? null : startDate,
  dueAt: time ? localTimeToInstant(startDate, time) : null, timezone: 'Europe/Warsaw', completedAt: null,
  recurrence: { frequency, interval: 1, startDate, time },
});
it('31 miesięcznie: luty/rok przestępny i powrót do 31; next nie pomija zaległości', () => {
  const t = task();
  expect(nextTaskOccurrence(t, new Set(['2026-01-31']))?.occurrenceKey).toBe('2026-02-28');
  expect(nextTaskOccurrence(t, new Set(['2026-01-31', '2026-02-28']))?.occurrenceKey).toBe('2026-03-31');
  expect(taskOccurrence(t, '2026-03-28')).toBeNull();
  expect(taskOccurrence(task('2028-01-31'), '2028-02-29')).not.toBeNull();
  expect(taskOccurrence({ ...t, recurrence: { ...t.recurrence!, interval: 2 } }, '2026-03-31')).not.toBeNull();
});
it('Warszawa DST: codziennie lokalnie, luka do 03:00, powrót do 02:30 następnego dnia; overlap wcześniej', () => {
  const t = task('2026-03-28', 'daily', '02:30');
  expect(taskOccurrence(t, '2026-03-29')?.dueAt).toBe('2026-03-29T01:00:00Z');
  expect(taskOccurrence(t, '2026-03-30')?.dueAt).toBe('2026-03-30T00:30:00Z');
  const gapAnchor = task('2026-03-29', 'daily', '02:30');
  expect(taskOccurrence(gapAnchor, '2026-03-30')?.dueAt).toBe('2026-03-30T00:30:00Z');
  expect(taskOccurrence(task('2026-10-24', 'daily', '02:30'), '2026-10-25')?.dueAt).toBe('2026-10-25T00:30:00Z');
  expect(taskOccurrence(task('2026-03-22', 'weekly', '02:30'), '2026-03-29')?.dueAt).toBe('2026-03-29T01:00:00Z');
});
it('zmiana reguły tylko w przyszłym segmencie; zachowane zaległe, stare daty i cofnięcia; zatrzymanie harmonogramu', () => {
  const before = task('2026-01-31');
  const after = taskDataSchema.parse(rescheduleTask(before, '2026-04-10', 'weekly', '09:15'));
  expect(validTaskScheduleChange(before, after)).toBe(true);
  expect(taskOccurrence(after, '2026-03-31')?.dueDate).toBe('2026-03-31');
  expect(taskOccurrence(after, '2026-04-17')?.dueAt).toBe('2026-04-17T07:15:00Z');
  expect(taskOccurrence(after, '2026-04-30')).toBeNull();
  expect(nextTaskOccurrence(after, new Set(['2026-01-31']))?.occurrenceKey).toBe('2026-02-28');
  expect(validTaskScheduleChange(before, { ...after, recurrence: { ...after.recurrence!, history: [] } })).toBe(false);
  expect(validTaskScheduleChange(before, { ...before, recurrence: null })).toBe(false);
  const stop = rescheduleTask(after, '2026-04-18', null, null);
  expect(validTaskScheduleChange(after, stop)).toBe(true);
  expect(taskOccurrence(stop, '2026-04-17')).not.toBeNull();
  expect(taskOccurrence(stop, '2026-04-24')).toBeNull();
  expect(nextTaskOccurrence(stop, new Set(['2026-01-31','2026-02-28','2026-03-31','2026-04-10','2026-04-17']))).toBeNull();
});
it('zaległe daty zależą od strefy, godzina od chwili; przypomnienie 09:00 lokalnie', () => {
  const t = task('2026-03-29');
  expect(taskOverdue(t, '2026-03-29T21:59:59Z')).toBe(false);
  expect(taskOverdue(t, '2026-03-29T22:00:00Z')).toBe(true);
  expect(taskReminderAt(t)).toBe('2026-03-29T07:00:00Z');
  expect(taskReminderAt(task('2026-03-29', 'daily', '02:30'))).toBe('2026-03-29T01:00:00Z');
  expect(taskOverdue({ ...t, completedAt: '2026-03-29T10:00:00Z' }, '2026-04-01T00:00:00Z')).toBe(false);
});
it('to samo taskId i nominalny dzień mają ten sam UUID na dwóch telefonach; odpowiedzialność względem ownera', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  expect(await taskOccurrenceId(id, '2026-11-05')).toBe(await taskOccurrenceId(id, '2026-11-05'));
  expect(await taskOccurrenceId(id, '2026-11-06')).not.toBe(await taskOccurrenceId(id, '2026-11-05'));
  expect(taskRecipients({ ownerId: 'a', visibility: 'shared', data: { assignee: 'partner' } }, ['a','b'])).toEqual(['b']);
  expect(taskRecipients({ ownerId: 'a', visibility: 'private', data: { assignee: 'both' } }, ['a','b'])).toEqual(['a']);
});

it('niepoprawna strefa/reguła zwracają błąd walidacji bez wyjątku', () => {
  const probe = { clientMutationId: crypto.randomUUID(), entityId: crypto.randomUUID(), entityType: 'task', command: 'create', baseVersion: 0, visibility: 'shared',
    data: { ...task('2026-03-29', 'daily', '02:30'), timezone: 'Nie/Istnieje' } };
  expect(() => mutationSchema.safeParse(probe)).not.toThrow();
  expect(mutationSchema.safeParse(probe).success).toBe(false);
});

it('przyszły pierwszy termin można zmienić przed rozpoczęciem lub zatrzymać bez tworzenia wystąpienia', () => {
  const before = task('2030-01-31');
  for (const from of ['2030-01-31', '2030-01-15']) {
    const after = taskDataSchema.parse(rescheduleTask(before, from, 'weekly', null));
    expect(validTaskScheduleChange(before, after)).toBe(true);
    expect(nextTaskOccurrence(after, new Set())?.occurrenceKey).toBe(from);
    const stopped = taskDataSchema.parse(rescheduleTask(before, from, null, null));
    expect(validTaskScheduleChange(before, stopped)).toBe(true);
    expect(nextTaskOccurrence(stopped, new Set())).toBeNull();
  }
});
