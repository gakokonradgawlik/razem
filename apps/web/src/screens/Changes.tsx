// "Zmiany do sprawdzenia": version conflicts and changes the server rejected.
// A conflict shows my version and the one saved on the server side by side; the user
// keeps one, or merges field by field (text can be joined by hand). Nothing is lost:
// a deleted-vs-edited record keeps my text until I decide.
import { useState } from 'react';
import { IMMUTABLE_PARENT_FIELDS } from '@razem/contracts';
import type { EntityType } from '@razem/contracts';
import { navigate, pathFor, useParam } from '../router.js';
import { Button, EmptyState, List, ListRow, Notice, ScreenHeader, Section, TextArea } from '../ui/components.js';
import { failureMessage, useServices } from '../services.js';
import type { AttentionItem, ConflictView } from '../services.js';
import { LoadingNotice, useLoad } from './records.js';

export const changePaths = { list: '/zmiany', conflict: '/zmiany/:conflictId' };

const typeLabel: Record<EntityType, string> = {
  shopping_list: 'Lista zakupów', shopping_item: 'Pozycja zakupów', task: 'Zadanie', task_occurrence: 'Wykonanie zadania',
  calendar_event: 'Wydarzenie', important_date: 'Ważna data', note: 'Notatka', reminder: 'Przypomnienie',
};
const fieldLabel: Record<string, string> = {
  name: 'Nazwa', title: 'Tytuł', body: 'Treść', description: 'Opis', quantity: 'Ilość', note: 'Uwaga', checked: 'Kupione',
  sortKey: 'Kolejność', assignee: 'Kto', dueDate: 'Termin (dzień)', dueAt: 'Termin (godzina)', timezone: 'Strefa czasowa',
  completedAt: 'Wykonano', recurrence: 'Powtarzanie', allDay: 'Cały dzień', startDate: 'Początek', endDate: 'Koniec',
  startAt: 'Początek', endAt: 'Koniec', month: 'Miesiąc', day: 'Dzień', startYear: 'Rok początkowy', kind: 'Rodzaj',
  enabled: 'Włączone', minutesBefore: 'Minut przed', localTime: 'Godzina',
};
const TEXT_FIELDS = new Set(['name', 'title', 'body', 'description', 'note', 'quantity']);
const HIDDEN_FIELDS: ReadonlySet<string> = new Set(IMMUTABLE_PARENT_FIELDS);
const errorLabel: Record<string, string> = {
  validation_error: 'Serwer nie przyjął tej zmiany (niepoprawne dane).',
  not_found: 'Wpis nie istnieje już na serwerze albo nie jest dostępny dla Twojego konta.',
  mutation_id_reused: 'Serwer odrzucił powtórzoną zmianę o innej treści.',
  upgrade_required: 'Ta zmiana wymaga nowszej wersji aplikacji.',
  payload_too_large: 'Zmiana jest zbyt duża, aby ją wysłać.',
};

export function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Tak' : 'Nie';
  if (typeof value === 'object') {
    const rule = value as { frequency?: string; interval?: number };
    if (rule.frequency) return `co ${rule.interval ?? 1} ${rule.frequency === 'daily' ? 'dni' : rule.frequency === 'weekly' ? 'tyg.' : 'mies.'}`;
    return JSON.stringify(value);
  }
  return String(value);
}

