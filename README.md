# Razem

Prywatny organizer dla dwóch osób. Fundament RAZ-1: npm workspaces, wspólne
kontrakty i szkielety aplikacji. RAZ-2: schemat SQLite i migracje, dwa konta,
sesje i serwis uprawnień. RAZ-4: serwer synchronizacji (push/pull, idempotencja,
konflikty, kosz/tombstones, retencja). RAZ-3: interfejs w stylu iOS i szkielet wszystkich
ekranów — listy, szczegóły, edycja, zawartość list zakupów. RAZ-5: prawdziwe logowanie,
lokalna baza IndexedDB per konto (Dexie), kolejka zmian, synchronizacja aktywnej aplikacji,
konflikty, eksport niewysłanych zmian i wylogowanie. RAZ-6: instalacja PWA, lokalny shell
offline i aktualizacje po zamknięciu wszystkich okien aplikacji. RAZ-8: zadania i przypisania, filtry oraz powtarzalne obowiązki z historią i ukończeniami
poszczególnych terminów. RAZ-9: agenda i miesiąc z wydarzeniami wielodniowymi, strefami IANA i corocznymi ważnymi datami. Opcjonalne ustawienie przypomnienia zapisuje się offline; wysyłkę dostarczy RAZ-12.

Zadania działają lokalnie i synchronizują się z drugim kontem. Wspólne zadania można
przypisać sobie, drugiej osobie lub obojgu; prywatne tylko sobie. Zadanie cykliczne
pokazuje najstarszy nieukończony termin. Szczegóły zawierają historię i przyciski
cofnięcia ukończeń. Zmianę reguły/godziny wprowadza się od przyszłego dnia,
bez usuwania wcześniejszych zaległości. Zobacz [architecture/tasks.md](architecture/tasks.md) i dowody [quality/raz-8.md](quality/raz-8.md).

Po aktualizacji z wersji sprzed RAZ-8 stara PWA pokaże potrzebę aktualizacji sync:
zapisz formularze, zamknij wszystkie okna Razem i otwórz ponownie. Oczekujące zmiany
pozostają. Sync używa v2, health v1; migracja SQLite v4 dodaje wyłącznie zdarzenia
zadań dla przyszłego workera. Nie uruchamia wysyłania powiadomień.

Kalendarz pokazuje wydarzenia i ważne daty w agendzie oraz miesiącu (tydzień od
poniedziałku). Kliknij dzień miesiąca, aby wyświetlić jego wpisy. „Agenda od dnia”
pozwala przeglądać także historię. Całodniowy koniec w formularzu jest wliczony;
zmiana strefy telefonu nie przesuwa dat. Rok początkowy ważnej daty jest opcjonalny.
Szczegóły: [architecture/calendar.md](architecture/calendar.md),
dowody: [quality/raz-9.md](quality/raz-9.md).

## Instalacja PWA i offline

Pierwsze otwarcie wymaga internetu i serwera: zaloguj się, poczekaj na „Zsynchronizowano”
oraz „Aplikacja gotowa do uruchamiania offline” w Ustawienia → Instalacja na iPhonie.
W Safari: Udostępnij → Do ekranu początkowego → Dodaj. Uruchom ikoną jeszcze raz online,
sprawdź konto i gotowość offline; potem działa też uruchomienie od zera w trybie samolotowym.
Produkcja wymaga HTTPS z zaufanym certyfikatem (lokalny loopback HTTP jest wyjątkiem testowym).
Service Worker rejestruje się tylko w buildzie produkcyjnym, nie w `npm run dev`.

Nowa wersja wyświetla komunikat: zapisz formularze, zamknij **wszystkie** okna/karty Razem
i otwórz ponownie. Nie ma automatycznego przeładowania. Zapisany outbox i konflikty zostają
w bazie konta; nie muszą być wysłane przed aktualizacją. Sama niezapisana treść formularza
nie przetrwa świadomego zamknięcia — najpierw użyj Zapisz.
Ochrona magazynu jest prośbą do przeglądarki, nie backupem. Odmowa/brak wsparcia nie blokuje
zapisu; usunięcie danych witryny może usunąć niewysłane zmiany. Ustawienia pokazują wynik
i udostępniają eksport. Szczegóły oraz granice testów: [quality/raz-6.md](quality/raz-6.md).

## Start

Wymagane Node **26.13.0 LTS**, npm **11.20.0**, lokalny dysk oraz toolchain
`python3 make g++` do kompilacji natywnego SQLite, gdy potrzebny. Wersje są wymuszane
przez `.npmrc`; `nvm install && nvm use` odczytuje `.nvmrc`.

```sh
npm ci
cp .env.example .env
npm run dev
```

