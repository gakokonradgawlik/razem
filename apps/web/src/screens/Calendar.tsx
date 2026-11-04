import { useState } from 'react';
import { DEFAULT_TIMEZONE, defaultVisibility, localTimeToInstant } from '@razem/contracts';
import { AddButton, DateField, EmptyState, List, ListRow, PrivacyPicker, PrivacyTag, ScreenHeader, Section, Segmented, TextArea, TextField, Toggle } from '../ui/components.js';
import { FormScreen, useFormValues } from '../ui/form.js';
import type { Errors } from '../ui/form.js';
import { Icon } from '../ui/icons.js';
import { pathFor, useParam } from '../router.js';
import { useServices } from '../services.js';
import type { Visibility } from '../services.js';
import { WEEKDAYS, addDays, addMonths, formatFullDate, formatInstant, formatIsoDate, formatMonth, instantToLocal, isoDate, monthGrid, todayIn } from '../dates.js';
import { contractData, maxText, requiredText } from './validation.js';
import { DeleteRecord, DetailFields, EditLink, FixedPrivacy, LoadingNotice, RecordGate, loaded, persist, useRecords } from './records.js';
import type { FormMode, Typed } from './records.js';

export const eventPaths = { detail: '/kalendarz/:eventId', edit: '/kalendarz/:eventId/edycja' } as const;
type CalendarEvent = Typed<'calendar_event'>;

/** "sobota, 28 marca 2026 – niedziela, 29 marca 2026" (all-day end is exclusive in the contract). */
export function eventWhen(event: CalendarEvent): string {
  const { data } = event;
  if (data.allDay && data.startDate && data.endDate) {
    const last = addDays(data.endDate, -1);
    return last === data.startDate ? `${formatIsoDate(data.startDate)}, cały dzień` : `${formatIsoDate(data.startDate)} – ${formatIsoDate(last)}`;
  }
  return data.startAt && data.endAt ? `${formatInstant(data.startAt)} – ${formatInstant(data.endAt)}` : '';
}
/** Sort key and "ends today or later" test, both in the household zone. */
const startKey = (event: CalendarEvent) => event.data.startDate ?? (event.data.startAt ? instantToLocal(event.data.startAt, event.data.timezone).date : '');
const endKey = (event: CalendarEvent) => event.data.endDate ? addDays(event.data.endDate, -1) : event.data.endAt ? instantToLocal(event.data.endAt, event.data.timezone).date : '';

type View = 'agenda' | 'month';

export function CalendarScreen() {
  const [view, setView] = useState<View>('agenda');
  const [state] = useRecords('calendar_event');
  const today = isoDate(todayIn());
  const upcoming = loaded(state)?.filter((event) => endKey(event) >= today).sort((a, b) => startKey(a).localeCompare(startKey(b)) || (a.data.startAt ?? '').localeCompare(b.data.startAt ?? ''));
  return (
    <>
      <ScreenHeader title="Kalendarz" action={<AddButton label="Nowe wydarzenie" to="/kalendarz/nowe" />} />
      <Segmented label="Widok kalendarza" value={view} onChange={setView} options={[{ value: 'agenda', label: 'Agenda' }, { value: 'month', label: 'Miesiąc' }]} />
      {view === 'agenda'
        ? <Section>{!upcoming ? <LoadingNotice />
          : upcoming.length === 0
            ? <EmptyState icon="calendar" title="Brak nadchodzących wydarzeń" text="Dodaj np. „Wizyta u dentysty, czwartek 17:30” albo wyjazd na kilka dni." action={{ label: 'Dodaj wydarzenie', to: '/kalendarz/nowe' }} />
            : <List label="Nadchodzące wydarzenia">
              {upcoming.map((event) => (
                <ListRow key={event.id} to={pathFor(eventPaths.detail, { eventId: event.id })} icon="calendar" iconTone="red" title={event.data.title} detail={eventWhen(event)} value={<PrivacyTag value={event.visibility} />} />
              ))}
            </List>}</Section>
        : <MonthView />}
    </>
  );
}

function MonthView() {
  const today = todayIn();
  const [shown, setShown] = useState({ year: today.year, month: today.month });
  const todayKey = isoDate(today);
  const title = formatMonth(shown.year, shown.month);
  return (
    <Section>
      <div className="month">
        <div className="month__bar">
          <button type="button" className="icon-button" aria-label="Poprzedni miesiąc" onClick={() => setShown(addMonths(shown.year, shown.month, -1))}><Icon name="chevronLeft" /></button>
          <h2 className="month__title" aria-live="polite">{title}</h2>
          <button type="button" className="icon-button" aria-label="Następny miesiąc" onClick={() => setShown(addMonths(shown.year, shown.month, 1))}><Icon name="chevronRight" /></button>
        </div>
        <table className="month__grid" aria-label={title}>
          <thead><tr>{WEEKDAYS.map((weekday) => <th key={weekday.short} scope="col" abbr={weekday.long}>{weekday.short}</th>)}</tr></thead>
          <tbody>
            {monthGrid(shown.year, shown.month).map((week, index) => (
              <tr key={index}>{week.map((day, column) => (
                <td key={column}>{day && (
                  <span className={`month__day ${isoDate(day) === todayKey ? 'month__day--today' : ''}`}
                    aria-label={`${formatFullDate(day)}${isoDate(day) === todayKey ? ', dzisiaj' : ''}, brak wydarzeń`}
                    aria-current={isoDate(day) === todayKey ? 'date' : undefined}>{day.day}</span>
                )}</td>
              ))}</tr>
            ))}
          </tbody>
        </table>
        <p className="section__footer">Brak wydarzeń w tym miesiącu.</p>
      </div>
    </Section>
  );
}

