// Ports between screens and the data/auth layer. RAZ-3 ships the UI on these shared
// contracts with honest "not available yet" adapters; RAZ-5 plugs in the real
// /api/auth calls, the local Dexie store and the sync coordinator. Screens never
// pretend that something was saved or synchronised.
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { loginRequestSchema, passwordChangeRequestSchema } from '@razem/contracts';
import type { EntityType } from '@razem/contracts';
import type { z } from 'zod';

export type LoginRequest = z.input<typeof loginRequestSchema>;
export type PasswordChangeRequest = z.input<typeof passwordChangeRequestSchema>;
export type AuthFailure = 'invalid_credentials' | 'rate_limited' | 'weak_password' | 'authentication_required' | 'unavailable' | 'not_implemented';
export type ActionResult = { ok: true } | { ok: false; reason: AuthFailure | 'storage_unavailable'; retryAfterSeconds?: number };

export type Session = { login: string; displayName: string; mustChangePassword: boolean };
export type Visibility = 'private' | 'shared';
/** New record. Children (shopping_item, task_occurrence, reminder) have no visibility: they inherit the parent's. */
export type DraftInput = { entityType: EntityType; visibility?: Visibility; data: Record<string, unknown> };
/** A record as the local store shows it to this account (already ACL-filtered by RAZ-5). */
export type StoredRecord = {
  id: string; entityType: EntityType; visibility: Visibility; version: number;
  /** True when the signed-in user owns the record ("Ja" in assignee is relative to the owner). */
  mine: boolean; data: Record<string, unknown>;
};
/** not_found also covers "no access": the UI never reveals whether a private record exists. */
export type LoadResult<T> = { status: 'ok'; value: T } | { status: 'not_found' } | { status: 'unavailable' };
export type RecordQuery = { entityType: EntityType; parentId?: string };
export type UpdateInput = { entityType: EntityType; id: string; baseVersion: number; patch: Record<string, unknown> };
export type DeleteInput = { entityType: EntityType; id: string; baseVersion: number };

export interface AppServices {
  session: Session | null;
  login(request: LoginRequest): Promise<ActionResult>;
  changePassword(request: PasswordChangeRequest): Promise<ActionResult>;
  /** Writes the record and its outbox entry locally (RAZ-5). Must not resolve ok unless persisted. */
  saveRecord(input: DraftInput): Promise<ActionResult>;
  /** Changes only the given fields; visibility and parent links are immutable. */
  updateRecord(input: UpdateInput): Promise<ActionResult>;
  /** Moves the record to the trash (restorable for 30 days). */
  deleteRecord(input: DeleteInput): Promise<ActionResult>;
  /** Live records of a type on this device (children by parentId). */
  listRecords(query: RecordQuery): Promise<LoadResult<StoredRecord[]>>;
  getRecord(entityType: EntityType, id: string): Promise<LoadResult<StoredRecord>>;
  pendingChanges: number;
  /** Status reported by the sync coordinator (RAZ-5); absent while it does not exist. */
  syncState?: SyncState;
}

const notImplemented = async (): Promise<ActionResult> => ({ ok: false, reason: 'not_implemented' });
const noStorage = async (): Promise<ActionResult> => ({ ok: false, reason: 'storage_unavailable' });
const nothingStored = async () => ({ status: 'unavailable' as const });
export const unavailableServices: AppServices = {
  session: null, pendingChanges: 0,
  login: notImplemented, changePassword: notImplemented,
  saveRecord: noStorage, updateRecord: noStorage, deleteRecord: noStorage,
  listRecords: nothingStored, getRecord: nothingStored,
};

const ServicesContext = createContext<AppServices>(unavailableServices);
export function ServicesProvider({ value, children }: { value: AppServices; children: ReactNode }) {
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}
export const useServices = () => useContext(ServicesContext);

/** Polish user-facing message for a failed action; no API names or technical detail. */
export function failureMessage(result: Exclude<ActionResult, { ok: true }>): string {
  switch (result.reason) {
    case 'invalid_credentials': return 'Nieprawidłowy login lub hasło.';
    case 'rate_limited': return `Zbyt wiele prób. Spróbuj ponownie${result.retryAfterSeconds ? ` za ${Math.ceil(result.retryAfterSeconds / 60)} min` : ' później'}.`;
    case 'weak_password': return 'Nowe hasło nie spełnia wymagań.';
    case 'authentication_required': return 'Sesja wygasła. Zaloguj się ponownie.';
    case 'unavailable': return 'Serwer jest niedostępny. Spróbuj ponownie, gdy połączenie wróci.';
    case 'not_implemented': return 'Ta funkcja nie jest jeszcze dostępna w tej wersji aplikacji.';
    case 'storage_unavailable': return 'Nie zapisano. Zapisywanie wpisów na tym urządzeniu nie jest jeszcze dostępne w tej wersji aplikacji.';
  }
}

// Sync status vocabulary from design/interface.md. navigator.onLine only tells us
// that the device has no network; it never proves the server is reachable.
export type SyncState =
  | { kind: 'offline' } | { kind: 'saving' } | { kind: 'pending'; count: number }
  | { kind: 'synced'; at: Date } | { kind: 'server_unavailable' } | { kind: 'signed_out' }
  | { kind: 'conflict'; count: number } | { kind: 'not_connected' };

const polishCount = (count: number, one: string, few: string, many: string) => {
  const mod10 = count % 10, mod100 = count % 100;
  if (count === 1) return one;
  return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
};
const timeFormat = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });

export function syncLabel(state: SyncState): { text: string; tone: 'neutral' | 'ok' | 'warning' | 'danger' } {
  switch (state.kind) {
    case 'offline': return { text: 'Offline', tone: 'warning' };
    case 'saving': return { text: 'Zapisywanie na tym urządzeniu', tone: 'neutral' };
    case 'pending': return { text: `Zmiany czekają na wysłanie (${state.count})`, tone: 'warning' };
    case 'synced': return { text: `Zsynchronizowano ${timeFormat.format(state.at)}`, tone: 'ok' };
    case 'server_unavailable': return { text: 'Serwer niedostępny', tone: 'danger' };
    case 'signed_out': return { text: 'Zaloguj się, aby wysłać zmiany', tone: 'warning' };
    case 'conflict': return { text: `${state.count} ${polishCount(state.count, 'zmiana wymaga', 'zmiany wymagają', 'zmian wymaga')} sprawdzenia`, tone: 'danger' };
    case 'not_connected': return { text: 'Nie zalogowano', tone: 'neutral' };
  }
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return online;
}

/** Current, truthful status. Without a session there is nothing to send and nothing synchronised. */
export function useSyncState(): SyncState {
  const { session, pendingChanges, syncState } = useServices();
  const online = useOnline();
  if (!online) return { kind: 'offline' };
  if (!session) return pendingChanges > 0 ? { kind: 'signed_out' } : { kind: 'not_connected' };
  return syncState ?? (pendingChanges > 0 ? { kind: 'pending', count: pendingChanges } : { kind: 'saving' });
}
