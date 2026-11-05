// Ports between screens and the data/auth layer. RAZ-3 ships the UI on these shared
// contracts with honest "not available yet" adapters; RAZ-5 plugs in the real
// /api/auth calls, the local Dexie store and the sync coordinator. Screens never
// pretend that something was saved or synchronised.
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { loginRequestSchema, passwordChangeRequestSchema } from '@razem/contracts';
import type { EntityType, Settings, SettingsPatch } from '@razem/contracts';
import type { z } from 'zod';

export type LoginRequest = z.input<typeof loginRequestSchema>;
export type PasswordChangeRequest = z.input<typeof passwordChangeRequestSchema>;
export type AuthFailure = 'invalid_credentials' | 'rate_limited' | 'weak_password' | 'authentication_required' | 'unavailable' | 'not_implemented';
export type StorageFailure = 'storage_unavailable' | 'storage_full' | 'not_found' | 'invalid' | 'conflict_open' | 'record_changed' | 'pending_changes' | 'account_changed';
export type ActionResult = { ok: true } | { ok: false; reason: AuthFailure | StorageFailure; retryAfterSeconds?: number };

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
export type UpdateInput = { entityType: EntityType; id: string; baseVersion: number; patch: Record<string, unknown>; expectedData?: Record<string, unknown> };
export type DeleteInput = { entityType: EntityType; id: string; baseVersion: number };
/** Explicitly confirmed text; copyId stays the same when retrying a local save. */
export type NoteCopy = { sourceId: string; copyId: string; data: { title: string; body: string } };

/** A change that needs the user: a version conflict or a change the server rejected. */
export type AttentionItem =
  | { kind: 'conflict'; id: string; entityType: EntityType; entityId: string; title: string; detectedAt: string }
  | { kind: 'rejected'; id: string; entityType: EntityType; entityId: string; title: string; error: string; queuedAt: string };
export type ConflictView = {
  id: string; entityType: EntityType; entityId: string; visibility: Visibility; detectedAt: string;
  /** My version (null when I deleted it here). */
  mine: Record<string, unknown> | null; mineDeleted: boolean;
  /** Version saved on the server; `server` is null when it was removed for good. */
  server: Record<string, unknown> | null; serverState: 'live' | 'trash' | 'gone';
};
export type ConflictResolution = { choice: 'server' } | { choice: 'mine' } | { choice: 'merge'; data: Record<string, unknown> };
export type TrashItem = { id: string; entityType: EntityType; title: string; deletedAt: string; visibility: Visibility };

export type CalendarSave = {
  entityType: 'calendar_event' | 'important_date'; id?: string; visibility: Visibility;
  data: Record<string, unknown>;
  /** Omitted on edit when the configuration was not changed in the form. */
  reminder?: { enabled: boolean; minutesBefore: number; localTime: string | null };
};

