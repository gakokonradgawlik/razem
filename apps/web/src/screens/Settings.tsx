import { useState } from 'react';
import { DEFAULT_TIMEZONE } from '@razem/contracts';
import { Button, List, ListRow, Notice, ScreenHeader, Section, Segmented, SyncBadge } from '../ui/components.js';
import { Icon } from '../ui/icons.js';
import { navigate } from '../router.js';
import { failureMessage, useServices, useSyncState } from '../services.js';
import { themeLabels, useTheme } from '../theme.js';
import type { ThemePreference } from '../theme.js';

export function SettingsScreen() {
  const services = useServices();
  const { session } = services;
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
          <ListRow icon="clock" iconTone="gray" title="Strefa czasowa" value={DEFAULT_TIMEZONE} />
        </List>
      </Section>
      <Section title="Powiadomienia" footer="Prośba o zgodę pojawi się dopiero po naciśnięciu „Włącz powiadomienia”.">
        <List><ListRow icon="bell" iconTone="red" title="Powiadomienia" value="Niedostępne" detail="Będą dostępne po zalogowaniu w zainstalowanej aplikacji" /></List>
      </Section>
      <Section title="Dane">
        <List>
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
  return (
    <>
      <ScreenHeader title="Instalacja na iPhonie" back={{ to: '/ustawienia', label: 'Ustawienia' }} />
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
    </>
  );
}
