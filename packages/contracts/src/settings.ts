import { z } from 'zod';
import { householdSchema, idSchema, userSchema } from './model.js';
import { timezoneSchema } from './dates.js';

/** Account metadata is online-only; domain records still use sync v2. */
export const settingsSchema = z.strictObject({
  userId: idSchema,
  household: householdSchema,
  members: z.array(z.strictObject({ id: idSchema, displayName: userSchema.shape.displayName })).max(2),
  notifications: z.strictObject({ includeTitles: z.boolean(), shoppingNotifications: z.boolean() }),
});
export const settingsPatchSchema = z.strictObject({
  displayName: userSchema.shape.displayName.optional(),
  timezone: timezoneSchema.optional(),
  includeTitles: z.boolean().optional(),
  shoppingNotifications: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0);
export type Settings = z.infer<typeof settingsSchema>;
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
