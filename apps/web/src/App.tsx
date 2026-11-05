import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Link, ParamsProvider, matchPath, navigate, usePath } from './router.js';
import type { Params } from './router.js';
import { Icon, BrandMark } from './ui/icons.js';
import type { IconName } from './ui/icons.js';
import { EmptyState, Notice, ScreenHeader, Section } from './ui/components.js';
import { ServicesProvider, unavailableServices } from './services.js';
import type { AppServices } from './services.js';
import { useTheme } from './theme.js';
import { useKeyboardInset } from './keyboard.js';
import { usePwaState } from './pwa.js';
import { TodayScreen } from './screens/Today.js';
import { EditShoppingListScreen, NewShoppingItemScreen, NewShoppingListScreen, ShoppingItemScreen, ShoppingListScreen, ShoppingScreen, shoppingPaths } from './screens/Shopping.js';
import { EditTaskScreen, NewTaskScreen, TaskDetailScreen, TasksScreen, taskPaths } from './screens/Tasks.js';
import { CalendarScreen, EditEventScreen, EventDetailScreen, NewEventScreen, eventPaths } from './screens/Calendar.js';
import {
  EditImportantDateScreen, EditNoteScreen, ImportantDateDetailScreen, ImportantDatesScreen, MoreScreen, NewImportantDateScreen, NewNoteScreen,
  NoteDetailScreen, NotesScreen, TrashScreen, datePaths, notePaths,
} from './screens/More.js';
import { InstallScreen, SettingsScreen } from './screens/Settings.js';
import { ChangePasswordScreen, LoginScreen } from './screens/Auth.js';
import { ChangesScreen, ConflictScreen, changePaths } from './screens/Changes.js';

type Tab = 'today' | 'shopping' | 'tasks' | 'calendar' | 'more';
export type Route = { path: string; title: string; tab: Tab; screen: ComponentType; chrome?: 'none' };

export const tabs: { id: Tab; label: string; icon: IconName; path: string }[] = [
  { id: 'today', label: 'Dzisiaj', icon: 'today', path: '/' },
  { id: 'shopping', label: 'Zakupy', icon: 'shopping', path: '/zakupy' },
  { id: 'tasks', label: 'Zadania', icon: 'tasks', path: '/zadania' },
  { id: 'calendar', label: 'Kalendarz', icon: 'calendar', path: '/kalendarz' },
  { id: 'more', label: 'Więcej', icon: 'more', path: '/wiecej' },
];

export const routes: Route[] = [
  { path: '/', title: 'Dzisiaj', tab: 'today', screen: TodayScreen },
  { path: '/zakupy', title: 'Zakupy', tab: 'shopping', screen: ShoppingScreen },
  { path: '/zakupy/nowa', title: 'Nowa lista', tab: 'shopping', screen: NewShoppingListScreen },
  { path: shoppingPaths.list, title: 'Lista zakupów', tab: 'shopping', screen: ShoppingListScreen },
  { path: shoppingPaths.editList, title: 'Edytuj listę', tab: 'shopping', screen: EditShoppingListScreen },
  { path: shoppingPaths.newItem, title: 'Nowa pozycja', tab: 'shopping', screen: NewShoppingItemScreen },
  { path: shoppingPaths.item, title: 'Pozycja', tab: 'shopping', screen: ShoppingItemScreen },
  { path: '/zadania', title: 'Zadania', tab: 'tasks', screen: TasksScreen },
  { path: '/zadania/nowe', title: 'Nowe zadanie', tab: 'tasks', screen: NewTaskScreen },
  { path: taskPaths.detail, title: 'Zadanie', tab: 'tasks', screen: TaskDetailScreen },
  { path: taskPaths.edit, title: 'Edytuj zadanie', tab: 'tasks', screen: EditTaskScreen },
  { path: '/kalendarz', title: 'Kalendarz', tab: 'calendar', screen: CalendarScreen },
  { path: '/kalendarz/nowe', title: 'Nowe wydarzenie', tab: 'calendar', screen: NewEventScreen },
  { path: eventPaths.detail, title: 'Wydarzenie', tab: 'calendar', screen: EventDetailScreen },
  { path: eventPaths.edit, title: 'Edytuj wydarzenie', tab: 'calendar', screen: EditEventScreen },
  { path: '/wiecej', title: 'Więcej', tab: 'more', screen: MoreScreen },
  { path: '/notatki', title: 'Notatki', tab: 'more', screen: NotesScreen },
  { path: '/notatki/nowa', title: 'Nowa notatka', tab: 'more', screen: NewNoteScreen },
  { path: notePaths.detail, title: 'Notatka', tab: 'more', screen: NoteDetailScreen },
  { path: notePaths.edit, title: 'Edytuj notatkę', tab: 'more', screen: EditNoteScreen },
  { path: '/wazne-daty', title: 'Ważne daty', tab: 'more', screen: ImportantDatesScreen },
  { path: '/wazne-daty/nowa', title: 'Nowa ważna data', tab: 'more', screen: NewImportantDateScreen },
  { path: datePaths.detail, title: 'Ważna data', tab: 'more', screen: ImportantDateDetailScreen },
  { path: datePaths.edit, title: 'Edytuj ważną datę', tab: 'more', screen: EditImportantDateScreen },
  { path: '/kosz', title: 'Kosz', tab: 'more', screen: TrashScreen },
  { path: '/ustawienia', title: 'Ustawienia', tab: 'more', screen: SettingsScreen },
  { path: '/ustawienia/instalacja', title: 'Instalacja na iPhonie', tab: 'more', screen: InstallScreen },
  { path: '/ustawienia/haslo', title: 'Zmiana hasła', tab: 'more', screen: ChangePasswordScreen },
  { path: changePaths.list, title: 'Zmiany do sprawdzenia', tab: 'more', screen: ChangesScreen },
  { path: changePaths.conflict, title: 'Konflikt', tab: 'more', screen: ConflictScreen },
  { path: '/logowanie', title: 'Logowanie', tab: 'more', screen: LoginScreen, chrome: 'none' },
];