Web: http://127.0.0.1:5173, API: http://127.0.0.1:3100. `.env.example` ustawia
`COOKIE_SECURE=false` wyłącznie dla lokalnego http; produkcja odrzuca tę wartość. Vite przekazuje `/api`,
`/healthz`, `/readyz` do API. `Ctrl+C` zatrzymuje web/API/worker.
SQLite powstaje w `./data/razem.sqlite`; katalog jest ignorowany przez Git.
Polecenia uruchamiaj z katalogu głównego. Zmiana portu API wymaga też zmiany proxy
w `apps/web/vite.config.ts`; zajęte porty sprawdź przed startem.
Zmienna `DATABASE_PATH` może wskazywać osobną bazę testową. Nie używaj NFS/SMB.

## Konta (lokalne CLI administratora)

Nie ma rejestracji, konta demo ani hasła domyślnego. Jedno gospodarstwo i dokładnie
dwa konta tworzy administrator na serwerze; hasła podaje się przez stdin (ukryte na
terminalu, potwierdzane), nigdy w argumentach/zmiennych. CLI ich nie wypisuje.

```sh
npm run build
npm run admin -- bootstrap               # nazwa domu, strefa, 2× login/nazwa/hasło tymczasowe
npm run admin -- reset-password <login>  # nowe hasło tymczasowe, odwołuje wszystkie sesje
npm run admin -- revoke-sessions <login> # wylogowanie na wszystkich urządzeniach
npm run admin -- status | migrate | measure-argon2
# bez buildu: npm run admin:dev -- <polecenie>
# Docker: docker compose -f deploy/compose.yaml run --rm -it app node apps/server/dist/admin.js bootstrap
```

Pierwsze logowanie hasłem tymczasowym pozwala tylko na `/api/me`, zmianę hasła
i wylogowanie. Szczegóły sesji, CSRF i limitów: [security/access.md](security/access.md).

## Baza i migracje

`DATABASE_PATH` (domyślnie `./data/razem.sqlite`): katalog tworzony z prawami 0700,
plik 0600, WAL, `foreign_keys`, `busy_timeout=5000`. Migracje to zamrożony SQL
w `packages/db/src/migrations.ts`, z sumą kontrolną w `schema_migrations`. Stosuje je
tylko serwer przy starcie (albo `admin migrate`), każdą w transakcji, z kopią
`<baza>.pre-migration-v<N>-<czas>.bak` przed aktualizacją istniejących danych.
Worker nie migruje: czeka do 60 s i kończy się, gdy schemat nie odpowiada wersji.
Zmieniona/nieznana historia migracji blokuje start. Nie edytuj zastosowanej migracji —
dodaj nową wersję. Kopie `.bak` zawierają dane wrażliwe; usuwaj je po weryfikacji.

## Kontrole

```sh
npm run typecheck
npm test
npm run build
npx playwright install --with-deps chromium webkit
npm run test:e2e
docker compose -f deploy/compose.yaml config
```

`npm test` uruchamia rzeczywiste testy kontraktów, Fastify, SQLite/Drizzle i renderu
React. Playwright wymaga buildu i pakietów systemowych przeglądarek; uruchamia
własny serwer produkcyjny na **127.0.0.1:4317**, dwa odizolowane konteksty na test,
Chromium oraz WebKit. Serwer i tymczasowa baza są usuwane przy zakończeniu.
Drugi serwer, **127.0.0.1:4318** (Vite, `apps/web/vite.fixtures.config.ts`), serwuje tę samą
aplikację z syntetycznymi wpisami tylko do testów ekranów szczegółów/edycji; nie wchodzi do buildu.
Trzeci, **127.0.0.1:4319** (`tests/start-sync-server.mjs`), to zbudowany serwer i `web/dist`
z tymczasową bazą i dwoma syntetycznymi kontami do scenariuszy offline/konfliktów
(`tests/e2e/offline.spec.ts`); różni się tylko `secureCookies=false`, bo WebKit na Linuksie
nie przechowuje ciasteczek `Secure` po http.
Dwa dodatkowe serwery na **127.0.0.1:4320/4321** obsługują izolowane scenariusze PWA
Chromium/WebKit (`tests/e2e/pwa.spec.ts`). Używają kopii buildu z różnymi nazwami zasobów
wersji A/B, potrafią symulować niekompletną aktualizację i rzeczywistą awarię API.
Sterowanie awarią/wersją istnieje wyłącznie w skrypcie testowym, poza aplikacją produkcyjną.
Cold start zamyka cały proces przeglądarki i otwiera jej trwały profil przy odciętej sieci.
`reuseExistingServer: false` zapobiega badaniu cudzej usługi. Raporty z `test-results/`
usuń po analizie (mogą zawierać dane, gdy późniejsze testy użyją prawdziwych kont).
WebKit nie zastępuje fizycznego iPhone'a.

Lokalny pipeline bez hostingu Git: `sh scripts/ci.sh` — wykonuje `npm ci`, typy,
testy, build, e2e i walidację Compose. Przeglądarki i Docker Compose przygotuj raz
wcześniej. `npm run ci` wykonuje te same kontrole po instalacji.
W środowisku z read-only katalogiem domowym użyj własnego zapisywalnego
`npm_config_cache` i `PLAYWRIGHT_BROWSERS_PATH`; nie zmieniaj konfiguracji innych projektów.
Przy kompilacji SQLite wskaż również własny `npm_package_config_node_gyp_devdir`.

