import { useState } from 'react';
import { defaultVisibility } from '@razem/contracts';
import type { EntityType } from '@razem/contracts';
import { AddButton, Button, EmptyState, Notice, List, ListRow, PrivacyPicker, PrivacyTag, ScreenHeader, Section, SelectField, TextArea, TextField } from '../ui/components.js';
import { FormScreen, useFormValues } from '../ui/form.js';
import type { Errors } from '../ui/form.js';
import { pathFor, useParam } from '../router.js';
import { failureMessage, useServices } from '../services.js';
import type { TrashItem, Visibility } from '../services.js';
import { contractData, maxText, requiredText } from './validation.js';
import { formatDayMonth } from '../dates.js';
import { DeleteRecord, DetailFields, EditLink, FixedPrivacy, LoadingNotice, RecordGate, loaded, persist, useLoad, useRecords } from './records.js';
import type { FormMode, Typed } from './records.js';

export const notePaths = { detail: '/notatki/:noteId', edit: '/notatki/:noteId/edycja' } as const;
export const datePaths = { detail: '/wazne-daty/:dateId', edit: '/wazne-daty/:dateId/edycja' } as const;

export function MoreScreen() {
  return (
    <>
      <ScreenHeader title="Więcej" />
      <Section>
        <List label="Więcej">
          <ListRow to="/notatki" icon="note" iconTone="yellow" title="Notatki" />
          <ListRow to="/wazne-daty" icon="heart" iconTone="pink" title="Ważne daty" />
          <ListRow to="/kosz" icon="trash" iconTone="gray" title="Kosz" />
          <ListRow to="/ustawienia" icon="settings" iconTone="gray" title="Ustawienia" />
        </List>
      </Section>
    </>
  );
}

// ---------- Notes ----------

/** Local search: case- and diacritics-insensitive match in title and body. */
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLocaleLowerCase('pl');
export function noteMatches(note: Typed<'note'>, query: string): boolean {
  const needle = fold(query.trim());
  return !needle || fold(`${note.data.title}\n${note.data.body}`).includes(needle);
}
const firstLine = (text: string) => text.split('\n').find((line) => line.trim())?.trim().slice(0, 120);

export function NotesScreen() {
  const [query, setQuery] = useState('');
  const [state] = useRecords('note');
  const all = loaded(state);
  const notes = all?.filter((note) => noteMatches(note, query));
  return (
    <>
      <ScreenHeader title="Notatki" back={{ to: '/wiecej', label: 'Więcej' }} action={<AddButton label="Nowa notatka" to="/notatki/nowa" />} />
      <div className="search" role="search">
        <TextField label="Szukaj w notatkach" type="search" value={query} onValue={setQuery} placeholder="Szukaj" enterKeyHint="search" autoComplete="off" />
      </div>
      <Section>
        {!notes ? <LoadingNotice />
          : notes.length > 0
            ? <List label="Notatki">
              {notes.map((note) => (
                <ListRow key={note.id} to={pathFor(notePaths.detail, { noteId: note.id })} icon="note" iconTone="yellow" title={note.data.title} detail={firstLine(note.data.body)} value={<PrivacyTag value={note.visibility} />} />
              ))}
            </List>
            : query.trim()
              ? <EmptyState icon="search" title="Brak wyników" text={`Żadna notatka nie zawiera „${query.trim()}”. Wyszukiwanie działa na tym urządzeniu.`} />
              : <EmptyState icon="note" title="Brak notatek" text="Nowa notatka jest domyślnie widoczna tylko dla Ciebie, np. „Pomysły na prezenty”." action={{ label: 'Napisz notatkę', to: '/notatki/nowa' }} />}
      </Section>
    </>
  );
}

type NoteForm = { title: string; body: string; visibility: Visibility };
function NoteFormScreen({ mode }: { mode: FormMode<'note'> }) {
  const services = useServices();
  const editing = mode.kind === 'edit' ? mode.record : null;
  const { values, set } = useFormValues<NoteForm>({ title: editing?.data.title ?? '', body: editing?.data.body ?? '', visibility: editing?.visibility ?? defaultVisibility('note') });
  const [errors, setErrors] = useState<Errors<NoteForm>>({});
  const back = editing ? pathFor(notePaths.detail, { noteId: editing.id }) : '/notatki';
  return (
    <FormScreen title={editing ? 'Edytuj notatkę' : 'Nowa notatka'} cancelTo={back} doneTo={back} errors={errors} setErrors={setErrors}
      validate={() => ({ title: requiredText(values.title, 'tytuł notatki'), body: maxText(values.body, 50_000) })}
      onSubmit={() => persist(services, 'note', mode, contractData('note', { title: values.title.trim(), body: values.body }), values.visibility)}>
      <div className="group">{editing ? <FixedPrivacy value={editing.visibility} /> : <PrivacyPicker subject="tę notatkę" value={values.visibility} onChange={set('visibility')} />}</div>
      <div className="group">
        <TextField label="Tytuł" value={values.title} onValue={set('title')} error={errors.title} placeholder="np. Pomysły na prezenty" autoComplete="off" maxLength={400} />
        <TextArea label="Treść" value={values.body} onValue={set('body')} error={errors.body} rows={8} />
      </div>
    </FormScreen>
  );
}

