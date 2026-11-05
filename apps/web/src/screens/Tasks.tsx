import { useState } from 'react';
import { taskDataSchema, nextTaskOccurrence, taskOccurrence, taskOverdue, rescheduleTask, defaultVisibility, localTimeToInstant } from '@razem/contracts';
import { AddButton, Button, DateField, EmptyState, List, ListRow, Notice, PrivacyPicker, PrivacyTag, ScreenHeader, Section, Segmented, SelectField, TextArea, TextField } from '../ui/components.js';
import { FormScreen, useFormValues } from '../ui/form.js';
import type { Errors } from '../ui/form.js';
import { pathFor, useParam } from '../router.js';
import { failureMessage, useServices, useTimezone } from '../services.js';
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
  return taskOverdue(task.data, now.toISOString());
}
export function projected(task: Task, occurrences: Typed<'task_occurrence'>[], done = false): Task | null {
  if (!task.data.recurrence) return task;
  const completed = occurrences.filter((o) => o.data.taskId === task.id && o.data.completedAt);
  if (done) {
    const last = completed.sort((a, b) => b.data.occurrenceKey.localeCompare(a.data.occurrenceKey))[0];
    if (last) return { ...task, data: { ...task.data, ...(taskOccurrence(task.data, last.data.occurrenceKey) ?? { dueDate: last.data.occurrenceKey, dueAt: null }), completedAt: last.data.completedAt } };
    return task.data.recurrence.until && !nextTaskOccurrence(task.data, new Set())
      ? { ...task, data: { ...task.data, dueDate: null, dueAt: null } } : null;
  }
  const next = nextTaskOccurrence(task.data, new Set(completed.map((o) => o.data.occurrenceKey)));
  return next ? { ...task, data: { ...task.data, ...next, completedAt: null } } : null;
}
const matches: Record<Filter, (task: Task) => boolean> = {
  mine: (task) => !task.data.completedAt && assignedToMe(task),
  shared: (task) => !task.data.completedAt && task.visibility === 'shared',
  overdue: (task) => isOverdue(task),
  done: (task) => task.data.completedAt !== null || !!task.data.recurrence?.until,
};

