// Shared plumbing for list, detail and edit screens. Records come only from the
// AppServices port (local store in RAZ-5); while it is unavailable the screens show
// honest empty/unavailable states and never invent data or confirm a write.
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { dataSchemas } from '@razem/contracts';
import type { EntityType } from '@razem/contracts';
import type { z } from 'zod';
import { Link, navigate } from '../router.js';
import { Button, EmptyState, Notice, PrivacyTag, ScreenHeader, Section } from '../ui/components.js';
import { failureMessage, useServices } from '../services.js';
import type { ActionResult, AppServices, LoadResult, StoredRecord, Visibility } from '../services.js';

export type DataOf<T extends EntityType> = z.infer<(typeof dataSchemas)[T]>;
export type Typed<T extends EntityType> = Omit<StoredRecord, 'data'> & { entityType: T; data: DataOf<T> };
export type LoadState<T> = { status: 'loading' } | LoadResult<T>;

/** Validates stored data against the shared contract; a record that does not parse is not shown. */
function typed<T extends EntityType>(type: T, record: StoredRecord): Typed<T> | null {
  if (record.entityType !== type) return null;
  const parsed = dataSchemas[type].safeParse(record.data);
  return parsed.success ? { ...record, entityType: type, data: parsed.data as DataOf<T> } : null;
}

export function useLoad<T>(load: () => Promise<LoadResult<T>>, key: string): [LoadState<T>, () => void] {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' });
  const [generation, setGeneration] = useState(0);
  // Local writes, pulled changes and other tabs bump the revision: the view re-reads the local store.
  const { revision } = useServices();
  useEffect(() => {
    let active = true;
    load().then((result) => { if (active) setState(result); }, () => { if (active) setState({ status: 'unavailable' }); });
    return () => { active = false; };
    // `key` identifies the query; `load` is recreated on every render.
  }, [key, generation, revision]);
  return [state, useCallback(() => setGeneration((value) => value + 1), [])];
}

export function useRecords<T extends EntityType>(entityType: T, parentId?: string): [LoadState<Typed<T>[]>, () => void] {
  const { listRecords } = useServices();
  return useLoad(async () => {
    const result = await listRecords(parentId ? { entityType, parentId } : { entityType });
    if (result.status !== 'ok') return result;
    return { status: 'ok', value: result.value.map((record) => typed(entityType, record)).filter((record) => record !== null) };
  }, `${entityType}:${parentId ?? ''}`);
}

export function useRecord<T extends EntityType>(entityType: T, id: string): [LoadState<Typed<T>>, () => void] {
  const { getRecord } = useServices();
  return useLoad(async () => {
    const result = await getRecord(entityType, id);
    if (result.status !== 'ok') return result;
    const record = typed(entityType, result.value);
    return record ? { status: 'ok', value: record } : { status: 'unavailable' };
  }, `${entityType}:${id}`);
}

/** Records to render in a list: nothing while loading, [] when the store is not available yet. */
export function loaded<T>(state: LoadState<T[]>): T[] | null {
  if (state.status === 'loading') return null;
  return state.status === 'ok' ? state.value : [];
}

export function LoadingNotice() {
  return <p className="loading" role="status">Wczytywanie…</p>;
}

/** Screen shown instead of a record that cannot be displayed. Same text for "deleted" and "no access". */
export function MissingRecord({ state, title, back }: { state: LoadState<unknown>; title: string; back: { to: string; label: string } }) {
  return (
    <>
      <ScreenHeader title={title} back={back} />
      <Section>
        {state.status === 'loading' ? <LoadingNotice />
          : state.status === 'not_found'
            ? <EmptyState icon="alert" title="Nie znaleziono wpisu" text="Wpis mógł zostać usunięty albo nie jest dostępny dla Twojego konta." action={{ label: `Wróć: ${back.label}`, to: back.to }} />
            : <EmptyState icon="alert" title="Nie można wyświetlić wpisu" text="Zaloguj się, aby wpisy zapisane na tym urządzeniu były dostępne." action={{ label: `Wróć: ${back.label}`, to: back.to }} />}
      </Section>
    </>
  );
}

