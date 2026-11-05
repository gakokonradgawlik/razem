import { useState } from 'react';
import type { ReactNode } from 'react';
import type { CalendarSave } from '../services.js';
import { useServices } from '../services.js';
import { DateField, Notice, SelectField, Toggle } from '../ui/components.js';
import { changedFields, LoadingNotice, persist, useRecords } from './records.js';
import type { FormMode } from './records.js';

export type ReminderConfig = NonNullable<CalendarSave['reminder']>;
export const defaultReminder = (timed = false): ReminderConfig => ({ enabled: false, minutesBefore: timed ? 30 : 0, localTime: timed ? null : '09:00' });
export function ReminderGate({ id, children }: { id: string; children: (reminder: ReminderConfig | undefined) => ReactNode }) {
  const [state] = useRecords('reminder', id);
  if (state.status === 'loading') return <LoadingNotice />;
  if (state.status !== 'ok') return <Notice tone="danger">Nie można wczytać przypomnienia. Otwórz formularz ponownie.</Notice>;
  const record = state.value.find((r) => r.data.enabled) ?? state.value[0];
  return <>{children(record?.data)}</>;
}
export function useReminder(initial?: ReminderConfig, timed = false) {
  return useState<ReminderConfig>(initial ? { enabled: initial.enabled, minutesBefore: initial.minutesBefore, localTime: initial.localTime } : defaultReminder(timed));
}
export function ReminderFields({ value, onChange, timed = false }: { value: ReminderConfig; onChange: (value: ReminderConfig) => void; timed?: boolean }) {
  return <div className="group">
    <Toggle label="Przypomnienie" checked={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })} />
    {value.enabled && <>
      <SelectField label="Wyprzedzenie przypomnienia" value={String(value.minutesBefore)} onValue={(minutes) => onChange({ ...value, minutesBefore: Number(minutes) })}
        options={Array.from(new Set([0, 15, 30, 60, 1440, 10080, value.minutesBefore])).sort((a,b) => a-b).map((minutes) => ({ value: String(minutes), label: minutes === 0 ? 'W dniu / o godzinie początku' : minutes % 1440 === 0 ? `${minutes / 1440} dni wcześniej` : `${minutes} min wcześniej` }))} />
      {!timed && <DateField label="Godzina przypomnienia" type="time" value={value.localTime ?? '09:00'} onValue={(localTime) => onChange({ ...value, localTime })} />}
    </>}
    <p className="field__hint">Ustawienie zapisuje się na tym urządzeniu. Powiadomienia nie są jeszcze wysyłane; ich obsługa pojawi się w kolejnej wersji. Brak alarmu offline.</p>
  </div>;
}
export function ReminderDetail({ type, id }: { type: 'calendar_event' | 'important_date'; id: string }) {
  const [state] = useRecords('reminder', id);
  const enabled = state.status === 'ok' ? state.value.find((r) => r.data.targetType === type && r.data.enabled) : undefined;
  return <p className="section__footer">{state.status === 'loading' ? 'Wczytywanie przypomnienia…' : state.status !== 'ok' ? 'Nie można wczytać przypomnienia.' : enabled ? `Przypomnienie zapisane: ${enabled.data.minutesBefore} min wcześniej${enabled.data.localTime ? `, godz. ${enabled.data.localTime}` : ''}. Powiadomienia nie są jeszcze wysyłane.` : 'Bez przypomnienia.'}</p>;
}
export function useCalendarPersist<T extends 'calendar_event' | 'important_date'>(type: T, mode: FormMode<T>, initialReminder: ReminderConfig) {
  const services = useServices();
  // Keep the form's baseline. Saving a title must not revert a reminder changed by another phone.
  const [baseline] = useState(initialReminder);
  return (data: Record<string, unknown>, visibility: CalendarSave['visibility'], reminder: ReminderConfig) => services.saveCalendar
    ? services.saveCalendar({ entityType: type, ...(mode.kind === 'edit' ? { id: mode.record.id } : {}),
      data: mode.kind === 'edit' ? changedFields(mode.record.data, data) : data, visibility,
      ...(mode.kind === 'create' || JSON.stringify(baseline) !== JSON.stringify(reminder) ? { reminder } : {}) })
    : reminder.enabled ? Promise.resolve({ ok: false as const, reason: 'storage_unavailable' as const }) : persist(services, type, mode, data, visibility);
}
export const yearsLabel = (years: number | null) => years === null ? '' : ` · ${years} ${years === 1 ? 'rok' : years % 10 >= 2 && years % 10 <= 4 && (years % 100 < 12 || years % 100 > 14) ? 'lata' : 'lat'}`;
