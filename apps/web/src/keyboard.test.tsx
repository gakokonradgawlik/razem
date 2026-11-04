// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useKeyboardInset } from './keyboard.js';

function Probe() { useKeyboardInset(); return <input aria-label="Pole" />; }
afterEach(() => { cleanup(); delete (window as { visualViewport?: unknown }).visualViewport; });

it('otwarta klawiatura (mniejszy visualViewport podczas edycji) ustawia --keyboard-inset i data-keyboard', () => {
  const listeners: Record<string, () => void> = {};
  const viewport = { height: 844, offsetTop: 0, addEventListener: (type: string, listener: () => void) => { listeners[type] = listener; }, removeEventListener: () => {} };
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
  const { getByLabelText } = render(<Probe />);
  const root = document.documentElement;
  expect(root.dataset.keyboard).toBeUndefined();
  act(() => { getByLabelText('Pole').focus(); viewport.height = 508; listeners.resize!(); });
  expect(root.style.getPropertyValue('--keyboard-inset')).toBe('336px');
  expect(root.dataset.keyboard).toBe('open');
  act(() => { (document.activeElement as HTMLElement).blur(); viewport.height = 844; listeners.resize!(); });
  expect(root.dataset.keyboard).toBeUndefined();
  // Pinch-zoom without editing is not treated as a keyboard.
  act(() => { viewport.height = 400; listeners.resize!(); });
  expect(root.dataset.keyboard).toBeUndefined();
});
