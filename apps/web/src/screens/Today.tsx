import { EmptyState, Menu, ScreenHeader, Section, SyncBadge } from '../ui/components.js';
import { formatLongDate, todayIn } from '../dates.js';

export const addMenuItems = [
  { label: 'Zadanie', icon: 'tasks', to: '/zadania/nowe' },
  { label: 'Wydarzenie', icon: 'calendar', to: '/kalendarz/nowe' },
  { label: 'Lista zakupów', icon: 'shopping', to: '/zakupy/nowa' },
  { label: 'Notatka', icon: 'note', to: '/notatki/nowa' },
] as const;

export function TodayScreen() {
  const date = formatLongDate(todayIn());
  return (
    <>
      <ScreenHeader title="Dzisiaj" subtitle={date.charAt(0).toUpperCase() + date.slice(1)}
        action={<Menu label="Dodaj" items={[...addMenuItems]} />} />
      <SyncBadge />
      <Section title="Najbliższe wydarzenia">
        <EmptyState icon="calendar" title="Brak wydarzeń" text="Dzisiaj i w najbliższych dniach nie ma nic w kalendarzu ani ważnych dat."
          action={{ label: 'Dodaj wydarzenie', to: '/kalendarz/nowe' }} />
      </Section>
      <Section title="Zadania na dziś i zaległe">
        <EmptyState icon="tasks" title="Nic na dziś" text="Zadania z dzisiejszym lub minionym terminem pojawią się tutaj."
          action={{ label: 'Dodaj zadanie', to: '/zadania/nowe' }} />
      </Section>
      <Section title="Zakupy">
        <EmptyState icon="shopping" title="Brak list zakupów" text="Utwórzcie listę, np. „Biedronka w sobotę”, i dopisujcie do niej rzeczy."
          action={{ label: 'Przejdź do zakupów', to: '/zakupy' }} />
      </Section>
    </>
  );
}
