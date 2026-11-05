import { useEffect, useState } from 'react';
import { localDate, nextTaskOccurrence } from '@razem/contracts';
import { Button, EmptyState, List, ListRow, Menu, Notice, PrivacyTag, ScreenHeader, Section, SyncBadge } from '../ui/components.js';
import { addDays, formatInstant, formatIsoDate, formatLongDate, isoDate, todayIn } from '../dates.js';
import { Link } from '../router.js';
import { failureMessage, useServices, useTimezone } from '../services.js';
import { LoadingNotice, useRecords } from './records.js';
import type { Typed } from './records.js';
import { assigneeLabel, projected } from './Tasks.js';
import { calendarEntries } from './Calendar.js';

export const addMenuItems = [
  { label: 'Zadanie', icon: 'tasks', to: '/zadania/nowe' },
  { label: 'Wydarzenie', icon: 'calendar', to: '/kalendarz/nowe' },
  { label: 'Lista zakupów', icon: 'shopping', to: '/zakupy/nowa' },
  { label: 'Notatka', icon: 'note', to: '/notatki/nowa' },
  { label: 'Ważna data', icon: 'heart', to: '/wazne-daty/nowa' },
] as const;

/** Receives only validated, ACL-filtered local records. */
export function todayTasks(tasks: Typed<'task'>[], occurrences: Typed<'task_occurrence'>[], now: Date) {
  return tasks.map((task) => projected(task, occurrences)).filter((task) => {
    if (!task || task.data.completedAt) return false;
    const day = task.data.dueDate ?? (task.data.dueAt ? localDate(task.data.dueAt, task.data.timezone) : null);
    // A task retains its own deadline zone after a household zone change.
    return day !== null && day <= isoDate(todayIn(task.data.timezone, now));
  }).filter((task) => task !== null).sort((a, b) =>
    (a.data.dueAt ?? a.data.dueDate ?? '').localeCompare(b.data.dueAt ?? b.data.dueDate ?? '') || a.id.localeCompare(b.id));
}

