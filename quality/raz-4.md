# RAZ-4 — dowody i przekazanie

Gałąź `agent/raz-4`. Środowisko: Node 26.13.0 / npm 11.20.0 (oficjalny tarball pobrany
do katalogu tymczasowego, SHA256 zgodny z `SHASUMS256.txt`; systemowy Node 22 nie obsługuje
Argon2id z `node:crypto`). Dane wyłącznie syntetyczne.

## Zrealizowano
- `apps/server/src/sync/service.ts`: `SyncService` – push (transakcja na mutację, receipts,
  fingerprint, operacje zależne), pull (snapshot/delta, cursor AES-256-GCM, watermark z ACL),
  `maintenance()` (kosz 30 dni → tombstones, receipts i journal 90 dni).
- `apps/server/src/sync/http.ts`: `POST /api/sync/push` (limit 1 MiB), `GET /api/sync/pull`.
- `packages/db/src/records.ts`: tombstones w create/update/delete/restore, idempotentne
  odhaczenie, `already_exists` dla wystąpień zadań, błędy ograniczeń bazy → `validation_error`
  (bez pętli 5xx), strony snapshotu i journala, purge kosza z dziećmi.
- `packages/db/src/sync-store.ts`, migracja v3 (`tombstones`, `sync_state`, indeksy retencji,
  trigger blokujący wskrzeszenie). Kontrakty: `pushEnvelopeSchema`, limity bajtowe, nowe kody.
- Opis działania: architecture/sync.md, sekcja „Implementacja serwera RAZ-4”.

## Testy (`npm test`: 12 plików, 97 testów, wszystkie zaliczone; `npm run typecheck`, `npm run build` OK)
`apps/server/src/sync/sync.test.ts` – HTTP przez Fastify `inject`, plikowa baza SQLite WAL,
dwa konta zalogowane hasłem, każde z własnym urządzeniem i lokalną kopią:
- zbieżność wspólnych danych A↔B, równoległe edycje różnych rekordów, prywatne tylko u właściciela
  (również treść nie pojawia się w lokalnej kopii B), właściciel nie zmienia się po edycji partnera;
  próby zmiany visibility/ownerId/householdId/version/createdAt/deletedAt → `validation_error`;
- zgubiony ACK (także inna kolejność kluczy) → ten sam wynik, 1 rekord, 1 wpis journala, 1 receipt;
  inna treść/encja/widoczność pod tym samym ID → `mutation_id_reused`; awaria wstrzyknięta
  triggerem przy receipt lub journalu → 500 `unavailable`, brak rekordu/journala/receipt,
  ponowienie → dokładnie jeden efekt; awaria w połowie partii; klucz zawiera konto;
- konflikt wersji bez LWW (późniejszy zegar nie wygrywa), rozwiązanie nową mutacją, idempotentne
  odhaczenie bez nowej wersji, delete kontra edit w obie strony, restore, purge po 30 dniach
  (lista + element + prywatna notatka), stare create/update/restore → conflict z tombstone,
  trigger bazy blokuje INSERT, operacje zależne `dependency_failed` bez receipt, jedno wystąpienie
  zadania z dwóch telefonów;
- snapshot po 5 rekordów z zapisami między stronami (nowe, edycje stron już wysłanych, delete,
  restore, purge kosza po przeskoku zegara) → kopia klienta równa stanowi serwera dla A i B;
  kosz w snapshot; pusta delta z nextCursor; 120 prywatnych zapisów A nie zmienia stron, hasMore,
  watermarku ani długości cursora B; cursor sprzed przyciętego journala i starszy niż 90 dni →
  `cursor_expired`, cudzy/zmieniony → `cursor_invalid`, ponowny bootstrap; wygasanie receipts;
- HTTP: 401 bez/z podrobioną sesją, 403 obcy Origin i cross-site, 403 hasło tymczasowe, 415
  text/plain, 400 dla błędnej koperty (JSON, deviceId, 0/101 mutacji, duplikat ID, pole nadmiarowe),
  400 `upgrade_required`, 413 `payload_too_large`, błąd elementu nie blokuje partii, 400 dla
  limitu pull; zgadywanie ID prywatnego wpisu = odpowiedź jak dla braku; podmiana list_id;
  brak treści prywatnej A w pull i receipts B; konflikt jako element odpowiedzi 200; awaria bazy
  → 500 z samym `{"error":"unavailable"}`.
- `packages/db/src/migrations.test.ts`: aktualizacja v2→v3 z danymi, losowy klucz per instalacja,
  jeden wiersz `sync_state`, monotoniczny floor, niezmienne tombstones, blokada wskrzeszenia.

Testy mutacyjne (ręczne, kod przywrócony): usunięcie odtwarzania receipt, `mutation_id_reused`,
blokady tombstone, kontynuacji od watermarku, ACL journala, wspólnej transakcji, paddingu cursora,
watermarku z ACL, floor journala lub wymuszenie ack dla nieaktualnych zmian – każda zmiana
powoduje porażkę 1–4 testów.

Smoke produkcyjnego buildu (`NODE_ENV=production node apps/server/dist/index.js`, tymczasowa
baza, port 4391 na loopback): migracje 1–3, `/healthz` i `/readyz` 200, `/api/sync/*` bez sesji
401. Proces zatrzymany, katalog usunięty, port wolny.

## Nie wykonano / granice
- `npm run test:e2e` nie uruchomiono: w środowisku brak przeglądarek Playwright; zadanie nie
  zmienia interfejsu. Nie jest to zgłaszane jako PASS.
- Klient offline (Dexie, outbox, reconciliation, UI konfliktów) – RAZ-5. Testy „dwóch urządzeń”
  używają syntetycznego klienta w teście, nie PWA ani fizycznych iPhone'ów.
- Create z UUID istniejącego cudzego prywatnego rekordu zwraca `not_found` (inne niż `ack` dla
  nowego ID); wymaga znajomości losowego UUID, bez ujawnienia treści i wersji.
- Retencja działa w jednym procesie app (zgodnie z architekturą: jedna instancja, SQLite).
