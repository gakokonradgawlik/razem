import { useState } from 'react';
import { DEFAULT_TIMEZONE, defaultVisibility, localTimeToInstant } from '@razem/contracts';
import { AddButton, Button, DateField, EmptyState, List, ListRow, Notice, PrivacyPicker, PrivacyTag, ScreenHeader, Section, Segmented, SelectField, TextArea, TextField } from '../ui/components.js';
import { FormScreen, useFormValues } from '../ui/form.js';
import type { Errors } from '../ui/form.js';
import { pathFor, useParam } from '../router.js';
import { failureMessage, useServices } from '../services.js';
import type { Visibility } from '../services.js';
import { contractData, maxText, requiredText } from './validation.js';
import { formatInstant, formatIsoDate, instantToLocal, isoDate, todayIn } from '../dates.js';
import { DeleteRecord, DetailFields, EditLink, FixedPrivacy, LoadingNotice, RecordGate, loaded, persist, useRecords } from './records.js';
import type { FormMode, Typed } from './records.js';

export const taskPaths = { detail: '/zadania/:taskId', edit: '/zadania/:taskId/edycja' } as const;
type Task = Typed<'task'>;

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

/** "Ja/Druga osoba" are relative to the record owner; translate them for the viewer. */
export function assigneeLabel(task: Task): string {
  return { me: 'Ja', other: 'Druga osoba', both: 'Oboje' }[assigneeForViewer(task.data.assignee, task.mine)];
}
const assignedToMe = (task: Task) => assigneeForViewer(task.data.assignee, task.mine) !== 'other';
function dueLabel(task: Task): string | undefined {
  if (task.data.dueAt) return formatInstant(task.data.dueAt);
  return task.data.dueDate ? formatIsoDate(task.data.dueDate) : undefined;
}
function isOverdue(task: Task, now = new Date()): boolean {
  if (task.data.completedAt) return false;
  if (task.data.dueAt) return new Date(task.data.dueAt) < now;
  return task.data.dueDate !== null && task.data.dueDate < isoDate(todayIn());
}
const matches: Record<Filter, (task: Task) => boolean> = {
  mine: (task) => !task.data.completedAt && assignedToMe(task),
  shared: (task) => !task.data.completedAt && task.visibility === 'shared',
  overdue: (task) => isOverdue(task),
  done: (task) => task.data.completedAt !== null,
};

export function TasksScreen() {
  const [filter, setFilter] = useState<Filter>('mine');
  const [state] = useRecords('task');
  const tasks = loaded(state)?.filter(matches[filter]);
  return (
    <>
      <ScreenHeader title="Zadania" action={<AddButton label="Nowe zadanie" to="/zadania/nowe" />} />
      <Segmented label="Filtr zadań" value={filter} options={filters} onChange={setFilter} />
      <Section>
        {!tasks ? <LoadingNotice />
          : tasks.length === 0 ? <EmptyState icon="tasks" {...emptyCopy[filter]} action={{ label: 'Dodaj zadanie', to: '/zadania/nowe' }} />
            : <List label="Zadania">
              {tasks.map((task) => (
                <ListRow key={task.id} to={pathFor(taskPaths.detail, { taskId: task.id })} icon={task.data.completedAt ? 'check' : 'tasks'} iconTone={isOverdue(task) ? 'red' : 'blue'}
                  title={task.data.title} detail={[dueLabel(task), assigneeLabel(task)].filter(Boolean).join(' · ')} value={<PrivacyTag value={task.visibility} />} />
              ))}
            </List>}
      </Section>
    </>
  );
}

const repeatLabel = { daily: 'Codziennie', weekly: 'Co tydzień', monthly: 'Co miesiąc' } as const;
export function TaskDetailScreen() {
  const taskId = useParam('taskId');
  return (
    <RecordGate entityType="task" id={taskId} title="Zadanie" back={{ to: '/zadania', label: 'Zadania' }}>
      {(task, reload) => <TaskDetail task={task} reload={reload} />}
    </RecordGate>
  );
}

