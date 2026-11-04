import { useCallback, useEffect, useState } from 'react';
import { preferenceSchema } from '@razem/contracts';
import type { z } from 'zod';

export type ThemePreference = z.infer<typeof preferenceSchema>['theme'];
export const THEME_STORAGE_KEY = 'razem:theme';
export const themeLabels: Record<ThemePreference, string> = { system: 'Systemowy', light: 'Jasny', dark: 'Ciemny' };

// The theme is a per-device display preference (no user data), so it lives in
// localStorage and is applied before React renders to avoid a flash. RAZ-5 may sync
// it with the account preferences; the device value stays the fallback.
export function readTheme(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): ThemePreference {
  const parsed = preferenceSchema.shape.theme.safeParse(storage?.getItem(THEME_STORAGE_KEY));
  return parsed.success ? parsed.data : 'system';
}

export function applyTheme(theme: ThemePreference, root: HTMLElement = document.documentElement) {
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : '#f2f2f7');
}

function safeStorage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

export function useTheme(): [ThemePreference, (theme: ThemePreference) => void] {
  const [theme, setThemeState] = useState<ThemePreference>(() => readTheme());
  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const update = () => applyTheme(readTheme());
    media?.addEventListener('change', update);
    return () => media?.removeEventListener('change', update);
  }, []);
  const setTheme = useCallback((next: ThemePreference) => {
    try { safeStorage()?.setItem(THEME_STORAGE_KEY, next); } catch { /* private mode: keep for this session */ }
    setThemeState(next);
  }, []);
  return [theme, setTheme];
}
