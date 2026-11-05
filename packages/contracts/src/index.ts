export * from './dates.js';
export * from './model.js';
export * from './sync.js';
export * from './auth.js';

import { z } from 'zod';
export const healthSchema = z.strictObject({ status: z.literal('ok'), service: z.literal('razem'), protocolVersion: z.literal(1) });
export const apiErrorSchema = z.strictObject({ error: z.enum([
  'authentication_required', 'invalid_credentials', 'password_change_required', 'weak_password',
  'forbidden', 'rate_limited', 'not_found', 'invalid_request', 'unavailable', 'upgrade_required', 'payload_too_large',
  'account_mismatch',
]), message: z.string().max(200).optional() });

export * from './tasks.js';
export * from './calendar.js';
export * from './settings.js';
export * from './export.js';
