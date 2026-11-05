import { z } from 'zod';
import { recordSchemaUnion, userSchema } from './model.js';
import { settingsSchema } from './settings.js';
import { instantSchema } from './dates.js';

/** Portable account data, deliberately excluding all authentication and push material. */
export const accountExportSchema = z.strictObject({
  format: z.literal('razem-account'), formatVersion: z.literal(1), exportedAt: instantSchema,
  account: userSchema.pick({ id: true, householdId: true, login: true, displayName: true }),
  settings: settingsSchema,
  records: z.array(recordSchemaUnion),
});
export type AccountExport = z.infer<typeof accountExportSchema>;
