import { DEFAULT_TIMEZONE } from '@razem/contracts';

export type PlainDate = { year: number; month: number; day: number };

/** Calendar date "now" in the household zone (not the device zone). */
export function todayIn(timezone = DEFAULT_TIMEZONE, now = new Date()): PlainDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

export const isoDate = ({ year, month, day }: PlainDate) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

// Formatting a date-only value at UTC noon avoids any device-zone shift.
const asUtc = (date: PlainDate) => new Date(Date.UTC(date.year, date.month - 1, date.day, 12));
const longFormat = new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const fullFormat = new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export const formatLongDate = (date: PlainDate) => longFormat.format(asUtc(date));
export const formatFullDate = (date: PlainDate) => fullFormat.format(asUtc(date));
/** "listopad 2026" (nominative month name). */
export function formatMonth(year: number, month: number): string {
  const text = new Intl.DateTimeFormat('pl-PL', { month: 'long', timeZone: 'UTC' }).format(asUtc({ year, month, day: 1 }));
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} ${year}`;
}

export const WEEKDAYS = [
  { short: 'Pn', long: 'poniedziałek' }, { short: 'Wt', long: 'wtorek' }, { short: 'Śr', long: 'środa' },
  { short: 'Cz', long: 'czwartek' }, { short: 'Pt', long: 'piątek' }, { short: 'So', long: 'sobota' }, { short: 'Nd', long: 'niedziela' },
] as const;

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Monday-first grid for a month; null pads the leading/trailing cells. */
export function monthGrid(year: number, month: number): (PlainDate | null)[][] {
  const first = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const cells: (PlainDate | null)[] = Array.from({ length: first }, () => null);
  for (let day = 1; day <= daysInMonth(year, month); day++) cells.push({ year, month, day });
  while (cells.length % 7) cells.push(null);
  const weeks: (PlainDate | null)[][] = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
}

export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const zeroBased = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 };
}
