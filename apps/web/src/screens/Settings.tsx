import { DEFAULT_TIMEZONE } from '@razem/contracts';
import { List, ListRow, Notice, ScreenHeader, Section, Segmented, SyncBadge } from '../ui/components.js';
import { Icon } from '../ui/icons.js';
import { useServices } from '../services.js';
import { themeLabels, useTheme } from '../theme.js';
import type { ThemePreference } from '../theme.js';

export function SettingsScreen() {
  const { session } = useServices();
  const [theme, setTheme] = useTheme();
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
      <Section title="Synchronizacja">
        <SyncBadge />
        <List>
          <ListRow icon="clock" iconTone="gray" title="Strefa czasowa" value={DEFAULT_TIMEZONE} />
        </List>
      </Section>
      <Section title="Powiadomienia" footer="Prośba o zgodę pojawi się dopiero po naciśnięciu „Włącz powiadomienia”.">
        <List><ListRow icon="bell" iconTone="red" title="Powiadomienia" value="Niedostępne" detail="Będą dostępne po zalogowaniu w zainstalowanej aplikacji" /></List>
      </Section>
      <Section title="Dane">
        <List>
          <ListRow icon="download" iconTone="green" title="Eksport danych" value="Niedostępne" detail="Wymaga zalogowania" />
          <ListRow to="/kosz" icon="trash" iconTone="gray" title="Kosz" detail="Usunięte wpisy przez 30 dni" />
        </List>
      </Section>
      <Section title="Aplikacja">
        <List><ListRow to="/ustawienia/instalacja" icon="phone" iconTone="blue" title="Instalacja na iPhonie" /></List>
      </Section>
      {session && (
        <Section>
          <button type="button" className="button button--destructive button--block" disabled>
            <Icon name="logout" size={20} /> Wyloguj
          </button>
        </Section>
      )}
    </>
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