export function ChangesScreen() {
  const services = useServices();
  const [state, reload] = useLoad(async () => ({ status: 'ok' as const, value: await (services.listAttention?.() ?? Promise.resolve([] as AttentionItem[])) }), 'attention');
  const [message, setMessage] = useState<string | null>(null);
  const items = state.status === 'ok' ? state.value : null;
  const discard = async (item: AttentionItem) => {
    const result = await services.discardRejected?.(item.id);
    setMessage(result && !result.ok ? failureMessage(result) : null);
    reload();
  };
  return (
    <>
      <ScreenHeader title="Zmiany do sprawdzenia" back={{ to: '/ustawienia', label: 'Ustawienia' }} />
      {message && <Notice tone="danger" role="alert">{message}</Notice>}
      <Section footer="Do czasu decyzji Twoja wersja jest zachowana na tym urządzeniu. Możesz ją też wyeksportować w Ustawieniach.">
        {items === null ? <LoadingNotice />
          : items.length === 0 ? <EmptyState icon="check" title="Wszystko w porządku" text="Nie ma zmian wymagających Twojej decyzji." />
            : (
              <List label="Zmiany do sprawdzenia">
                {items.map((item) => item.kind === 'conflict'
                  ? <ListRow key={item.id} to={pathFor(changePaths.conflict, { conflictId: item.id })} icon="alert" iconTone="red" title={item.title} detail={`${typeLabel[item.entityType]} · zmieniono też na innym urządzeniu`} />
                  : (
                    <li key={item.id} className="row row--stack">
                      <span className="row__text"><span className="row__title">{item.title}</span><span className="row__detail">{typeLabel[item.entityType]} · {errorLabel[item.error] ?? 'Serwer nie przyjął tej zmiany.'}</span></span>
                      <Button variant="destructive" onClick={() => void discard(item)}>Odrzuć tę zmianę</Button>
                    </li>
                  ))}
              </List>
            )}
      </Section>
    </>
  );
}

type Pick = 'mine' | 'server' | 'joined';

export function ConflictScreen() {
  const conflictId = useParam('conflictId');
  const services = useServices();
  const [state] = useLoad(async () => (services.getConflict ? services.getConflict(conflictId) : { status: 'unavailable' as const }), `conflict:${conflictId}`);
  const back = { to: changePaths.list, label: 'Zmiany' };
  if (state.status === 'loading') return <><ScreenHeader title="Konflikt" back={back} /><LoadingNotice /></>;
  if (state.status !== 'ok') {
    return (
      <>
        <ScreenHeader title="Konflikt" back={back} />
        <Section><EmptyState icon="check" title="Ten konflikt jest już rozwiązany" text="Wróć do listy zmian do sprawdzenia." action={{ label: 'Zmiany do sprawdzenia', to: changePaths.list }} /></Section>
      </>
    );
  }
  return <ConflictResolver conflict={state.value} />;
}

