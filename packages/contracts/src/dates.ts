import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

export const dateSchema = z.iso.date();
export const instantSchema = z.iso.datetime({ offset: false });
export const timezoneSchema = z.string().max(100).refine((value) => {
  if (/^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('pl-PL', { timeZone: value });
    return true;
  } catch { return false; }
}, 'Oczekiwano strefy IANA');
export const DEFAULT_TIMEZONE = 'Europe/Warsaw';

// A gap resolves to its first valid minute, not the same minutes after the gap.
// An overlap resolves to the earlier occurrence. Domain schedules have minute precision.
export function localTimeToInstant(date: string, time: string, timezone = DEFAULT_TIMEZONE): string {
  dateSchema.parse(date);
  timezoneSchema.parse(timezone);
  z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).parse(time);
  let nominal = Temporal.PlainDateTime.from(`${date}T${time}`);
  for (let minute = 0; minute <= 1440; minute++) {
    const earlier = nominal.toZonedDateTime(timezone, { disambiguation: 'earlier' });
    if (earlier.toPlainDateTime().equals(nominal)) return earlier.toInstant().toString();
    nominal = nominal.add({ minutes: 1 });
  }
  throw new RangeError('Brak istniejącej chwili w ciągu doby');
}

export function annualDate(month: number, day: number, year: number): string {
  z.number().int().min(1).max(9999).parse(year);
  // A leap year validates the original annual rule before clamping its occurrence.
  Temporal.PlainDate.from({ year: 2000, month, day }, { overflow: 'reject' });
  return Temporal.PlainDate.from({ year, month, day }, { overflow: 'constrain' }).toString();
}

export function monthlyDate(nominalDay: number, year: number, month: number): string {
  z.number().int().min(1).max(31).parse(nominalDay);
  z.number().int().min(1).max(12).parse(month);
  z.number().int().min(1).max(9999).parse(year);
  return Temporal.PlainDate.from({ year, month, day: nominalDay }, { overflow: 'constrain' }).toString();
}
