# RAZ-8 — zadania, przypisania i powtarzalne obowiązki

Gałąź `agent/raz-8`, implementacja `de00ffa`, poprawki i rozszerzenia regresji
`413c868`. Bez scalenia do main i bez wdrożenia. Zasady: [tasks.md](../architecture/tasks.md).

## Zrealizowany zakres

- Formularze i filtry zadań czytają IndexedDB konta. Utworzenie, edycja, przypisanie,
  ukończenie/cofnięcie i wystąpienia zapisują rekord + outbox atomowo; restart offline
  zachowuje dane. Assignee jest względem ownera, a etykiety/formularze względem czytelnika.
- Private tylko self, dziedziczone ACL wystąpień, brak w filtrach/pull/konfliktach/API
  drugiego konta. Widoczność niezmienna. Odpowiedzi na guessed ID bez treści/stanu.
- Jeden szablon i naturalny klucz wystąpienia, stały UUID z taskId i lokalnej daty.
  Dwa telefony odhaczające z różnymi timestampami nie tworzą dwóch ukończeń ani zdarzeń.
  Zagubiony ACK oraz późniejsze Cofnij zachowują kolejność i intencję.
- Reguły daily/weekly/monthly, 31. dzień bez dryfu lutowego, nominalna godzina i DST.
  Nowa reguła od przyszłego dnia zachowuje wcześniejsze terminy i ukończenia.
  Pierwszy przyszły termin można przesunąć/zmienić, zatrzymać i ponownie uruchomić.
  Pusty zatrzymany harmonogram pozostaje dostępny w Ukończonych bez sztucznego completedAt.
- Wspólne helpery terminów/zaległości/odbiorców/przypomnień. Migracja SQLite v4 dodaje
  server-only `task_events` bez treści, w transakcji domeny/journala/receipt. Nie ma
  wysyłki push z UI ani implementacji dispatchera; RAZ-12 odczyta aktualne ACL/stan
  i wykona skan istniejących zadań oraz deduplikowane planowanie.
- Jawny sync v2, ponieważ stary strict klient nie odczyta rozszerzenia recurrence.
  V1 push i pull bez nowego nagłówka dostają upgrade_required przed danymi/zapisem.
  Aktualizacja PWA zachowuje Dexie v2, outbox, identyfikatory mutacji/urządzenia i cursor.

## Weryfikacja — 05.11.2026

Node 26.13.0 pobrano z oficjalnego nodejs.org i sprawdzono SHASUMS256 przed użyciem.
Systemowy Node 22 nie był używany do testów. Dane wyłącznie syntetyczne.

| Kontrola | Wynik |
| --- | --- |
| `npm run typecheck` | PASS, stan końcowy |
| `npm test -- --reporter=dot` | 190 PASS, 21 plików, stan końcowy |
| `npm run build` | PASS, wszystkie workspaces; ostrzeżenie Vite o bundle >500 kB |
| `npm run test:e2e -- --workers=4` | 57 PASS, 1 SKIP, 3 min; pełny przebieg po głównej implementacji |
| `npm run test:e2e -- tests/e2e/tasks.spec.ts --workers=2` | 4 PASS, 30,5 s; powtórzenie na końcowym buildzie po ostatnich poprawkach |
| `docker compose -f deploy/compose.yaml config --quiet` | PASS |
| `git diff --check` | PASS |

SKIP to istniejący test safe-area przez CDP w WebKit (ten silnik nie ma CDP).
Nie zaliczano go jako PASS. JSDOM wypisuje istniejące ostrzeżenia scrollTo, a testy
współdzielonych kart — zamknięcia połączenia Dexie podczas usuwania bazy; asercje przeszły.

Dowody w kodzie:

- `packages/contracts/src/tasks.test.ts`: 31.01→28/29.02→31.03, interwały,
  daily/weekly Europe/Warsaw w obu zmianach DST, start w luce 02:30,
  historia reguł, cofnięcia/stop, pierwszy przyszły termin, granica dnia i 09:00,
  stabilne UUID, odbiorcy private/shared oraz walidacja złej strefy bez wyjątku.