export interface AppServices {
  /** No form may accept input until the initial account database is open. */
  initializing?: boolean;
  session: Session | null;
  settings?: Settings | undefined;
  updateSettings?(patch: SettingsPatch): Promise<ActionResult>;
  /**
   * Opaque identity of the open account database (new on every sign-in, account switch
   * and logout). The app remounts every screen when it changes, so form values and loaded
   * records of one account never stay on screen for another; every call of these
   * services is bound to it and refuses (account_changed) once it is stale.
   */
  accountKey?: string;
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
  /** Local changes not yet confirmed by the server (ACK). */
  pendingChanges: number;
  /** Status reported by the sync coordinator; absent while it does not exist. */
  syncState?: SyncState;
  /** Changes on every local write/pull (also from other tabs); views reload on it. */
  revision?: number;
  attentionCount?: number;
  /** Requires the server; refuses with pending_changes unless discardPending. */
  logout?(options: { discardPending: boolean }): Promise<ActionResult>;
  syncNow?(): Promise<void>;
  /** Downloads a file with the changes that exist only on this device. */
  exportPending?(): Promise<ActionResult>;
  exportAccount?(): Promise<ActionResult>;
  listAttention?(): Promise<AttentionItem[]>;
  getConflict?(id: string): Promise<LoadResult<ConflictView>>;
  resolveConflict?(id: string, resolution: ConflictResolution): Promise<ActionResult>;
  discardRejected?(id: string): Promise<ActionResult>;
  listTrash?(): Promise<LoadResult<TrashItem[]>>;
  saveCalendar?(input: CalendarSave): Promise<ActionResult>;
  setTaskOccurrence?(taskId: string, occurrenceKey: string, completed: boolean): Promise<ActionResult>;
  restoreRecord?(entityType: EntityType, id: string): Promise<ActionResult>;
  shareNote?(input: NoteCopy): Promise<ActionResult>;
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
export const useTimezone = () => useServices().settings?.household.timezone ?? 'Europe/Warsaw';

/** Polish user-facing message for a failed action; no API names or technical detail. */
export function failureMessage(result: Exclude<ActionResult, { ok: true }>): string {
  switch (result.reason) {
    case 'invalid_credentials': return 'Nieprawidłowy login lub hasło.';
    case 'rate_limited': return `Zbyt wiele prób. Spróbuj ponownie${result.retryAfterSeconds ? ` za ${Math.ceil(result.retryAfterSeconds / 60)} min` : ' później'}.`;
    case 'weak_password': return 'Nowe hasło nie spełnia wymagań.';
    case 'authentication_required': return 'Sesja wygasła. Zaloguj się ponownie.';
    case 'unavailable': return 'Serwer jest niedostępny. Spróbuj ponownie, gdy połączenie wróci.';
    case 'not_implemented': return 'Ta funkcja nie jest jeszcze dostępna w tej wersji aplikacji.';
    case 'storage_unavailable': return 'Nie zapisano. Pamięć tego urządzenia jest niedostępna (np. tryb prywatny lub zablokowane dane witryny).';
    case 'storage_full': return 'Nie zapisano: brak miejsca na urządzeniu. Wyeksportuj niewysłane zmiany w Ustawieniach i zwolnij miejsce.';
    case 'not_found': return 'Nie zapisano. Wpis mógł zostać usunięty albo nie jest dostępny.';
    case 'invalid': return 'Nie zapisano. Sprawdź wpisane dane.';
    case 'conflict_open': return 'Ten wpis zmieniono też na innym urządzeniu. Najpierw wybierz wersję w „Zmiany do sprawdzenia”.';
    case 'record_changed': return 'Notatka zmieniła się podczas edycji. Porównaj obie wersje poniżej i połącz tekst przed ponownym zapisem.';
    case 'pending_changes': return 'Na tym urządzeniu są niewysłane zmiany.';
    case 'account_changed': return 'Nie zapisano: w tej aplikacji zalogowano inne konto.';
  }
}

// Sync status vocabulary from design/interface.md. navigator.onLine only tells us
// that the device has no network; it never proves the server is reachable.
export type SyncState =
  | { kind: 'offline'; pending?: number } | { kind: 'saving' } | { kind: 'pending'; count: number }
  | { kind: 'synced'; at: Date } | { kind: 'server_unavailable'; pending?: number } | { kind: 'signed_out'; pending?: number }
  | { kind: 'conflict'; count: number } | { kind: 'not_connected' } | { kind: 'connecting' }
  | { kind: 'storage_full' } | { kind: 'storage_unavailable' } | { kind: 'update_required' };

const polishCount = (count: number, one: string, few: string, many: string) => {
  const mod10 = count % 10, mod100 = count % 100;
  if (count === 1) return one;
  return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
};
const timeFormat = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });

const waiting = (pending: number | undefined) => pending ? ` · zmiany czekają na wysłanie (${pending})` : '';
export function syncLabel(state: SyncState): { text: string; tone: 'neutral' | 'ok' | 'warning' | 'danger' } {
  switch (state.kind) {
    case 'offline': return { text: `Offline${waiting(state.pending)}`, tone: 'warning' };
    case 'saving': return { text: 'Zapisywanie na tym urządzeniu', tone: 'neutral' };
    case 'pending': return { text: `Zmiany czekają na wysłanie (${state.count})`, tone: 'warning' };
    case 'synced': return { text: `Zsynchronizowano ${timeFormat.format(state.at)}`, tone: 'ok' };
    case 'server_unavailable': return { text: `Serwer niedostępny${waiting(state.pending)}`, tone: 'danger' };
    case 'signed_out': return { text: state.pending ? `Zaloguj się, aby wysłać zmiany (${state.pending})` : 'Zaloguj się, aby wysłać zmiany', tone: 'warning' };
    case 'connecting': return { text: 'Łączenie z serwerem…', tone: 'neutral' };
    case 'storage_full': return { text: 'Brak miejsca na urządzeniu – ostatnia zmiana nie została zapisana', tone: 'danger' };
    case 'storage_unavailable': return { text: 'Pamięć urządzenia niedostępna – zmiany nie są zapisywane', tone: 'danger' };
    case 'update_required': return { text: 'Wymagana nowa wersja aplikacji – zmiany czekają', tone: 'danger' };
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
  // With a session the coordinator's state is the truth (it tried the server); navigator.onLine
  // alone neither proves nor disproves that the server is reachable.
  if (session && syncState) return syncState;
  if (!online) return pendingChanges > 0 ? { kind: 'offline', pending: pendingChanges } : { kind: 'offline' };
  if (!session) return pendingChanges > 0 ? { kind: 'signed_out', pending: pendingChanges } : { kind: 'not_connected' };
  return syncState ?? (pendingChanges > 0 ? { kind: 'pending', count: pendingChanges } : { kind: 'connecting' });
}
