import { useState } from 'react';
import { DEFAULT_TIMEZONE, defaultVisibility, localTimeToInstant, dateSchema, timezoneSchema, eventDays, importantOccurrence, nextImportantOccurrence } from '@razem/contracts';
import { AddButton, DateField, EmptyState, Notice, List, ListRow, PrivacyPicker, PrivacyTag, ScreenHeader, Section, Segmented, TextArea, TextField, Toggle } from '../ui/components.js';
import { FormScreen, useFormValues } from '../ui/form.js';
import type { Errors } from '../ui/form.js';
import { Icon } from '../ui/icons.js';
import { pathFor, useParam } from '../router.js';
import type { Visibility } from '../services.js';
import { WEEKDAYS, addDays, addMonths, formatFullDate, formatInstant, formatIsoDate, formatMonth, instantToLocal, isoDate, monthGrid, todayIn } from '../dates.js';
import { contractData, maxText, requiredText } from './validation.js';
import { DeleteRecord, DetailFields, EditLink, FixedPrivacy, LoadingNotice, RecordGate, loaded, useRecords } from './records.js';
import type { FormMode, Typed } from './records.js';
import { ReminderDetail, ReminderFields, ReminderGate, useCalendarPersist, useReminder, yearsLabel } from './calendar-shared.js';
import type { ReminderConfig } from './calendar-shared.js';

export const eventPaths = { detail: '/kalendarz/:eventId', edit: '/kalendarz/:eventId/edycja' } as const;
type CalendarEvent = Typed<'calendar_event'>;

