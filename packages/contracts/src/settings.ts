import { z } from 'zod';
import { householdSchema, idSchema, userSchema } from './model.js';
import { timezoneSchema } from './dates.js';

export const NOTIFICATION_SETTINGS_HEADER = 'x-razem-notifications';

/** Account metadata is online-only; domain records still use sync v2. */
export const settingsSchema = z.strictObject({
  userId: idSchema,
  household: householdSchema,
  members: z.array(z.strictObject({ id: idSchema, displayName: userSchema.shape.displayName })).max(2),
  // Optional extensions also preserve old cached settings on an offline phone.
  notifications: z.strictObject({
    includeTitles: z.boolean(), shoppingNotifications: z.boolean(),
    taskReminders: z.boolean().optional(),
    taskReminderTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    taskMinutesBefore: z.number().int().min(0).max(10080).optional(),
    taskAssignments: z.boolean().optional(),
  }),
});
export const settingsPatchSchema = z.strictObject({
  displayName: userSchema.shape.displayName.optional(),
  timezone: timezoneSchema.optional(),
  includeTitles: z.boolean().optional(),
  shoppingNotifications: z.boolean().optional(),
  taskReminders: z.boolean().optional(),
  taskReminderTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  taskMinutesBefore: z.number().int().min(0).max(10080).optional(),
  taskAssignments: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0);
export type Settings = z.infer<typeof settingsSchema>;
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
