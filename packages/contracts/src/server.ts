// Server-only persistence descriptors, deliberately outside the public barrel.
// Never serialize these envelopes as user/session API responses.
import { z } from 'zod';
import { instantSchema } from './dates.js';
import { entityTypeSchema, idSchema, metadataSchema, userSchema } from './model.js';
import { mutationResultSchema } from './sync.js';

export const storedUserSchema = userSchema.extend({ passwordHash: z.string().startsWith('$argon2id$') });
export const sessionSchema = z.strictObject({
  id: idSchema, userId: idSchema, tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: instantSchema, expiresAt: instantSchema,
});
export const receiptSchema = z.strictObject({
  userId: idSchema, deviceId: idSchema, clientMutationId: idSchema,
  payloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/), result: mutationResultSchema,
  committedAt: instantSchema, expiresAt: instantSchema,
});
export const syncChangeSchema = z.strictObject({
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ...metadataSchema.pick({ id: true, householdId: true, ownerId: true, visibility: true, version: true }).shape,
  entityType: entityTypeSchema,
});
export const storedTombstoneSchema = metadataSchema.extend({ entityType: entityTypeSchema, deletedAt: instantSchema });
export const dispatchSchema = z.strictObject({
  id: idSchema, reminderId: idSchema, userId: idSchema,
  deduplicationKey: z.string().min(1).max(512), scheduledAt: instantSchema,
  state: z.enum(['pending', 'processing', 'sent', 'failed']), attempts: z.number().int().nonnegative(),
  nextAttemptAt: instantSchema.nullable(), leaseUntil: instantSchema.nullable(), sentAt: instantSchema.nullable(),
});