## Build i kontenery

```sh
npm run build
NODE_ENV=production npm start
```

Fastify obsługuje build web i API pod jednym originem, w tym ścieżki SPA.
`/healthz` sprawdza proces, `/readyz` również dostęp do SQLite. Każde `/api` wymaga
sesji (401); dane domenowe wyłącznie przez `/api/sync/push` i `/api/sync/pull`
(RAZ-4, opis w architecture/sync.md). Nagłówki typu `x-user-id` ani deviceId nie nadają uprawnień.
Za reverse proxy ustaw `RAZEM_PUBLIC_ORIGIN` (dokładny origin HTTPS) i ewentualnie
`RAZEM_TRUST_PROXY`.
Worker na razie utrzymuje połączenie i obsługuje zakończenie procesu; niczego nie wysyła.

`deploy/compose.yaml` definiuje app + worker i lokalny wolumen SQLite; host port
jest ograniczony do loopback, domyślnie 3100 (`RAZEM_PORT`). Obraz bazowy ma dokładną
wersję i digest, procesy działają jako `node`, bez dodatkowych capabilities.
Build: `docker compose -f deploy/compose.yaml build app`. Ten etap projektu nie
wdraża aplikacji. HTTPS/proxy i uruchomienie na serwerze należą do zadań operacyjnych.
Nie uruchamiaj `down -v` na instalacji z danymi. Nie używamy Vite preview w produkcji.

## Struktura i dokumentacja

| Ścieżka | Odpowiedzialność |
| --- | --- |
| `apps/web` | React/Vite; `src/offline/` – lokalna baza, komendy, kolejka, silnik sync, konto |
| `apps/server` | Fastify, health/readiness, sesje/auth, CLI `admin`, pliki web |
| `apps/worker` | osobny proces przypomnień — na razie lifecycle |
| `packages/contracts` | Zod i typy TS, daty, prywatność, sync v1 |
| `packages/db` | SQLite WAL, migracje, schemat Drizzle, repozytoria i serwis uprawnień |
| `tests/e2e` | rzeczywisty HTTP i render buildu w przeglądarkach |

Czytaj [docs/START.md](docs/START.md), [kontrakt v1](architecture/contracts.md),
[synchronizację](architecture/sync.md), [bezpieczeństwo](security/access.md)
i [repozytorium/wersje](operations/repository.md). Dokumentacja produktu opisuje
docelowe MVP; zrealizowany zakres i dowody: [quality/raz-1.md](quality/raz-1.md), [quality/raz-2.md](quality/raz-2.md), [quality/raz-3.md](quality/raz-3.md), [quality/raz-5.md](quality/raz-5.md).
PWA: [quality/raz-6.md](quality/raz-6.md). W repo nie ma kont demo, haseł domyślnych,
kluczy ani danych domowników.

## Notatki (RAZ-10)

Notatki są domyślnie prywatne, działają lokalnie offline, mają wyszukiwanie
w tytule/treści, kosz i przywracanie. Udostępnienie wymaga potwierdzenia i tworzy
niezależną wspólną kopię; oryginał pozostaje prywatny. Konflikt pozwala połączyć
tekst ręcznie, a błędy zapisu zachowują formularz. Szczegóły i granice:
[architecture/notes.md](architecture/notes.md), dowody: [quality/raz-10.md](quality/raz-10.md).

## Dzisiaj i ustawienia (RAZ-11)

Dzisiaj pokazuje lokalne zadania na dziś/zaległe (z odhaczaniem i Cofnij), wydarzenia
oraz ważne daty z siedmiu dni i aktywne zakupy. Menu Dodaj otwiera formularze pięciu
typów; zapis działa offline. Każda sekcja ma skrót do pełnego modułu.

Ustawienia → Profil i domownicy: własna nazwa, nazwa drugiej osoby, wspólna strefa
domu. Zapis profilu/strefy i preferencji powiadomień wymaga serwera; ostatnie
ustawienia są dostępne po restarcie offline. Motyw zapisuje się na urządzeniu.
Zmiana strefy nie przesuwa istniejących terminów. Pełny eksport będzie dostępny
z RAZ-13, wysyłka powiadomień z RAZ-12; aktualnie są jasno oznaczone jako niedostępne.
Eksport niewysłanych zmian, kosz, konflikty, instalacja i wylogowanie są dostępne.
Szczegóły: [architecture/today-settings.md](architecture/today-settings.md),
dowody: [quality/raz-11.md](quality/raz-11.md).

Test Dzisiaj/ustawień uruchamia dwa dodatkowe izolowane serwery testowe na
127.0.0.1:4322/4323 (Chromium/WebKit), aby zmiana strefy nie wpływała na inne testy.
Playwright zatrzymuje je i usuwa syntetyczne bazy po zakończeniu.
