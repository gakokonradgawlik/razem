import { z } from 'zod';
import { localDate } from './tasks.js';
import { dateSchema, instantSchema, timezoneSchema, localTimeToInstant } from './dates.js';

export const idSchema = z.uuid();
export const visibilitySchema = z.enum(['private', 'shared']);
const title = z.string().trim().min(1).max(200);
const text = z.string().max(50_000);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const householdSchema = z.strictObject({ id: idSchema, name: title, timezone: timezoneSchema });
// API projection: credentials and session token hashes are never wire fields.
export const userSchema = z.strictObject({
  id: idSchema, householdId: idSchema, login: z.string().min(1).max(254),
  displayName: title, mustChangePassword: z.boolean(), createdAt: instantSchema,
});
export const deviceSchema = z.strictObject({
  id: idSchema, userId: idSchema, name: title, lastSeenAt: instantSchema,
});
const ruleShape = {
  frequency: z.enum(['daily', 'weekly', 'monthly']), interval: z.number().int().min(1).max(365), startDate: dateSchema,
};
export const recurrenceSegmentSchema = z.strictObject({
  ...ruleShape, until: dateSchema, time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(), timezone: timezoneSchema,
});
export const recurrenceSchema = z.strictObject({
  ...ruleShape, until: dateSchema.optional(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(), history: z.array(recurrenceSegmentSchema).max(1000).optional(),
}).superRefine((rule, ctx) => {
  if ((rule.frequency === 'weekly' && rule.interval > 52) || (rule.frequency === 'monthly' && rule.interval > 12))
    ctx.addIssue({ code: 'custom', message: 'Niepoprawny interwał' });
  let end = '';
  for (const segment of rule.history ?? []) {
    if (segment.startDate < end || segment.until <= segment.startDate || segment.until > rule.startDate)
      ctx.addIssue({ code: 'custom', message: 'Niepoprawna historia harmonogramu' });
    end = segment.until;
  }
  if (rule.until && rule.until <= rule.startDate) ctx.addIssue({ code: 'custom', message: 'Niepoprawny koniec harmonogramu' });
});

export const shoppingListDataSchema = z.strictObject({ name: title });
export const shoppingItemDataSchema = z.strictObject({
  listId: idSchema, name: title, quantity: z.string().max(100), note: z.string().max(2000),
  checked: z.boolean(), sortKey: z.number().finite(),
});
export const taskDataSchema = z.strictObject({
  title, description: text, assignee: z.enum(['self', 'partner', 'both']),
  dueDate: dateSchema.nullable(), dueAt: instantSchema.nullable(), timezone: timezoneSchema,
  completedAt: instantSchema.nullable(), recurrence: recurrenceSchema.nullable(),
});
export const taskOccurrenceDataSchema = z.strictObject({
  taskId: idSchema, occurrenceKey: dateSchema, completedAt: instantSchema.nullable(),
});
export const calendarEventDataSchema = z.strictObject({
  title, description: text, allDay: z.boolean(), timezone: timezoneSchema,
  startDate: dateSchema.nullable(), endDate: dateSchema.nullable(),
  startAt: instantSchema.nullable(), endAt: instantSchema.nullable(),
});
export const importantDateDataSchema = z.strictObject({
  name: title, month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31),
  startYear: z.number().int().min(1).max(9999).nullable(), kind: z.enum(['birthday', 'anniversary', 'other']),
});
export const noteDataSchema = z.strictObject({ title, body: text });
export const reminderDataSchema = z.strictObject({
  targetType: z.enum(['task', 'calendar_event', 'important_date']), targetId: idSchema,
  enabled: z.boolean(), minutesBefore: z.number().int().min(0).max(525600),
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
});
export const dataSchemas = {
  shopping_list: shoppingListDataSchema, shopping_item: shoppingItemDataSchema,
  task: taskDataSchema, task_occurrence: taskOccurrenceDataSchema,
  calendar_event: calendarEventDataSchema, important_date: importantDateDataSchema,
  note: noteDataSchema, reminder: reminderDataSchema,
};
export const entityTypeSchema = z.enum([
  'shopping_list', 'shopping_item', 'task', 'task_occurrence',
  'calendar_event', 'important_date', 'note', 'reminder',
]);
export type EntityType = z.infer<typeof entityTypeSchema>;
export const metadataSchema = z.strictObject({
  id: idSchema, householdId: idSchema, ownerId: idSchema, visibility: visibilitySchema,
  version, createdAt: instantSchema, updatedAt: instantSchema, deletedAt: instantSchema.nullable(),
});