/** "sobota, 28 marca 2026 – niedziela, 29 marca 2026" (all-day end is exclusive in the contract). */
export function eventWhen(event: CalendarEvent): string {
  const { data } = event;
  if (data.allDay && data.startDate && data.endDate) {
    const last = addDays(data.endDate, -1);
    return last === data.startDate ? `${formatIsoDate(data.startDate)}, cały dzień` : `${formatIsoDate(data.startDate)} – ${formatIsoDate(last)}`;
  }
  return data.startAt && data.endAt ? `${formatInstant(data.startAt, data.timezone)} – ${formatInstant(data.endAt, data.timezone)}` : '';
}
type CalendarEntry = { key: string; title: string; start: string; end: string; when: string; to: string; visibility: Visibility; instant: string };
function entries(events: CalendarEvent[], dates: Typed<'important_date'>[], from: string, year?: number): CalendarEntry[] {
  const result: CalendarEntry[] = events.map((event) => ({ key: event.id, title: event.data.title, ...eventDays(event.data),
    when: eventWhen(event), to: pathFor(eventPaths.detail, { eventId: event.id }), visibility: event.visibility, instant: event.data.startAt ?? '' }));
  for (const date of dates) {
    const occurrence = year === undefined ? nextImportantOccurrence(date.data, from) : importantOccurrence(date.data, year);
    if (!occurrence) continue;
    result.push({ key: date.id, title: date.data.name, start: occurrence.date, end: addDays(occurrence.date, 1),
      when: `${formatIsoDate(occurrence.date)}, co roku${yearsLabel(occurrence.years)}`, to: `/wazne-daty/${date.id}`, visibility: date.visibility, instant: '' });
  }
  return result.sort((a,b) => a.start.localeCompare(b.start) || a.instant.localeCompare(b.instant) || a.key.localeCompare(b.key));
}
function CalendarList({ items, label }: { items: CalendarEntry[]; label: string }) {
  return items.length ? <List label={label}>{items.map((entry) => <ListRow key={entry.key} to={entry.to} icon="calendar" iconTone="red" title={entry.title} detail={entry.when} value={<PrivacyTag value={entry.visibility} />} />)}</List>
    : <p className="section__footer">Brak wydarzeń i ważnych dat w wybranym zakresie.</p>;
}
type View = 'agenda' | 'month';
export function CalendarScreen() {
  const [view, setView] = useState<View>('agenda');
  const [state] = useRecords('calendar_event');
  const [datesState] = useRecords('important_date');
  const events = loaded(state), dates = loaded(datesState);
  const today = isoDate(todayIn());
  const [from, setFrom] = useState(today);
  const upcoming = events && dates ? entries(events, dates, from).filter((entry) => entry.end > from) : null;
  return <>
    <ScreenHeader title="Kalendarz" action={<AddButton label="Nowe wydarzenie" to="/kalendarz/nowe" />} />
    <Segmented label="Widok kalendarza" value={view} onChange={setView} options={[{ value: 'agenda', label: 'Agenda' }, { value: 'month', label: 'Miesiąc' }]} />
    {state.status === 'unavailable' || datesState.status === 'unavailable' ? <Notice tone="danger">Nie można wczytać kalendarza z tego urządzenia.</Notice>
      : !upcoming ? <LoadingNotice /> : view === 'agenda' ? <Section>
        <DateField label="Agenda od dnia" value={from} onValue={(value) => { if (value) setFrom(value); }} />
        {upcoming.length ? <CalendarList items={upcoming} label="Nadchodzące wydarzenia" />
          : <EmptyState icon="calendar" title="Brak nadchodzących wydarzeń" text="Dodaj wydarzenie albo ważną datę." action={{ label: 'Dodaj wydarzenie', to: '/kalendarz/nowe' }} />}
      </Section> : <MonthView events={events!} dates={dates!} />}
  </>;
}
function MonthView({ events, dates }: { events: CalendarEvent[]; dates: Typed<'important_date'>[] }) {
  const today = todayIn();
  const [shown, setShown] = useState({ year: today.year, month: today.month });
  const [selected, setSelected] = useState<string | null>(null);
  const todayKey = isoDate(today), title = formatMonth(shown.year, shown.month);
  const first = isoDate({ ...shown, day: 1 });
  const next = isoDate({ ...addMonths(shown.year, shown.month, 1), day: 1 });
  const all = entries(events, dates, first, shown.year);
  const items = all.filter((entry) => selected ? entry.start <= selected && entry.end > selected : entry.start < next && entry.end > first);
  const shift = (delta: number) => { setShown(addMonths(shown.year, shown.month, delta)); setSelected(null); };
  return <Section>
    <div className="month">
      <div className="month__bar">
        <button type="button" className="icon-button" aria-label="Poprzedni miesiąc" onClick={() => shift(-1)}><Icon name="chevronLeft" /></button>
        <h2 className="month__title" aria-live="polite">{title}</h2>
        <button type="button" className="icon-button" aria-label="Następny miesiąc" onClick={() => shift(1)}><Icon name="chevronRight" /></button>
      </div>
      <table className="month__grid" aria-label={title}>
        <thead><tr>{WEEKDAYS.map((weekday) => <th key={weekday.short} scope="col" abbr={weekday.long}>{weekday.short}</th>)}</tr></thead>
        <tbody>{monthGrid(shown.year, shown.month).map((week, index) => <tr key={index}>{week.map((day, column) => {
          if (!day) return <td key={column} />;
          const key = isoDate(day), count = all.filter((entry) => entry.start <= key && entry.end > key).length;
          return <td key={column}><button type="button" className={`month__day ${key === todayKey ? 'month__day--today' : ''}`}
            aria-label={`${formatFullDate(day)}${key === todayKey ? ', dzisiaj' : ''}, wpisy: ${count}`}
            aria-pressed={selected === key} aria-current={key === todayKey ? 'date' : undefined}
            onClick={() => setSelected(selected === key ? null : key)}>{day.day}{count > 0 && <span className="month__dot" aria-hidden="true" />}</button></td>;
        })}</tr>)}</tbody>
      </table>
    </div>
    <h2 className="section__title">{selected ? formatIsoDate(selected) : 'W tym miesiącu'}</h2>
    <CalendarList items={items} label={selected ? 'Wpisy wybranego dnia' : 'Wpisy miesiąca'} />
  </Section>;
}

