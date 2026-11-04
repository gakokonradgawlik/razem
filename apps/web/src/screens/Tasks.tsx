import { useState } from 'react';
import { DEFAULT_TIMEZONE, defaultVisibility, localTimeToInstant } from '@razem/contracts';
import { AddButton, DateField, EmptyState, PrivacyPicker, ScreenHeader, Section, Segmented, SelectField, TextArea, TextField } from '../ui/components.js';
import { FormScreen, useFormValues } from '../ui/form.js';
import type { Errors } from '../ui/form.js';
import { useServices } from '../services.js';
import type { Visibility } from '../services.js';
import { contractData, maxText, requiredText } from './validation.js';

type Filter = 'mine' | 'shared' | 'overdue' | 'done';
const filters: { value: Filter; label: string }[] = [
  { value: 'mine', label: 'Moje' }, { value: 'shared', label: 'Wspólne' }, { value: 'overdue', label: 'Zaległe' }, { value: 'done', label: 'Ukończone' },
];
const emptyCopy: Record<Filter, { title: string; text: string }> = {
  mine: { title: 'Brak Twoich zadań', text: 'Tu są zadania przypisane Tobie lub Wam obojgu, np. „Zapłacić za prąd”.' },
  shared: { title: 'Brak wspólnych zadań', text: 'Wspólne zadania widzicie oboje, nawet gdy są przypisane jednej osobie.' },
  overdue: { title: 'Nic zaległego', text: 'Zadania z minionym terminem pojawią się tutaj.' },
  done: { title: 'Brak ukończonych zadań', text: 'Ukończone zadania można przywrócić do listy.' },
};

export function TasksScreen() {
  const [filter, setFilter] = useState<Filter>('mine');
  return (
    <>
      <ScreenHeader title="Zadania" action={<AddButton label="Nowe zadanie" to="/zadania/nowe" />} />
      <Segmented label="Filtr zadań" value={filter} options={filters} onChange={setFilter} />
      <Section>
        <EmptyState icon="tasks" {...emptyCopy[filter]} action={{ label: 'Dodaj zadanie', to: '/zadania/nowe' }} />
      </Section>
    </>
  );
}

type Assignee = 'self' | 'partner' | 'both';
type Repeat = 'none' | 'daily' | 'weekly' | 'monthly';
type TaskForm = { title: string; description: string; visibility: Visibility; assignee: Assignee; dueDate: string; dueTime: string; repeat: Repeat };

export function NewTaskScreen() {
  const { saveRecord } = useServices();
  const { values, set, setValues } = useFormValues<TaskForm>({
    title: '', description: '', visibility: defaultVisibility('task'), assignee: 'both', dueDate: '', dueTime: '', repeat: 'none',
  });
  const [errors, setErrors] = useState<Errors<TaskForm>>({});
  const changeVisibility = (visibility: Visibility) =>
    setValues((current) => ({ ...current, visibility, assignee: visibility === 'private' ? 'self' : current.assignee }));

  const validate = (): Errors<TaskForm> => ({
    title: requiredText(values.title, 'tytuł zadania'),
    description: maxText(values.description, 50_000),
    dueDate: values.dueTime && !values.dueDate ? 'Godzina wymaga dnia.' : values.repeat !== 'none' && !values.dueDate ? 'Powtarzanie wymaga terminu.' : undefined,
    assignee: values.visibility === 'private' && values.assignee !== 'self' ? 'Prywatne zadanie można przypisać tylko sobie.' : undefined,
  });
  const submit = () => {
    const dueAt = values.dueDate && values.dueTime ? localTimeToInstant(values.dueDate, values.dueTime, DEFAULT_TIMEZONE) : null;
    const startDate = values.dueDate || null;
    const data = contractData('task', {
      title: values.title.trim(), description: values.description, assignee: values.assignee,
      dueDate: dueAt ? null : startDate, dueAt, timezone: DEFAULT_TIMEZONE, completedAt: null,
      recurrence: values.repeat === 'none' || !startDate ? null : { frequency: values.repeat, interval: 1, startDate },
    });
    return saveRecord({ entityType: 'task', visibility: values.visibility, data });
  };

  return (
    <FormScreen title="Nowe zadanie" cancelTo="/zadania" doneTo="/zadania" errors={errors} setErrors={setErrors} validate={validate} onSubmit={submit}>
      <div className="group">
        <TextField label="Tytuł" value={values.title} onValue={set('title')} error={errors.title} placeholder="np. Odebrać paczkę" autoComplete="off" maxLength={400} />
        <TextArea label="Opis (opcjonalnie)" value={values.description} onValue={set('description')} error={errors.description} />
      </div>
      <div className="group">
        <PrivacyPicker subject="to zadanie" value={values.visibility} onChange={changeVisibility} />
        <SelectField<Assignee> label="Kto to zrobi?" value={values.assignee} onValue={set('assignee')} error={errors.assignee}
          hint={values.visibility === 'private' ? 'Prywatne zadanie możesz przypisać tylko sobie.' : undefined}
          options={[{ value: 'self', label: 'Ja' }, { value: 'partner', label: 'Druga osoba', disabled: values.visibility === 'private' }, { value: 'both', label: 'Oboje', disabled: values.visibility === 'private' }]} />
      </div>
      <div className="group">
        <div className="field-row">
          <DateField label="Termin – dzień" value={values.dueDate} onValue={set('dueDate')} error={errors.dueDate} />
          <DateField label="Godzina (opcjonalnie)" type="time" value={values.dueTime} onValue={set('dueTime')} />
        </div>
        <SelectField<Repeat> label="Powtarzaj" value={values.repeat} onValue={set('repeat')}
          hint="Np. co miesiąc 31. dnia: w krótszych miesiącach ostatniego dnia."
          options={[{ value: 'none', label: 'Nie powtarzaj' }, { value: 'daily', label: 'Codziennie' }, { value: 'weekly', label: 'Co tydzień' }, { value: 'monthly', label: 'Co miesiąc' }]} />
      </div>
    </FormScreen>
  );
}
