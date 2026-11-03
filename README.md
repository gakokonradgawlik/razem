# Razem

Prywatny organizer dla dwóch osób. Fundament RAZ-1: npm workspaces, wspólne
kontrakty i szkielety aplikacji. RAZ-2: schemat SQLite i migracje, dwa konta,
sesje i serwis uprawnień. **To jeszcze nie jest działający organizer.**
Ekran informacyjny nie zapisuje danych. Ekran logowania, serwis sync, edycja offline,
Service Worker i przypomnienia mają kolejne zadania.

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
sesji (401); endpointy danych dostarczy serwis sync (RAZ-4) — do tego czasu zalogowany
dostaje 404. Nagłówki typu `x-user-id` ani deviceId nie nadają uprawnień.
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
| `apps/web` | React/Vite, adapter klienta API, szkielet Dexie per konto |
| `apps/server` | Fastify, health/readiness, sesje/auth, CLI `admin`, pliki web |
| `apps/worker` | osobny proces przypomnień — na razie lifecycle |
| `packages/contracts` | Zod i typy TS, daty, prywatność, sync v1 |
| `packages/db` | SQLite WAL, migracje, schemat Drizzle, repozytoria i serwis uprawnień |
| `tests/e2e` | rzeczywisty HTTP i render buildu w przeglądarkach |

Czytaj [docs/START.md](docs/START.md), [kontrakt v1](architecture/contracts.md),
[synchronizację](architecture/sync.md), [bezpieczeństwo](security/access.md)
i [repozytorium/wersje](operations/repository.md). Dokumentacja produktu opisuje
docelowe MVP; zrealizowany zakres i dowody: [quality/raz-1.md](quality/raz-1.md), [quality/raz-2.md](quality/raz-2.md).
W repo nie ma kont demo, haseł domyślnych, kluczy ani danych domowników.