export const NewNoteScreen = () => <NoteFormScreen mode={{ kind: 'create' }} />;
export function EditNoteScreen() {
  const noteId = useParam('noteId');
  return (
    <RecordGate entityType="note" id={noteId} title="Edytuj notatkę" back={{ to: pathFor(notePaths.detail, { noteId }), label: 'Notatka' }}>
      {(record) => <NoteFormScreen mode={{ kind: 'edit', record }} />}
    </RecordGate>
  );
}

export function NoteDetailScreen() {
  const noteId = useParam('noteId');
  const back = { to: '/notatki', label: 'Notatki' };
  return (
    <RecordGate entityType="note" id={noteId} title="Notatka" back={back}>
      {(note) => (
        <>
          <ScreenHeader title={note.data.title} back={back} action={<EditLink to={pathFor(notePaths.edit, { noteId })} />} />
          <p className="screen-meta"><PrivacyTag value={note.visibility} /></p>
          <Section>
            <div className="group note-body">{note.data.body ? <p className="prewrap">{note.data.body}</p> : <p className="field__hint">Notatka nie ma treści.</p>}</div>
          </Section>
          <Section><DeleteRecord entityType="note" record={note} what="notatkę" doneTo="/notatki" /></Section>
        </>
      )}
    </RecordGate>
  );
}

// ---------- Important dates ----------

const kindLabel = { birthday: 'Urodziny', anniversary: 'Rocznica', other: 'Inne' } as const;
export function ImportantDatesScreen() {
  const [state] = useRecords('important_date');
  const dates = loaded(state)?.sort((a, b) => a.data.month - b.data.month || a.data.day - b.data.day);
  return (
    <>
      <ScreenHeader title="Ważne daty" back={{ to: '/wiecej', label: 'Więcej' }} action={<AddButton label="Nowa ważna data" to="/wazne-daty/nowa" />} />
      <Section>
        {!dates ? <LoadingNotice />
          : dates.length === 0
            ? <EmptyState icon="heart" title="Brak ważnych dat" text="Urodziny, rocznice i inne daty powtarzają się co roku, np. „Rocznica ślubu, 14 czerwca”."
              action={{ label: 'Dodaj datę', to: '/wazne-daty/nowa' }} />
            : <List label="Ważne daty">
              {dates.map((date) => (
                <ListRow key={date.id} to={pathFor(datePaths.detail, { dateId: date.id })} icon="heart" iconTone="pink" title={date.data.name}
                  detail={`${formatDayMonth(date.data.month, date.data.day)} · ${kindLabel[date.data.kind]}`} value={<PrivacyTag value={date.visibility} />} />
              ))}
            </List>}
      </Section>
    </>
  );
}

type Kind = 'birthday' | 'anniversary' | 'other';
type DateForm = { name: string; kind: Kind; month: string; day: string; startYear: string; visibility: Visibility };
const MONTHS = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
const MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function ImportantDateFormScreen({ mode }: { mode: FormMode<'important_date'> }) {
  const services = useServices();
  const editing = mode.kind === 'edit' ? mode.record : null;
  const back = editing ? pathFor(datePaths.detail, { dateId: editing.id }) : '/wazne-daty';
  const { values, set } = useFormValues<DateForm>(editing
    ? { name: editing.data.name, kind: editing.data.kind, month: String(editing.data.month), day: String(editing.data.day), startYear: editing.data.startYear ? String(editing.data.startYear) : '', visibility: editing.visibility }
    : { name: '', kind: 'birthday', month: '1', day: '1', startYear: '', visibility: defaultVisibility('important_date') });
  const [errors, setErrors] = useState<Errors<DateForm>>({});
  const validate = (): Errors<DateForm> => {
    const year = values.startYear.trim();
    return {
      name: requiredText(values.name, 'nazwę'),
      day: Number(values.day) > (MAX_DAYS[Number(values.month) - 1] ?? 0) ? `${MONTHS[Number(values.month) - 1]} nie ma ${values.day}. dnia.` : undefined,
      startYear: year && !/^\d{1,4}$/.test(year) ? 'Podaj rok cyframi, np. 2015.' : year && Number(year) < 1 ? 'Rok musi być dodatni.' : undefined,
    };
  };
  return (
    <FormScreen title={editing ? 'Edytuj ważną datę' : 'Nowa ważna data'} cancelTo={back} doneTo={back} errors={errors} setErrors={setErrors} validate={validate}
      onSubmit={() => persist(services, 'important_date', mode, contractData('important_date', {
        name: values.name.trim(), kind: values.kind, month: Number(values.month), day: Number(values.day), startYear: values.startYear.trim() ? Number(values.startYear) : null,
      }), values.visibility)}>
      <div className="group">
        <TextField label="Nazwa" value={values.name} onValue={set('name')} error={errors.name} placeholder="np. Urodziny Mamy" autoComplete="off" maxLength={400} />
        <SelectField<Kind> label="Rodzaj" value={values.kind} onValue={set('kind')} options={[{ value: 'birthday', label: 'Urodziny' }, { value: 'anniversary', label: 'Rocznica' }, { value: 'other', label: 'Inne' }]} />
      </div>
      <div className="group">
        <div className="field-row">
          <SelectField label="Dzień" value={values.day} onValue={set('day')} error={errors.day} options={Array.from({ length: 31 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))} />
          <SelectField label="Miesiąc" value={values.month} onValue={set('month')} options={MONTHS.map((name, index) => ({ value: String(index + 1), label: name }))} />
        </div>
        <TextField label="Rok początkowy (opcjonalnie)" value={values.startYear} onValue={set('startYear')} error={errors.startYear} inputMode="numeric" autoComplete="off" maxLength={4}
          hint="Pozwala pokazać, która to rocznica lub ile lat kończy osoba. 29 lutego w zwykłym roku przypada 28 lutego." />
      </div>
      <div className="group">{editing ? <FixedPrivacy value={editing.visibility} /> : <PrivacyPicker subject="tę datę" value={values.visibility} onChange={set('visibility')} />}</div>
    </FormScreen>
  );
}

