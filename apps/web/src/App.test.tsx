// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { App } from './App.js';
import { localDatabaseName } from './local-db.js';

afterEach(cleanup);
it('renderuje polski ekran i prawdziwe domyślne ustawienie prywatności', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Razem', level: 1 })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Dzisiaj' })).toBeTruthy();
  expect(screen.getByText('Tylko ja')).toBeTruthy();
  expect(screen.getByText(/Logowanie i zapisywanie będą dostępne/)).toBeTruthy();
});
it('przestrzeń IndexedDB jest oddzielona dla konta i gospodarstwa', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const keys = [localDatabaseName({ userId: a, householdId: a }), localDatabaseName({ userId: b, householdId: a }), localDatabaseName({ userId: a, householdId: b })];
  expect(new Set(keys).size).toBe(3);
  expect(() => localDatabaseName({ userId: 'anonymous', householdId: a })).toThrow();
});
