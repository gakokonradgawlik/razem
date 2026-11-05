// Minimal History API router: path-based URLs (deep links from notifications later),
// no extra dependency. The server already falls back to index.html for SPA paths.
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => { listeners.delete(listener); window.removeEventListener('popstate', listener); };
}
const currentPath = () => normalizePath(window.location.pathname);

export function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

export function navigate(path: string, options: { replace?: boolean } = {}) {
  if (normalizePath(path) === currentPath()) return;
  if (options.replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  listeners.forEach((listener) => listener());
  window.scrollTo?.({ top: 0 });
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, currentPath, () => '/');
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string; children: ReactNode };
export function Link({ to, onClick, children, ...rest }: LinkProps) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest}>{children}</a>;
}

// Route patterns: "/zakupy/:listId". A parameter matches only a UUID (record ids
// from the contract), so "/zakupy/nowa" never collides with "/zakupy/:listId".
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type Params = Record<string, string>;

export function matchPath(pattern: string, path: string): Params | null {
  const want = pattern.split('/'), have = normalizePath(path).split('/');
  if (want.length !== have.length) return null;
  const params: Params = {};
  for (let index = 0; index < want.length; index++) {
    const segment = want[index]!, actual = have[index]!;
    if (segment.startsWith(':')) {
      if (segment === ':type' ? !['task','calendar_event','important_date','shopping_list','shopping_item'].includes(actual) : !UUID.test(actual)) return null;
      params[segment.slice(1)] = actual.toLowerCase();
    } else if (segment !== actual) return null;
  }
  return params;
}

/** Concrete path for a pattern, e.g. pathFor('/zakupy/:listId', { listId }). */
export function pathFor(pattern: string, params: Params): string {
  return pattern.replace(/:(\w+)/g, (_, name: string) => {
    const value = params[name];
    if (!value) throw new Error(`Brak parametru ${name}`);
    return value;
  });
}

const ParamsContext = createContext<Params>({});
export const ParamsProvider = ParamsContext.Provider;
export function useParam(name: string): string {
  const value = useContext(ParamsContext)[name];
  if (!value) throw new Error(`Brak parametru ${name}`);
  return value;
}