export function TodayScreen() {
  const timezone = useTimezone();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(timer); }, []);
  const today = isoDate(todayIn(timezone, now));
  const date = formatLongDate(todayIn(timezone, now));
  const services = useServices();
  const [tasks, reloadTasks] = useRecords('task');
  const [occurrences, reloadOccurrences] = useRecords('task_occurrence');
  const [events] = useRecords('calendar_event');
  const [dates] = useRecords('important_date');
  const [lists] = useRecords('shopping_list');
  const [items] = useRecords('shopping_item');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{ task: Typed<'task'>; key?: string } | null>(null);
  const complete = async (task: Typed<'task'>, completed: boolean, key?: string) => {
    if (busy) return;
    setBusy(true); setMessage(null);
    try {
      const result = task.data.recurrence
        ? await services.setTaskOccurrence?.(task.id, key!, completed) ?? { ok: false as const, reason: 'not_implemented' as const }
        : await services.updateRecord({ entityType: 'task', id: task.id, baseVersion: task.version, patch: { completedAt: completed ? new Date().toISOString() : null } });
      if (!result.ok) { setMessage(failureMessage(result)); return; }
      setUndo(completed ? { task, ...(key ? { key } : {}) } : null);
      reloadTasks(); reloadOccurrences();
    } catch { setMessage('Nie zapisano. Spróbuj ponownie.'); } finally { setBusy(false); }
  };
  const taskRows = tasks.status === 'ok' && occurrences.status === 'ok' ? todayTasks(tasks.value, occurrences.value, now) : [];
  const calendar = events.status === 'ok' && dates.status === 'ok'
    ? calendarEntries(events.value, dates.value, today, undefined, timezone).filter((entry) => entry.end > today && entry.start < addDays(today, 7)) : [];
  const shopping = lists.status === 'ok' && items.status === 'ok' ? lists.value.map((list) => {
    const children = items.value.filter((item) => item.data.listId === list.id);
    return { list, open: children.filter((item) => !item.data.checked).length, empty: children.length === 0 };
  }).filter((row) => row.empty || row.open > 0).sort((a, b) => a.list.data.name.localeCompare(b.list.data.name, 'pl')) : [];
  const unavailable = (states: { status: string }[]) => states.some((state) => state.status === 'unavailable');
  const loading = (states: { status: string }[]) => states.some((state) => state.status === 'loading');
  const problem = <Notice tone="warning">Nie można wczytać danych z tego urządzenia. Zaloguj się lub spróbuj ponownie.</Notice>;
  return <>
    <ScreenHeader title="Dzisiaj" subtitle={date.charAt(0).toUpperCase() + date.slice(1)} action={<Menu label="Dodaj" items={[...addMenuItems]} />} />
    <SyncBadge />
    <Section title="Zadania na dziś i zaległe">
      {message && <Notice tone="danger" role="alert">{message}</Notice>}
      {undo && <Notice tone="success" role="status">Ukończono: {undo.task.data.title}. <Button variant="plain" disabled={busy} onClick={() => void complete(undo.task, false, undo.key)}>Cofnij</Button></Notice>}
      {unavailable([tasks, occurrences]) ? problem : loading([tasks, occurrences]) ? <LoadingNotice /> : taskRows.length ?
        <ul className="list" aria-label="Zadania na dziś i zaległe">{taskRows.slice(0, 5).map((task) => {
          const key = task.data.recurrence && occurrences.status === 'ok' ? nextTaskOccurrence(task.data, new Set(occurrences.value.filter((o) => o.data.taskId === task.id && o.data.completedAt).map((o) => o.data.occurrenceKey)))?.occurrenceKey : undefined;
          return <li key={task.id} className="row item-row">
            <label className="check"><input type="checkbox" checked={false} disabled={busy} onChange={() => void complete(task, true, key)} /><span className="visually-hidden">Ukończ: {task.data.title}</span></label>
            <Link className="item-row__link" to={`/zadania/${task.id}`}><span className="row__text"><span className="row__title">{task.data.title}</span><span className="row__detail">{task.data.dueAt ? formatInstant(task.data.dueAt, task.data.timezone) : formatIsoDate(task.data.dueDate!)} · {assigneeLabel(task)} · <PrivacyTag value={task.visibility} /></span></span></Link>
          </li>;
        })}</ul> : <EmptyState icon="tasks" title="Nic na dziś" text="Zadania z dzisiejszym lub minionym terminem pojawią się tutaj." action={{ label: 'Dodaj zadanie', to: '/zadania/nowe' }} />}
      <Link className="button button--plain" to="/zadania">Wszystkie zadania</Link>
    </Section>
    <Section title="Najbliższe 7 dni">
      {unavailable([events, dates]) ? problem : loading([events, dates]) ? <LoadingNotice /> : calendar.length ?
        <List label="Wydarzenia i ważne daty">{calendar.slice(0, 5).map((entry) => <ListRow key={entry.key} to={entry.to} icon="calendar" iconTone="red" title={entry.title} detail={entry.when} value={<PrivacyTag value={entry.visibility} />} />)}</List>
        : <EmptyState icon="calendar" title="Brak wydarzeń" text="Dzisiaj i w kolejnych sześciu dniach nie ma wydarzeń ani ważnych dat." action={{ label: 'Dodaj wydarzenie', to: '/kalendarz/nowe' }} />}
      <Link className="button button--plain" to="/kalendarz">Cały kalendarz</Link>
    </Section>
    <Section title="Zakupy">
      {unavailable([lists, items]) ? problem : loading([lists, items]) ? <LoadingNotice /> : shopping.length ?
        <List label="Aktywne zakupy">{shopping.slice(0, 5).map(({ list, open, empty }) => <ListRow key={list.id} to={`/zakupy/${list.id}`} icon="shopping" iconTone="green" title={list.data.name} detail={empty ? 'Dopisz pierwszy produkt' : `Do kupienia: ${open}`} value={<PrivacyTag value={list.visibility} />} />)}</List>
        : <EmptyState icon="shopping" title="Zakupy gotowe" text="Nie ma aktywnych list. Utwórz własną listę lub dopisz produkty do istniejącej." action={{ label: 'Utwórz listę', to: '/zakupy/nowa' }} />}
      <Link className="button button--plain" to="/zakupy">Wszystkie listy zakupów</Link>
    </Section>
  </>;
}