function TaskDetail({ task, reload }: { task: Task; reload: () => void }) {
  const { updateRecord } = useServices();
  const [failure, setFailure] = useState<string | null>(null);
  const done = task.data.completedAt !== null;
  // Completing a one-off task is written at once; recurring tasks complete single
  // occurrences (task_occurrence), which the tasks module adds together with the store.
  const toggle = async () => {
    setFailure(null);
    const result = await updateRecord({ entityType: 'task', id: task.id, baseVersion: task.version, patch: { completedAt: done ? null : new Date().toISOString() } })
      .catch(() => ({ ok: false as const, reason: 'storage_unavailable' as const }));
    if (result.ok) reload(); else setFailure(failureMessage(result));
  };
  return (
    <>
      <ScreenHeader title={task.data.title} back={{ to: '/zadania', label: 'Zadania' }}
        action={<EditLink to={pathFor(taskPaths.edit, { taskId: task.id })} />} />
      <Section>
        <DetailFields rows={[
          { label: 'Widoczność', value: <PrivacyTag value={task.visibility} /> },
          { label: 'Kto to zrobi?', value: assigneeLabel(task) },
          { label: 'Termin', value: dueLabel(task) ?? 'Bez terminu' },
          ...(task.data.recurrence ? [{ label: 'Powtarzaj', value: repeatLabel[task.data.recurrence.frequency] }] : []),
          { label: 'Stan', value: done ? 'Ukończone' : isOverdue(task) ? 'Zaległe' : 'Do zrobienia' },
          ...(task.data.description ? [{ label: 'Opis', value: <span className="prewrap">{task.data.description}</span> }] : []),
        ]} />
      </Section>
      <Section>
        {failure && <Notice tone="danger" role="alert">{failure}</Notice>}
        {task.data.recurrence
          ? <p className="section__footer">Odhaczanie pojedynczych terminów powtarzanego zadania nie jest jeszcze dostępne w tej wersji aplikacji.</p>
          : <Button variant={done ? 'tinted' : 'filled'} className={`button button--${done ? 'tinted' : 'filled'} button--block`} onClick={toggle}>{done ? 'Przywróć do zrobienia' : 'Oznacz jako ukończone'}</Button>}
      </Section>
      <Section><DeleteRecord entityType="task" record={task} what="zadanie" doneTo="/zadania" /></Section>
    </>
  );
}

type Assignee = 'self' | 'partner' | 'both';
/** Assignee as the viewer sees it. The contract's 'self'/'partner' are relative to the record owner. */
type ViewerAssignee = 'me' | 'other' | 'both';
export function assigneeForViewer(assignee: Assignee, mine: boolean): ViewerAssignee {
  if (assignee === 'both') return 'both';
  return (assignee === 'self') === mine ? 'me' : 'other';
}
export function assigneeForRecord(value: ViewerAssignee, mine: boolean): Assignee {
  if (value === 'both') return 'both';
  return (value === 'me') === mine ? 'self' : 'partner';
}
type Repeat = 'none' | 'daily' | 'weekly' | 'monthly';
type TaskForm = { title: string; description: string; visibility: Visibility; assignee: ViewerAssignee; dueDate: string; dueTime: string; repeat: Repeat };

function initialTask(mode: FormMode<'task'>): TaskForm {
  if (mode.kind === 'create') return { title: '', description: '', visibility: defaultVisibility('task'), assignee: 'both', dueDate: '', dueTime: '', repeat: 'none' };
  const { data, visibility, mine } = mode.record;
  const local = data.dueAt ? instantToLocal(data.dueAt, data.timezone) : null;
  return {
    title: data.title, description: data.description, visibility, assignee: assigneeForViewer(data.assignee, mine),
    dueDate: local?.date ?? data.dueDate ?? '', dueTime: local?.time ?? '', repeat: data.recurrence?.frequency ?? 'none',
  };
}