function NotFoundScreen() {
  return (
    <>
      <ScreenHeader title="Nie znaleziono" />
      <Section><EmptyState icon="alert" title="Tej strony nie ma" text="Link mógł być nieaktualny." action={{ label: 'Wróć do ekranu Dzisiaj', to: '/' }} /></Section>
    </>
  );
}
const notFound: Route = { path: '', title: 'Nie znaleziono', tab: 'today', screen: NotFoundScreen };

export function findRoute(path: string): [Route, Params] {
  for (const candidate of routes) {
    const params = matchPath(candidate.path, path);
    if (params) return [candidate, params];
  }
  return [notFound, {}];
}

export function App({ services = unavailableServices }: { services?: AppServices }) {
  const path = usePath();
  const pwa = usePwaState();
  const [route, params] = findRoute(path);
  useTheme();
  useKeyboardInset();
  const first = useRef(true);
  const mustChange = services.session?.mustChangePassword === true;

  useEffect(() => {
    // A temporary password allows nothing but setting an own one (server rule, RAZ-2).
    if (mustChange && path !== '/ustawienia/haslo') navigate('/ustawienia/haslo', { replace: true });
  }, [mustChange, path]);

  useEffect(() => {
    document.title = route.title === 'Dzisiaj' ? 'Razem' : `${route.title} · Razem`;
    // Move focus to the new screen title for VoiceOver, but not on the initial load.
    if (first.current) { first.current = false; return; }
    document.querySelector<HTMLElement>('[data-screen-title]')?.focus({ preventScroll: true });
  }, [route, path]);

  // Another account opened in this app (e.g. signed in in another tab and adopted by sync):
  // tell the user why the open form or view was closed. Cleared on the next navigation.
  const login = services.session?.login ?? null;
  const previousLogin = useRef(login);
  const [switchedTo, setSwitchedTo] = useState<string | null>(null);
  useEffect(() => {
    if (previousLogin.current !== null && login !== null && login !== previousLogin.current) setSwitchedTo(services.session?.displayName ?? login);
    previousLogin.current = login;
  }, [login]);
  const switchedAt = useRef(path);
  useEffect(() => { if (switchedTo !== null && path !== switchedAt.current) setSwitchedTo(null); switchedAt.current = path; }, [path]);

  // Every screen is bound to the open account database (accountKey): on an account switch
  // it is remounted, so form values, loaded records and callbacks of the previous account
  // are discarded instead of being shown to, or saved into, the new one.
  const accountKey = services.accountKey ?? '';
  const Screen = route.screen;
  const loading = <><ScreenHeader title={route.title} /><Section><p role="status">Otwieranie danych na tym urządzeniu…</p></Section></>;
  if (route.chrome === 'none') return <ServicesProvider value={services}>{services.initializing ? loading : <Screen key={accountKey} />}</ServicesProvider>;
  const screen = services.initializing ? loading : <ParamsProvider value={params}><Screen /></ParamsProvider>;
  return (
    <ServicesProvider value={services}>
      <a className="skip-link" href="#main">Przejdź do treści</a>
      <div className="shell">
        <nav className="tabbar" aria-label="Główna nawigacja">
          <div className="tabbar__brand"><BrandMark size={32} /><span>Razem</span></div>
          <ul className="tabbar__list">
            {tabs.map((tab) => (
              <li key={tab.id}>
                <Link to={tab.path} className="tabbar__item" aria-current={tab.id !== route.tab ? undefined : tab.path === path ? 'page' : 'true'}>
                  <Icon name={tab.icon} /><span className="tabbar__label">{tab.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main className="content" id="main" key={`${accountKey}|${path}`}>
          {pwa === 'update' && <Notice tone="info" role="status" title="Dostępna nowa wersja">
            Dokończ i zapisz formularze. Następnie zamknij wszystkie okna Razem i otwórz aplikację ponownie. Niewysłane zmiany pozostaną na tym urządzeniu.
          </Notice>}
          {switchedTo !== null && (
            <Notice tone="warning" role="alert" title={`Otwarto konto: ${switchedTo}`}>
              W tej aplikacji zalogowano inne konto. Niezapisane formularze poprzedniego konta zamknięto; jego niewysłane zmiany czekają na jego ponowne logowanie.
            </Notice>
          )}
          {screen}
        </main>
      </div>
    </ServicesProvider>
  );
}
