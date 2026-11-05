// Typed Drizzle view of the schema. DDL lives in migrations.ts (frozen SQL);
// schema.test.ts checks that every column here exists in the migrated database.
import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const households = sqliteTable('households', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull(),
  createdAt: text('created_at').notNull(),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  householdId: text('household_id').notNull(),
  login: text('login').notNull(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull(),
  passwordChangedAt: text('password_changed_at').notNull(),
  createdAt: text('created_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  previousTokenHash: text('previous_token_hash'),
  previousValidUntil: text('previous_valid_until'),
  createdAt: text('created_at').notNull(),
  renewedAt: text('renewed_at').notNull(),
  expiresAt: text('expires_at').notNull(),
});

export const devices = sqliteTable('devices', {
  id: text('id').notNull(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.id] })]);

export const authEventKinds = ['bootstrap', 'login', 'logout', 'password_changed', 'password_reset', 'sessions_revoked', 'login_locked'] as const;
export type AuthEventKind = typeof authEventKinds[number];
export const authEvents = sqliteTable('auth_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id'),
  kind: text('kind', { enum: authEventKinds }).notNull(),
  createdAt: text('created_at').notNull(),
});

export const authThrottle = sqliteTable('auth_throttle', {
  keyHash: text('key_hash').primaryKey(),
  failures: integer('failures').notNull(),
  windowStartedAt: text('window_started_at').notNull(),
  lockedUntil: text('locked_until'),
});

const metadata = {
  id: text('id').primaryKey(),
  householdId: text('household_id').notNull(),
  ownerId: text('owner_id').notNull(),
  visibility: text('visibility', { enum: ['private', 'shared'] }).notNull(),
  version: integer('version').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
};

export const shoppingLists = sqliteTable('shopping_lists', { ...metadata, name: text('name').notNull() });
export const shoppingItems = sqliteTable('shopping_items', {
  ...metadata, listId: text('list_id').notNull(), name: text('name').notNull(), quantity: text('quantity').notNull(),
  note: text('note').notNull(), checked: integer('checked', { mode: 'boolean' }).notNull(), sortKey: real('sort_key').notNull(),
});
export const tasks = sqliteTable('tasks', {
  ...metadata, title: text('title').notNull(), description: text('description').notNull(),
  assignee: text('assignee', { enum: ['self', 'partner', 'both'] }).notNull(),
  dueDate: text('due_date'), dueAt: text('due_at'), timezone: text('timezone').notNull(),
  completedAt: text('completed_at'), recurrence: text('recurrence', { mode: 'json' }),
});
export const taskOccurrences = sqliteTable('task_occurrences', {
  ...metadata, taskId: text('task_id').notNull(), occurrenceKey: text('occurrence_key').notNull(), completedAt: text('completed_at'),
});
export const calendarEvents = sqliteTable('calendar_events', {
  ...metadata, title: text('title').notNull(), description: text('description').notNull(),
  allDay: integer('all_day', { mode: 'boolean' }).notNull(), timezone: text('timezone').notNull(),
  startDate: text('start_date'), endDate: text('end_date'), startAt: text('start_at'), endAt: text('end_at'),
});
export const importantDates = sqliteTable('important_dates', {
  ...metadata, name: text('name').notNull(), month: integer('month').notNull(), day: integer('day').notNull(),
  startYear: integer('start_year'), kind: text('kind', { enum: ['birthday', 'anniversary', 'other'] }).notNull(),
});
export const notes = sqliteTable('notes', { ...metadata, title: text('title').notNull(), body: text('body').notNull() });
export const reminders = sqliteTable('reminders', {
  ...metadata, targetType: text('target_type', { enum: ['task', 'calendar_event', 'important_date'] }).notNull(),
  targetId: text('target_id').notNull(), enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  minutesBefore: integer('minutes_before').notNull(), localTime: text('local_time'),
});

