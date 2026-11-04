<!-- razem/architecture/sync.md · updated 2026-11-04 by claude-runner (RAZ-4) -->
# Razem — kontrakt offline i synchronizacji
## Gwarancje i granice
Pierwsze uruchomienie, utworzenie kont i pobranie danych wymaga internetu/serwera. Potem działa lokalna kopia i kolejka zmian. Zamknięta PWA na iOS nie jest niezawodnym wykonawcą synchronizacji w tle; zawsze synchronizuj na starcie, visibilitychange/focus i odzyskaniu realnego połączenia oraz co 15 s podczas aktywnego użycia. Retry exponential backoff z jitter, limit czasu żądań; przy 401 czekaj na ponowne logowanie.
Push nie służy do cichej synchronizacji. Oczekujące dane mogą istnieć wyłącznie na telefonie; utrata magazynu przeglądarki może je usunąć. Poproś o persistent storage jeśli dostępne, ale nie obiecuj gwarancji. Zapewnij eksport oczekujących danych przy problemie.

## Lokalna transakcja
UI → domenowy command → pojedyncza transakcja Dexie: rekord, outbox (clientMutationId UUID, deviceId, entityType/id, command, patch, baseVersion) i ewentualnie baza porównania. Widok korzysta z local DB i pokazuje powodzenie dopiero po commit lokalnym. Nigdy nie zapisuj zmian jedynie w pamięci lub localStorage.
Kilka lokalnych zmian jednego rekordu zachowuje kolejność i zależności; po ACK podmień bazę dla kolejnej mutacji. Nie spłaszczaj żądań w sposób tracący intencję. Karta aktywna/worker nie mogą wysłać kolidujących kolejek bez blokady.

## Push
POST /api/sync/push: ograniczona partia, każda operacja ma własny wynik; operacje tego samego rekordu w kolejności. Serwer w transakcji sprawdza sesję, ACL, walidację domenową i baseVersion, zapisuje rekord/wersję/journal oraz mutation_receipt. ACK dopiero po commit.
Klucz idempotencji user_id+device_id+clientMutationId; receipt przechowuje wynik i fingerprint payloadu. Ponowienie tego samego ID z inną treścią jest błędem. Zagubiona odpowiedź i ponowienie nie tworzą drugiego rekordu ani przypomnienia. Niezweryfikowany deviceId nie daje dostępu.
Nie usuwaj wpisu outbox do trwałego potwierdzenia. Błąd 5xx/sieci pozostawia kolejkę; błąd walidacji/403 przenosi do lokalnego widocznego stanu wymagającego działania zamiast nieskończonego retry. Zapisuj wyłącznie wyniki, do których użytkownik ma dostęp.

## Pull
GET /api/sync/pull?cursor=...: serwer zwraca stronicowany, spójny przyrost i nowy cursor, z rekordami lub tombstone'ami. Cursor opaque związany z użytkownikiem; ACL obowiązuje przed zwrotem danych, także w change logu, licznikach i błędach. Brak danych prywatnych partnera w payloadach.
W jednej transakcji lokalnej zastosuj partię i cursor. Otrzymanie remote wersji nie nadpisuje lokalnego dirty rekordu — aktualizuje bazę i wymusza reconciliation.
Pełny bootstrap daje spójny snapshot i watermark; stronicowanie nie gubi zmian wykonanych w trakcie snapshotu. Brak/upłynięcie ważności cursora wywołuje pełną resynchronizację; najpierw zachowaj pending/conflicts, nie kasuj ich przy zastępowaniu cache.

## Konflikty i usuwanie
Optimistic concurrency: inna wersja niż baseVersion oznacza conflict (HTTP/element 409), nie LWW na podstawie zegara. Przechowuj lokalną intencję, bazę i aktualną wersję serwera. UI pokazuje obie wersje; użytkownik wybiera serwer/lokalną albo scala tekst. Zapis rozwiązania używa bieżącej wersji i nowego mutationId; kolejny konflikt ponownie widoczny.
Różne rekordy łączą się bez konfliktu; identyczne idempotentne odhaczenie może zwrócić ACK bez kolejnego efektu ubocznego, ale edycja treści nie może ukrywać konfliktu. Delete kontra edit musi zachować lokalną edycję do odzyskania; stary telefon nie wskrzesza usuniętego rekordu samoczynnie.
Soft-delete z koszem 30 dni i restore jako wersjonowana mutacja. Tombstones i receipts utrzymuj co najmniej 90 dni; wymuś pełny snapshot starszych klientów i opisany rebase pending operacji zamiast zakładać brak historii.
Widoczność i właściciel niezmienne od utworzenia. Unikamy nieodwracalnego cofania treści już pobranej przez drugą osobę. Odwołanie sesji nie usuwa zdalnie lokalnej kopii offline; opisz granicę.

## PWA i aktualizacje
Cache'uj shell i lokalne zasoby; dane kont i /api nie trafiają do ogólnego Cache API. Baza użytkownika oddzielona per account/household. Wylogowanie po świadomym rozwiązaniu pending zmian czyści lokalne dane i powiązanie push. Drugi użytkownik na tym samym urządzeniu nie widzi poprzednich danych.
Service Worker aktualizuje się bez wymuszonego reload/skipWaiting podczas edycji lub pending zmian. Kompatybilne kontrakty/migracje i komunikat o nowej wersji. Testuj upgrade starej bazy z outbox. Brak miejsca nie może skończyć się fałszywym potwierdzeniem zapisu.
Nie używaj Background Sync API jako wymaganego mechanizmu; jego dostępność jest ograniczona: https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API.

