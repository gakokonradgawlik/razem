# RAZ-9 — kalendarz, wydarzenia i ważne daty

Gałąź `agent/raz-9`. Implementacja `6287665`, poprawki `3f8396a`, weryfikacja zapisu przed restartem `c16493d`.
Bez scalenia do main i bez wdrożenia. Kontrakt: [calendar.md](../architecture/calendar.md).

## Zakres i granice

- Agenda i miesiąc pokazują wydarzenia całodniowe/godzinowe/wielodniowe i ważne daty.
  Nawigacja miesiącami, wybór dnia, historia przez początkowy dzień agendy.
- Formularz wydarzenia: nazwa/opis, zakres, IANA, widoczność, przypomnienie.
  Stałe date-only z wyłącznym końcem, UTC Z plus IANA dla godzin, walidacja także po DST.
- Roczne daty z opcjonalnym rokiem i licznikiem. 29.02 ograniczone do 28.02 bez utraty reguły.
- Lokalny wpis i jego przypomnienie z outbox w jednej transakcji. Rollback po quota.
  Edycja tylko zmienionych pól; niezmieniona konfiguracja przypomnienia nie jest nadpisywana.
- Prywatność z istniejącego serwisu ACL, baza per konto. Przypomnienie dziedziczy zakres
  rodzica, jest ukryte po usunięciu rodzica. Kontrakt odbiorców nie uwzględnia obcego domu.
- Payload/sync v2, SQLite v4, Dexie v2 bez zmian schematu. Przetestowany upgrade starych danych.
- RAZ-11 doda agregację Dzisiaj i ustawienie strefy domu; obecnie widoki kalendarza grupują
  godziny w Europe/Warsaw, szczegóły pokazują strefę wydarzenia. Podsumowania muszą korzystać
  z odczytu przez ACL, opisanego w architecture/calendar.md, bez alternatywnej ścieżki danych.
- RAZ-12 dostarczy wysyłkę push. Tu ustawienie zapisuje się offline; UI jawnie wskazuje brak
  wysyłki. Domyślnie wyłączone; po włączeniu godziny 30 min wcześniej, daty o 09:00.
  Nie obiecujemy alarmu offline ani zewnętrznej integracji Apple/Google.

## Weryfikacja — 05.11.2026

Node26.13.0 z oficjalnego nodejs.org, archiwum sprawdzone względem SHASUMS256.
Wszystkie dane i hasła w testach syntetyczne. Kontrole końcowe:

