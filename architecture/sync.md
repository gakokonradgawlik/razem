<!-- razem/architecture/sync.md · updated 2026-11-05 by Codex (RAZ-6) -->
# Razem — kontrakt offline i synchronizacji

## Rozszerzenie RAZ-8: sync v2 i zadania

Bieżąca koperta push/odpowiedź pull ma `protocolVersion: 2`. Push v1 oraz pull bez
`x-razem-protocol: 2` zwracają `400 upgrade_required` przed operacjami na danych.
Nagłówek `x-razem-account` nadal jest wymagany i sprawdzany wobec sesji.
Powód: historia reguł zadań jest nieczytelna dla starego strict schematu.
Klient zachowuje lokalną bazę, mutacje i cursor; wymagane zamknięcie wszystkich okien
PWA i ponowne otwarcie po dostępności spójnej aktualizacji. Health pozostaje v1.
Dwa ukończenia tego samego zadania/wystąpienia mają semantykę jednego odhaczenia,
także przy różnych niepustych timestampach. Cofnięcie kontra ukończenie pozostaje
konfliktem. Wystąpienia nowego klienta mają stały UUID z taskId + nominalnej daty;
nie powstają nowe szablony. Szczegóły: [tasks.md](tasks.md).
Poniższe historyczne sekcje RAZ-4/5 opisują mechanizm bazowy; ten akapit uaktualnia
wersję protokołu i semantykę porównania completedAt.

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
  Push i pull wymagają nagłówka `x-razem-account` równego kontu sesji tego żądania, inaczej
  409 `account_mismatch` bez skutków (dodane w RAZ-5, opis w sekcji klienta).
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
  ani czasu klienta: `updatedAt` nadaje serwer. Jedyny wyjątek: nieaktualny patch zawierający
  **wyłącznie** pole odhaczenia (`shopping_item.checked`, `task.completedAt`,
  `task_occurrence.completedAt`), którego wartość jest już stanem bieżącym (to samo odhaczenie na
  obu telefonach), dostaje `ack` bez nowej wersji. Każda inna nieaktualna edycja – także treści
  identycznej z bieżącą albo odhaczenia połączonego z polem treści – to `conflict`. Edycja
  rekordu w koszu → `conflict`; drugie wystąpienie zadania tego samego dnia → `already_exists`
  (jeden rekord na `(taskId, occurrenceKey)`).
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
- Klient offline (kolejka, Dexie, reconciliation): sekcja RAZ-5 niżej; serwer nie zakłada
  niczego o jego zegarze.

## Implementacja klienta RAZ-5 (stan kodu)
Kod: `apps/web/src/local-db.ts` (schemat Dexie), `apps/web/src/offline/` – `store.ts` (komendy,
kolejka, ACK/rebase, pull, konflikty, eksport), `sync.ts` (silnik), `controller.ts` (konto/sesja),
`live.tsx` (adapter `AppServices` dla ekranów), `api.ts` (HTTP z limitem 10 s).
- **Baza per konto**: `razem:<householdId>:<userId>`; tabele `records` (widok lokalny), `queue`
  (outbox, `++seq` = kolejność komend), `bases` (stan serwera, na którym oparto lokalne zmiany),
  `conflicts`, `meta` (deviceId, cursor, status, rewizja), `seen` (ID z trwającego snapshotu).
  W `localStorage` tylko tożsamość ostatniego konta (ID, login, nazwa) – bez tokenu i treści –
  żeby aplikacja otwierała się offline na jego danych. Inne konto = inna baza.
- **Migracja v1→v2** (szkielet RAZ-3): outbox przenoszony do `queue` z zachowaniem
  `clientMutationId`, `attempts` i **deviceId** (część klucza idempotencji), cursor do `meta`.
- **Komenda** (create/update/delete/restore): jedna transakcja Dexie rw na wszystkie tabele:
  rekord + wpis kolejki (+ baza przy pierwszej zmianie czystego rekordu) + rewizja. Walidacja
  kontraktem (także reguły domenowe) przed zapisem; dziecko dziedziczy widoczność/owner rodzica.
  Wynik `ok` dopiero po commit; QuotaExceeded → `storage_full`, inne błędy → `storage_unavailable`,
  nic nie zostaje zapisane połowicznie. Edycja rekordu z otwartym konfliktem jest blokowana.
- **baseVersion**: wersja serwera, na której oparto zmianę; kolejna zmiana tego samego rekordu
  w kolejce ma `null` („po mojej poprzedniej”) i po ACK poprzedniej dostaje wersję z ACK (rebase).
  Wersji z pull nigdy nie podstawiamy pod czekającą zmianę – inaczej ukrylibyśmy konflikt.
