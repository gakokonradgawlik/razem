import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { addMonths, formatMonth, monthGrid, todayIn } from '../dates.js';
import { toSyncState } from '../offline/live.js';
import { syncLabel } from '../services.js';

// ---------- WCAG contrast of design tokens (light and dark) ----------
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((match) => [match[1]!, match[2]!.toLowerCase()]));
}
const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {'))));
const darkStart = css.indexOf(':root[data-theme="dark"]');
const dark = { ...light, ...tokens(css.slice(darkStart, css.indexOf('}', darkStart))) };
const mediaStart = css.indexOf(':root:not([data-theme="light"])');
const darkMedia = { ...light, ...tokens(css.slice(mediaStart, css.indexOf('}', mediaStart))) };

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const textPairs: [string, string][] = [
  ['text', 'bg'], ['text', 'surface'], ['text', 'surface-raised'], ['text', 'fill'],
  ['text-secondary', 'bg'], ['text-secondary', 'surface'], ['text-secondary', 'fill'],
  ['accent', 'bg'], ['accent', 'surface'], ['accent', 'accent-tint'], ['on-accent', 'accent-fill'],
  ['danger', 'surface'], ['danger', 'danger-tint'], ['text', 'danger-tint'], ['text', 'warning-tint'], ['text', 'success-tint'], ['text', 'accent-tint'],
];
const boundaryPairs: [string, string][] = [['control-border', 'surface'], ['accent', 'surface'], ['warning', 'warning-tint'], ['success', 'success-tint']];

it.each([['jasny', light], ['ciemny (wybrany)', dark], ['ciemny (systemowy)', darkMedia]])('kontrast tokenów: motyw %s spełnia WCAG AA', (_name, palette) => {
  for (const [fg, bg] of textPairs) expect(contrast(palette[fg]!, palette[bg]!), `${fg} na ${bg}`).toBeGreaterThanOrEqual(4.5);
  for (const [fg, bg] of boundaryPairs) expect(contrast(palette[fg]!, palette[bg]!), `${fg} na ${bg}`).toBeGreaterThanOrEqual(3);
});

it('oba warianty ciemnego motywu mają te same tokeny', () => {
  expect(dark).toEqual(darkMedia);
});

it('ikony w wierszach listy mają biały symbol z kontrastem ≥3:1', () => {
  for (const match of css.matchAll(/\.row__icon--[a-z]+ \{ background: (#[0-9a-f]{6}); \}/g)) expect(contrast('#ffffff', match[1]!)).toBeGreaterThanOrEqual(3);
});

// ---------- Dates ----------
it('dzisiaj liczone w strefie Europe/Warsaw, nie w strefie urządzenia', () => {
  expect(todayIn('Europe/Warsaw', new Date('2026-10-24T22:30:00Z'))).toEqual({ year: 2026, month: 10, day: 25 });
  expect(todayIn('Europe/Warsaw', new Date('2026-07-01T21:59:00Z'))).toEqual({ year: 2026, month: 7, day: 1 });
});

it('siatka miesiąca zaczyna się od poniedziałku i obsługuje luty przestępny', () => {
  const nov = monthGrid(2026, 11); // 1.11.2026 = niedziela
  expect(nov[0]!.slice(0, 6)).toEqual([null, null, null, null, null, null]);
  expect(nov[0]![6]).toEqual({ year: 2026, month: 11, day: 1 });
  expect(monthGrid(2028, 2).flat().filter(Boolean)).toHaveLength(29);
  expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
  expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
  expect(formatMonth(2026, 11)).toBe('Listopad 2026');
});

it('statusy synchronizacji mają brzmienie z design/interface.md', () => {
  expect(syncLabel({ kind: 'offline' }).text).toBe('Offline');
  expect(syncLabel({ kind: 'saving' }).text).toBe('Zapisywanie na tym urządzeniu');
  expect(syncLabel({ kind: 'pending', count: 3 }).text).toBe('Zmiany czekają na wysłanie (3)');
  expect(syncLabel({ kind: 'synced', at: new Date('2026-11-04T13:05:00Z') }).text).toBe('Zsynchronizowano 14:05');
  expect(syncLabel({ kind: 'server_unavailable' }).text).toBe('Serwer niedostępny');
  expect(syncLabel({ kind: 'signed_out' }).text).toBe('Zaloguj się, aby wysłać zmiany');
  expect(syncLabel({ kind: 'conflict', count: 1 }).text).toBe('1 zmiana wymaga sprawdzenia');
  expect(syncLabel({ kind: 'conflict', count: 3 }).text).toBe('3 zmiany wymagają sprawdzenia');
  expect(syncLabel({ kind: 'conflict', count: 5 }).text).toBe('5 zmian wymaga sprawdzenia');
  expect(syncLabel({ kind: 'offline', pending: 2 }).text).toBe('Offline · zmiany czekają na wysłanie (2)');
  expect(syncLabel({ kind: 'server_unavailable', pending: 1 }).text).toBe('Serwer niedostępny · zmiany czekają na wysłanie (1)');
  expect(syncLabel({ kind: 'signed_out', pending: 4 }).text).toBe('Zaloguj się, aby wysłać zmiany (4)');
  expect(syncLabel({ kind: 'storage_full' }).tone).toBe('danger');
  expect(syncLabel({ kind: 'storage_unavailable' }).text).toContain('Pamięć urządzenia niedostępna');
  expect(syncLabel({ kind: 'update_required' }).text).toContain('nowa wersja');
});

it('stan kontrolera → status: konflikt i brak miejsca mają pierwszeństwo, "Zsynchronizowano" tylko po udanym cyklu bez zaległości', () => {
  const base = { phase: 'ready' as const, account: null, unsent: 0, attention: 0, revision: 1, storage: 'ok' as const, generation: 1,
    status: { connection: 'ok' as const, lastSyncAt: '2026-11-04T13:05:00.000Z', lastAckAt: null, checkedAt: null } };
  expect(toSyncState(base)).toEqual({ kind: 'synced', at: new Date('2026-11-04T13:05:00.000Z') });
  expect(toSyncState({ ...base, unsent: 2 })).toEqual({ kind: 'pending', count: 2 });
  expect(toSyncState({ ...base, unsent: 2, status: { ...base.status, connection: 'server_unavailable' } })).toEqual({ kind: 'server_unavailable', pending: 2 });
  expect(toSyncState({ ...base, unsent: 1, status: { ...base.status, connection: 'auth_required' } })).toEqual({ kind: 'signed_out', pending: 1 });
  expect(toSyncState({ ...base, attention: 1, status: { ...base.status, connection: 'offline' } })).toEqual({ kind: 'conflict', count: 1 });
  expect(toSyncState({ ...base, storage: 'full', attention: 1 })).toEqual({ kind: 'storage_full' });
  expect(toSyncState({ ...base, status: { ...base.status, lastSyncAt: null, connection: 'unknown' } })).toEqual({ kind: 'connecting' });
});