type EventForm = { title: string; description: string; visibility: Visibility; allDay: boolean; startDate: string; startTime: string; endDate: string; endTime: string };

function initialEvent(mode: FormMode<'calendar_event'>): EventForm {
  if (mode.kind === 'create') {
    const today = isoDate(todayIn());
    return { title: '', description: '', visibility: defaultVisibility('calendar_event'), allDay: false, startDate: today, startTime: '18:00', endDate: today, endTime: '19:00' };
  }
  const { data, visibility } = mode.record;
  const start = data.startAt ? instantToLocal(data.startAt, data.timezone) : null;
  const end = data.endAt ? instantToLocal(data.endAt, data.timezone) : null;
  return {
    title: data.title, description: data.description, visibility, allDay: data.allDay,
    startDate: start?.date ?? data.startDate ?? '', startTime: start?.time ?? '18:00',
    endDate: end?.date ?? (data.endDate ? addDays(data.endDate, -1) : ''), endTime: end?.time ?? '19:00',
  };
}

function EventFormScreen({ mode }: { mode: FormMode<'calendar_event'> }) {
  const services = useServices();
  const editing = mode.kind === 'edit' ? mode.record : null;
  const timezone = editing?.data.timezone ?? DEFAULT_TIMEZONE;
  const back = editing ? pathFor(eventPaths.detail, { eventId: editing.id }) : '/kalendarz';
  const { values, set } = useFormValues<EventForm>(initialEvent(mode));
  const [errors, setErrors] = useState<Errors<EventForm>>({});
  const validate = (): Errors<EventForm> => {
    const result: Errors<EventForm> = { title: requiredText(values.title, 'nazwę wydarzenia'), description: maxText(values.description, 50_000) };
    if (!values.startDate) result.startDate = 'Wybierz dzień rozpoczęcia.';
    if (!values.endDate) result.endDate = 'Wybierz dzień zakończenia.';
    if (!values.allDay) {
      if (!values.startTime) result.startTime = 'Wybierz godzinę rozpoczęcia.';
      if (!values.endTime) result.endTime = 'Wybierz godzinę zakończenia.';
    }
    if (!result.startDate && !result.endDate && !result.startTime && !result.endTime) {
      const ends = values.allDay ? values.endDate >= values.startDate : `${values.endDate}T${values.endTime}` > `${values.startDate}T${values.startTime}`;
      if (!ends) result.endDate = 'Koniec musi być po początku.';
    }
    return result;
  };
  const submit = () => {
    // All-day end is exclusive in the contract: the day after the last chosen day.
    const data = values.allDay
      ? { startDate: values.startDate, endDate: addDays(values.endDate, 1), startAt: null, endAt: null }
      : { startDate: null, endDate: null, startAt: localTimeToInstant(values.startDate, values.startTime, timezone), endAt: localTimeToInstant(values.endDate, values.endTime, timezone) };
    return persist(services, 'calendar_event', mode, contractData('calendar_event', {
      title: values.title.trim(), description: values.description, allDay: values.allDay, timezone, ...data,
    }), values.visibility);
  };
  return (
    <FormScreen title={editing ? 'Edytuj wydarzenie' : 'Nowe wydarzenie'} cancelTo={back} doneTo={back} errors={errors} setErrors={setErrors} validate={validate} onSubmit={submit}>
      <div className="group">
        <TextField label="Nazwa" value={values.title} onValue={set('title')} error={errors.title} placeholder="np. Urodziny Kasi" autoComplete="off" maxLength={400} />
        <TextArea label="Opis (opcjonalnie)" value={values.description} onValue={set('description')} error={errors.description} />
      </div>
      <div className="group">
        <Toggle label="Cały dzień" checked={values.allDay} onChange={set('allDay')} />
        <div className="field-row">
          <DateField label="Początek – dzień" value={values.startDate} onValue={set('startDate')} error={errors.startDate} />
          {!values.allDay && <DateField label="Godzina" type="time" value={values.startTime} onValue={set('startTime')} error={errors.startTime} />}
        </div>
        <div className="field-row">
          <DateField label="Koniec – dzień" value={values.endDate} onValue={set('endDate')} error={errors.endDate} />
          {!values.allDay && <DateField label="Godzina" type="time" value={values.endTime} onValue={set('endTime')} error={errors.endTime} />}
        </div>
        <p className="field__hint">Godziny w strefie {timezone}.</p>
      </div>
      <div className="group">{editing ? <FixedPrivacy value={editing.visibility} /> : <PrivacyPicker subject="to wydarzenie" value={values.visibility} onChange={set('visibility')} />}</div>
    </FormScreen>
  );
}

export const NewEventScreen = () => <EventFormScreen mode={{ kind: 'create' }} />;
export function EditEventScreen() {
  const eventId = useParam('eventId');
  return (
    <RecordGate entityType="calendar_event" id={eventId} title="Edytuj wydarzenie" back={{ to: pathFor(eventPaths.detail, { eventId }), label: 'Wydarzenie' }}>
      {(record) => <EventFormScreen mode={{ kind: 'edit', record }} />}
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
              { label: 'Widoczność', value: <PrivacyTag value={event.visibility} /> },
              ...(event.data.description ? [{ label: 'Opis', value: <span className="prewrap">{event.data.description}</span> }] : []),
            ]} />
          </Section>
          <Section><DeleteRecord entityType="calendar_event" record={event} what="wydarzenie" doneTo="/kalendarz" /></Section>
        </>
      )}
    </RecordGate>
  );
}