type EventForm = { title: string; description: string; visibility: Visibility; allDay: boolean; startDate: string; startTime: string; endDate: string; endTime: string; timezone: string };

function initialEvent(mode: FormMode<'calendar_event'>): EventForm {
  if (mode.kind === 'create') {
    const today = isoDate(todayIn());
    return { title: '', description: '', visibility: defaultVisibility('calendar_event'), allDay: false, startDate: today, startTime: '18:00', endDate: today, endTime: '19:00', timezone: DEFAULT_TIMEZONE };
  }
  const { data, visibility } = mode.record;
  const start = data.startAt ? instantToLocal(data.startAt, data.timezone) : null;
  const end = data.endAt ? instantToLocal(data.endAt, data.timezone) : null;
  return {
    timezone: data.timezone, title: data.title, description: data.description, visibility, allDay: data.allDay,
    startDate: start?.date ?? data.startDate ?? '', startTime: start?.time ?? '18:00',
    endDate: end?.date ?? (data.endDate ? addDays(data.endDate, -1) : ''), endTime: end?.time ?? '19:00',
  };
}

function EventFormScreen({ mode, initialReminder }: { mode: FormMode<'calendar_event'>; initialReminder?: ReminderConfig | undefined }) {
  const save = useCalendarPersist('calendar_event', mode);
  const [reminder, setReminder] = useReminder(initialReminder, mode.kind === 'create' || !mode.record.data.allDay);
  const editing = mode.kind === 'edit' ? mode.record : null;

  const back = editing ? pathFor(eventPaths.detail, { eventId: editing.id }) : '/kalendarz';
  const { values, set } = useFormValues<EventForm>(initialEvent(mode));
  const [errors, setErrors] = useState<Errors<EventForm>>({});
  const timezone = values.timezone;
  const validate = (): Errors<EventForm> => {
    const result: Errors<EventForm> = { title: requiredText(values.title, 'nazwę wydarzenia'), description: maxText(values.description, 50_000) };
    if (!dateSchema.safeParse(values.startDate).success) result.startDate = 'Wybierz poprawny dzień rozpoczęcia.';
    if (!dateSchema.safeParse(values.endDate).success || values.endDate === '9999-12-31' && values.allDay) result.endDate = 'Wybierz poprawny dzień zakończenia.';
    if (!values.allDay) {
      if (!values.startTime) result.startTime = 'Wybierz godzinę rozpoczęcia.';
      if (!values.endTime) result.endTime = 'Wybierz godzinę zakończenia.';
    }
    if (!result.startDate && !result.endDate && !result.startTime && !result.endTime) {
      const ends = values.allDay ? values.endDate >= values.startDate : `${values.endDate}T${values.endTime}` > `${values.startDate}T${values.startTime}`;
      if (!ends) result.endDate = 'Koniec musi być po początku.';
    }
    if (!timezoneSchema.safeParse(timezone).success) result.timezone = 'Podaj poprawną strefę, np. Europe/Warsaw.';
    if (!Object.values(result).some(Boolean) && !values.allDay) {
      try {
        if (Date.parse(localTimeToInstant(values.endDate, values.endTime, timezone)) <= Date.parse(localTimeToInstant(values.startDate, values.startTime, timezone))) result.endDate = 'Koniec po uwzględnieniu zmiany czasu musi być po początku.';
      } catch { result.startDate = 'Sprawdź datę i godzinę.'; }
    }
    return result;
  };
  const submit = () => {
    // All-day end is exclusive in the contract: the day after the last chosen day.
    const data = values.allDay
      ? { startDate: values.startDate, endDate: addDays(values.endDate, 1), startAt: null, endAt: null }
      : { startDate: null, endDate: null, startAt: localTimeToInstant(values.startDate, values.startTime, timezone), endAt: localTimeToInstant(values.endDate, values.endTime, timezone) };
    return save(contractData('calendar_event', {
      title: values.title.trim(), description: values.description, allDay: values.allDay, timezone, ...data,
    }), values.visibility, { ...reminder, localTime: values.allDay ? reminder.localTime ?? '09:00' : null });
  };
  return (
    <FormScreen title={editing ? 'Edytuj wydarzenie' : 'Nowe wydarzenie'} cancelTo={back} doneTo={back} errors={errors} setErrors={setErrors} validate={validate} onSubmit={submit}>
      <div className="group">
        <TextField label="Nazwa" value={values.title} onValue={set('title')} error={errors.title} placeholder="np. Urodziny Kasi" autoComplete="off" maxLength={400} />
        <TextArea label="Opis (opcjonalnie)" value={values.description} onValue={set('description')} error={errors.description} />
      </div>
      <div className="group">
        <Toggle label="Cały dzień" checked={values.allDay} onChange={(allDay) => { set('allDay')(allDay); setReminder({ ...reminder, minutesBefore: allDay ? 0 : 30, localTime: allDay ? '09:00' : null }); }} />
        <div className="field-row">
          <DateField label="Początek – dzień" value={values.startDate} onValue={set('startDate')} error={errors.startDate} />
          {!values.allDay && <DateField label="Godzina" type="time" value={values.startTime} onValue={set('startTime')} error={errors.startTime} />}
        </div>
        <div className="field-row">
          <DateField label="Koniec – dzień" value={values.endDate} onValue={set('endDate')} error={errors.endDate} />
          {!values.allDay && <DateField label="Godzina" type="time" value={values.endTime} onValue={set('endTime')} error={errors.endTime} />}
        </div>
        <TextField label="Strefa czasowa" value={values.timezone} onValue={set('timezone')} error={errors.timezone} hint="Np. Europe/Warsaw. Godziny są zapisywane w tej strefie; daty całodniowe zachowują dzień." />
        <p className="field__hint">Ostatni dzień całodniowego zakresu jest wliczony. Przy zmianie czasu: nieistniejąca godzina → pierwsza poprawna minuta, powtórzona → wcześniejsze wystąpienie.</p>
      </div>
      <ReminderFields value={reminder} onChange={setReminder} timed={!values.allDay} />
      <div className="group">{editing ? <FixedPrivacy value={editing.visibility} /> : <PrivacyPicker subject="to wydarzenie" value={values.visibility} onChange={set('visibility')} />}</div>
    </FormScreen>
  );
}

