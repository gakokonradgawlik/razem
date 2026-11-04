# RAZ-3 — dowody i przekazanie

Gałąź `agent/raz-3`. Środowisko: Node 26.13.0 / npm 11.20.0 (oficjalny tarball w katalogu
tymczasowym, SHA256 zgodny z `SHASUMS256.txt`), Playwright 1.64.1 z Chromium i WebKit
pobranymi do katalogu tymczasowego. Bez danych użytkowników; teksty przykładowe tylko w placeholderach.

## Zrealizowano
System UI i szkielet wszystkich ekranów MVP — opis w design/interface.md, sekcja „Implementacja RAZ-3”.

Po review (commity cf8f697, a5a5c96): zawartość listy zakupów i formularz pozycji (nazwa, ilość, uwaga),
odhaczanie z „Cofnij”, szczegóły i edycja zadań, wydarzeń, notatek, ważnych dat i list, usuwanie
z potwierdzeniem, wiersze list prowadzące do szczegółów, stany wczytywania/niedostępne/nie znaleziono.
Lista tras do sprawdzenia nie jest wyliczana ręcznie: testy biorą ją z `routes` w `App.tsx`.

## Kontrole
| Kontrola | Wynik |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | PASS: 15 plików, 133 testy (web: `App.test.tsx`, `screens/records.test.tsx`, `ui/ui.test.ts`, `keyboard.test.tsx`) |
| `npm run build` | PASS (ostrzeżenie Vite o paczce >500 kB — polifill Temporal z kontraktów; do rozważenia code-splitting w zadaniu PWA) |
| `npm run test:e2e` | PASS 33, 1 pominięty (safe-area przez CDP działa tylko w Chromium; w WebKit pominięty) |

E2E (`tests/e2e/interface.spec.ts`, Chromium desktop + WebKit z profilem iPhone 13, `pl-PL`, Europe/Warsaw):
- wszystkie trasy z `App.tsx` (35, parametry wypełnione UUID; w buildzie produkcyjnym szczegóły pokazują stan „Nie można wyświetlić wpisu”) × szerokości 375/390/430/1280: brak poziomego scrolla, każdy widoczny cel ≥44×44 px
  (dla radio/checkbox — etykieta), każda kontrolka ma dostępną nazwę, pola ≥16 px; także po walidacji i w widoku miesiąca.
- Duży tekst (root 200 %) na wszystkich trasach przy 375 px, ciemny motyw (systemowy i wybrany),
  `prefers-reduced-motion` (menu bez animacji), zapamiętanie motywu po przeładowaniu.
- Safe area (Chromium `Emulation.setSafeAreaInsetsOverride` 47/34 px): pasek zakładek i pasek formularza.
- Klawiatura: hak CSS ukrywa pasek i dodaje odstęp; logika `visualViewport` testowana jednostkowo.
- Formularz: prywatność „Tylko ja/Wspólne” widoczna przed zapisem, fokus na błędnym polu, po nieudanym
  zapisie treść zachowana, URL bez zmian, brak jakiejkolwiek bazy IndexedDB.
- `tests/e2e/records.spec.ts` na aplikacji testowej (127.0.0.1:4318, syntetyczne wpisy z długimi polskimi nazwami):
  21 ekranów z treścią (zawartość listy, pozycja nowa/edycja, szczegóły i edycja każdego typu, wpis nieznaleziony) × 4 szerokości
  × 2 silniki — brak poziomego scrolla, cele ≥44 px, nazwy kontrolek; duży tekst 200 % na liście zakupów;
  odhaczenie → „Kupione” → Cofnij; walidacja formularza pozycji z zachowaniem treści; edycja z widocznością jako tekst
  i Anuluj; ostatni przycisk strony przewija się ponad dolny pasek.
- Testy jednostkowe (`screens/records.test.tsx`): osiągalność lista → szczegóły → edycja dla wszystkich typów, patch tylko ze
  zmienionymi polami i `baseVersion`, brak zapisu bez zmian, pozycja bez własnej widoczności, pozycja z innej listy
  i cudzy wpis jako „Nie znaleziono wpisu” bez treści i działań, nieudane odhaczenie/usunięcie zgłoszone, dane niezgodne
  z kontraktem nie są wyświetlane, przypisanie zadania względem oglądającego, wyszukiwanie notatek bez polskich znaków.
- Kontrast tokenów (jasny i oba warianty ciemnego) liczony wzorem WCAG w `ui/ui.test.ts`: tekst ≥4,5:1, obramowania i ikony ≥3:1.

## Kontrola wizualna
Zrzuty (`RAZEM_SCREENSHOTS=<katalog> npm run test:e2e`) ekranów Dzisiaj, Nowe zadanie (z błędem
walidacji), Nowa notatka, Ustawienia i Logowanie w 375/390/430/1280 px, Chromium i WebKit — obejrzane,
nie są commitowane. Zauważone i poprawione: format daty/godziny w WebKit (locale e2e ustawione na pl-PL).
Po review: zrzuty zawartości listy zakupów, nowej pozycji, szczegółów zadania i edycji notatki × 4 szerokości × 2 silniki —
obejrzane; poprawiono nachodzenie znacznika „Wspólne” na długi tytuł oraz tekst przy zadaniu powtarzanym, który
obiecywał niedostępne odhaczanie terminu.

## Granice — NIE zweryfikowano
- Fizyczny iPhone: Safari/PWA standalone, prawdziwa klawiatura, notch/Dynamic Island, VoiceOver, Dynamic Type
  z ustawień systemu. WebKit w Playwright i emulacja safe-area ich nie zastępują (lista w quality/acceptance.md).
- Odhaczanie pojedynczych terminów zadań powtarzanych, przywracanie z kosza, udostępnienie kopii notatki, agregacja wpisów na ekranie Dzisiaj.
- Rzeczywiste logowanie, zapis lokalny, synchronizacja, eksport, push, wylogowanie z ostrzeżeniem — RAZ-5 i kolejne.
- Manifest, ikony PNG i Service Worker — zadanie PWA.