- **Push**: partie do 100 mutacji i ~1 MiB, w kolejności kolejki, **najwyżej jedna mutacja na
  rekord w partii**; tworzenie dziecka może iść w tej samej partii co tworzenie rodzica. Pomijane
  są zmiany za konfliktem/odrzuceniem tego rekordu lub rodzica. Wyniki w jednej transakcji:
  `ack` → usunięcie wpisu, rebase następnego, a gdy nic nie czeka – stan serwera staje się widokiem;
  `conflict` → cały łańcuch zmian rekordu przechodzi do `conflicts` (lokalny widok, baza, serwer);
  nieaktualne usunięcie rekordu już usuniętego na serwerze rozstrzyga się samo;
  `dependency_failed` → czeka; `already_exists` (wystąpienie zadania) → przyjęcie kopii serwera;
  inne błędy → `needs_action` (widoczne, bez retry w kółko). 413/400 całej partii → mniejsze
  partie, a pojedyncza mutacja → `needs_action`. Błąd sieci/5xx/timeout zostawia kolejkę;
  zagubiona odpowiedź jest powtarzana tym samym ID (receipt serwera, jeden efekt).
- **Pull**: strony do 200; każda strona i cursor w jednej transakcji. Rekord z lokalnymi zmianami
  nie jest nadpisywany – aktualizuje się jego baza (i stan serwera w konflikcie). Brak cursora lub
  `resync_required` → pełny snapshot: kolejka i konflikty zostają, a po końcu snapshotu (pierwsza
  strona delty albo ostatnia strona snapshotu) usuwane są tylko czyste rekordy, których serwer
  już nie zwrócił. Tombstone usuwa czysty rekord i jego czyste dzieci; brudnego nie wskrzesza.
- **Silnik**: start, `focus`/`visibilitychange`, `online`, po komendzie i co 15 s, gdy karta jest
  widoczna. Brak Background Sync i pracy zamkniętej PWA. Jeden cykl naraz na bazę konta między
  kartami: Web Locks (`ifAvailable`), w razie braku – lease w `meta` (60 s, z losowym tokenem).
  Lease jest odnawiany i weryfikowany **przed każdym żądaniem** (push, pull) i przed zapisem strony
  pull; odnowienie udaje się tylko, gdy wiersz wciąż ma token tego cyklu. Utrata lease (np. karta
  zamrożona w tle dłużej niż 60 s, a inna karta go przejęła – nawet jeśli już zwolniła) kończy
  cykl bez dalszej wysyłki. Granica: żądanie już wysłane przed zamrożeniem może się zakończyć
  równolegle z cyklem innej karty – skutki chroni idempotencja serwera (receipt).
  Cykl: `GET /api/me` (sesja należy do konta tej bazy – inaczej kolejka nie jest wysyłana,
  a aplikacja przełącza się na konto sesji) → push → pull → push nowych zmian.
- **Powiązanie z kontem po stronie serwera**: każde `push`/`pull` ma nagłówek `x-razem-account`
  (`SYNC_ACCOUNT_HEADER`, ID konta bazy). Serwer porównuje go z sesją **tego samego** żądania;
  brak lub inna wartość → 409 `account_mismatch`, bez zapisu, receipt i danych. Dzięki temu
  zmiana ciasteczka w innej karcie między `/api/me` a push, między partiami albo przed pull nie
  przypisze treści A do B ani nie wpisze danych B do bazy A. Klient na 409 zatrzymuje cykl,
  ustawia status, pyta `/api/me` i przełącza kartę na konto sesji; kolejka A zostaje w bazie A.
  Nagłówek niczego nie autoryzuje – decyduje sesja. `stop()` silnika (wylogowanie, zmiana konta
  w tej karcie) przerywa trwające żądanie (AbortController) i kończy cykl przed kolejnym.
  Kontroler przed zamknięciem bazy czeka na koniec przerwanego cyklu (`stopAndSettle`), więc lease
  zwalnia się w otwartej bazie i ponowne logowanie tego konta od razu wysyła jego kolejkę.
  Backoff wykładniczy 2 s…5 min z jitterem dla ticków; zdarzenia użytkownika/sieci go pomijają;
  `Retry-After` przy 429. `navigator.onLine` to tylko podpowiedź: próba zawsze idzie do serwera,
  „Offline” = nieudana próba sieciowa przy `onLine=false`; odpowiedź HTTP 5xx/proxy = „Serwer
  niedostępny”. 401 → „Zaloguj się, aby wysłać zmiany”, kolejka zostaje do zalogowania tego konta.
