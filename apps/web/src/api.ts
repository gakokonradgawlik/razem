import { healthSchema, pullResponseSchema, pushRequestSchema, pushResponseSchema } from '@razem/contracts';
import type { PushRequest } from '@razem/contracts';

export class HttpError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); }
}
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new HttpError(response.status);
  return response.json();
}
export async function readHealth() { return healthSchema.parse(await request('/healthz')); }
export async function pushChanges(input: PushRequest) {
  const payload = pushRequestSchema.parse(input);
  return pushResponseSchema.parse(await request('/api/sync/push', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }));
}
export async function pullChanges(cursor?: string) {
  const query = new URLSearchParams(cursor ? { cursor } : {});
  return pullResponseSchema.parse(await request(`/api/sync/pull?${query}`));
}
