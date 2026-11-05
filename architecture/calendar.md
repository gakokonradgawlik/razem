# Kalendarz i ważne daty — RAZ-9

## Model, widoki i strefy

`calendar_event`, `important_date` i `reminder` zachowują istniejący strict kontrakt;
sync pozostaje v2, SQLite v4, IndexedDB v2. Nie wprowadzono migracji ani zmian
payloadów wymagających upgrade klienta.

Formularz wydarzenia: nazwa, opis, początek/koniec, cały dzień, strefa IANA,
widoczność oraz opcjonalne przypomnienie. Domyślna strefa Europe/Warsaw.
Widoczność domyślnie shared, po utworzeniu stała, także offline.
Godziny zapisujemy jako UTC Z plus osobna strefa. Szczegóły i agenda pokazują czas
w strefie wydarzenia z jej nazwą; pozycja w miesiącu wynika ze strefy Europe/Warsaw.
Strefa systemu telefonu nie zmienia grupowania. Wybór domowej strefy w ustawieniach
pozostaje RAZ-11; obecna domyślna strefa kalendarza to Europe/Warsaw.

Całodniowe `startDate/endDate` to YYYY-MM-DD bez konwersji strefy. W formularzu
wybiera się ostatni dzień włącznie; zapis dodaje dzień, odczyt odejmuje dzień.
Koniec kontraktu jest wyłączny i musi być po początku. Godzinowy koniec także musi
być późniejszy już po rozwiązaniu DST. Godzinowe wydarzenie kończące się o północy
nie pojawia się w następnym dniu. Wspólne `eventDays` zwraca wyłączny zakres dni.

Agenda pokazuje wydarzenia kończące się po wybranym dniu początkowym (domyślnie
dzisiaj), także trwające od wcześniejszego dnia, i najbliższe wystąpienie każdej
ważnej daty. Pole „Agenda od dnia” pozwala odnaleźć historię. Miesiąc zaczyna się
w poniedziałek, oznacza dni z wpisami, pokazuje listę i pozwala wybrać dzień.
Ponowny wybór tego dnia przywraca listę miesiąca. Wpis wielodniowy jest oznaczony
każdego dnia zakresu, ale na liście miesiąca występuje raz.

Ważne daty: nazwa, rodzaj, month/day, opcjonalny startYear, widoczność, przypomnienie.
`importantOccurrence` nie generuje wystąpień przed startYear, a przy jego braku
nie pokazuje licznika. 29.02 → 28.02 w roku nieprzestępnym; oryginalna reguła nie
zmienia się i wraca 29.02 w przestępnym. Lista sortuje po najbliższym wystąpieniu,
a szczegóły i kalendarz pokazują licznik lat, jeżeli rok jest znany.

Wspólne reguły znajdują się w `packages/contracts/src/calendar.ts`, DST w `dates.ts`:
luka → pierwsza istniejąca minuta, overlap → wcześniejsze wystąpienie. Funkcje zakresów
i rocznic mogą być używane przez RAZ-11 do podsumowań; dane wejściowe muszą pochodzić
z odczytu z ACL (`AppServices.listRecords` / `RecordRepository.list`). Sam helper
dat nie uwierzytelnia konta. Dzisiaj nie agreguje jeszcze kalendarza (RAZ-11).

## Local-first i przypomnienia

UI odczytuje dane przez AppServices z bazy konta. `LocalStore.saveCalendar` zapisuje
w jednej transakcji Dexie rodzica, opcjonalne przypomnienie i outbox obydwu wpisów.
Błąd walidacji/quota cofa całość; formularz zachowuje treść. Edycja wysyła tylko
zmienione pola. Niezmienione ustawienie przypomnienia nie jest wysyłane przy edycji
samej nazwy — nie cofa konfiguracji, która mogła przyjść w międzyczasie z partnera.
Istniejące retry/ACK/konflikty/resync i separacja kont działają bez drugiej ścieżki CRUD.

Przypomnienie ma oddzielny UUID deterministyczny z ID rodzica; istniejący identyfikator
z wcześniejszego klienta zostaje zachowany. Dwa niezależne utworzenia tej samej
konfiguracji na telefonach spotkają zwykły konflikt wersji; nie powstają dwa ID.
Jeśli dawne dane mają kilka konfiguracji, jawna zmiana formularza wyłącza dodatkowe.
Wyłączenie zachowuje konfigurację jako enabled=false. Usunięty rodzic ukrywa lokalne
przypomnienie; przywrócenie rodzica je odsłania. Docelowy worker musi sprawdzić także
aktualny stan rodzica przed wysyłką.

Przy włączeniu: godzinowe domyślnie 30 min wcześniej; całodniowe i ważne daty 09:00
danego dnia. Wyprzedzenie oraz lokalna godzina edytowalne. Przypomnienia są opcjonalne,
przełącznik początkowo wyłączony. `calendarReminderAt` wylicza chwilę według zapisanej
konfiguracji; dla ważnej daty potrzebuje roku wystąpienia i strefy domu (domyślnie
Warszawa). `calendarRecipients` przyjmuje zaufane konta gospodarstwa, stosuje ACL
rodzica i zwraca pustą listę dla usuniętego wpisu. Nie zastępuje walidacji sesji ani
ponownego sprawdzenia przypomnienia podczas dispatch.

Przypomnienia dziedziczą zakres rodzica w lokalnym i serwerowym zapisie. Prywatny
rodzic i konfiguracja nie docierają do partnera w pull, szczegółach ani kalendarzu.
Nowa lokalna kontrola weryfikuje także zgodność targetType z rodzicem oraz ukrywa
dzieci usuniętych/niedostępnych rodziców.

RAZ-12 dostarcza worker/push, anulowanie i deduplikację dispatch. Ustawienie zapisane
offline wymaga synchronizacji i świadomego opt-in urządzenia; szczegóły: [push.md](push.md).
Brak obietnicy alarmu offline i brak integracji z Apple/Google Calendar.

## Weryfikacja

Dowody: [quality/raz-9.md](../quality/raz-9.md). Testy obejmują rzeczywistą
synchronizację dwóch niezależnych magazynów, utracony ACK, rollback i upgrade starych
danych SQLite/IndexedDB oraz Chromium i mobilny WebKit z restartem całego procesu
przeglądarki w trybie offline. WebKit nie jest testem fizycznego iPhone'a.
