import { z } from 'zod';
import { instantSchema } from './dates.js';
import { dataSchemas, entityTypeSchema, idSchema, recordSchemaUnion, validateDomain, visibilitySchema } from './model.js';
import type { EntityType } from './model.js';

export const PROTOCOL_VERSION = 1;
export const MAX_PUSH_BATCH = 100;
export const MAX_PULL_PAGE = 200;
export const RETENTION_DAYS = 90;
export const TRASH_DAYS = 30;
const baseVersion = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const identity = { clientMutationId: idSchema, entityId: idSchema };

function entityMutations<T extends EntityType, S extends z.ZodObject, V extends z.ZodRawShape>(type: T, data: S, visibility: V) {
  // Children inherit ACL from their immutable parent reference. They cannot choose visibility.
  const patch = data.partial();
  const immutableParentFields = ['listId', 'taskId', 'occurrenceKey', 'targetType', 'targetId'];
  return [
    z.strictObject({ ...identity, entityType: z.literal(type), command: z.literal('create'),
      baseVersion: z.literal(0), ...visibility, data }),
    z.strictObject({ ...identity, entityType: z.literal(type), command: z.literal('update'), baseVersion, patch })
      .superRefine((value, ctx) => {
        if (Object.keys(value.patch).length === 0) ctx.addIssue({ code: 'custom', message: 'Pusta zmiana' });
        if (Object.keys(value.patch).some((key) => immutableParentFields.includes(key)))
          ctx.addIssue({ code: 'custom', message: 'Powiązanie nadrzędne jest niezmienne' });
      }),
  ] as const;
}

export const mutationSchema = z.union([
  ...entityMutations('shopping_list', dataSchemas.shopping_list, { visibility: visibilitySchema }), ...entityMutations('shopping_item', dataSchemas.shopping_item, {}), ...entityMutations('task', dataSchemas.task, { visibility: visibilitySchema }),
  ...entityMutations('task_occurrence', dataSchemas.task_occurrence, {}), ...entityMutations('calendar_event', dataSchemas.calendar_event, { visibility: visibilitySchema }), ...entityMutations('important_date', dataSchemas.important_date, { visibility: visibilitySchema }),
  ...entityMutations('note', dataSchemas.note, { visibility: visibilitySchema }), ...entityMutations('reminder', dataSchemas.reminder, {}),
  z.strictObject({ ...identity, entityType: entityTypeSchema, command: z.enum(['delete', 'restore']), baseVersion }),
]).superRefine((mutation, ctx) => {
  if (mutation.command === 'create') validateDomain(mutation.entityType, mutation.data, 'visibility' in mutation ? mutation.visibility : undefined, ctx);
});
export type Mutation = z.infer<typeof mutationSchema>;
export const pushRequestSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION), deviceId: idSchema,
  mutations: z.array(mutationSchema).min(1).max(MAX_PUSH_BATCH),
}).superRefine((request, ctx) => {
  if (new Set(request.mutations.map((m) => m.clientMutationId)).size !== request.mutations.length)
    ctx.addIssue({ code: 'custom', message: 'Powtórzone ID mutacji w partii' });
});

export const tombstoneSchema = z.strictObject({
  entityType: entityTypeSchema, id: idSchema, version: baseVersion, deletedAt: instantSchema,
});
export const serverStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('record'), record: recordSchemaUnion }),
  z.strictObject({ kind: z.literal('tombstone'), tombstone: tombstoneSchema }),
]);
const resultIdentity = { clientMutationId: idSchema, entityType: entityTypeSchema, entityId: idSchema };
export const mutationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...resultIdentity, status: z.literal('ack'), state: serverStateSchema }),
  z.strictObject({ ...resultIdentity, status: z.literal('conflict'), state: serverStateSchema }),
  // Access failures disclose no record, version or existence. No user content in messages.
  z.strictObject({ ...resultIdentity, status: z.literal('error'), code: z.enum([
    'validation_error', 'not_found', 'mutation_id_reused', 'dependency_failed', 'upgrade_required',
  ]), retryable: z.literal(false) }),
]).superRefine((result, ctx) => {
  if (result.status === 'error') return;
  const state = result.state.kind === 'record' ? result.state.record : result.state.tombstone;
  if (state.id !== result.entityId || state.entityType !== result.entityType)
    ctx.addIssue({ code: 'custom', message: 'Stan nie odpowiada mutacji' });
});
export const pushResponseSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION), results: z.array(mutationResultSchema).min(1).max(MAX_PUSH_BATCH),
});
const cursor = z.string().min(1).max(4096);
export const pullRequestSchema = z.strictObject({
  cursor: cursor.optional(), limit: z.coerce.number().int().min(1).max(MAX_PULL_PAGE).default(100),
});
export const pullResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'), protocolVersion: z.literal(PROTOCOL_VERSION), mode: z.enum(['snapshot', 'delta']),
    watermark: cursor, changes: z.array(serverStateSchema).max(MAX_PULL_PAGE),
    nextCursor: cursor, hasMore: z.boolean(),
  }),
  z.strictObject({ status: z.literal('resync_required'), reason: z.enum(['cursor_expired', 'cursor_invalid']) }),
]);
export type PushRequest = z.infer<typeof pushRequestSchema>;
export type PushResponse = z.infer<typeof pushResponseSchema>;
export type PullResponse = z.infer<typeof pullResponseSchema>;
export const localConflictSchema = z.strictObject({
  id: idSchema, mutation: mutationSchema, base: recordSchemaUnion.nullable(),
  server: serverStateSchema, detectedAt: instantSchema,
});
export const outboxEntrySchema = z.strictObject({
  deviceId: idSchema, mutation: mutationSchema, queuedAt: instantSchema,
  state: z.enum(['pending', 'needs_action']), attempts: z.number().int().nonnegative(),
});