/** Renders children with the record once it is loaded; otherwise the matching state screen. */
export function RecordGate<T extends EntityType>({ entityType, id, title, back, children }: {
  entityType: T; id: string; title: string; back: { to: string; label: string }; children: (record: Typed<T>, reload: () => void) => ReactNode;
}) {
  const [state, reload] = useRecord(entityType, id);
  if (state.status !== 'ok') return <MissingRecord state={state} title={title} back={back} />;
  return <>{children(state.value, reload)}</>;
}

// ---------- Create vs edit ----------

export type FormMode<T extends EntityType> = { kind: 'create' } | { kind: 'edit'; record: Typed<T> };

/** Fields whose value differs (deep compare of JSON values). */
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(after).filter(([key, value]) => JSON.stringify(before[key]) !== JSON.stringify(value)));
}

/** Create: new record with the chosen visibility. Edit: only the changed fields; nothing changed → nothing written. */
export function persist<T extends EntityType>(services: AppServices, entityType: T, mode: FormMode<T>, data: Record<string, unknown>, visibility?: Visibility): Promise<ActionResult> {
  if (mode.kind === 'create') return services.saveRecord(visibility ? { entityType, visibility, data } : { entityType, data });
  const patch = changedFields(mode.record.data, data);
  if (Object.keys(patch).length === 0) return Promise.resolve({ ok: true });
  return services.updateRecord({ entityType, id: mode.record.id, baseVersion: mode.record.version, patch });
}

/** Visibility of an existing record: shown as text, cannot be changed (MVP rule). */
export function FixedPrivacy({ value, inherited }: { value: Visibility; inherited?: string }) {
  return (
    <div className="fixed-privacy">
      <p className="field__label">Kto widzi?</p>
      <p><PrivacyTag value={value} /></p>
      <p className="field__hint">{inherited ? `Widoczność jak ${inherited}. ` : ''}Widoczności nie można zmienić po zapisaniu.</p>
    </div>
  );
}

// ---------- Detail parts ----------

export function EditLink({ to, label = 'Edytuj' }: { to: string; label?: string }) {
  return <Link to={to} className="button button--plain">{label}</Link>;
}

export function DetailFields({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="details">
      {rows.map((row) => <div key={row.label} className="details__row"><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
    </dl>
  );
}

/** Delete with explicit confirmation; the record goes to the trash. Failure is reported, never hidden. */
export function DeleteRecord({ entityType, record, what, doneTo }: { entityType: EntityType; record: StoredRecord; what: string; doneTo: string }) {
  const { deleteRecord } = useServices();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setFailure(null);
    try {
      const result = await deleteRecord({ entityType, id: record.id, baseVersion: record.version });
      if (result.ok) { navigate(doneTo); return; }
      setFailure(failureMessage(result));
    } catch { setFailure('Nie usunięto. Spróbuj ponownie.'); } finally { setBusy(false); }
  };
  return (
    <div className="delete">
      {failure && <Notice tone="danger" role="alert">{failure}</Notice>}
      {confirming ? (
        <div className="delete__confirm" role="group" aria-label={`Potwierdź usunięcie: ${what}`}>
          <p>Usunąć {what}? Trafi do kosza, skąd można przywrócić przez 30 dni.</p>
          <div className="actions">
            <Button variant="destructive" onClick={run} disabled={busy} aria-busy={busy || undefined}>Usuń</Button>
            <Button variant="plain" onClick={() => { setConfirming(false); setFailure(null); }}>Anuluj</Button>
          </div>
        </div>
      ) : <Button variant="destructive" className="button button--destructive button--block" onClick={() => setConfirming(true)}>Usuń {what}</Button>}
    </div>
  );
}