export const syncChanges = sqliteTable('sync_changes', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  entityType: text('entity_type').notNull(), entityId: text('entity_id').notNull(),
  householdId: text('household_id').notNull(), ownerId: text('owner_id').notNull(),
  visibility: text('visibility', { enum: ['private', 'shared'] }).notNull(),
  version: integer('version').notNull(), changedAt: text('changed_at').notNull(),
  actorId: text('actor_id'),
});
export const mutationReceipts = sqliteTable('mutation_receipts', {
  userId: text('user_id').notNull(), deviceId: text('device_id').notNull(), clientMutationId: text('client_mutation_id').notNull(),
  payloadFingerprint: text('payload_fingerprint').notNull(), result: text('result', { mode: 'json' }).notNull(),
  committedAt: text('committed_at').notNull(), expiresAt: text('expires_at').notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.deviceId, t.clientMutationId] })]);
export const preferences = sqliteTable('preferences', {
  userId: text('user_id').primaryKey(), timezone: text('timezone').notNull(),
  theme: text('theme', { enum: ['system', 'light', 'dark'] }).notNull(),
  pushEnabled: integer('push_enabled', { mode: 'boolean' }).notNull(),
  includeTitles: integer('include_titles', { mode: 'boolean' }).notNull(),
  shoppingNotifications: integer('shopping_notifications', { mode: 'boolean' }).notNull(),
  taskReminders: integer('task_reminders', { mode: 'boolean' }).notNull().default(true),
  taskReminderTime: text('task_reminder_time').notNull().default('09:00'),
  taskMinutesBefore: integer('task_minutes_before').notNull().default(0),
  taskAssignments: integer('task_assignments', { mode: 'boolean' }).notNull().default(true),
  updatedAt: text('updated_at').notNull(),
});
export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(), deviceId: text('device_id').notNull(),
  endpoint: text('endpoint').notNull(), p256dh: text('p256dh').notNull(), auth: text('auth').notNull(),
  expirationTime: integer('expiration_time'), createdAt: text('created_at').notNull(), sessionId: text('session_id'),
});
export const reminderDispatches = sqliteTable('reminder_dispatches', {
  id: text('id').primaryKey(), subscriptionId: text('subscription_id').notNull(), userId: text('user_id').notNull(),
  targetType: text('target_type').notNull(), targetId: text('target_id').notNull(), kind: text('kind').notNull(), eventSequence: integer('event_sequence'),
  deduplicationKey: text('deduplication_key').notNull(), scheduledAt: text('scheduled_at').notNull(),
  state: text('state').notNull(), attempts: integer('attempts').notNull(), nextAttemptAt: text('next_attempt_at').notNull(),
  leaseUntil: text('lease_until'), leaseToken: text('lease_token'), sentAt: text('sent_at'),
});
export const workerState = sqliteTable('worker_state', {
  id: integer('id').primaryKey(), taskSequence: integer('task_sequence').notNull(), shoppingSequence: integer('shopping_sequence').notNull(),
});

export const tombstones = sqliteTable('tombstones', {
  entityType: text('entity_type').notNull(), id: text('id').notNull(),
  householdId: text('household_id').notNull(), ownerId: text('owner_id').notNull(),
  visibility: text('visibility', { enum: ['private', 'shared'] }).notNull(),
  version: integer('version').notNull(), deletedAt: text('deleted_at').notNull(), purgedAt: text('purged_at').notNull(),
}, (t) => [primaryKey({ columns: [t.entityType, t.id] })]);
export const syncState = sqliteTable('sync_state', {
  id: integer('id').primaryKey(), cursorKey: text('cursor_key').notNull(), journalFloor: integer('journal_floor').notNull(),
});

export const domainTables = {
  shopping_list: shoppingLists, shopping_item: shoppingItems, task: tasks, task_occurrence: taskOccurrences,
  calendar_event: calendarEvents, important_date: importantDates, note: notes, reminder: reminders,
} as const;

/** Server-only events; consumers must re-read task ACL/current state before dispatch. */
export const taskEvents = sqliteTable('task_events', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }), taskId: text('task_id').notNull(),
  entityId: text('entity_id').notNull(), version: integer('version').notNull(), kind: text('kind').notNull(),
  occurrenceKey: text('occurrence_key'), householdId: text('household_id').notNull(), ownerId: text('owner_id').notNull(),
  visibility: text('visibility', { enum: ['private', 'shared'] }).notNull(), changedAt: text('changed_at').notNull(),
  actorId: text('actor_id'), previousAssignee: text('previous_assignee', { enum: ['self', 'partner', 'both'] }),
});
