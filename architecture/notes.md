# Notatki — RAZ-10

Notatka ma tytuł i `body` jako plain text. Formularz, lista, szczegóły,
wyszukiwanie, kosz i przywracanie korzystają wyłącznie z lokalnego magazynu
konta; sieć służy istniejącemu sync v2. Nie ma załączników ani rich text.
Kod ekranów: `apps/web/src/screens/More.tsx`; komendy:
`apps/web/src/offline/store.ts`; adapter: `apps/web/src/offline/live.tsx`.

## Tworzenie i wyszukiwanie

Domyślna widoczność nowej notatki to „Tylko ja”. Przed pierwszym zapisem można
wybrać „Wspólne”. Po utworzeniu zakres pozostaje stały, również przed pierwszą
synchronizacją. Tytuł jest wymagany (limit kontraktu 400 znaków), treść do 50 000
jednostek tekstu według istniejącego schematu. Polskie znaki i emoji pozostają
w danych; wyszukiwanie w tytule i treści ignoruje wielkość liter i diakrytyki
(w tym ł), bez wysyłania zapytania do serwera. Kosz nie bierze udziału w wynikach.
Treść jest renderowana jako tekst React, z zachowaniem nowych linii.

## Udostępnienie prywatnej notatki

„Udostępnij wspólną kopię” pokazuje drugi krok z pełnym tytułem i treścią oraz
wyjaśnieniem: druga osoba w domu otrzyma kopię po sync, może ją edytować/usunąć,
oryginał pozostaje prywatny, a widoczności kopii nie można cofnąć. „Anuluj”
nie zapisuje niczego. Dopiero „Utwórz wspólną kopię” zapisuje osobną notatkę
z nowym UUID. Dalsze zmiany obu notatek są niezależne.

`NoteCopy` zawiera lokalny `sourceId`, stały dla próby `copyId` oraz snapshot
potwierdzonego tekstu. `LocalStore.shareNote` sprawdza dostęp, aktywną prywatną
notatkę właściciela, poprawny nowy UUID i dane. Jedna transakcja zapisuje wspólny
rekord i jego create w kolejce. Istniejąca identyczna kopia pod tym ID oznacza
sukces bez nowej mutacji; inny payload/zakres jest błędem. Snapshot oraz copyId
pozostają w potwierdzeniu po błędzie lokalnego zapisu. Do sync trafia wyłącznie
zwykła mutacja create nowej notatki: **bez sourceId ani powiązania z oryginałem**.
Po lokalnym sukcesie retry sieci korzysta z trwałego clientMutationId/deviceId
oraz receipts serwera. Restart po lokalnym sukcesie zachowuje tę samą kolejkę.
Ponowne świadome wywołanie udostępnienia jest nową operacją i może utworzyć kolejną kopię.

## Edycja, błędy i konflikty

Błąd sieci nie blokuje zapisu lokalnego. Brak miejsca lub niedostępny magazyn
wycofuje transakcję i zostawia tekst formularza; interfejs nie potwierdza zapisu.
Zapisany outbox czeka na ACK; eksport niewysłanych zmian obejmuje tylko dane
aktywnego konta. Niezapisany szkic formularza jest w pamięci widoku — nie jest
objęty eksportem ani gwarancją przetrwania zamknięcia aplikacji.

Dwie zapisane edycje offline tego samego wpisu mają standardowy konflikt wersji:
`/zmiany` przechowuje moją wersję i wersję serwera. Można zachować jedną z nich
albo wybrać „Połącz ręcznie” dla tytułu/treści i zapisać połączony tekst. Nowy
mutationId opiera się na aktualnej wersji serwera; kolejna równoległa edycja
ponownie tworzy konflikt. Błąd scalania nie usuwa konfliktu ani wpisanego tekstu.
Delete/edit nie wskrzesza notatki bez decyzji; kosz pozwala przywrócić z moją wersją.

Edycja otwarta przed odebraniem nowszej wersji zachowuje pierwotną podstawę i szkic.
`expectedData` jest porównywane atomowo w transakcji update (wyłącznie lokalna
precondition; nie trafia do protokołu). Zmiana danych oznacza `record_changed`
bez zapisu. Formularz pokazuje bieżący tekst obok pól szkicu; po ręcznym
połączeniu „Użyj bieżącej wersji jako podstawy” pozwala zapisać. Kolejna zmiana
podczas tego kroku ponownie blokuje stary zapis. Zniknięcie wpisu lub błąd odczytu
podczas edycji nie odmontowuje formularza. Zmiana konta odmontowuje cały ekran,
a stary callback odmawia zapisu (`account_changed`).

## Prywatność, kosz i zgodność

Serwer nadal używa jedynej ścieżki RecordRepository/ACL dla push/pull/konfliktów.
Partner nie pobiera prywatnego tytułu, treści ani ID w snapshot/delta. Guessed-ID
update/delete/restore daje `not_found` bez stanu/wersji (odpowiedź korelująca echo
powtarza ID podane przez klienta). Próba zmiany visibility jest odrzucana.
Przeglądarka odczytuje wyłącznie bazę bieżącego konta i filtruje ACL lokalnie.

Soft-delete i restore korzystają z istniejących wersjonowanych mutacji. Kosz trwa
30 dni; trwałe tombstones i retencja zgodnie z [sync.md](sync.md).
RAZ-10 nie zmienia sync v2, schematu SQLite v4 ani Dexie v2. Regresja upgrade
v1→v2 sprawdza zachowanie prywatnego tekstu Unicode, kolejki oraz identyfikatorów
mutacji i urządzenia. Pełny eksport serwera `/api/export` pozostaje niezaimplementowany
(404); obecny działający eksport to lokalny eksport niewysłanych zmian/konfliktów.
Prywatność oznacza separację kont w aplikacji, bez E2EE przed administratorem.