export const NewImportantDateScreen = () => <ImportantDateFormScreen mode={{ kind: 'create' }} />;
export function EditImportantDateScreen() {
  const dateId = useParam('dateId');
  return (
    <RecordGate entityType="important_date" id={dateId} title="Edytuj ważną datę" back={{ to: pathFor(datePaths.detail, { dateId }), label: 'Ważna data' }}>
      {(record) => <ImportantDateFormScreen mode={{ kind: 'edit', record }} />}
    </RecordGate>
  );
}

export function ImportantDateDetailScreen() {
  const dateId = useParam('dateId');
  const back = { to: '/wazne-daty', label: 'Ważne daty' };
  return (
    <RecordGate entityType="important_date" id={dateId} title="Ważna data" back={back}>
      {(date) => (
        <>
          <ScreenHeader title={date.data.name} back={back} action={<EditLink to={pathFor(datePaths.edit, { dateId })} />} />
          <Section>
            <DetailFields rows={[
              { label: 'Data', value: `${formatDayMonth(date.data.month, date.data.day)}, co roku` },
              { label: 'Rodzaj', value: kindLabel[date.data.kind] },
              ...(date.data.startYear ? [{ label: 'Rok początkowy', value: String(date.data.startYear) }] : []),
              { label: 'Widoczność', value: <PrivacyTag value={date.visibility} /> },
            ]} />
          </Section>
          <Section><DeleteRecord entityType="important_date" record={date} what="ważną datę" doneTo="/wazne-daty" /></Section>
        </>
      )}
    </RecordGate>
  );
}

// ---------- Trash ----------

export function TrashScreen() {
  const services = useServices();
  const [state, reload] = useLoad(() => services.listTrash ? services.listTrash() : Promise.resolve({ status: 'unavailable' as const }), 'trash');
  const [failure, setFailure] = useState<string | null>(null);
  const items = state.status === 'ok' ? state.value : state.status === 'loading' ? null : [];
  const restore = async (item: TrashItem) => {
    const result = await services.restoreRecord?.(item.entityType, item.id);
    setFailure(result && !result.ok ? failureMessage(result) : null);
    reload();
  };
  return (
    <>
      <ScreenHeader title="Kosz" back={{ to: '/wiecej', label: 'Więcej' }} />
      {failure && <Notice tone="danger" role="alert">{failure}</Notice>}
      <Section footer="Usunięte wpisy są przechowywane przez 30 dni, potem znikają na stałe.">
        {items === null ? <LoadingNotice />
          : items.length === 0 ? <EmptyState icon="trash" title="Kosz jest pusty" text="Usunięte zakupy, zadania, wydarzenia i notatki można stąd przywrócić." />
            : (
              <List label="Usunięte wpisy">
                {items.map((item) => (
                  <li key={item.id} className="row row--stack">
                    <span className="row__text"><span className="row__title">{item.title}</span>
                      <span className="row__detail">{trashLabel[item.entityType] ?? 'Wpis'} · <PrivacyTag value={item.visibility} /></span></span>
                    <Button variant="tinted" onClick={() => void restore(item)}>Przywróć</Button>
                  </li>
                ))}
              </List>
            )}
      </Section>
    </>
  );
}

const trashLabel: Partial<Record<EntityType, string>> = { shopping_list: 'Lista zakupów', task: 'Zadanie', calendar_event: 'Wydarzenie', important_date: 'Ważna data', note: 'Notatka' };
