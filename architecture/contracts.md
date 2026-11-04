# Wspólne kontrakty v1 — RAZ-1

Źródło wykonawcze: `packages/contracts/src/`. `index.ts` eksportuje publiczne
modele, Zod/typy, wspólne reguły czasu i opis protokołu sync. Zmiana wymaga
zachowania zgodności starego klienta albo jawnego zwiększenia wersji i ścieżki upgrade.
Wszystkie obiekty są strict; walidacja odrzuca nadmiarowe pola.

## Encje i zakres

Rekordy sync: `shopping_list`, `shopping_item`, `task`, `task_occurrence`,
`calendar_event`, `important_date`, `note`, `reminder`. Każdy ma metadane:
id UUID, householdId, ownerId, visibility private/shared, version ≥ 1,
createdAt/updatedAt UTC i deletedAt nullable. Klient nadaje UUID nowego rekordu,
ale **serwer** ustala gospodarstwo/właściciela/czasy i kolejne wersje.

Nowa notatka prywatna; pozostałe samodzielne encje domyślnie wspólne. Wybór zakresu
jest wymagany w create, a UI ma go pokazać przed zapisem. Widoczność/owner/household
niezmienne od utworzenia, także offline. Udostępnienie notatki to świadoma kopia.
Element zakupów, wystąpienie zadania i przypomnienie dziedziczą ACL rodzica;
ich create nie przyjmuje visibility, update nie zmienia powiązania nadrzędnego.
Serwer weryfikuje zgodność ich metadanych z rodzicem. Rekord wystąpienia ma
unikalność `(taskId, occurrenceKey)` wymuszoną w bazie (RAZ-2).
`assignee: self/partner/both` interpretuje się względem ownerId, nie aktualnego czytelnika.

`userSchema` to bezpieczna projekcja konta bez hasha hasła. Preferencje i subskrypcje
push mają osobne kontrakty online, poza mutacjami domenowymi. Subskrypcji i ich kluczy
nie wolno logować. Dane kont i subskrypcje nie trafiają do ogólnego cache.
Osobny eksport `@razem/contracts/server` opisuje zapis konta z Argon2id, sesję
z hashem tokenu, receipts, journal ACL, tombstones oraz deduplikowaną kolejkę dispatch.
Nie należy importować go do web ani serializować jako odpowiedzi API.

`canReadRecord` sprawdza gospodarstwo oraz owner dla private; nie uwierzytelnia
sesji i nie zastępuje sprawdzenia rodzica. Publiczne endpointy RAZ-1 nie zwracają
żadnych rekordów użytkownika. Nazwa Dexie jest przestrzenią householdId + userId;
bez konta ekran nie otwiera bazy. Atomowe command/outbox, logout i migracje lokalne
pozostają w kolejnych zadaniach.

## Daty

Date-only: poprawne `YYYY-MM-DD`, bez konwersji UTC. Chwile: ISO z końcówką `Z`;
strefa IANA osobno, domyślnie Europe/Warsaw. Zadanie ma dueDate albo dueAt,
powtarzanie wymaga terminu. Wydarzenie ma albo daty z wyłącznym końcem, albo chwile
UTC z końcem po początku. Prywatne zadanie może być przypisane tylko self.

Reguła powtarzania zachowuje nominalny startDate i interval, frequency daily/weekly/monthly.
Dzień 31 ogranicza się do końca docelowego miesiąca; roczna reguła 29.02 do 28.02,
z zachowaniem oryginalnego month/day. `occurrenceKey` to nominalna lokalna data.
Temporal polyfill obsługuje IANA; precyzja harmonogramu minuta. DST: 02:30 w luce
Warszawy przechodzi do 03:00 (pierwsza istniejąca minuta), a dwuznaczne 02:30 do
wcześniejszego wystąpienia. Nie używamy czasu klienta do rozstrzygania konfliktów.

## Push i odpowiedzi

`POST /api/sync/push`: `{protocolVersion: 1, deviceId, mutations}`; partia 1–100,
bez powtórzeń clientMutationId wewnątrz partii. Każda mutacja ma UUID clientMutationId,
entityType, entityId i command. Create: baseVersion 0 + pełne data + visibility
dla samodzielnej encji. Update: baseVersion ≥ 1 i niepusty patch danych domenowych.
Delete/restore: baseVersion ≥ 1. Serwer waliduje kompletny stan po zastosowaniu
patch (termin, zakres wydarzenia, prywatne przypisanie); sam poprawny patch tego nie dowodzi.

Kolejność wejściowa obowiązuje w obrębie rekordu. Wynik każdego elementu:
`ack` z kanonicznym rekordem/tombstone, `conflict` z aktualnym dostępnym stanem
lub `error` z kodem bez treści rekordu. Wyniki korelowane przez clientMutationId,
entityType i entityId. Brak uprawnień i nieistniejący wpis mają wspólne `not_found`;
bez informacji o istnieniu, wersji i treści. HTTP 401 blokuje sync i zachowuje outbox.

Idempotencja: `(session.userId, deviceId, clientMutationId)` i fingerprint SHA256
kanonicznego payloadu. Ponowienie identycznej mutacji odtwarza receipt; podmieniony
payload zwraca mutation_id_reused. ACK dopiero po transakcyjnym commit rekordu,
journala i receipt. DeviceId nie jest uprawnieniem. Retencja receipts/tombstones
co najmniej 90 dni, kosz 30 dni. Implementacja serwera: RAZ-4, opis w
architecture/sync.md („Implementacja serwera RAZ-4”). Dodatkowy kod elementu
`already_exists` (drugie wystąpienie zadania tego samego dnia), błędy API
`upgrade_required` i `payload_too_large`; limity `MAX_PUSH_BYTES` i
`MAX_PULL_PAGE_BYTES` (1 MiB). Serwer używa `pushEnvelopeSchema`, by walidować
mutacje pojedynczo; klient nadal wysyła zgodnie z `pushRequestSchema`.

## Stronicowany pull

`GET /api/sync/pull?cursor=...&limit=100`, limit 1–200. Brak cursora rozpoczyna
snapshot. Wynik `ok`: protocolVersion, mode snapshot/delta, stały watermark
snapshotu, changes (rekordy/tombstones), nextCursor i hasMore. Cursor niepusty,
opaque, wydawany/uwierzytelniany przez serwer i związany z kontem; nie jest offsetem
kontrolowanym przez klienta. Nawet pusta strona przekazuje nextCursor.

Po ostatniej stronie snapshotu cursor przechodzi do przyrostu od watermarku,
aby zapisy w czasie bootstrapu nie zginęły. Serwer filtruje ACL przed payloadem,
licznikami i konfliktem. `resync_required` cursor_invalid/cursor_expired oznacza
bootstrap z zachowaniem outbox i konfliktów. Aplikacja zapisuje stronę wraz z
cursorem w jednej lokalnej transakcji; dirty rekord wymaga reconciliation.

## Granica RAZ-1

Schematy nie dowodzą działającego sync, autoryzacji ani offline PWA. API danych
jest zamknięte; klient API waliduje żądania/odpowiedzi, ma timeout i zachowuje status
HTTP, lecz nie uruchamia kolejki. Nie dodano alternatywnego CRUD omijającego sync.
Realne dwa konta, retry/idempotencja, bootstrap i dirty merge są DoD kolejnych zadań.