export function TasksScreen() {
  const [filter, setFilter] = useState<Filter>('mine');
  const [state] = useRecords('task');
  const [occurrences] = useRecords('task_occurrence');
  const rows = loaded(occurrences);
  const tasks = rows && loaded(state)?.map((task) => projected(task, rows, filter === 'done')).filter((task) => task !== null).filter(matches[filter])
    .sort((a, b) => (a.data.dueAt ?? a.data.dueDate ?? '9999').localeCompare(b.data.dueAt ?? b.data.dueDate ?? '9999') || a.id.localeCompare(b.id));
  return (
    <>
      <ScreenHeader title="Zadania" action={<AddButton label="Nowe zadanie" to="/zadania/nowe" />} />
      <Segmented label="Filtr zadań" value={filter} options={filters} onChange={setFilter} />
      <Section>
        {!tasks ? <LoadingNotice />
          : tasks.length === 0 ? <EmptyState icon="tasks" {...emptyCopy[filter]} action={{ label: 'Dodaj zadanie', to: '/zadania/nowe' }} />
            : <List label="Zadania">
              {tasks.map((task) => (
                <ListRow key={task.id} to={pathFor(taskPaths.detail, { taskId: task.id })} icon={filter === 'done' ? 'check' : 'tasks'} iconTone={isOverdue(task) ? 'red' : 'blue'}
                  title={task.data.title} detail={[dueLabel(task), filter === 'done' && !task.data.completedAt ? 'Harmonogram zakończony' : null, assigneeLabel(task)].filter(Boolean).join(' · ')} value={<PrivacyTag value={task.visibility} />} />
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
  const { updateRecord, setTaskOccurrence } = useServices();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<string | null>(null);
  const [occurrences, reloadOccurrences] = useRecords('task_occurrence', task.id);
  const rows = loaded(occurrences);
  const current = rows ? projected(task, rows) : null;
  const shown = current ?? task;
  const next = task.data.recurrence && rows ? nextTaskOccurrence(task.data, new Set(rows.filter((o) => o.data.completedAt).map((o) => o.data.occurrenceKey))) : null;
  const done = task.data.completedAt !== null;
  const completeOccurrence = async (key: string, completed: boolean) => {
    if (busy || !setTaskOccurrence) return;
    setBusy(true); setFailure(null);
    try {
      const result = await setTaskOccurrence(task.id, key, completed);
      if (result.ok) { setUndo(completed ? key : null); reloadOccurrences(); } else setFailure(failureMessage(result));
    } catch { setFailure('Nie zapisano. Spróbuj ponownie.'); } finally { setBusy(false); }
  };
  const toggle = async () => {
    if (busy) return;
    setBusy(true); setFailure(null);
    try {
      const result = await updateRecord({ entityType: 'task', id: task.id, baseVersion: task.version, patch: { completedAt: done ? null : new Date().toISOString() } });
      if (result.ok) reload(); else setFailure(failureMessage(result));
    } catch { setFailure('Nie zapisano. Spróbuj ponownie.'); } finally { setBusy(false); }
  };
  return (
    <>
      <ScreenHeader title={task.data.title} back={{ to: '/zadania', label: 'Zadania' }}
        action={<EditLink to={pathFor(taskPaths.edit, { taskId: task.id })} />} />
      <Section>
        <DetailFields rows={[
          { label: 'Widoczność', value: <PrivacyTag value={task.visibility} /> },
          { label: 'Kto to zrobi?', value: assigneeLabel(task) },
          { label: 'Termin', value: task.data.recurrence && rows && !current ? 'Harmonogram zakończony' : dueLabel(shown) ?? 'Bez terminu' },
          ...(task.data.recurrence ? [{ label: 'Powtarzaj', value: repeatLabel[task.data.recurrence.frequency] }] : []),
          { label: 'Stan', value: task.data.recurrence && rows && !current ? 'Harmonogram zakończony' : done ? 'Ukończone' : isOverdue(shown) ? 'Zaległe' : 'Do zrobienia' },
          ...(task.data.description ? [{ label: 'Opis', value: <span className="prewrap">{task.data.description}</span> }] : []),
        ]} />
      </Section>
      <Section>
        {failure && <Notice tone="danger" role="alert">{failure}</Notice>}
        {task.data.recurrence
          ? <>
            {!rows ? <LoadingNotice /> : next && <Button variant="filled" disabled={busy || !setTaskOccurrence} onClick={() => completeOccurrence(next.occurrenceKey, true)}>Ukończ termin {next.occurrenceKey}</Button>}
            {undo && <Notice>Termin {undo} ukończony. <Button variant="plain" disabled={busy} onClick={() => completeOccurrence(undo, false)}>Cofnij</Button></Notice>}
          </>
          : <Button variant={done ? 'tinted' : 'filled'} className={`button button--${done ? 'tinted' : 'filled'} button--block`} disabled={busy} onClick={toggle}>{done ? 'Przywróć do zrobienia' : 'Oznacz jako ukończone'}</Button>}
      </Section>
      {!!rows?.some((o) => o.data.completedAt) && <Section title="Ukończone terminy">
        {rows.filter((o) => o.data.completedAt).sort((a, b) => b.data.occurrenceKey.localeCompare(a.data.occurrenceKey)).map((o) =>
          <p key={o.id}>{formatIsoDate(o.data.occurrenceKey)} <Button variant="plain" disabled={busy} onClick={() => completeOccurrence(o.data.occurrenceKey, false)}>Przywróć termin {o.data.occurrenceKey}</Button></p>)}
      </Section>}
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
    dueDate: local?.date ?? data.dueDate ?? '', dueTime: data.recurrence?.time ?? local?.time ?? '', repeat: data.recurrence?.until ? 'none' : data.recurrence?.frequency ?? 'none',
  };
}

function TaskFormScreen({ mode }: { mode: FormMode<'task'> }) {
  const services = useServices();
  const defaultTimezone = useTimezone();
  const editing = mode.kind === 'edit' ? mode.record : null;
  const { values, set, setValues } = useFormValues<TaskForm>(initialTask(mode));
  const [errors, setErrors] = useState<Errors<TaskForm>>({});
  const back = editing ? pathFor(taskPaths.detail, { taskId: editing.id }) : '/zadania';
  const changeVisibility = (visibility: Visibility) =>
    setValues((current) => ({ ...current, visibility, assignee: visibility === 'private' ? 'me' : current.assignee }));

  const initial = initialTask(mode);
  const scheduleChanged = values.dueDate !== initial.dueDate || values.dueTime !== initial.dueTime || values.repeat !== initial.repeat;
  const validate = (): Errors<TaskForm> => ({
    title: requiredText(values.title, 'tytuł zadania'),
    description: maxText(values.description, 50_000),
    dueDate: editing?.data.recurrence && scheduleChanged && values.dueDate <= isoDate(todayIn(editing.data.timezone)) ? 'Wybierz przyszły dzień zmiany harmonogramu.' : values.dueTime && !values.dueDate ? 'Godzina wymaga dnia.' : values.repeat !== 'none' && !values.dueDate ? 'Powtarzanie wymaga terminu.' : undefined,
    assignee: values.visibility === 'private' && values.assignee !== 'me' ? 'Prywatne zadanie można przypisać tylko sobie.' : undefined,
  });
  const submit = () => {
    const timezone = editing?.data.timezone ?? defaultTimezone;
    const dueAt = values.dueDate && values.dueTime ? localTimeToInstant(values.dueDate, values.dueTime, timezone) : null;
    const startDate = values.dueDate || null;
    const previous = editing?.data.recurrence;
    // Keep an existing interval (e.g. every 2 weeks) when only other fields change.
    const interval = previous && previous.frequency === values.repeat ? previous.interval : 1;
    const data = contractData('task', {
      title: values.title.trim(), description: values.description, assignee: assigneeForRecord(values.assignee, editing?.mine ?? true),
      dueDate: dueAt ? null : startDate, dueAt, timezone, completedAt: values.repeat !== 'none' ? null : editing?.data.completedAt ?? null,
      recurrence: editing?.data.recurrence ?? (values.repeat === 'none' || !startDate ? null : { frequency: values.repeat, interval, startDate, time: values.dueTime || null }),
    });
    const scheduled = editing?.data.recurrence
      ? scheduleChanged ? rescheduleTask({ ...taskDataSchema.parse(data), dueDate: editing.data.dueDate, dueAt: editing.data.dueAt, timezone: editing.data.timezone }, values.dueDate, values.repeat === 'none' ? null : values.repeat, values.dueTime || null, timezone)
        : { ...data, dueDate: editing.data.dueDate, dueAt: editing.data.dueAt }
      : data;
    return persist(services, 'task', mode, scheduled, values.visibility);
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
          <DateField label={editing?.data.recurrence ? "Nowy harmonogram od" : "Termin – dzień"} hint={editing?.data.recurrence ? "Przy zmianie wybierz przyszły dzień. Wcześniejsze terminy i ukończenia pozostaną." : undefined} value={values.dueDate} onValue={set('dueDate')} error={errors.dueDate} />
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
