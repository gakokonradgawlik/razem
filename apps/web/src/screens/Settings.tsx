import { useState, useSyncExternalStore } from 'react';
import { usePwaState, useStandalone } from '../pwa.js';
import { persistenceSnapshot, subscribePersistence } from '../storage-persistence.js';
import { settingsPatchSchema } from '@razem/contracts';
import type { Settings } from '@razem/contracts';
import { FormScreen } from '../ui/form.js';
import type { Errors } from '../ui/form.js';
import { Button, List, ListRow, Notice, ScreenHeader, Section, Segmented, SyncBadge, TextField, Toggle } from '../ui/components.js';
import { Icon } from '../ui/icons.js';
import { navigate } from '../router.js';
import { failureMessage, useServices, useSyncState, useTimezone } from '../services.js';
import { themeLabels, useTheme } from '../theme.js';
import type { ThemePreference } from '../theme.js';

export function SettingsScreen() {
  const services = useServices();
  const { session } = services;
  const timezone = useTimezone();
  const [theme, setTheme] = useTheme();
  const sync = useSyncState();
  const [message, setMessage] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const attention = services.attentionCount ?? 0;
  const exportPending = async () => {
    const result = await services.exportPending?.();
    setMessage(!result ? null : result.ok ? { tone: 'success', text: 'Zapisano plik z niewysłanymi zmianami.' } : { tone: 'danger', text: failureMessage(result) });
  };
  return (
    <>
      <ScreenHeader title="Ustawienia" back={{ to: '/wiecej', label: 'Więcej' }} />
      <Section title="Konto">
        <List>
          {session
            ? <ListRow icon="people" iconTone="blue" title={session.displayName} detail={session.login} />
            : <ListRow to="/logowanie" icon="people" iconTone="blue" title="Zaloguj się" detail="Konta zakłada administrator domowego serwera" />}
          <ListRow to="/ustawienia/profil" icon="people" iconTone="blue" title="Profil i domownicy" disabled={!session} detail={services.settings?.members.map((member) => member.displayName).join(' · ') ?? 'Nazwy domowników i strefa domu'} />
          <ListRow to="/ustawienia/haslo" icon="key" iconTone="gray" title="Zmień hasło" disabled={!session} detail={session ? undefined : 'Wymaga zalogowania'} />
        </List>
      </Section>
      <Section title="Wygląd">
        <Segmented<ThemePreference> label="Motyw" value={theme} onChange={setTheme}
          options={(['system', 'light', 'dark'] as const).map((value) => ({ value, label: themeLabels[value] }))} />
        <p className="section__footer">Systemowy motyw podąża za ustawieniem iPhone’a. Wybór dotyczy tego urządzenia.</p>
      </Section>
      {message && <Notice tone={message.tone} role={message.tone === 'danger' ? 'alert' : 'status'}>{message.text}</Notice>}
      <Section title="Synchronizacja" footer="Zmiany wysyłają się, gdy aplikacja jest otwarta i serwer jest dostępny. Zamknięta aplikacja na iPhonie nie synchronizuje w tle.">
        <SyncBadge />
        <List>
          {session && sync.kind === 'signed_out' && <ListRow to="/logowanie" icon="people" iconTone="blue" title="Zaloguj się ponownie" detail="Niewysłane zmiany zostaną wysłane po zalogowaniu" />}
          {session && <ListRow icon="cloud" iconTone="blue" title={syncing ? 'Synchronizowanie…' : 'Synchronizuj teraz'} disabled={syncing}
            onClick={() => { setSyncing(true); void (services.syncNow?.() ?? Promise.resolve()).finally(() => setSyncing(false)); }} />}
          {session && <ListRow to="/zmiany" icon="alert" iconTone={attention ? 'red' : 'gray'} title="Zmiany do sprawdzenia" value={String(attention)} />}
          <ListRow to="/ustawienia/profil" disabled={!session} icon="clock" iconTone="gray" title="Strefa czasowa" detail={timezone} />
        </List>
      </Section>
      <Section title="Powiadomienia">
        <List><ListRow to="/ustawienia/powiadomienia" disabled={!session} icon="bell" iconTone="red" title="Preferencje powiadomień" detail="Wysyłka będzie dostępna w kolejnej wersji" /></List>
      </Section>
      <Section title="Dane">
        <StorageNotice />
        <List>
          <ListRow disabled icon="download" iconTone="gray" title="Eksport wszystkich moich i wspólnych danych" detail="Niedostępny w tej wersji. Możesz pobrać niewysłane zmiany poniżej." />
          {session && services.exportPending
            ? <ListRow onClick={() => void exportPending()} icon="download" iconTone="green" title="Eksport niewysłanych zmian" detail={services.pendingChanges ? `Zmiany tylko na tym urządzeniu: ${services.pendingChanges}` : 'Brak niewysłanych zmian'} />
            : <ListRow icon="download" iconTone="green" title="Eksport niewysłanych zmian" value="Niedostępne" detail="Wymaga zalogowania" />}
          <ListRow to="/kosz" icon="trash" iconTone="gray" title="Kosz" detail="Usunięte wpisy przez 30 dni" />
        </List>
      </Section>
      <Section title="Aplikacja">
        <List><ListRow to="/ustawienia/instalacja" icon="phone" iconTone="blue" title="Instalacja na iPhonie" /></List>
      </Section>
      {session && <LogoutSection onExport={exportPending} />}
    </>
  );
}

