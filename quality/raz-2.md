# RAZ-2 — dowody i przekazanie

Gałąź `agent/raz-2`. Środowisko: Node 26.13.0 / npm 11.20.0 (oficjalny tarball,
SHA256 zweryfikowany z `SHASUMS256.txt`), dane wyłącznie syntetyczne.

## Zrealizowano
- `packages/db/src/migrations.ts`: v1 konta/sesje/urządzenia/zdarzenia/limity,
  v2 domena (listy, elementy, zadania, wystąpienia, wydarzenia, ważne daty, notatki,
  przypomnienia), `sync_changes`, `mutation_receipts`, preferencje, subskrypcje push,
  kolejka `reminder_dispatches`. STRICT, CHECK, FK złożone, triggery niezmienności.
- Runner: suma SHA-256, transakcja IMMEDIATE na migrację, `foreign_key_check` przed
  commit, kopia `VACUUM INTO` (0600) przed aktualizacją, odmowa przy zmienionej,
  nieciągłej lub przyszłej historii. Worker tylko weryfikuje wersję.
- `schema.ts` (Drizzle), `AccountRepository`, `RecordRepository` + `accessPolicy`.
- `apps/server`: `AuthService`, trasy auth, CSRF/Origin, CLI `admin`, `config.ts`.
- Kontrakty: `auth.ts` (żądania, `passwordProblem`, `meResponseSchema`), nowe kody błędów.

## Testy (`npm test`)
- `packages/db/src/migrations.test.ts`: od zera; zgodność Drizzle↔kolumny;
  aktualizacja bazy v1 z danymi (dane, FK, wersje, limit członków, kopia 0600);
  baza RAZ-1; wycofanie błędnej migracji i naruszenia FK; suma/nieznana wersja;
  ograniczenia: 1 gospodarstwo, 2 członków, niezmienność, dziedziczenie zakresu.
- `packages/db/src/records.test.ts`: konta A/B — odczyt wspólnych, brak prywatnych
  partnera w get/list/journal, ta sama odpowiedź dla cudzego i nieistniejącego,
  podmiana ownerId/householdId/visibility/version, list_id/taskId/targetId partnera,
  przeniesienie elementu, prywatne zadanie tylko self, wersje/konflikty/usuń/przywróć.
- `apps/server/src/auth.test.ts`: bootstrap/reset bez drukowania haseł, odmowa
  ponownego bootstrapu i słabych haseł, brak rejestracji/kont demo, cookie,
  wymuszona zmiana hasła, rotacja przy zmianie hasła, odwołanie innych urządzeń,
  ogólny błąd, podrobione cookie i `x-user-id`, rolling/rotacja/okres łaski/wygaśnięcie,
  logout, CSRF (brak/obcy/`null` Origin, cross-site, text/plain), limity konto/IP,
  brak haseł i tokenów w plikach bazy/WAL, limit payloadu 413.
- `apps/server/src/auth/passwords.test.ts`: parametry produkcyjne, NFC, odrzucenie
  podmienionych parametrów; `config.test.ts`: zasady produkcyjne.

## Ograniczenia
- Brak ekranu logowania w web (zadanie interfejsu) i endpointów danych (RAZ-4);
  zalogowany dostaje 404 na `/api/sync/*`.
- Parametry Argon2id zmierzono na hoście deweloperskim, nie na docelowym Ubuntu.
- Limity logowania w SQLite: jedna instancja app (zgodnie z architekturą).