export const NewEventScreen = () => <EventFormScreen mode={{ kind: 'create' }} />;
export function EditEventScreen() {
  const eventId = useParam('eventId');
  return (
    <RecordGate entityType="calendar_event" id={eventId} title="Edytuj wydarzenie" back={{ to: pathFor(eventPaths.detail, { eventId }), label: 'Wydarzenie' }}>
      {(record) => <ReminderGate id={record.id}>{(reminder) => <EventFormScreen mode={{ kind: 'edit', record }} initialReminder={reminder} />}</ReminderGate>}
    </RecordGate>
  );
}

export function EventDetailScreen() {
  const eventId = useParam('eventId');
  const back = { to: '/kalendarz', label: 'Kalendarz' };
  return (
    <RecordGate entityType="calendar_event" id={eventId} title="Wydarzenie" back={back}>
      {(event) => (
        <>
          <ScreenHeader title={event.data.title} back={back} action={<EditLink to={pathFor(eventPaths.edit, { eventId })} />} />
          <Section>
            <DetailFields rows={[
              { label: 'Kiedy', value: eventWhen(event) },
              { label: 'Strefa', value: event.data.timezone },
              { label: 'Widoczność', value: <PrivacyTag value={event.visibility} /> },
              ...(event.data.description ? [{ label: 'Opis', value: <span className="prewrap">{event.data.description}</span> }] : []),
            ]} />
          </Section>
          <ReminderDetail type="calendar_event" id={event.id} />
          <Section><DeleteRecord entityType="calendar_event" record={event} what="wydarzenie" doneTo="/kalendarz" /></Section>
        </>
      )}
    </RecordGate>
  );
}
