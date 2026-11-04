import { useState } from 'react';
import { defaultVisibility } from '@razem/contracts';
import { AddButton, EmptyState, List, ListRow, PrivacyPicker, ScreenHeader, Section, SelectField, TextArea, TextField } from '../ui/components.js';
import { FormScreen, useFormValues } from '../ui/form.js';
import type { Errors } from '../ui/form.js';
import { useServices } from '../services.js';
import type { Visibility } from '../services.js';
import { contractData, maxText, requiredText } from './validation.js';

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

export function NotesScreen() {
  const [query, setQuery] = useState('');
  return (
    <>
      <ScreenHeader title="Notatki" back={{ to: '/wiecej', label: 'Więcej' }} action={<AddButton label="Nowa notatka" to="/notatki/nowa" />} />
      <div className="search" role="search">
        <TextField label="Szukaj w notatkach" type="search" value={query} onValue={setQuery} placeholder="Szukaj" enterKeyHint="search" autoComplete="off" />
      </div>
      <Section>
        {query.trim()
          ? <EmptyState icon="search" title="Brak wyników" text={`Żadna notatka nie zawiera „${query.trim()}”. Wyszukiwanie działa na tym urządzeniu.`} />
          : <EmptyState icon="note" title="Brak notatek" text="Nowa notatka jest domyślnie widoczna tylko dla Ciebie, np. „Pomysły na prezenty”." action={{ label: 'Napisz notatkę', to: '/notatki/nowa' }} />}
      </Section>
    </>
  );
}

type NoteForm = { title: string; body: string; visibility: Visibility };
export function NewNoteScreen() {
  const { saveRecord } = useServices();
  const { values, set } = useFormValues<NoteForm>({ title: '', body: '', visibility: defaultVisibility('note') });
  const [errors, setErrors] = useState<Errors<NoteForm>>({});
  return (
    <FormScreen title="Nowa notatka" cancelTo="/notatki" doneTo="/notatki" errors={errors} setErrors={setErrors}
      validate={() => ({ title: requiredText(values.title, 'tytuł notatki'), body: maxText(values.body, 50_000) })}
      onSubmit={() => saveRecord({ entityType: 'note', visibility: values.visibility, data: contractData('note', { title: values.title.trim(), body: values.body }) })}>
      <div className="group"><PrivacyPicker subject="tę notatkę" value={values.visibility} onChange={set('visibility')} /></div>
      <div className="group">
        <TextField label="Tytuł" value={values.title} onValue={set('title')} error={errors.title} placeholder="np. Pomysły na prezenty" autoComplete="off" maxLength={400} />
        <TextArea label="Treść" value={values.body} onValue={set('body')} error={errors.body} rows={8} />
      </div>
    </FormScreen>
  );
}

// ---------- Important dates ----------

export function ImportantDatesScreen() {
  return (
    <>
      <ScreenHeader title="Ważne daty" back={{ to: '/wiecej', label: 'Więcej' }} action={<AddButton label="Nowa ważna data" to="/wazne-daty/nowa" />} />
      <Section>
        <EmptyState icon="heart" title="Brak ważnych dat" text="Urodziny, rocznice i inne daty powtarzają się co roku, np. „Rocznica ślubu, 14 czerwca”."
          action={{ label: 'Dodaj datę', to: '/wazne-daty/nowa' }} />
      </Section>
    </>
  );
}

type Kind = 'birthday' | 'anniversary' | 'other';
type DateForm = { name: string; kind: Kind; month: string; day: string; startYear: string; visibility: Visibility };
const MONTHS = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
const MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function NewImportantDateScreen() {
  const { saveRecord } = useServices();
  const { values, set } = useFormValues<DateForm>({ name: '', kind: 'birthday', month: '1', day: '1', startYear: '', visibility: defaultVisibility('important_date') });
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
    <FormScreen title="Nowa ważna data" cancelTo="/wazne-daty" doneTo="/wazne-daty" errors={errors} setErrors={setErrors} validate={validate}
      onSubmit={() => saveRecord({ entityType: 'important_date', visibility: values.visibility, data: contractData('important_date', {
        name: values.name.trim(), kind: values.kind, month: Number(values.month), day: Number(values.day), startYear: values.startYear.trim() ? Number(values.startYear) : null,
      }) })}>
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
      <div className="group"><PrivacyPicker subject="tę datę" value={values.visibility} onChange={set('visibility')} /></div>
    </FormScreen>
  );
}

// ---------- Trash ----------

export function TrashScreen() {
  return (
    <>
      <ScreenHeader title="Kosz" back={{ to: '/wiecej', label: 'Więcej' }} />
      <Section footer="Usunięte wpisy są przechowywane przez 30 dni, potem znikają na stałe.">
        <EmptyState icon="trash" title="Kosz jest pusty" text="Usunięte zakupy, zadania, wydarzenia i notatki można stąd przywrócić." />
      </Section>
    </>
  );
}
