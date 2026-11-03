export * from './dates.js';
export * from './model.js';
export * from './sync.js';

import { z } from 'zod';
export const healthSchema = z.strictObject({ status: z.literal('ok'), service: z.literal('razem'), protocolVersion: z.literal(1) });
export const apiErrorSchema = z.strictObject({ error: z.enum(['authentication_required', 'not_found', 'invalid_request', 'unavailable']) });
