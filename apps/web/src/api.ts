// HTTP client of the PWA. Every request has a time limit; the caller decides what a
// failure means. A response is never interpreted as success unless it parses with the
// shared contract. The fetcher is injectable so tests talk to the real Fastify app.
import { apiErrorSchema, healthSchema, meResponseSchema, pullResponseSchema, pushRequestSchema, pushResponseSchema } from '@razem/contracts';
import type { MeResponse, PullResponse, PushRequest, PushResponse } from '@razem/contracts';

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type ApiFailure =
  | 'network' | 'timeout' | 'server' | 'authentication_required' | 'password_change_required'
  | 'invalid_credentials' | 'rate_limited' | 'weak_password' | 'upgrade_required' | 'payload_too_large'
  | 'invalid_request' | 'forbidden' | 'invalid_response';

export class ApiError extends Error {
  constructor(readonly kind: ApiFailure, readonly status = 0, readonly retryAfterSeconds?: number) { super(`API ${kind}`); }
  /** Failures after which the same request may succeed later without user action. */
  get transient() { return this.kind === 'network' || this.kind === 'timeout' || this.kind === 'server' || this.kind === 'rate_limited'; }
}

export const REQUEST_TIMEOUT_MS = 10_000;

export class Api {
  constructor(private readonly fetcher: Fetcher = (url, init) => fetch(url, init), private readonly timeoutMs = REQUEST_TIMEOUT_MS) {}

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(path, {
        ...init, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Accept: 'application/json', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      });
    } catch (error) {
      throw new ApiError(error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'network');
    }
    if (response.status === 204) return null;
    let body: unknown = null;
    try { body = await response.json(); } catch {
      if (response.ok) throw new ApiError('invalid_response', response.status);
    }
    if (response.ok) return body;
    const code = apiErrorSchema.safeParse(body);
    const error = code.success ? code.data.error : undefined;
    if (response.status >= 500 || error === 'unavailable') throw new ApiError('server', response.status);
    if (response.status === 401) throw new ApiError(error === 'invalid_credentials' ? 'invalid_credentials' : 'authentication_required', 401);
    if (response.status === 429) throw new ApiError('rate_limited', 429, Number(response.headers.get('Retry-After')) || undefined);
    if (response.status === 413) throw new ApiError('payload_too_large', 413);
    if (error === 'password_change_required') throw new ApiError('password_change_required', response.status);
    if (error === 'weak_password') throw new ApiError('weak_password', response.status);
    if (error === 'upgrade_required') throw new ApiError('upgrade_required', response.status);
    if (response.status === 403) throw new ApiError('forbidden', 403);
    // A proxy page or unknown status: treat like an unreachable server, never as success.
    if (!code.success) throw new ApiError('server', response.status);
    throw new ApiError('invalid_request', response.status);
  }

  private parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ApiError('invalid_response');
    return parsed.data;
  }

  async health() { return this.parse(healthSchema, await this.request('/healthz')); }
  async me(): Promise<MeResponse> { return this.parse(meResponseSchema, await this.request('/api/me')); }
  async login(login: string, password: string): Promise<MeResponse> {
    return this.parse(meResponseSchema, await this.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ login, password }) }));
  }
  async changePassword(currentPassword: string, newPassword: string): Promise<MeResponse> {
    return this.parse(meResponseSchema, await this.request('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }));
  }
  async logout(): Promise<void> { await this.request('/api/auth/logout', { method: 'POST', body: '{}' }); }
  async push(input: PushRequest): Promise<PushResponse> {
    const payload = pushRequestSchema.parse(input);
    return this.parse(pushResponseSchema, await this.request('/api/sync/push', { method: 'POST', body: JSON.stringify(payload) }));
  }
  async pull(cursor: string | undefined, limit: number): Promise<PullResponse> {
    const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    return this.parse(pullResponseSchema, await this.request(`/api/sync/pull?${query}`));
  }
}