- **Stan interfejsu związany z kontem**: każda aktywacja bazy konta (logowanie, przełączenie,
  przejęcie sesji z innej karty, wylogowanie) dostaje nową **generację**. `AppServices` niesie
  `accountKey` (konto + generacja), a wszystkie ich odczyty i komendy są związane z tą generacją:
  wywołanie zachowane przez ekran poprzedniego konta (np. „Zapisz” formularza A) dostaje
  `account_changed` i nic nie zapisuje, a odczyt – `unavailable`. `App` montuje ekrany z kluczem
  `accountKey`, więc po zmianie konta wartości formularzy, wczytane rekordy i callbacki A znikają
  z widoku; `useLoad` ma `accountKey` w zależnościach (rewizje różnych baz mogą być równe).
  Użytkownik widzi komunikat „Otwarto konto: …”; niezapisany formularz A nie jest przenoszony
  (szkic nie jest zachowywany), a niewysłane zmiany A czekają w bazie A.
- **Status** (wspólny dla kart, w `meta`): „Zsynchronizowano HH:MM” tylko po udanym cyklu i bez
  niewysłanych zmian; licznik = wpisy kolejki + zmiany w konfliktach. Pierwszeństwo: brak
  miejsca/pamięci > zmiany do sprawdzenia > logowanie > nowa wersja > offline > serwer > liczba.
- **Konflikty** (`/zmiany`, `/zmiany/:id`): moja wersja i wersja z serwera obok siebie; wybór
  serwera, mojej albo scalanie pole po polu (tekst można połączyć ręcznie). Rozwiązanie to nowa
  mutacja z nowym ID na bieżącej wersji serwera – zmiana w międzyczasie daje nowy konflikt.
  Powiązania nadrzędne i klucze (`IMMUTABLE_PARENT_FIELDS` w `@razem/contracts`: `listId`, `taskId`,
  `occurrenceKey`, `targetType`, `targetId`) nie są edytowalne przy scalaniu; `LocalStore.resolve`
  zawsze bierze je z rekordu, niezależnie od danych z ekranu.
  Kosz na serwerze + moja edycja → „Przywróć z moją wersją” (restore + update). Tombstone →
  moja treść jako **nowy** wpis (nowe ID), stare ID nie wraca. Moje usunięcie + zdalna edycja →
  „Usuń mimo to” albo wersja z serwera. Odrzucone zmiany można odrzucić lokalnie.
- **Eksport** (Ustawienia, ostrzeżenie przy wylogowaniu, odznaka przy braku miejsca): plik JSON
  z niewysłanymi zmianami i konfliktami tego konta. **Wylogowanie**: przy niewysłanych zmianach
  wymaga decyzji (wyślij/eksportuj/usuń), potrzebuje serwera (`/api/auth/logout`), potem kasuje
  bazę konta i wpis tożsamości. `navigator.storage.persist()` jest proszony bez obietnic.
- **Granice historyczne RAZ-5**: zimny start offline dodano w RAZ-6 (sekcja niżej); wcześniej działała otwarta karta.
  Dane prywatne innego konta nigdy nie trafiają do lokalnej bazy (ACL serwera + sprawdzenie
  `canReadRecord` przy zapisie lokalnym). Przełączenie konta nie usuwa bazy poprzedniego konta
  (jego kolejka czeka na jego logowanie), ale nie jest dla nikogo innego otwierana.

## Implementacja PWA RAZ-6
Manifest i lokalne ikony 180/192/512/maskable są w `apps/web/public`. Build Vite wywołuje
`scripts/build-pwa.mjs`: generuje SW i wersję cache z SHA256 zawartości plików oraz szablonu.
Precache obejmuje wyłącznie jawne lokalne zasoby buildu, pobrane atomowo bez cookies.
`/api`, health/readiness, obce originy i metody inne niż GET nie są cache’owane; brak runtime cache.
Nawigacje SPA zawsze dostają shell wersji aktywnego SW, także online. Nowa wersja czeka na
zamknięcie wszystkich kart/PWA; brak skipWaiting, clients.claim i wymuszonego reload.
UI prosi o zapis formularzy przed zamknięciem. Outbox/conflicts pozostają w bazie konta;
aktywacja usuwa tylko stare cache shellu. Nieudana instalacja zostawia poprzednią wersję.
Schemat Dexie v2 i protokół v1 pozostają bez zmian; test przeglądarkowy sprawdza upgrade v1
z outbox i zachowanie deviceId/clientMutationId. Kolejne migracje muszą być transakcyjne,
zachowywać pending i kompatybilność aktywnych klientów; żadnego kasowania bazy przy błędzie
ani rollbacku przez downgrade schematu. Publikacja wymaga kompletnego, spójnego artefaktu.
Ekran instalacji rozpoznaje standalone, prowadzi po krokach iPhone i pokazuje gotowość shellu.
Pierwsze uruchomienie ikoną, logowanie i bootstrap wymagają połączenia. Wynik persist jest
widoczny (także odmowa/brak wsparcia/błąd); ochrona magazynu nie zastępuje backupu/eksportu.
Dowody i lista fizycznych testów oczekujących po wdrożeniu: `quality/raz-6.md`.