// Used for complete create data and records, not for patches: the server validates
// the merged record again in its transaction before accepting any update.
export function validateDomain(type: EntityType, data: Record<string, unknown>, visibility: string | undefined, ctx: z.RefinementCtx) {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (type === 'task') {
    if (data.dueDate !== null && data.dueAt !== null) invalid('Termin jest datą albo chwilą');
    if (data.recurrence && !data.dueDate && !data.dueAt) invalid('Powtarzanie wymaga terminu');
    if (data.recurrence) {
      const rule = data.recurrence as z.infer<typeof recurrenceSchema>;
      if (data.completedAt !== null) invalid('Ukończ pojedynczy termin zamiast szablonu');
      if (rule.time !== undefined && (data.dueDate && data.dueDate !== rule.startDate || data.dueAt && localDate(String(data.dueAt), String(data.timezone)) !== rule.startDate)) invalid('Termin musi odpowiadać początkowi reguły');
      if (rule.time !== undefined && (rule.time === null ? data.dueAt !== null : data.dueAt === null || Date.parse(String(data.dueAt)) !== Date.parse(localTimeToInstant(rule.startDate, rule.time, String(data.timezone))))) invalid('Godzina reguły nie odpowiada terminowi');
    }
    if (visibility === 'private' && data.assignee !== 'self') invalid('Prywatne zadanie można przypisać tylko sobie');
  }
  if (type === 'calendar_event') {
    if (data.allDay) {
      if (!data.startDate || !data.endDate || data.startAt !== null || data.endAt !== null || String(data.endDate) <= String(data.startDate))
        invalid('Wydarzenie całodniowe wymaga dat i wyłącznego końca po początku');
    } else if (!data.startAt || !data.endAt || data.startDate !== null || data.endDate !== null || Date.parse(String(data.endAt)) <= Date.parse(String(data.startAt))) {
      invalid('Wydarzenie godzinowe wymaga chwil UTC i końca po początku');
    }
  }
  if (type === 'important_date') {
    const maxDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (Number(data.day) > (maxDays[Number(data.month) - 1] ?? 0)) invalid('Niepoprawny dzień miesiąca');
  }
}

function recordSchema<T extends EntityType, S extends z.ZodObject>(type: T, data: S) {
  return z.strictObject({ ...metadataSchema.shape, entityType: z.literal(type), data });
}
export const recordSchemaUnion = z.union([
  recordSchema('shopping_list', shoppingListDataSchema), recordSchema('shopping_item', shoppingItemDataSchema), recordSchema('task', taskDataSchema),
  recordSchema('task_occurrence', taskOccurrenceDataSchema), recordSchema('calendar_event', calendarEventDataSchema), recordSchema('important_date', importantDateDataSchema),
  recordSchema('note', noteDataSchema), recordSchema('reminder', reminderDataSchema),
]).superRefine((record, ctx) => {
  validateDomain(record.entityType, record.data, record.visibility, ctx);
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) ctx.addIssue({ code: 'custom', message: 'updatedAt przed createdAt' });
});
export type SyncRecord = z.infer<typeof recordSchemaUnion>;
export type AccountScope = { userId: string; householdId: string };

// Only one ACL primitive; it is not a substitute for authenticating a session.
export function canReadRecord(scope: AccountScope, record: Pick<SyncRecord, 'householdId' | 'ownerId' | 'visibility'>): boolean {
  return scope.householdId === record.householdId && (record.visibility === 'shared' || record.ownerId === scope.userId);
}

export function defaultVisibility(type: EntityType): z.infer<typeof visibilitySchema> {
  return type === 'note' ? 'private' : 'shared';
}

export const preferenceSchema = z.strictObject({
  timezone: timezoneSchema, theme: z.enum(['system', 'light', 'dark']),
  pushEnabled: z.boolean(), includeTitles: z.boolean(), shoppingNotifications: z.boolean(),
});
export const pushSubscriptionSchema = z.strictObject({
  deviceId: idSchema, endpoint: z.url({ protocol: /^https$/ }).max(4096),
  expirationTime: z.number().int().nonnegative().nullable(),
  keys: z.strictObject({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(512) }),
});
