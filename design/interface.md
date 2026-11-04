<!-- razem/design/interface.md · updated 2026-11-04 by Claude (RAZ-3, po review) -->
# Razem — interfejs
## Kierunek
Spokojny, czytelny interfejs inspirowany iOS: systemowy krój -apple-system, system-ui; jasne powierzchnie, zaokrąglone grupy, subtelne separatory, niebieski akcent, oszczędna ikonografia. Bez kopiowania marki Apple ani zewnętrznych fontów/zasobów koniecznych do offline.
Nazwa i ikona: Razem; autorski prosty znak dwóch połączonych kształtów. Ikony lokalne, apple-touch-icon 180 oraz manifest 192/512 i wariant maskable z bezpiecznym marginesem.

## Nawigacja
Dolny pasek: Dzisiaj, Zakupy, Zadania, Kalendarz, Więcej. Więcej: Notatki, Ważne daty, Kosz, Ustawienia. Jeden widoczny przycisk dodawania w kontekście ekranu. Ekrany szczegółów i formularze z jasnym Zapisz/Anuluj; dla szybkiego odhaczania zapis natychmiast lokalny i opcja Cofnij.
Na szerokim ekranie boczna nawigacja i ograniczona szerokość treści; te same możliwości.

## Interakcje
- Cele dotykowe min. 44x44 CSS px, etykiety kontrolek i obsługa VoiceOver.
- Pola tekstowe min. 16 px, bez blokowania zoomu; poprawna klawiatura, fokus i walidacja przy polu.
- Uwzględnij safe-area-inset, dynamiczny viewport i klawiaturę ekranową.
- Gesty przesunięcia opcjonalne: każda operacja ma też przycisk/menu.
- Jasny/ciemny zgodny z systemem, kontrast co najmniej WCAG AA, prefers-reduced-motion.
- Widoczne puste stany z działaniem i realistyczne polskie przykłady; dane przykładowe tylko w trybie demo/test.
- Statusy: Offline; Zapisywanie na tym urządzeniu; Zmiany czekają na wysłanie (liczba); Zsynchronizowano [czas]; Serwer niedostępny; Zaloguj się, aby wysłać zmiany; Zmiana wymaga sprawdzenia.
- Nie utożsamiaj navigator.onLine z dostępnością serwera.
- Prywatność widoczna tekstowo ('Tylko ja'/'Wspólne'), nie samym kolorem.
- Przy konflikcie pokaż moją i zapisaną na serwerze wersję; wybór wersji lub ręczne połączenie, bez utraty tekstu.
- Przy błędzie quota pokaż informację i możliwość eksportu oczekujących zmian; nie potwierdzaj zapisu, który się nie powiódł.

## Powiadomienia i instalacja
Własny ekran objaśnia 'Udostępnij → Do ekranu początkowego'; nie obiecuj przycisku beforeinstallprompt na iOS. Nie wyświetlaj systemowej prośby push przy pierwszej wizycie; dopiero po naciśnięciu Włącz powiadomienia. Rozróżnij brak wsparcia, brak instalacji, odmowę i niedostępną subskrypcję.
Pokaż ostatnią synchronizację i ostrzeżenie o niewysłanych zmianach przed wylogowaniem. Żadnych surowych nazw API, ścieżek, tokenów czy szczegółów implementacji w zwykłych ekranach.


