import { randomUUID } from 'node:crypto';
import type { AccountScope, EntityType, SyncRecord } from '@razem/contracts';
import { RecordRepository } from '@razem/db';
import type { Database } from '@razem/db';

export const H = '00000000-0000-4000-8000-000000000001';
export const A: AccountScope = { householdId: H, userId: '00000000-0000-4000-8000-0000000000aa' };
export const B: AccountScope = { householdId: H, userId: '00000000-0000-4000-8000-0000000000bb' };
export const TIME = '2026-11-05T10:00:00.000Z';
export const HASH = '$argon2id$v=19$m=8,t=1,p=1$c3ludGhldGlj$c3ludGhldGlj';
export function seedAccounts(database: Database) {
  database.sqlite.prepare('INSERT INTO households VALUES (?, ?, ?, ?)').run(H, 'Syntetyczny dom', 'Europe/Warsaw', TIME);
  const user = database.sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, 0, ?, ?)');
  for (const [scope, label] of [[A, 'a'], [B, 'b']] as const) user.run(scope.userId, H, `${label}@example.test`, `Konto ${label.toUpperCase()}`, HASH, TIME, TIME);
}
export function seedDomain(database: Database) {
  const repo = new RecordRepository(database);
  const records: SyncRecord[] = [];
  for (const [scope, visibility, label] of [[A, 'private', 'PRIVATE_A'], [B, 'private', 'PRIVATE_B'], [B, 'shared', 'SHARED']] as const) {
    const add = (entityType: EntityType, data: Record<string, unknown>, child = false, id = randomUUID()) => {
      const result = repo.create(scope, { entityType, id, data, ...(child ? {} : { visibility }) });
      if (result.status !== 'ack') throw new Error(`Fixture ${entityType}: ${JSON.stringify(result)}`);
      records.push(result.record); return result.record.id;
    };
    const list = add('shopping_list', { name: label });
    add('shopping_item', { listId: list, name: label, quantity: '2', note: '', checked: false, sortKey: 1 }, true);
    const task = add('task', { title: label, description: '', assignee: 'self', dueDate: '2026-11-05', dueAt: null, timezone: 'Europe/Warsaw', completedAt: null,
      recurrence: { frequency: 'daily', interval: 1, startDate: '2026-11-05' } });
    add('task_occurrence', { taskId: task, occurrenceKey: '2026-11-05', completedAt: TIME }, true);
    add('calendar_event', { title: label, description: '', allDay: true, timezone: 'Europe/Warsaw', startDate: '2026-11-05', endDate: '2026-11-06', startAt: null, endAt: null });
    add('important_date', { name: label, month: 2, day: 29, startYear: null, kind: 'birthday' });
    add('note', { title: label, body: `${label} syntetyczna treść` });
    add('reminder', { targetType: 'task', targetId: task, enabled: true, minutesBefore: 30, localTime: '09:00' }, true);
  }
  return records;
}