function TaskFormScreen({ mode }: { mode: FormMode<'task'> }) {
  const services = useServices();
  const editing = mode.kind === 'edit' ? mode.record : null;
  const { values, set, setValues } = useFormValues<TaskForm>(initialTask(mode));
  const [errors, setErrors] = useState<Errors<TaskForm>>({});
  const back = editing ? pathFor(taskPaths.detail, { taskId: editing.id }) : '/zadania';
  const changeVisibility = (visibility: Visibility) =>
    setValues((current) => ({ ...current, visibility, assignee: visibility === 'private' ? 'me' : current.assignee }));

  const validate = (): Errors<TaskForm> => ({
    title: requiredText(values.title, 'tytuł zadania'),
    description: maxText(values.description, 50_000),
    dueDate: values.dueTime && !values.dueDate ? 'Godzina wymaga dnia.' : values.repeat !== 'none' && !values.dueDate ? 'Powtarzanie wymaga terminu.' : undefined,
    assignee: values.visibility === 'private' && values.assignee !== 'me' ? 'Prywatne zadanie można przypisać tylko sobie.' : undefined,
  });
  const submit = () => {
    const timezone = editing?.data.timezone ?? DEFAULT_TIMEZONE;
    const dueAt = values.dueDate && values.dueTime ? localTimeToInstant(values.dueDate, values.dueTime, timezone) : null;
    const startDate = values.dueDate || null;
    const previous = editing?.data.recurrence;
    // Keep an existing interval (e.g. every 2 weeks) when only other fields change.
    const interval = previous && previous.frequency === values.repeat ? previous.interval : 1;
    const data = contractData('task', {
      title: values.title.trim(), description: values.description, assignee: assigneeForRecord(values.assignee, editing?.mine ?? true),
      dueDate: dueAt ? null : startDate, dueAt, timezone, completedAt: editing?.data.completedAt ?? null,
      recurrence: values.repeat === 'none' || !startDate ? null : { frequency: values.repeat, interval, startDate },
    });
    return persist(services, 'task', mode, data, values.visibility);
  };

  return (
    <FormScreen title={editing ? 'Edytuj zadanie' : 'Nowe zadanie'} cancelTo={back} doneTo={back} errors={errors} setErrors={setErrors} validate={validate} onSubmit={submit}>
      <div className="group">
        <TextField label="Tytuł" value={values.title} onValue={set('title')} error={errors.title} placeholder="np. Odebrać paczkę" autoComplete="off" maxLength={400} />
        <TextArea label="Opis (opcjonalnie)" value={values.description} onValue={set('description')} error={errors.description} />
      </div>
      <div className="group">
        {editing ? <FixedPrivacy value={editing.visibility} /> : <PrivacyPicker subject="to zadanie" value={values.visibility} onChange={changeVisibility} />}
        <SelectField<ViewerAssignee> label="Kto to zrobi?" value={values.assignee} onValue={set('assignee')} error={errors.assignee}
          hint={values.visibility === 'private' ? 'Prywatne zadanie możesz przypisać tylko sobie.' : undefined}
          options={[{ value: 'me', label: 'Ja' }, { value: 'other', label: 'Druga osoba', disabled: values.visibility === 'private' }, { value: 'both', label: 'Oboje', disabled: values.visibility === 'private' }]} />
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

export const NewTaskScreen = () => <TaskFormScreen mode={{ kind: 'create' }} />;
export function EditTaskScreen() {
  const taskId = useParam('taskId');
  return (
    <RecordGate entityType="task" id={taskId} title="Edytuj zadanie" back={{ to: pathFor(taskPaths.detail, { taskId }), label: 'Zadanie' }}>
      {(record) => <TaskFormScreen mode={{ kind: 'edit', record }} />}
    </RecordGate>
  );
}