function ConflictResolver({ conflict }: { conflict: ConflictView }) {
  const services = useServices();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = conflict.mine ?? {}, server = conflict.server ?? {};
  const fields = [...new Set([...Object.keys(mine), ...Object.keys(server)])].filter((key) => !HIDDEN_FIELDS.has(key));
  const differing = fields.filter((key) => JSON.stringify(mine[key]) !== JSON.stringify(server[key]));
  const [picks, setPicks] = useState<Record<string, Pick>>(() => Object.fromEntries(differing.map((key) => [key, 'mine'])));
  const [joined, setJoined] = useState<Record<string, string>>(() => Object.fromEntries(differing.filter((key) => TEXT_FIELDS.has(key))
    .map((key) => [key, [mine[key], server[key]].filter((part) => typeof part === 'string' && part !== '').join('\n')])));
  const canMerge = !conflict.mineDeleted && conflict.serverState !== 'gone' && conflict.mine !== null && differing.length > 0;

  const run = async (resolution: Parameters<NonNullable<typeof services.resolveConflict>>[1]) => {
    if (!services.resolveConflict) return;
    setBusy(true); setFailure(null);
    try {
      const result = await services.resolveConflict(conflict.id, resolution);
      if (result.ok) { navigate(changePaths.list); return; }
      setFailure(failureMessage(result));
    } catch { setFailure('Nie zapisano. Spróbuj ponownie.'); } finally { setBusy(false); }
  };
  // Hidden fields (parent references, keys) are not editable, but the merged record still needs them.
  const merged = () => ({
    ...Object.fromEntries([...HIDDEN_FIELDS].filter((key) => key in server || key in mine).map((key) => [key, key in server ? server[key] : mine[key]])),
    ...Object.fromEntries(fields.map((key) => {
      const pick = picks[key];
      if (pick === 'server') return [key, server[key]];
      if (pick === 'joined') return [key, joined[key] ?? ''];
      return [key, key in mine ? mine[key] : server[key]];
    })),
  });

  const situation = conflict.serverState === 'gone'
    ? 'Na innym urządzeniu wpis został trwale usunięty. Twoją wersję możesz zapisać jako nowy wpis.'
    : conflict.mineDeleted ? 'Usunięto go na tym urządzeniu, a w międzyczasie zmieniono na innym.'
      : conflict.serverState === 'trash' ? 'Na innym urządzeniu wpis przeniesiono do kosza, a tutaj go zmieniono. Twoja treść jest zachowana.'
        : 'Ten sam wpis zmieniono na dwóch urządzeniach. Wybierz wersję albo połącz zmiany.';

  return (
    <>
      <ScreenHeader title="Konflikt" subtitle={typeLabel[conflict.entityType]} back={{ to: changePaths.list, label: 'Zmiany' }} />
      <Notice tone="warning" title="Wymaga Twojej decyzji">{situation}</Notice>
      {failure && <Notice tone="danger" role="alert">{failure}</Notice>}
      <div className="compare">
        <Section title="Moja wersja (to urządzenie)">
          {conflict.mineDeleted ? <p className="compare__empty">Usunięte na tym urządzeniu</p> : <Fields data={mine} keys={fields} highlight={differing} />}
        </Section>
        <Section title={conflict.serverState === 'gone' ? 'Na serwerze' : conflict.serverState === 'trash' ? 'Na serwerze (w koszu)' : 'Zapisana na serwerze'}>
          {conflict.serverState === 'gone' ? <p className="compare__empty">Trwale usunięte</p> : <Fields data={server} keys={fields} highlight={differing} />}
        </Section>
      </div>
      {canMerge && (
        <Section title="Połącz" footer="Dla każdej różnicy wybierz wersję. Tekst możesz połączyć i poprawić ręcznie.">
          {differing.map((key) => (
            <fieldset key={key} className="merge-field">
              <legend className="field__label">{fieldLabel[key] ?? key}</legend>
              <div className="merge-field__choices">
                {(['mine', 'server', ...(TEXT_FIELDS.has(key) ? ['joined'] as const : [])] as Pick[]).map((pick) => (
                  <label key={pick} className="merge-field__choice">
                    <input type="radio" name={`pick-${key}`} checked={picks[key] === pick} onChange={() => setPicks((current) => ({ ...current, [key]: pick }))} />
                    <span>{pick === 'mine' ? `Moja: ${show(mine[key])}` : pick === 'server' ? `Z serwera: ${show(server[key])}` : 'Połącz ręcznie'}</span>
                  </label>
                ))}
              </div>
              {picks[key] === 'joined' && <TextArea label={`${fieldLabel[key] ?? key} – połączona treść`} value={joined[key] ?? ''} onValue={(value) => setJoined((current) => ({ ...current, [key]: value }))} rows={5} />}
            </fieldset>
          ))}
          <Button variant="filled" className="button button--filled button--block" disabled={busy} onClick={() => void run({ choice: 'merge', data: merged() })}>Zapisz połączoną wersję</Button>
        </Section>
      )}
      <Section>
        <div className="actions actions--stack">
          <Button variant="tinted" disabled={busy} onClick={() => void run({ choice: 'mine' })}>
            {conflict.serverState === 'gone' ? (conflict.mineDeleted ? 'Zostaw usunięte' : 'Zapisz moją wersję jako nowy wpis')
              : conflict.mineDeleted ? 'Usuń mimo to' : conflict.serverState === 'trash' ? 'Przywróć z moją wersją' : 'Zachowaj moją wersję'}
          </Button>
          <Button variant="plain" disabled={busy} onClick={() => void run({ choice: 'server' })}>
            {conflict.serverState === 'live' ? 'Zachowaj wersję z serwera' : 'Odrzuć moją wersję'}
          </Button>
        </div>
      </Section>
    </>
  );
}

function Fields({ data, keys, highlight }: { data: Record<string, unknown>; keys: string[]; highlight: string[] }) {
  return (
    <dl className="details">
      {keys.map((key) => (
        <div key={key} className={`details__row${highlight.includes(key) ? ' details__row--changed' : ''}`}>
          <dt>{fieldLabel[key] ?? key}{highlight.includes(key) ? ' (różni się)' : ''}</dt><dd className="details__text">{show(data[key])}</dd>
        </div>
      ))}
    </dl>
  );
}