- `apps/web/src/offline/tasks.test.ts`: realne Fastify/SQLite + Dexie na dwóch
  niezależnych magazynach. CRUD offline/restart/kolejka, utracona odpowiedź,
  konflikt edycji/ukończenia z obiema wersjami, dwa ukończenia/różne timestampy,
  jeden task i occurrence, jedno zdarzenie, undo za zagubionym ACK,
  zmiana reguły bez utraty zaległości, private i bezpośrednie negatywne próby API.
- `packages/db/src/migrations.test.ts`: v3→v4 zachowuje szablony/ukończenia/journal,
  backup/FK/integrity; stare ścieżki v1/v2 także przeszły.
  `records.test.ts`: brak treści w zdarzeniach, idempotencja, konflikty,
  wymuszony błąd zapisu zdarzenia cofa także domenę/journal.
- `apps/server/src/sync/sync.test.ts`: v1 nie zapisuje receipt ani danych,
  stary pull nie otrzymuje rekordów, v2 obsługuje dawny kształt reguły.
  Starsze regresje prywatności, idempotencji, konfliktów i kont nadal przeszły.
- `apps/web/src/screens/records.test.tsx`: zakończony harmonogram nie ma fałszywej
  zaległości; zatrzymany przed startem pozostaje dostępny do edycji.
- `tests/e2e/tasks.spec.ts`, Chromium + WebKit:
  1. Dwa konta. Utworzenie/edycja/przypisanie, godzina, ukończenie/cofnięcie,
     filtry i private offline. Zamknięcie całego procesu i start trwałego profilu
     bez sieci. Powrót online, odpowiedzialność względem partnera, ukończenie
     na drugim koncie, brak private w guessed URL, każdym filtrze i pełnym pull.
  2. Dwa telefony odhaczają tę samą datę offline. Po sync jeden kolejny termin
     i jedna historia; przywrócenie/Cofnij. Nowa reguła od przyszłego dnia,
     zachowanie starych ukończeń/zaległych. Zmiana pierwszego przyszłego terminu,
     zatrzymanie, odczyt przez partnera i ponowne uruchomienie harmonogramu.

Wstępny przebieg unit niezaliczony: oczekiwania migracji wymagały v4; starszy fixture
reguły miał inny dueDate niż startDate (zachowano zgodność); test konfliktu dwóch
różnych timestampów ukończenia dostosowano do semantyki tego samego zamiaru,
pozostawiając rzeczywisty konflikt ukończ/cofnij. Wstępny typecheck nowego testu
wykrył opcję Playwright `exact` używaną w Testing Library; poprawiono. Pobranie
przeglądarek do domyślnego read-only katalogu nie powiodło się; użyto własnego /tmp.
Nie oznaczono tych prób jako zaliczonych.

## Sprzątanie i granice

Testy zakończone, własne serwery zatrzymane. `ss` potwierdził wolne porty
4317, 4318, 4319, 4320 i 4321. Brak własnych tymczasowych katalogów
razem-tasks-profile-*, razem-shopping-profile-*, razem-pwa-profile-*, razem-client-*,
razem-e2e-*, razem-mig-* i razem-sync-* w /tmp. Usunięto własne narzędzia/przeglądarki
`/tmp/raz-8-tools` oraz `test-results/`. Nie tworzono kontenerów ani sieci, nie ruszano
trwałych danych ani cudzych procesów. Nie pozostawiono podglądu.

Nie testowano fizycznego iPhone'a/VoiceOver ani instalacji HTTPS właściciela.
Automatyczny WebKit nie jest ich odpowiednikiem. Nie wdrażano i nie sprawdzano
rzeczywistego dostarczania push; należą do dalszych zadań. RAZ-12 powinien uwzględnić
server-only task_events i wymagany początkowy skan starych szablonów.
