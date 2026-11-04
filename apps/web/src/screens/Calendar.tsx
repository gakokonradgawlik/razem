import { useState } from 'react';
import { DEFAULT_TIMEZONE, defaultVisibility, localTimeToInstant } from '@razem/contracts';
import { AddButton, DateField, EmptyState, PrivacyPicker, ScreenHeader, Section, Segmented, TextArea, TextField, Toggle } from '../ui/components.js';
import { FormScreen, useFormValues } from '../ui/form.js';
import type { Errors } from '../ui/form.js';
import { Icon } from '../ui/icons.js';
import { useServices } from '../services.js';
import type { Visibility } from '../services.js';
import { WEEKDAYS, addMonths, formatFullDate, formatMonth, isoDate, monthGrid, todayIn } from '../dates.js';
import { contractData, maxText, requiredText } from './validation.js';

type View = 'agenda' | 'month';

export function CalendarScreen() {
  const [view, setView] = useState<View>('agenda');
  return (
    <>
      <ScreenHeader title="Kalendarz" action={<AddButton label="Nowe wydarzenie" to="/kalendarz/nowe" />} />
      <Segmented label="Widok kalendarza" value={view} onChange={setView} options={[{ value: 'agenda', label: 'Agenda' }, { value: 'month', label: 'Miesiąc' }]} />
      {view === 'agenda'
        ? <Section><EmptyState icon="calendar" title="Brak nadchodzących wydarzeń" text="Dodaj np. „Wizyta u dentysty, czwartek 17:30” albo wyjazd na kilka dni." action={{ label: 'Dodaj wydarzenie', to: '/kalendarz/nowe' }} /></Section>
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

function nextDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

export function NewEventScreen() {
  const { saveRecord } = useServices();
  const today = isoDate(todayIn());
  const { values, set } = useFormValues<EventForm>({
    title: '', description: '', visibility: defaultVisibility('calendar_event'), allDay: false,
    startDate: today, startTime: '18:00', endDate: today, endTime: '19:00',
  });
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
      ? { startDate: values.startDate, endDate: nextDay(values.endDate), startAt: null, endAt: null }
      : { startDate: null, endDate: null, startAt: localTimeToInstant(values.startDate, values.startTime), endAt: localTimeToInstant(values.endDate, values.endTime) };
    return saveRecord({ entityType: 'calendar_event', visibility: values.visibility, data: contractData('calendar_event', {
      title: values.title.trim(), description: values.description, allDay: values.allDay, timezone: DEFAULT_TIMEZONE, ...data,
    }) });
  };
  return (
    <FormScreen title="Nowe wydarzenie" cancelTo="/kalendarz" doneTo="/kalendarz" errors={errors} setErrors={setErrors} validate={validate} onSubmit={submit}>
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
        <p className="field__hint">Godziny w strefie Europe/Warsaw.</p>
      </div>
      <div className="group"><PrivacyPicker subject="to wydarzenie" value={values.visibility} onChange={set('visibility')} /></div>
    </FormScreen>
  );
}