| Kontrola | Wynik |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test -- --reporter=dot` | 201 PASS, 23 pliki |
| `npm run build` | PASS, wszystkie workspaces; istniejące ostrzeżenie bundle >500 kB |
| `npm run test:e2e -- --workers=2` | 59 PASS, 1 SKIP, 2,5 min; końcowy build |
| `docker compose -f deploy/compose.yaml config --quiet` | PASS |
| `git diff --check` | PASS |

Dowody w testach:

- `packages/contracts/src/calendar.test.ts`: DST Warszawa 29.03 i 25.10.2026,
  rozwiązanie luki/overlap, niepoprawny koniec po DST, cztery strefy, daty całodniowe,
  północ wyłączna, przełom roku, 29.02 w kolejnych latach, rocznica bez roku,
  licznik i start w przyszłości. Czas przypomnienia oraz odbiorcy private/shared/usunięty/obcy dom.
- `apps/web/src/offline/calendar.test.ts`: rzeczywisty Fastify/SQLite i dwa osobne magazyny
  Dexie. CRUD offline/restart, utrata ACK, synchronizacja drugiego konta, private i reminder
  poza danymi partnera, edycja/wyłączenie przypomnienia/usunięcie, rollback rodzica/outbox
  po złym czasie i quota. Upgrade v1→v2 zachowuje daty, identyfikatory i parent przypomnienia.
- `packages/db/src/migrations.test.ts`: upgrade v2→v4 zachowuje kalendarz, ważną datę 29.02
  bez roku i prywatne przypomnienie bez zmiany treści/wersji/ACL; FK/integrity i zakaz
  zmiany zakresu. Nie dodawano zbędnej migracji i nie zmieniano zamrożonego SQL.
- `apps/web/src/screens/records.test.tsx`: poniedziałek, oznaczenia dni, wybór dnia i koniec
  wyłączny, ważna data bez fikcyjnego licznika, widoczność, walidacja DST i złej IANA przy
  polu bez utraty treści. Edycja nazwy nie wysyła niezmienionego przypomnienia.
- `tests/e2e/calendar.spec.ts`: Chromium i mobilny WebKit 390×844. Offline formularze,
  edycja, rocznica bez roku i z licznikiem, oba widoki, cele miesiąca ≥44 px i brak scrolla
  poziomego. Strefa urządzenia Los_Angeles, wpisu Kiritimati, grupowanie Warszawa.
  Restart całego procesu z trwałym profilem bez sieci, zachowany opis i przypomnienie,
  sync partnera, negatywne szczegóły/agenda/miesiąc i pełny pull private oraz usuwanie.
- Istniejące testy e2e obejmują layout formularzy/szczegółów i miesiąca przy 375/390/430/1280 px,
  duży tekst, ciemny motyw, PWA/cache, sync/konflikty, zakupy i zadania.

Wstępne niezaliczone próby: systemowy Node22 bez crypto.argon2; zbyt ogólny selektor
przycisku dnia w nowym teście; oczekiwanie kolejności UUID przy równym queuedAt migracji
(zamiast zbioru zachowanych ID, przy istniejącej obsłudze zależności rodzic/dziecko).
Pierwszy izolowany e2e kalendarza miał 2 PASS. Pełny przebieg przed końcowymi poprawkami:
48 PASS, 11 FAIL, 1 SKIP — dawne sprawdzenie tabeli miesiąca na originie bez konta,
utrata świeżej edycji po restarcie Chromium, błąd silnika WebKit w dwóch testach zakupów.
Dalszy przebieg: 58 PASS, 1 FAIL (Chromium kalendarz), 1 SKIP. Bezpośredni odczyt
IndexedDB wykazał, że nowy test przechodził do kolejnego ekranu, zanim kończył się
asynchroniczny zapis: `getByText` widział tekst w textarea jeszcze w formularzu.
Test czeka teraz na adres szczegółów po zapisie i odczytuje rekord bezpośrednio
z IndexedDB przed restartem. Rozważane strict durability nie usuwało przyczyny
i zostało cofnięte; brak dowodu na utratę potwierdzonego zapisu przez aplikację.
Layout bada istniejący fixture origin. Końcowy przebieg używa niezmiennego buildu
i dwóch workerów, z cache przeglądarki we własnym /tmp.
Nie zaliczano nieudanych przebiegów jako dowodu spełnienia DoD.

## Sprzątanie i przekazanie

Końcowy przebieg: 59 PASS i 1 SKIP. Pominięty test to istniejąca emulacja safe-area
przez CDP w WebKit (brak CDP); nie oznaczano go jako zaliczonego.
Zakończono własne testy, serwery i procesy przeglądarek. Sprawdzono wolne porty
4317, 4318, 4319, 4320 i 4321. Usunięto własne narzędzia, przeglądarki, profile,
bazy i logi z `/tmp/raz-9-tools`, raporty `test-results/` oraz 61 własnych katalogów
`razem-client-*`/`razem-sync-*` pozostałych po pierwszym nieudanym setupie Node22.
Nie pozostały własne katalogi razem-* z tej sesji w /tmp.
Nie tworzono kontenerów/sieci i nie ruszano danych trwałych. Brak podglądu do pozostawienia.
Nie testowano fizycznego iPhone'a, VoiceOver ani instalacji właściciela; WebKit nie jest
ich zamiennikiem. Brak wdrożenia i rzeczywistego dostarczania push.
