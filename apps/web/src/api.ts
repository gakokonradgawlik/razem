// HTTP client of the PWA. Every request has a time limit; the caller decides what a
// failure means. A response is never interpreted as success unless it parses with the
// shared contract. The fetcher is injectable so tests talk to the real Fastify app.
import { NOTIFICATION_SETTINGS_HEADER, pushConfigSchema, pushStatusSchema, pushSubscribeSchema, accountExportSchema, PROTOCOL_VERSION, SYNC_PROTOCOL_HEADER, SYNC_ACCOUNT_HEADER, apiErrorSchema, healthSchema, meResponseSchema, pullResponseSchema, pushRequestSchema, pushResponseSchema, settingsSchema, settingsPatchSchema } from '@razem/contracts';
import type { PushSubscribe, EntityType, MeResponse, PullResponse, PushRequest, PushResponse, SettingsPatch } from '@razem/contracts';

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type ApiFailure =
  | 'network' | 'timeout' | 'server' | 'authentication_required' | 'password_change_required'
  | 'invalid_credentials' | 'rate_limited' | 'weak_password' | 'upgrade_required' | 'payload_too_large'
  | 'invalid_request' | 'forbidden' | 'invalid_response' | 'account_mismatch' | 'aborted';

export class ApiError extends Error {
  constructor(readonly kind: ApiFailure, readonly status = 0, readonly retryAfterSeconds?: number) { super(`API ${kind}`); }
  /** Failures after which the same request may succeed later without user action. */
  get transient() { return this.kind === 'network' || this.kind === 'timeout' || this.kind === 'server' || this.kind === 'rate_limited'; }
}

export const REQUEST_TIMEOUT_MS = 10_000;

export class Api {
  constructor(private readonly fetcher: Fetcher = (url, init) => fetch(url, init), private readonly timeoutMs = REQUEST_TIMEOUT_MS) {}

  private async request(path: string, init: RequestInit = {}, abort?: AbortSignal): Promise<unknown> {
    let response: Response;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try {
      if (abort?.aborted) throw new DOMException('Aborted', 'AbortError');
      response = await this.fetcher(path, {
        ...init, credentials: 'same-origin', cache: 'no-store', signal: abort ? AbortSignal.any([timeout, abort]) : timeout,
        headers: { Accept: 'application/json', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      });
    } catch (error) {
      if (abort?.aborted) throw new ApiError('aborted');
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
    if (error === 'account_mismatch') throw new ApiError('account_mismatch', response.status);
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

  async pushConfig(account: string) {
    return this.parse(pushConfigSchema, await this.request('/api/push/config', { headers: { [SYNC_ACCOUNT_HEADER]: account } }));
  }
  async pushStatus(account: string, device: string) {
    return this.parse(pushStatusSchema, await this.request(`/api/push/devices/${device}`, { headers: { [SYNC_ACCOUNT_HEADER]: account } }));
  }
  async subscribePush(account: string, input: PushSubscribe) {
    return this.parse(pushStatusSchema, await this.request('/api/push/subscription', { method: 'PUT', body: JSON.stringify(pushSubscribeSchema.parse(input)), headers: { [SYNC_ACCOUNT_HEADER]: account } }));
  }
  async removePush(account: string, device: string) {
    await this.request(`/api/push/devices/${device}`, { method: 'DELETE', body: '{}', headers: { [SYNC_ACCOUNT_HEADER]: account } });
  }
  async resolvePush(account: string, entityType: EntityType, id: string): Promise<string> {
    const result = await this.request('/api/push/resolve', { method: 'POST', body: JSON.stringify({ entityType, id }), headers: { [SYNC_ACCOUNT_HEADER]: account } });
    if (!result || typeof result !== 'object' || !('path' in result) || typeof result.path !== 'string'
      || !/^\/(zadania|kalendarz|wazne-daty|zakupy)\/[0-9a-f-]{36}$/.test(result.path)) throw new ApiError('invalid_response');
    return result.path;
  }
  async exportAccount(account: string) {
    const result = this.parse(accountExportSchema, await this.request('/api/export', { headers: { [SYNC_ACCOUNT_HEADER]: account, [NOTIFICATION_SETTINGS_HEADER]: '1' } }));
    if (result.account.id !== account || result.settings.userId !== account) throw new ApiError('account_mismatch');
    return result;
  }
  async health() { return this.parse(healthSchema, await this.request('/healthz')); }
  async me(): Promise<MeResponse> { return this.parse(meResponseSchema, await this.request('/api/me')); }
  async settings(account: string, abort?: AbortSignal, patch?: SettingsPatch) {
    const result = this.parse(settingsSchema, await this.request('/api/settings', {
      headers: { [SYNC_ACCOUNT_HEADER]: account, [NOTIFICATION_SETTINGS_HEADER]: '1' },
      ...(patch ? { method: 'PATCH', body: JSON.stringify(settingsPatchSchema.parse(patch)) } : {}),
    }, abort));
    if (result.userId !== account) throw new ApiError('account_mismatch');
    return result;
  }
  async login(login: string, password: string): Promise<MeResponse> {
    return this.parse(meResponseSchema, await this.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ login, password }) }));
  }
  async changePassword(currentPassword: string, newPassword: string): Promise<MeResponse> {
    return this.parse(meResponseSchema, await this.request('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }));
  }
  async logout(account: string): Promise<void> { await this.request('/api/auth/logout', { method: 'POST', body: '{}', headers: { [SYNC_ACCOUNT_HEADER]: account } }); }
  /**
   * Sync requests carry the account their local database belongs to; the server checks it
   * against the session of the same request (409 account_mismatch), so a session switched to
   * another account in the meantime can neither receive this queue nor fill this database.
   */
  async push(input: PushRequest, account: string, abort?: AbortSignal): Promise<PushResponse> {
    const payload = pushRequestSchema.parse(input);
    return this.parse(pushResponseSchema, await this.request('/api/sync/push', { method: 'POST', body: JSON.stringify(payload), headers: { [SYNC_ACCOUNT_HEADER]: account, [SYNC_PROTOCOL_HEADER]: String(PROTOCOL_VERSION) } }, abort));
  }
  async pull(cursor: string | undefined, limit: number, account: string, abort?: AbortSignal): Promise<PullResponse> {
    const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    return this.parse(pullResponseSchema, await this.request(`/api/sync/pull?${query}`, { headers: { [SYNC_ACCOUNT_HEADER]: account, [SYNC_PROTOCOL_HEADER]: String(PROTOCOL_VERSION) } }, abort));
  }
}
