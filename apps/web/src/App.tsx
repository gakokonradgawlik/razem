import { defaultVisibility } from '@razem/contracts';

export function App() {
  const privacy = defaultVisibility('note') === 'private' ? 'Tylko ja' : 'Wspólne';
  return (
    <main>
      <p className="eyebrow">Wspólna przestrzeń</p>
      <h1>Razem</h1>
      <section aria-labelledby="today">
        <h2 id="today">Dzisiaj</h2>
        <p>Tu znajdziecie Wasze plany, zadania i zakupy.</p>
        <p>Aplikacja jest w przygotowaniu. Logowanie i zapisywanie będą dostępne w kolejnych etapach.</p>
      </section>
      <aside aria-label="Prywatność notatek">
        <h2>Wasze sprawy, Wasz wybór</h2>
        <p>Nowe notatki: <strong>{privacy}</strong>. Zakupy, zadania i wydarzenia są domyślnie wspólne.</p>
      </aside>
    </main>
  );
}