## Implementacja serwera RAZ-4 (stan kodu)
Kod: `apps/server/src/sync/` (`service.ts`, `http.ts`), `packages/db/src/records.ts`
(`RecordRepository` – jedyna ścieżka zapisu domeny), `packages/db/src/sync-store.ts`, migracja v3.
- **Push** `POST /api/sync/push` (sesja, CSRF jak w RAZ-2; limit treści 1 MiB, partia 1–100).
  Koperta jest walidowana całościowo (400 `invalid_request`, inna `protocolVersion` → 400
  `upgrade_required`, za duża → 413 `payload_too_large`); każda mutacja osobno, więc jeden zły
  element dostaje własny `validation_error`, a reszta partii przechodzi. Mutacje wykonywane w
  kolejności wejścia, **każda w jednej transakcji SQLite IMMEDIATE**: receipt → ACL/walidacja/
  baseVersion → rekord i wersja → wpis journala → receipt. ACK dopiero po commit; awaria w
  trakcie (5xx) wycofuje całość, wcześniejsze mutacje partii mają już receipt.
- **Idempotencja**: klucz `(session.userId, deviceId, clientMutationId)`; fingerprint SHA-256
  kanonicznego JSON mutacji (posortowane klucze). Ten sam payload odtwarza zapisany wynik bez
  drugiego efektu; inny → `mutation_id_reused`. Receipt zapisywany dla każdego rozstrzygnięcia
  (ack/conflict/error), nie dla `mutation_id_reused` ani `dependency_failed`. deviceId to tylko
  część klucza i wpis `devices` (last_seen) – nie daje dostępu.
- **Operacje zależne**: gdy mutacja rekordu X w partii nie dała `ack`, kolejne mutacje X i
  tworzenie dzieci X (listId/taskId/targetId) dostają `dependency_failed` bez wykonania i bez
  receipt – klient rebase'uje je po rozwiązaniu konfliktu.
- **Konflikty**: inna wersja niż baseVersion → wynik elementu `conflict` z aktualnym stanem
  widocznym dla konta (odpowiedź HTTP 200 dla partii; 409 jest semantyką elementu). Nie ma LWW
  ani czasu klienta: `updatedAt` nadaje serwer. Wyjątek bez utraty danych: nieaktualna zmiana,
  której efekt jest już stanem bieżącym (np. to samo odhaczenie na obu telefonach), dostaje
  `ack` bez nowej wersji. Edycja rekordu w koszu → `conflict`; drugie wystąpienie zadania tego
  samego dnia → `already_exists` (jeden rekord na `(taskId, occurrenceKey)`).
- **Kosz i tombstones**: delete ustawia `deletedAt` (rekord zostaje w koszu, w snapshot i delta,
  restore wersjonowane). Po 30 dniach zadanie retencji usuwa rekord **z dziećmi** i zapisuje
  tombstone (typ, id, ACL, wersja+1, daty – bez treści) jako nową wersję w journalu. Tombstones
  są trwałe; trigger bazy blokuje ponowny INSERT tego ID. Stare create/update/delete/restore
  dostają `conflict` ze stanem tombstone (lub `not_found`, gdy to cudzy prywatny).
- **Pull** `GET /api/sync/pull?cursor&limit` (limit 1–200, domyślnie 100, ok. 1 MiB na stronę).
  Bez cursora: snapshot – wszystkie widoczne rekordy (także kosz) w kolejności typów rodzic→dziecko
  i id (keyset), watermark = najwyższa sekwencja journala na pierwszej stronie. Każda strona to
  jedna transakcja odczytu (spójny widok WAL). Po ostatniej stronie cursor przechodzi w deltę od
  watermarku, więc zmiany zrobione w trakcie stronicowania przychodzą w delcie (hasMore=true,
  jeśli są). Delta: widoczne wpisy journala po sekwencji, aktualny stan rekordu lub tombstone,
  deduplikacja w stronie. Zapis SQLite jest jednowątkowy (IMMEDIATE), więc sekwencje są
  zatwierdzane rosnąco i czytelnik nie przeskoczy niezatwierdzonej luki.
- **Cursor**: AES-256-GCM kluczem losowym instalacji (`sync_state.cursor_key`, generowany w
  migracji), stała długość, związany z kontem. Watermark (`w1.<HMAC>`) i hasMore liczone tylko
  z wpisów widocznych dla konta – prywatne zapisy partnera nie zmieniają stron, watermarku,
  liczników ani długości cursora. `resync_required`: `cursor_invalid` (zmieniony, cudzy,
  nieczytelny) lub `cursor_expired` (starszy niż 90 dni albo sprzed przyciętego journala).
- **Retencja** (`SyncService.maintenance`, co godzinę w procesie serwera i przy starcie):
  kosz 30 dni → tombstones, receipts 90 dni, journal 90 dni (podnosi `journal_floor`).
  Globalny punkt synchronizacji (`RecordRepository.maxSequence`) to max(najwyższa sekwencja
  journala, `journal_floor`) – monotoniczny także po całkowitym przycięciu journala; sekwencje
  (AUTOINCREMENT) nigdy nie są ponownie używane, więc świeży snapshot i delta pozostają ciągłe.
- **ACL**: wszystkie odczyty i wyniki (ack, conflict, pull, journal) przez `accessPolicy`;
  cudzy prywatny i nieistniejący dają identyczne `not_found` bez treści i wersji. Granica: create
  z UUID, który już istnieje jako cudzy prywatny rekord, też zwraca `not_found` (różne od `ack`
  dla nowego ID) – wymaga znajomości 122-bitowego losowego UUID, treść i wersja nie wyciekają.
- Klient offline (kolejka, Dexie, reconciliation) to RAZ-5; serwer nie zakłada niczego o jego
  zegarze.
