// Adapter: the AppController (local store + sync engine + account) as the AppServices
// port used by the screens. Everything the UI shows comes from the local database.
import { useMemo, useSyncExternalStore } from 'react';
import type { EntityType } from '@razem/contracts';
import type { AppController, Snapshot } from './controller.js';
import { titleOf } from './store.js';
import type { LocalStore, StoreResult } from './store.js';
import type { LocalRecord } from '../local-db.js';
import type { ActionResult, AppServices, ConflictView, StoredRecord, SyncState } from '../services.js';

export function toSyncState(snapshot: Snapshot): SyncState | undefined {
  if (snapshot.phase === 'storage_unavailable' || snapshot.storage === 'unavailable') return { kind: 'storage_unavailable' };
  if (snapshot.phase !== 'ready') return undefined;
  if (snapshot.storage === 'full') return { kind: 'storage_full' };
  if (snapshot.attention > 0) return { kind: 'conflict', count: snapshot.attention };
  const pending = snapshot.unsent;
  const withPending = <T extends object>(state: T) => (pending > 0 ? { ...state, pending } : state);
  switch (snapshot.status.connection) {
    case 'auth_required': case 'password_change': case 'account_mismatch': return withPending({ kind: 'signed_out' as const });
    case 'upgrade_required': return { kind: 'update_required' };
    case 'offline': return withPending({ kind: 'offline' as const });
    case 'server_unavailable': return withPending({ kind: 'server_unavailable' as const });
    default: break;
  }
  if (pending > 0) return { kind: 'pending', count: pending };
  if (snapshot.status.connection === 'ok' && snapshot.status.lastSyncAt) return { kind: 'synced', at: new Date(snapshot.status.lastSyncAt) };
  return { kind: 'connecting' };
}

const done = (result: StoreResult<unknown>): ActionResult => result.ok ? { ok: true } : { ok: false, reason: result.reason };

function view(record: LocalRecord, userId: string): StoredRecord {
  return { id: record.id, entityType: record.entityType, visibility: record.visibility, version: record.version, mine: record.ownerId === userId, data: record.data };
}

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.rel = 'noopener';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function servicesFor(controller: AppController, snapshot: Snapshot): AppServices {
  const account = snapshot.phase === 'ready' || snapshot.phase === 'storage_unavailable' ? snapshot.account : null;
  const userId = account?.userId ?? '';
  // Every read and write below is bound to the account database these services were
  // made for: after an account switch (e.g. adopted from another tab) a stale callback
  // held by a screen reads nothing and writes nothing into the new account's database.
  const generation = snapshot.generation;
  const store = () => controller.storeFor(generation);
  const command = <T,>(run: (s: LocalStore) => Promise<StoreResult<T>>) => controller.command(run, generation);
  const syncState = toSyncState(snapshot);
  return {
    initializing: snapshot.phase === 'starting',
    session: account ? { login: account.login, displayName: snapshot.settings?.members.find((m) => m.id === userId)?.displayName ?? account.displayName, mustChangePassword: account.mustChangePassword } : null,
    settings: snapshot.settings,
    updateSettings: (patch) => controller.updateSettings(patch, generation),
    accountKey: `${account?.userId ?? '-'}#${generation}`,
    pendingChanges: snapshot.unsent,
    ...(syncState ? { syncState } : {}),
    revision: snapshot.revision,
    attentionCount: snapshot.attention,
    login: async (request) => controller.login(request.login, request.password),
    changePassword: async (request) => controller.changePassword(request.currentPassword, request.newPassword),
    logout: (options) => controller.logout(options, generation),
    syncNow: () => controller.syncNow(),
    saveRecord: async ({ entityType, visibility, data }) => done(await command((s) => s.create(entityType, data, visibility))),
    updateRecord: async ({ entityType, id, patch, expectedData }) => done(await command((s) => s.update(entityType, id, patch, expectedData))),
    deleteRecord: async ({ entityType, id }) => done(await command((s) => s.remove(entityType, id))),
    saveCalendar: async (input) => done(await command((s) => s.saveCalendar(input))),
    setTaskOccurrence: async (taskId, key, completed) => done(await command((s) => s.setTaskOccurrence(taskId, key, completed))),
    restoreRecord: async (entityType, id) => done(await command((s) => s.restore(entityType, id))),
    shareNote: async (input) => done(await command((s) => s.shareNote(input))),
    listRecords: async ({ entityType, parentId }) => {
      const s = store();
      if (!s) return { status: 'unavailable' };
      try { return { status: 'ok', value: (await s.list(entityType, parentId)).map((record) => view(record, userId)) }; } catch { return { status: 'unavailable' }; }
    },
    getRecord: async (entityType: EntityType, id: string) => {
      const s = store();
      if (!s) return { status: 'unavailable' };
      try {
        const record = await s.get(id);
        return record && record.entityType === entityType && record.deletedAt === null ? { status: 'ok', value: view(record, userId) } : { status: 'not_found' };
      } catch { return { status: 'unavailable' }; }
    },
    listTrash: async () => {
      const s = store();
      if (!s) return { status: 'unavailable' };
      try {
        return { status: 'ok', value: (await s.trash()).map((record) => ({ id: record.id, entityType: record.entityType, title: titleOf(record.data), deletedAt: record.deletedAt!, visibility: record.visibility })) };
      } catch { return { status: 'unavailable' }; }
    },
    listAttention: async () => (await store()?.attention()) ?? [],
    getConflict: async (id) => {
      const conflict = await store()?.conflict(id);
      if (!conflict) return { status: 'not_found' };
      const server = conflict.server;
      const value: ConflictView = {
        id: conflict.id, entityType: conflict.entityType, entityId: conflict.entityId, detectedAt: conflict.detectedAt,
        visibility: conflict.local?.visibility ?? (server.kind === 'record' ? server.record.visibility : 'private'),
        mine: conflict.local?.data ?? null, mineDeleted: !conflict.local || conflict.local.deletedAt !== null,
        server: server.kind === 'record' ? server.record.data : null,
        serverState: server.kind === 'tombstone' ? 'gone' : server.record.deletedAt !== null ? 'trash' : 'live',
      };
      return { status: 'ok', value };
    },
    resolveConflict: async (id, resolution) => done(await command((s) => s.resolve(id, resolution))),
    discardRejected: async (id) => done(await command((s) => s.discardRejected(id))),
    exportPending: async () => {
      const s = store();
      if (!s || !account) return { ok: false, reason: 'storage_unavailable' };
      try {
        const data = await s.exportPending(account.login);
        download(`razem-niewyslane-zmiany-${data.exportedAt.slice(0, 10)}.json`, JSON.stringify(data, null, 2));
        return { ok: true };
      } catch { return { ok: false, reason: 'storage_unavailable' }; }
    },
  };
}

export function useControllerServices(controller: AppController): AppServices {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return useMemo(() => servicesFor(controller, snapshot), [controller, snapshot]);
}

