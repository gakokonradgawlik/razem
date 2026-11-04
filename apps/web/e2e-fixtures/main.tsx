// E2E-only entry: the real App on an in-memory port with synthetic Polish records,
// so detail/edit/item screens can be checked with content (long names, many rows).
// Served by vite.fixtures.config.ts on 127.0.0.1:4318; never part of `vite build`.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { EntityType } from '@razem/contracts';
import { App } from '../src/App.js';
import { applyTheme, readTheme } from '../src/theme.js';
import type { AppServices, StoredRecord } from '../src/services.js';
import '../src/style.css';

export const fixtureId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rec = (n: number, entityType: EntityType, data: Record<string, unknown>, extra: Partial<StoredRecord> = {}): StoredRecord =>
  ({ id: fixtureId(n), entityType, visibility: 'shared', version: 1, mine: true, data, ...extra });
const item = (n: number, name: string, quantity: string, note: string, checked: boolean) =>
  rec(n, 'shopping_item', { listId: fixtureId(1), name, quantity, note, checked, sortKey: n });

const records: StoredRecord[] = [
  rec(1, 'shopping_list', { name: 'Zakupy na weekend w Biedronce i na targu przy ulicy Długiej' }),
  rec(2, 'shopping_list', { name: 'Apteka' }, { visibility: 'private' }),
  item(10, 'Mleko', '2 l', 'bez laktozy', false),
  item(11, 'Pomidory malinowe z targu, najlepiej od pani z ostatniego stoiska', '1 kg', 'jeśli nie ma, to koktajlowe', false),
  item(12, 'Chleb żytni', '', '', true),
  item(13, 'Kawa ziarnista', '500 g', '', false),
  rec(20, 'task', { title: 'Zapłacić rachunek za prąd i sprawdzić odczyt licznika', description: 'Numer klienta w segregatorze „Dom”.\nTermin do 10.', assignee: 'both', dueDate: null, dueAt: '2026-11-10T17:00:00Z', timezone: 'Europe/Warsaw', completedAt: null, recurrence: { frequency: 'monthly', interval: 1, startDate: '2026-11-10' } }),
  rec(21, 'task', { title: 'Odebrać paczkę', description: '', assignee: 'self', dueDate: '2026-11-05', dueAt: null, timezone: 'Europe/Warsaw', completedAt: null, recurrence: null }, { visibility: 'private' }),
  rec(30, 'calendar_event', { title: 'Wyjazd w góry z przyjaciółmi', description: 'Schronisko na Hali Ornak, rezerwacja na nazwisko Kowalska.', allDay: true, timezone: 'Europe/Warsaw', startDate: '2099-03-28', endDate: '2099-03-31', startAt: null, endAt: null }),
  rec(31, 'calendar_event', { title: 'Dentysta', description: '', allDay: false, timezone: 'Europe/Warsaw', startDate: null, endDate: null, startAt: '2099-01-15T16:30:00Z', endAt: '2099-01-15T17:15:00Z' }, { visibility: 'private' }),
  rec(40, 'note', { title: 'Pomysły na prezenty świąteczne dla całej rodziny', body: 'Mama: szal z wełny merino\nTata: książka o żeglarstwie\nKasia: zestaw do kaligrafii' }, { visibility: 'private' }),
  rec(50, 'important_date', { name: 'Rocznica ślubu', kind: 'anniversary', month: 6, day: 14, startYear: 2015 }),
];

const services: AppServices = {
  session: null, pendingChanges: 0,
  login: async () => ({ ok: false, reason: 'not_implemented' }),
  changePassword: async () => ({ ok: false, reason: 'not_implemented' }),
  saveRecord: async () => ({ ok: true }),
  updateRecord: async ({ id, patch }) => {
    const found = records.find((record) => record.id === id);
    if (!found) return { ok: false, reason: 'storage_unavailable' };
    Object.assign(found, { version: found.version + 1, data: { ...found.data, ...patch } });
    return { ok: true };
  },
  deleteRecord: async ({ id }) => { records.splice(records.findIndex((record) => record.id === id), 1); return { ok: true }; },
  listRecords: async ({ entityType, parentId }) => ({ status: 'ok', value: records.filter((record) => record.entityType === entityType && (!parentId || record.data.listId === parentId)).map((record) => ({ ...record })) }),
  getRecord: async (entityType, id) => {
    const found = records.find((record) => record.id === id && record.entityType === entityType);
    return found ? { status: 'ok', value: { ...found } } : { status: 'not_found' };
  },
};

applyTheme(readTheme());
createRoot(document.getElementById('root')!).render(<StrictMode><App services={services} /></StrictMode>);
