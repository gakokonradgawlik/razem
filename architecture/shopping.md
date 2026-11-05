# Zakupy — implementacja RAZ-7

## Przepływ

`Shopping.tsx` → `AppServices` → `AppController.command` → `LocalStore` → jedna
transakcja Dexie (rekord i outbox) → istniejący silnik sync → `RecordRepository`.
UI czyta wyłącznie lokalną bazę konta. Sukces, wyczyszczenie pola i Cofnij pojawiają
się po zatwierdzeniu lokalnej transakcji; ACK serwera nie jest warunkiem pracy.

Wiele list, domyślnie wspólnych. Przed utworzeniem wybór „Wspólne” / „Tylko ja”;
po zapisie zakres niezmienny, także offline. Dziecko dziedziczy zakres listy,
nie przyjmuje osobnej widoczności; `listId` jest niezmienny. Prywatność egzekwuje
serwer, również przy guessed ID, konfliktach, usuwaniu i przywracaniu.

## Obsługa

- Na ekranie listy „Nazwa produktu” + Enter lub „Dodaj” zapisuje pozycję i zostawia
  fokus do następnej. Pole czyści się dopiero po sukcesie; błąd zachowuje tekst.
  Link „Dodaj pozycję” otwiera pełny formularz z ilością tekstową i uwagą.
- Edycja pozycji wysyła tylko zmienione pola. Ilość jest tekstem, np.
  „2 opakowania”, a nie liczbą. Nazwa/ilość/uwaga obsługują polskie znaki.
- Odhaczenie zapisuje lokalnie natychmiast, oferuje Cofnij i przenosi wpis do
  sekcji „Kupione” na dole. Cofnij to kolejna komenda przez tę samą kolejkę.
- Porządek w obu sekcjach: rosnąco `sortKey`, przy remisie porównanie UUID.
  Nowy wpis dostaje `Date.now()` jako klucz; to porządek prezentacji, a nie
  rozstrzyganie konfliktów zegarem. Klucz nie jest renumerowany przy odhaczaniu,
  edycji, ACK ani pull. Odznaczenie przywraca miejsce w części „Do kupienia”.
- Usuwanie wymaga potwierdzenia. Kosz (Więcej → Kosz) zawiera także pojedyncze
  pozycje zakupów. Przywrócenie jest wersjonowaną komendą i działa offline.
  Usunięcie listy zachowuje jej dzieci; lokalne widoki i komendy dzieci są wtedy
  niedostępne. Najpierw przywraca się listę. Po przywróceniu wracają jej aktywne
  pozycje, a wcześniej usunięte nadal są w koszu. Serwer usuwa listę z dziećmi
  trwale po 30 dniach zgodnie z istniejącą retencją.

## Synchronizacja i zgodność

Bez nowego endpointu CRUD, schematu bazy czy wersji protokołu (Dexie v2, protokół v1).
Różne pozycje to różne rekordy, więc ich zmiany łączą się. Sprzeczna edycja tej samej
pozycji korzysta z `/zmiany`: zachowuje moją i serwerową wersję, pozwala wybrać
wersję albo scalać pola; rozwiązanie dostaje nowy mutationId i aktualny baseVersion.
Podmiana listId, owner/household lub zakresu pozostaje odrzucana.

Starsza kolejka v1 może po migracji mieć dziecko przed rodzicem, gdy queuedAt
jest równe, a UUID dziecka sortuje się wcześniej. `nextBatch` sprawdza wszystkie
oczekujące create rodziców: dziecko czeka, aż rodzic wejdzie wcześniej do partii
lub dostanie ACK. Nie zmienia się payloadów, deviceId ani clientMutationId,
więc zachowana jest idempotencja po utracie odpowiedzi.

Dowody i ograniczenia: [quality/raz-7.md](../quality/raz-7.md).
