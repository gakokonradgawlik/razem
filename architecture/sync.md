<!-- razem/architecture/sync.md · updated 2026-10-28 by Codex -->
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