/** Logout warns about unsent changes: send them, export them or consciously discard them. */
function LogoutSection({ onExport }: { onExport: () => Promise<void> }) {
  const services = useServices();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const pending = services.pendingChanges;
  const logout = async (discardPending: boolean) => {
    if (!services.logout) return;
    setBusy(true); setFailure(null);
    try {
      const result = await services.logout({ discardPending });
      if (result.ok) { navigate('/logowanie', { replace: true }); return; }
      if (result.reason === 'pending_changes') { setAsking(true); return; }
      setFailure(result.reason === 'unavailable' ? 'Wylogowanie wymaga połączenia z serwerem. Dane na tym urządzeniu pozostają bez zmian.' : failureMessage(result));
    } catch { setFailure('Nie udało się wylogować. Spróbuj ponownie.'); } finally { setBusy(false); }
  };
  return (
    <Section footer="Wylogowanie usuwa z tego urządzenia dane Twojego konta. Na serwerze pozostają wszystkie wysłane wpisy.">
      {failure && <Notice tone="danger" role="alert">{failure}</Notice>}
      {asking && pending > 0 ? (
        <div className="delete__confirm" role="group" aria-label="Niewysłane zmiany przed wylogowaniem">
          <Notice tone="warning" title={`Niewysłane zmiany: ${pending}`}>Istnieją tylko na tym urządzeniu. Po wylogowaniu zostaną usunięte.</Notice>
          <div className="actions actions--stack">
            <Button variant="filled" disabled={busy} onClick={() => void services.syncNow?.()}>Spróbuj wysłać teraz</Button>
            <Button variant="tinted" disabled={busy} onClick={() => void onExport()}>Eksportuj zmiany do pliku</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void logout(true)}>Wyloguj i usuń niewysłane zmiany</Button>
            <Button variant="plain" onClick={() => setAsking(false)}>Anuluj</Button>
          </div>
        </div>
      ) : (
        <button type="button" className="button button--destructive button--block" disabled={busy || !services.logout} onClick={() => void logout(false)}>
          <Icon name="logout" size={20} /> Wyloguj
        </button>
      )}
    </Section>
  );
}