## Implementacja RAZ-3 (stan kodu)
- `apps/web/src/ui/`: tokeny w `style.css` (jasny/ciemny przez `prefers-color-scheme` lub `data-theme`), lokalne ikony SVG (`icons.tsx`, w tym znak Razem), komponenty `components.tsx` (nagłówek ekranu, przycisk dodawania, `Menu`, `List`/`ListRow`, `EmptyState`, `Notice`, `SyncBadge`, `Segmented`, `TextField`/`TextArea`/`SelectField`/`DateField`/`Toggle`, `PrivacyPicker`, `PrivacyTag`) i `form.tsx` (pasek Anuluj · tytuł · Zapisz, błędy przy polach, fokus na pierwszym błędzie, treść nigdy nie jest czyszczona po błędzie).
- Router History API (`router.tsx`) z parametrami (`/zakupy/:listId`; parametr pasuje tylko do UUID, więc `/zakupy/nowa` nie koliduje). Trasy w `App.tsx` (`routes`): ekrany główne i Więcej; tworzenie (`/zakupy/nowa`, `/zadania/nowe`, `/kalendarz/nowe`, `/notatki/nowa`, `/wazne-daty/nowa`); szczegóły i edycja (`/zadania/:taskId[/edycja]`, `/kalendarz/:eventId[/edycja]`, `/notatki/:noteId[/edycja]`, `/wazne-daty/:dateId[/edycja]`); zakupy: zawartość listy `/zakupy/:listId`, zmiana nazwy `/zakupy/:listId/edycja`, nowa pozycja `/zakupy/:listId/pozycje/nowa`, edycja pozycji `/zakupy/:listId/pozycje/:itemId`; ustawienia, instalacja, zmiana hasła, logowanie. Poniżej 900 px dolny pasek, od 900 px boczna nawigacja i treść maks. 44rem.
- Dane i auth przez port `AppServices` (`services.tsx`). Domyślny adapter nic nie zapisuje: zapis zwraca „Nie zapisano…”, logowanie/zmiana hasła „funkcja nie jest jeszcze dostępna”. RAZ-5 podłącza `/api/auth/*`, Dexie (wpis + outbox w jednej transakcji) i koordynator sync (`syncState`). Port odczytu: `listRecords({entityType, parentId})`, `getRecord(type, id)` (wynik `ok`/`not_found`/`unavailable`; `not_found` także przy braku dostępu — bez ujawniania istnienia wpisu), zapis: `saveRecord`, `updateRecord({id, baseVersion, patch})`, `deleteRecord` (do kosza). Domyślny adapter zwraca `unavailable`, więc listy pokazują stany puste, a szczegóły „Nie można wyświetlić wpisu” — brak danych przykładowych. Dane wpisu są walidowane schematem kontraktu przed wyświetleniem.
- Wspólne części ekranów wpisów: `screens/records.tsx` (`useRecords`/`useRecord`, `RecordGate`, `MissingRecord`, `DetailFields`, `DeleteRecord` z potwierdzeniem, `FixedPrivacy`, `persist`). Edycja używa tego samego formularza co tworzenie, wypełnionego wpisem; widoczność pokazana tekstem i niezmienna; wysyłane są tylko zmienione pola z `baseVersion`, brak zmian = brak zapisu. Pozycja zakupów dziedziczy widoczność listy (bez wyboru), pola: nazwa, ilość (tekst), uwaga. Odhaczenie pozycji i ukończenie zadania jednorazowego zapisują się od razu, z „Cofnij” (zakupy) i komunikatem błędu przy niepowodzeniu; kupione są na dole listy. Przypisanie zadania „Ja/Druga osoba” jest pokazywane względem oglądającego (`mine`).
- Formularze budują dane przez schematy `dataSchemas` z `@razem/contracts`; domyślna widoczność z `defaultVisibility`; prywatne zadanie wymusza przypisanie „Ja”; wydarzenie całodniowe ma wyłączny koniec (dzień po ostatnim); godziny przez `localTimeToInstant` w Europe/Warsaw.
- Status sync: słownik z sekcji Interakcje (`syncLabel`). Bez sesji: „Nie zalogowano” (lub „Zaloguj się, aby wysłać zmiany”, gdy coś czeka); „Offline” tylko gdy `navigator.onLine === false` — nigdy jako dowód dostępności serwera.
- Motyw: preferencja urządzenia w `localStorage` (`razem:theme`), stosowana przed renderem. Rozmiar tekstu: `font: -apple-system-body` (Dynamic Type) i jednostki rem.
- Safe area: `env(safe-area-inset-*)` w pasku, treści, pasku formularza i ekranie logowania. Klawiatura: `visualViewport` → `--keyboard-inset` i `data-keyboard="open"` (ukrywa dolny pasek podczas edycji; pinch-zoom bez edycji ignorowany).
- Poza zakresem RAZ-3: manifest i ikony PNG 180/192/512/maskable, Service Worker (zadanie PWA); faktyczny magazyn wpisów i outbox (RAZ-5); odhaczanie pojedynczych terminów zadań powtarzanych (`task_occurrence`), przywracanie z kosza, udostępnienie kopii notatki, przypomnienia, konflikty i eksport (moduły funkcjonalne). Ekran Dzisiaj nie agreguje jeszcze wpisów.
