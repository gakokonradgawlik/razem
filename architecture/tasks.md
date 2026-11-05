# Zadania — RAZ-8

UI czyta lokalny magazyn konta i zapisuje przez `LocalStore` + outbox w jednej transakcji.
Tytuł/opis, dzień albo godzina UTC + strefa, przypisanie i ukończenie zwykłego zadania
korzystają z dotychczasowych mutacji. Widoczność jest niezmienna; private tylko `self`.
`self/partner` są względem właściciela, ekran przelicza je względem czytającego.
Filtry: moje (ja lub oboje, otwarte), wspólne (shared, otwarte), zaległe (otwarte, miniony
termin), ukończone. Termin dnia staje się zaległy po końcu dnia w strefie zadania.
Godzinowy termin porównuje chwile UTC. Brak terminu nie jest zaległością.

## Stały szablon i wystąpienia

`packages/contracts/src/tasks.ts` zawiera wspólne reguły dla UI i przyszłego workera.
Szablon nigdy nie jest odhaczany ani kopiowany do następnego zadania. Najbliższy termin
to najstarsza nieukończona data harmonogramu, również zaległa. Ukończenie tworzy
`task_occurrence`; cofnięcie ustawia jego `completedAt=null`. Ukończone terminy są
widoczne w szczegółach, także po zmianie reguły. Filtr ukończonych pokazuje szablon
z ostatnim ukończonym terminem; szczegóły pozwalają przywrócić każdy termin.
Pusty harmonogram zatrzymany przed pierwszym terminem jest także dostępny w Ukończonych
z etykietą „Harmonogram zakończony”, bez sztucznego ukończenia.

Klucz `(taskId, occurrenceKey)` jest unikalny w SQLite. Nowy klient oblicza stały UUID
z SHA256 przestrzeni `razem:task-occurrence:v1:<taskId>:<YYYY-MM-DD>` (122 bity hasha,
znaczniki UUID w wersji 8 — własna przestrzeń identyfikatorów). Hash oblicza
przed transakcją Dexie. Dwa telefony tworzą ten sam ID. Serwer ACK-uje to samo
ukończenie mimo różnicy timestampów, bez nowej wersji/journala/zdarzenia. Zwykłe
ukończenia mają tę samą semantykę. Patch treści ze starą wersją nadal daje konflikt.
Łańcuch ukończ→cofnij nie jest spłaszczany; po ACK pierwszej mutacji druga otrzymuje
kanoniczną wersję. Starsze losowe ID wystąpień nadal mają ochronę naturalnego klucza
(`already_exists`); nowy klient używa znalezionego lokalnego rekordu przy cofnięciu.

Codziennie/tygodniowo według lokalnego kalendarza. Miesięcznie od oryginalnego dnia
(np. 31.01 → 28.02 → 31.03), bez dryfu od skróconego lutego. `recurrence.time` zachowuje
nominalną godzinę, także gdy pierwszy termin wpada w lukę DST. Luka → pierwsza istniejąca
minuta; overlap → wcześniejsza chwila. `occurrenceKey` zawsze jest lokalną datą.

## Zmiana harmonogramu

Opcjonalne pola istniejącego JSON `recurrence`: `time` (HH:mm albo null), `until`
(wyłączny koniec) i `history` (do 1000 wcześniejszych segmentów: frequency, interval,
startDate, until, time, timezone). Stare reguły bez rozszerzeń nadal są poprawne;
godzinę wyprowadza się z dueAt. Nie migrujemy IndexedDB ani zapisanych payloadów.

Formularz przy zmianie dnia/godziny/reguły wymaga przyszłego dnia „Nowy harmonogram od”.
Wcześniejsze segmenty i ich zaległe terminy pozostają. Wyłączenie powtarzania ustawia
`until`, pozostawiając historię. Sama edycja tekstu lub przypisania nie zmienia reguły.
Serwer i local store weryfikują, że historia przed wskazaną granicą jest dokładnie
historią poprzedniego szablonu. Przyszły pierwszy termin można też przesunąć
lub zatrzymać przed rozpoczęciem (pusty segment z until=startDate).
Serwer nie porównuje granicy z dniem dostarczenia: poprawna zmiana offline może dotrzeć
po jej wejściu w życie. UI wymaga przyszłej daty w chwili edycji. Ukończenia pozostają
osobnymi rekordami; stare daty można cofnąć. Usunięcie szablonu ukrywa lokalnie dzieci,
a jego przywrócenie przywraca ich widoczność.

## Sync v2 i aktualizacja

Historia jest rozszerzeniem nieczytelnym dla ścisłego schematu starego klienta.
Dlatego `PROTOCOL_VERSION=2`; push v1 zwraca `400 upgrade_required` przed zapisem.
Pull wymaga `x-razem-protocol: 2` (oprócz `x-razem-account`); brak/stara wersja daje
`400 upgrade_required` przed zwróceniem rekordów. Stary silnik już pokazuje potrzebę
aktualizacji; użytkownik zapisuje formularz, zamyka wszystkie okna i otwiera PWA ponownie.
Outbox, deviceId/clientMutationId, cursor i konflikty zostają. Nowy klient wysyła stare
mutacje w kopercie v2; format mutacji się nie zmienia. Health ma oddzielny kontrakt v1.
Wdrożenie musi obejmować spójny build web/API. Nie ma wdrożenia w RAZ-8.

## Granica przypomnień (RAZ-12)

Migracja SQLite v4 dodaje serwerową tabelę `task_events`, poza sync i API. Repozytorium
zapisuje ją w tej samej transakcji co domenę/journal/receipt: task.created, task.assigned,
task.schedule_changed, task.completed/reopened, task.deleted/restored. Identyfikacja:
sequence, taskId, entityId, version, occurrenceKey, changedAt oraz ACL szablonu.
Unikalność `(entity_id, version, kind)`; brak tytułów, opisów i subskrypcji. Nie ma wysyłki push
z UI; dispatcher działa od RAZ-12 ([push.md](push.md)). Purge szablonu usuwa jego zdarzenia przez FK.

Worker RAZ-12 zachowuje trwały checkpoint, skanuje także starsze szablony bez zdarzeń,
odczytuje aktualne ukończenia i ponownie sprawdza ACL/stan/przypisanie przed wysyłką.
Dedup per urządzenie, lease, retry i anulowanie: [push.md](push.md).
Domyślnie przypomina o godzinie terminu albo o 09:00 dla dnia; ustawienia konta
pozwalają wyłączyć i zmienić godzinę/wyprzedzenie oraz wyłączyć przypisania.
Prywatne przypomnienie trafia tylko do właściciela. Brak gwarancji alarmu offline.
Dowody RAZ-8: `quality/raz-8.md`; worker/push: [quality/raz-12.md](../quality/raz-12.md).