export function InstallScreen() {
  const standalone = useStandalone();
  const pwa = usePwaState();
  return (
    <>
      <ScreenHeader title="Instalacja na iPhonie" back={{ to: '/ustawienia', label: 'Ustawienia' }} />
      <Notice tone={standalone ? 'success' : 'info'} title={standalone ? 'Otworzono jako aplikację' : 'Otworzono w przeglądarce'}>
        {standalone ? 'Razem działa w osobnym oknie z ekranu początkowego.' : 'Dodaj Razem do ekranu początkowego według poniższych kroków.'}
      </Notice>
      <Section>
        <ol className="steps">
          <li><span className="steps__icon"><Icon name="share" /></span><span>Otwórz Razem w Safari i naciśnij <strong>Udostępnij</strong> na dolnym pasku.</span></li>
          <li><span className="steps__icon"><Icon name="addSquare" /></span><span>Przewiń i wybierz <strong>Do ekranu początkowego</strong>.</span></li>
          <li><span className="steps__icon"><Icon name="check" /></span><span>Naciśnij <strong>Dodaj</strong>, a potem otwieraj Razem ikoną z ekranu początkowego.</span></li>
        </ol>
      </Section>
      <Notice tone="info" title="Dlaczego z ekranu początkowego?">
        Na iPhonie powiadomienia działają tylko w aplikacji dodanej do ekranu początkowego. Safari nie pokazuje osobnego przycisku instalacji.
      </Notice>
      <Notice tone={pwa === 'ready' || pwa === 'update' ? 'success' : 'warning'} title={pwa === 'ready' || pwa === 'update' ? 'Aplikacja gotowa do uruchamiania offline' : 'Przygotowanie do pracy offline'}>
        {pwa === 'unavailable' ? 'Nie udało się przygotować aplikacji. Otwórz ją ponownie przy działającym połączeniu. Wymagane jest bezpieczne połączenie.' : 'Pierwszy raz otwórz aplikację z internetem, zaloguj się i poczekaj na „Zsynchronizowano”. Po instalacji ponownie otwórz ją ikoną przy działającym internecie i sprawdź ten komunikat. Potem możesz zamknąć ją i uruchomić bez sieci.'}
      </Notice>
      <StorageNotice />
    </>
  );
}

function StorageNotice() {
  const persistence = useSyncExternalStore(subscribePersistence, persistenceSnapshot);
  return <Notice tone="info" title="Dane na tym urządzeniu">
    {persistence === 'granted' ? 'Przeglądarka przyznała ochronę magazynu przed automatycznym usuwaniem. '
      : persistence === 'denied' ? 'Przeglądarka nie przyznała trwałego magazynu. '
      : persistence === 'unsupported' ? 'Ta przeglądarka nie udostępnia ochrony magazynu. '
      : persistence === 'unavailable' ? 'Nie udało się sprawdzić ochrony magazynu. '
      : 'Po otwarciu konta poprosimy przeglądarkę o ochronę magazynu. '}
    Usunięcie danych witryny lub utrata urządzenia może usunąć niewysłane zmiany. Synchronizuj regularnie i w razie problemów eksportuj niewysłane zmiany.
  </Notice>;
}

