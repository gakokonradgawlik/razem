<!-- razem/architecture/overview.md · updated 2026-10-28 by Codex -->
# Razem — architektura i model
## Przyjęte rozwiązanie
Jedna prywatna instalacja dla dwóch osób. npm workspaces: apps/web (React, Vite, TypeScript), apps/server (Fastify, TypeScript), packages/contracts (Zod i typy), packages/db (Drizzle/SQLite), apps/worker (harmonogram przypomnień). IndexedDB/Dexie jako lokalne źródło UI; Service Worker dla offline aplikacji. SQLite WAL na trwałym lokalnym dysku serwera, busy_timeout, foreign_keys. Bez Dexie Cloud, Redis, zewnętrznej bazy i obowiązkowego SMTP.
Node aktywne LTS i stabilne zgodne zależności wybiera RAZ-1 po sprawdzeniu oficjalnych źródeł; konkretne wersje przypina w plikach i obrazie.
RAZ-1 przypina Node 26.13.0 / npm 11.20.0; pełna tabela i źródła w operations/repository.md.
Kontrakt v1 i rozstrzygnięcia payloadów: architecture/contracts.md. SQLite przez
stabilny adapter Drizzle/better-sqlite3; schemat domenowy i migracje dostarcza RAZ-2.
Produkcja: web build serwowany przez aplikację, /api pod tym samym originem, worker korzysta z tej samej bazy na pojedynczym hoście. Kontenery app i worker; reverse proxy HTTPS istniejące lub Caddy. Bez uruchamiania dev/Vite preview jako produkcji.

## Polecenia i repozytorium
RAZ-1 zapewnia npm ci, npm run dev, npm run typecheck, npm test, npm run build, npm run test:e2e; wspólny lockfile i .env.example bez sekretów. Repo powstaje w dedykowanym katalogu razem, lokalizacja i komendy w operations/repository.md. Vitest testy jednostkowe/integracyjne; Playwright dwa odizolowane konteksty, Chromium i WebKit. Fixtures syntetyczne, brak danych domowników.

## Model
Wszystkie ID generowane jako UUID; daty zmian nadaje serwer, wersja integer; czas klienta nie rozstrzyga konfliktów.
- household: id, nazwa, domyślna strefa.
- user: household_id, login/email, display_name, password_hash, must_change_password, created_at.
- session: user_id, hash identyfikatora sesji, expires_at; rotacja i unieważnienie.
- device: user_id, device_id, nazwa, last_seen; device_id nie jest uprawnieniem.
- wspólne metadane synchronizowanych rekordów: id, entity_type, household_id, owner_id, visibility private/shared (niezmienna), version, created_at, updated_at, deleted_at.
- shopping_list + shopping_item (list_id, nazwa, ilość tekstowa, uwaga, checked, sort_key); item dziedziczy uprawnienia listy.
- task: tytuł, opis, assignee self/partner/both, due_date albo due_at, completed_at, recurrence; ukończenia instancji w task_occurrence.
- calendar_event: tytuł, opis, all_day, start_date/end_date lub start_at/end_at, timezone; koniec całodniowego zakresu wyłączny.
- important_date: nazwa, month/day, opcjonalny start_year, rodzaj; powtórzenie roczne.
- note: tytuł, body plain text.
- reminder/preference/push_subscription; kolejka dispatch z kluczem deduplikacji.
- sync_changes (sekwencja i minimalne referencje z ACL), mutation_receipts (user+device+clientMutationId), conflicts (lokalny klient) i tombstones.

## Daty i powtarzanie
Strefa domyślna Europe/Warsaw, tydzień od poniedziałku; daty całodniowe YYYY-MM-DD bez konwersji przez północ UTC. Godzinowe chwile UTC plus strefa IANA.
Dla czasu nieistniejącego przy zmianie DST przesuń do pierwszego istniejącego czasu; dla dwuznacznego wybierz wcześniejsze wystąpienie i testuj. Stosuj sprawdzoną bibliotekę obsługi IANA (dobór w RAZ-1).
Codziennie/co tydzień według lokalnego kalendarza, miesięcznie dzień z ograniczeniem do końca miesiąca. 29 lutego w latach nieprzestępnych przypada 28 lutego; zachowaj oryginalną regułę na następny rok.
Zadanie cykliczne ma stały szablon i jedno ukończenie per occurrence_key (data nominalna); oba telefony nie tworzą dwóch kolejnych zadań. Zmiana harmonogramu od przyszłych instancji, stare ukończenia pozostają.

## API
/api/auth, /api/me, /api/sync/push, /api/sync/pull, /api/export, /api/push oraz /healthz i /readyz. Kontrakty w packages/contracts przed budowaniem modułów.
Wpisy lokalnie tworzą mutacje; serwer wszystkie mutacje kieruje przez jeden serwis walidacji/ACL/wersji/journala. Nie implementuj drugiej ścieżki CRUD omijającej sync.
Preferencje konta i subskrypcje push są online i osobno walidowane. 401 zatrzymuje sync, nie kasuje outbox. Żaden klient nie może dowolnie nadać sobie owner_id/household_id.
Szczegóły synchronizacji: architecture/sync.md.

## Źródła techniczne
- Vite: https://vite.dev/guide/build i https://vite.dev/guide/static-deploy
- Fastify: https://fastify.dev/docs/latest/Reference/TypeScript/
- Dexie: https://dexie.org/docs/Tutorial/React
- SQLite backup: https://www.sqlite.org/backup.html
- Service Worker: https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
Źródła stanowią punkt odniesienia; RAZ-1 sprawdza kompatybilność faktycznych wydań, nie przyjmuje numerów wersji z pamięci.

