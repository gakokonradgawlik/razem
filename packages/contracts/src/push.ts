import { z } from 'zod';
import { entityTypeSchema, idSchema } from './model.js';

// Accept only known push providers: prevents authenticated SSRF to the household LAN.
export const pushEndpointSchema = z.url().max(4096).refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
    && (url.hostname.endsWith('.push.apple.com') || url.hostname === 'fcm.googleapis.com'
      || url.hostname === 'updates.push.services.mozilla.com' || url.hostname === 'wns2-par02p.notify.windows.com'
      || url.hostname.endsWith('.notify.windows.com'));
});
export const pushSubscribeSchema = z.strictObject({
  deviceId: idSchema,
  subscription: z.strictObject({
    endpoint: pushEndpointSchema, expirationTime: z.number().int().nonnegative().nullable(),
    keys: z.strictObject({ p256dh: z.string().regex(/^B[A-Za-z0-9_-]{86}=?$/), auth: z.string().regex(/^[A-Za-z0-9_-]{22}(==)?$/) }),
  }),
});
export const pushConfigSchema = z.strictObject({ publicKey: z.string().nullable() });
export const pushStatusSchema = z.strictObject({ enabled: z.boolean() });
export const pushTargetSchema = z.strictObject({ entityType: entityTypeSchema, id: idSchema });
export type PushSubscribe = z.infer<typeof pushSubscribeSchema>;