function MissingSettings({ title }: { title: string }) {
  return <><ScreenHeader title={title} back={{ to: '/ustawienia', label: 'Ustawienia' }} /><Notice tone="warning">Połącz się z serwerem i wybierz „Synchronizuj teraz”, aby pobrać ustawienia domu.</Notice></>;
}
export function ProfileScreen() {
  const { settings } = useServices();
  return settings ? <ProfileForm settings={settings} /> : <MissingSettings title="Profil i domownicy" />;
}
function ProfileForm({ settings }: { settings: Settings }) {
  const services = useServices();
  const [baseline] = useState(settings);
  const own = baseline.members.find((member) => member.id === baseline.userId);
  const [displayName, setDisplayName] = useState(own?.displayName ?? services.session?.displayName ?? '');
  const [timezone, setTimezone] = useState(baseline.household.timezone);
  const [errors, setErrors] = useState<Errors<{ displayName: string; timezone: string }>>({});
  return <FormScreen title="Profil i domownicy" cancelTo="/ustawienia" doneTo="/ustawienia" errors={errors} setErrors={setErrors}
    validate={() => {
      const result = settingsPatchSchema.safeParse({ displayName, timezone });
      if (result.success) return {};
      return Object.fromEntries(result.error.issues.map((issue) => [issue.path[0], issue.path[0] === 'timezone' ? 'Podaj poprawną strefę, np. Europe/Warsaw.' : 'Wpisz nazwę od 1 do 200 znaków.']));
    }}
    onSubmit={() => {
      const patch = { ...(displayName.trim() !== own?.displayName ? { displayName: displayName.trim() } : {}), ...(timezone !== baseline.household.timezone ? { timezone } : {}) };
      return Object.keys(patch).length ? services.updateSettings?.(patch) ?? Promise.resolve({ ok: false, reason: 'not_implemented' }) : Promise.resolve({ ok: true });
    }}>
    <div className="group">
      <TextField label="Twoja nazwa" value={displayName} onValue={setDisplayName} error={errors.displayName} maxLength={200} autoComplete="name" />
      <p className="field__hint">Każdy domownik zmienia własną nazwę na swoim koncie.</p>
      <List>{settings.members.filter((member) => member.id !== settings.userId).map((member) => <ListRow key={member.id} icon="people" title={member.displayName} detail="Druga osoba w domu" />)}</List>
    </div>
    <div className="group"><TextField label="Strefa czasowa domu" value={timezone} onValue={setTimezone} error={errors.timezone} hint="Np. Europe/Warsaw. Wspólne ustawienie zmienia dni w kalendarzu i porę przypomnień ważnych dat. Istniejące terminy zadań i godziny wydarzeń pozostają w swoich strefach." /></div>
    <Notice>Zapis profilu i strefy wymaga połączenia z serwerem. Ostatnio pobrane ustawienia są dostępne offline.</Notice>
  </FormScreen>;
}

export function NotificationsScreen() {
  const { settings } = useServices();
  return settings ? <NotificationsForm settings={settings} /> : <MissingSettings title="Powiadomienia" />;
}
function NotificationsForm({ settings }: { settings: Settings }) {
  const services = useServices();
  const [baseline] = useState(settings.notifications);
  const [includeTitles, setIncludeTitles] = useState(baseline.includeTitles);
  const [shoppingNotifications, setShoppingNotifications] = useState(baseline.shoppingNotifications);
  const [errors, setErrors] = useState<Errors<Record<string, string>>>({});
  return <FormScreen title="Powiadomienia" cancelTo="/ustawienia" doneTo="/ustawienia" errors={errors} setErrors={setErrors} validate={() => ({})}
    onSubmit={() => {
      if (!settings || !services.updateSettings) return Promise.resolve({ ok: false, reason: 'unavailable' });
      const patch = { ...(includeTitles !== baseline.includeTitles ? { includeTitles } : {}), ...(shoppingNotifications !== baseline.shoppingNotifications ? { shoppingNotifications } : {}) };
      return Object.keys(patch).length ? services.updateSettings(patch) : Promise.resolve({ ok: true });
    }}>
    <Notice tone="warning">Powiadomienia nie są jeszcze wysyłane. Możesz zapisać preferencje konta na przyszłość; zapis wymaga połączenia. Nie gwarantujemy alarmu offline.</Notice>
    <div className="group">
      <Button disabled>Włącz powiadomienia — niedostępne w tej wersji</Button>
      <Toggle label="Tytuły na ekranie blokady" checked={includeTitles} onChange={setIncludeTitles} disabled={!settings} hint="Domyślnie treść będzie ogólna. Włączenie pozwoli pokazywać tytuły Twoich prywatnych i wspólnych wpisów na ekranie blokady." />
      <Toggle label="Zmiany w zakupach" checked={shoppingNotifications} onChange={setShoppingNotifications} disabled={!settings} hint="Opcjonalne, domyślnie wyłączone." />
    </div>
  </FormScreen>;
}
