# Powiadomienia Web Push — RAZ-12

## Zachowanie użytkowe

Powiadomienia włącza się osobno na każdym urządzeniu w Ustawienia → Powiadomienia.
Systemowa prośba pojawia się wyłącznie po kliknięciu „Włącz powiadomienia”. Na iPhonie
wymagana jest aplikacja dodana do ekranu początkowego, uruchomiona ikoną, z bezpiecznego
originu. UI rozróżnia potrzebę instalacji, brak wsparcia/HTTPS, odmowę, brak konfiguracji
serwera i nieudaną subskrypcję. Powrót do aplikacji i zmiana uprawnień odświeżają stan;
cofnięcie zgody odpina powiązanie, gdy serwer jest dostępny. Nie ma automatycznego opt-in.

Domyślnie lockscreen pokazuje „Masz przypomnienie w Razem”. Świadome ustawienie konta
pozwala pokazywać tytuły własnych i wspólnych wpisów. Prywatny wpis zawsze pozostaje
wyłącznie u właściciela. Zakupy wymagają dodatkowego przełącznika (domyślnie false).
Powiadomienia o przypisaniu zadania można osobno wyłączyć. Zmiana produktu, także
usunięcie, prowadzi do dostępnej, żywej listy; usunięta lista nie wysyła powiadomienia.
Przypisania i zmiany zakupów powiadamiają wyłącznie drugą osobę: autor czynności
nie dostaje push na żadne ze swoich urządzeń. Nowe wspólne zadanie `both`/`partner`
utworzone przez A powiadamia B; `self` i zadanie prywatne nie generują powiadomienia
o przypisaniu dla A. Zmiana przypisania powiadamia tylko nowo dodanych odbiorców,
po wykluczeniu autora. Przypomnienia o terminach nadal trafiają do przypisanych osób,
także jeśli same utworzyły zadanie.

Zadania mają domyślnie przypomnienie w chwili terminu albo o 09:00 w zapisanej strefie
zadania dla terminu date-only. Ustawienia konta pozwalają wyłączyć przypomnienia,
zmienić godzinę date-only oraz wyprzedzenie 0–10080 minut. Istniejący rekord `reminder`
targetType=task jest nadrzędną konfiguracją wpisu. Zwykłe ukończone zadanie i ukończone
wystąpienie cyklu nie przypominają. Worker nie tworzy kolejnych szablonów ani ukończeń.

Kalendarz i ważne daty korzystają z opcjonalnych konfiguracji wpisów RAZ-9. Godzinowe:
domyślnie 30 minut wcześniej; całodniowe i ważne daty: 09:00 danego dnia. Wyprzedzenie,
godzina i wyłączenie pozostają w formularzu wpisu i zapisują się offline z outbox.
Wydarzenie zachowuje własną strefę, ważna data używa aktualnej strefy domu. Reguły DST,
29.02 i powtarzania pochodzą ze wspólnych funkcji `@razem/contracts`. Przy kilku dawnych
konfiguracjach jednego wpisu obowiązuje najnowsza (remis: rosnące ID).

Serwer zna tylko zsynchronizowane wpisy. Wysyłka zależy od połączenia, ustawień telefonu
i usługi push; nie jest lokalnym alarmem offline. Każdy push pokazuje widoczne
powiadomienie. Service Worker nie synchronizuje danych po cichu ani w tle.

## API, konto i dane

Wszystkie `/api/push/*` wymagają aktualnej sesji, własnego hasła i nagłówka
`x-razem-account`; mutacje także wspólnej ochrony Origin/CSRF. deviceId nie autoryzuje.

| Endpoint | Działanie |
| --- | --- |
| GET `/api/push/config` | Wyłącznie publiczny klucz VAPID lub null |
| GET `/api/push/devices/:id` | Stan własnego urządzenia w bieżącej sesji |
| PUT `/api/push/subscription` | Strict deviceId + standardowy JSON subskrypcji |
| DELETE `/api/push/devices/:id` | Odpięcie własnego urządzenia bieżącej sesji |
| POST `/api/push/resolve` | Ponowne ACL dla entityType/id; zwraca wyłącznie trasę |

Endpoint może wskazywać wyłącznie HTTPS oficjalnych usług Apple, FCM, Mozilla lub
Windows Push, bez credentials, niestandardowego portu i fragmentu. Ogranicza to SSRF
z serwera do LAN. Nie można przejąć endpointu innego konta/sesji przez jego rejestrację.
Unikalność `(user_id,device_id)` i endpointu chroni przed podwójną subskrypcją.
Powtórzenie identycznego PUT zachowuje ID subskrypcji i kolejkę.

Subskrypcja jest związana FK z sesją. Logout, reset/odwołanie sesji i restore backupu
usuwają powiązanie push. Udany login zastępujący ciasteczko odpina push poprzedniej
sesji przeglądarki; inne urządzenia pozostają. Po ponownym logowaniu trzeba jawnie
włączyć push. Wygaśnięcie sesji także zatrzymuje wysyłkę (rolling domyślnie 30 dni).
Browser może nadal mieć niepowiązaną subskrypcję po logout; serwer nie może już jej użyć,
a kolejny opt-in zastępuje ją. Lokalne outbox/conflicts zachowują istniejącą separację kont.

Kliknięcie otwiera `/powiadomienie/:type/:id`. Ekran najpierw pyta serwer o aktualną
sesję/ACL/stan wpisu i dopiero przekierowuje do lokalnych szczegółów. Prywatny cudzy,
usunięty i nieistniejący wpis nie ujawniają treści. Bez sieci lub sesji link nie otwiera
cache szczegółów; logowanie zachowuje bezpieczną trasę powrotu. SW dopuszcza wyłącznie
własny origin i znane trasy, także przy podmienionych danych kliknięcia.

SQLite v5 unieważnia nieweryfikowalne stare subskrypcje i nieużywany szkielet kolejki
v2, dodaje powiązanie sesji, preferencje i `worker_state`. Zachowuje domenę, sesje,
journal, receipts oraz wcześniejsze preferencje. Migracje v1–v5 są zamrożone; migruje
wyłącznie serwer z backupem. Worker czeka na aktualny schemat, sam nie migruje.
Migracja v6 dodaje `actor_id` do `task_events` i `sync_changes` oraz
`previous_assignee` do `task_events`. `RecordRepository` zapisuje autora z zaufanego
`AccountScope` i poprzednie przypisanie w tej samej transakcji co rekord/journal/receipt.
`owner_id` pozostaje właścicielem rekordu, także gdy zmienia go partner. Pola są tylko
serwerowe, bez zmiany payloadów API, sync czy eksportu. Starsze zdarzenia i systemowy
purge mają autora NULL: nie zgadujemy go z właściciela i pomijamy takie powiadomienia
assignment/shopping, również już oczekujące w kolejce. Terminy nadal obsługuje pełny skan.
Dexie v2 i sync v2 pozostają bez zmian. Rozszerzone preferencje settings/eksportu
wymagają `x-razem-notifications: 1`; starsza strict PWA otrzymuje dotychczasowe dwa pola.
Nowy klient czyta także stary offline cache z domyślnymi wartościami rozszerzenia.
Historyczne `preferences.push_enabled` nie autoryzuje wysyłki; decydują ważne subskrypcje.

## Kolejka i gwarancje

Worker uruchamia cykl na starcie i co 15 sekund, najwyżej jeden naraz na proces.
Pełny skan aktualnych terminów obejmuje także zadania sprzed dodania `task_events`.
Horyzont planowania to 32 dni; pominięte terminy są nadrabiane najwyżej przez 24 godziny.
Nowa subskrypcja nie dostaje zdarzeń/terminów sprzed opt-in. Kolejne wystąpienia cykliczne
wylicza wspólna reguła, nie najstarsza zaległość pokazywana w UI.

Przypisania pochodzą z `task_events`, zakupy z `sync_changes`. Checkpointy są trwałe;
partia do 1000 zdarzeń i wstawienie dispatch są zatwierdzane w jednej transakcji
IMMEDIATE. Błąd wstawienia cofa również checkpoint. Dwa zdarzenia create/assigned
tego samego zadania i wersji dają jedną wysyłkę. Brak subskrypcji nie zatrzymuje checkpointu.
Planner i dispatcher wykluczają autora zdarzenia oraz dotychczasowych odbiorców
przypisania (porównanie `previous_assignee` z aktualnym przypisaniem przez wspólne
`taskRecipients`). Cofnięcie/utrata uprawnień i zmiana wersji nadal anulują stary dispatch.

`reminder_dispatches` ma unikalny hash klucza obejmującego subskrypcję, wpis, wersję,
rodzaj, termin, źródło i konfigurację. Brak payloadów/tytułów w kolejce. Każde urządzenie
ma własny dispatch i retry. Zmiana/usunięcie wpisu, konfiguracji, przypisania, ukończenia,
preferencji albo sesji unieważnia stare zadanie. Najpierw anuluje je planner, a dispatcher
ponownie sprawdza aktualny stan bezpośrednio przed wywołaniem transportu. Sprawdza także
ACL rodzica produktu i konfiguracji. Edycja tytułu po wysyłce nie powtarza tego samego
już wysłanego terminu. Ponowne włączenie przyszłego, anulowanego przypomnienia je przywraca.

Przejęcie pracy jest transakcją SQLite: `processing`, lease 60 s, losowy token i licznik
prób. Zakończenie wymaga nadal własnego tokenu. Restart odzyskuje wygasły lease;
nieterminowa odpowiedź starego workera nie nadpisuje nowszej próby. Transport ma timeout
10 s. Retry dla sieci/5xx/408/429: 30 s, 60 s, 120 s… do godziny, maksymalnie 8 prób.
Inne błędy 4xx kończą wysyłkę. 404/410 usuwa martwą subskrypcję i jej kolejkę; znany
expirationTime jest sprawdzany niezależnie. TTL u dostawcy wynosi godzinę.

Nie ma transakcji obejmującej SQLite i zewnętrzną usługę. Awaria po przyjęciu push przez
dostawcę, przed zapisaniem `sent`, może spowodować ponowne dostarczenie po lease/retry.
To granica dostarczenia co najmniej raz, bez obietnicy exactly-once. Stały tag pomaga
scalać powtórki w centrum powiadomień. Zmiany/logout zatwierdzone po ostatnim sprawdzeniu
lub push już przyjęty przez usługę nie mogą odwołać wiadomości będącej w drodze.

## VAPID i konfiguracja operacyjna

Standardowy transport `web-push` 3.6.7 szyfruje payload (`aes128gcm`) i podpisuje VAPID.
Jedna stała para `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` oraz prawidłowy `VAPID_SUBJECT`
(mailto lub HTTPS) musi być dostępna app i workerowi. Brak wszystkich trzech wyłącza
wysyłkę; konfiguracja częściowa/błędna blokuje start stałym komunikatem bez sekretów.
Kluczy nie generuje się przy każdym starcie. Publiczny klucz trafia do zalogowanej PWA;
prywatny oraz endpoint/auth/p256dh pozostają poza Git i logami. Logger HTTP jest wyłączony,
błędy transportu nie są drukowane, bo mogą zawierać payload i nagłówki autoryzacji.

Parę generuje administrator dopiero w autoryzowanym środowisku, raz na instalację,
za pomocą `webpush.generateVAPIDKeys()`, zapisując wynik bezpośrednio do chronionego pliku
0600. Nie podawaj klucza w argumentach procesu ani nie wypisuj go do terminala/logów.
Przykładowe nazwy są w `.env.example`; Compose przekazuje te same trzy zmienne obu usługom.
Chroniony plik można przekazać jako `docker compose --env-file /chroniony/plik.env ...`.
Backup konfiguracji i odtworzenie: [operations/backup.md](../operations/backup.md).
Zmiana pary wymaga ponownego opt-in urządzeń. Nie wykonano wdrożenia ani rotacji kluczy.

## Weryfikacja i źródła

Dowody automatyczne i jawne granice: [quality/raz-12.md](../quality/raz-12.md).
Fizyczny test obu iPhone'ów po wdrożeniu HTTPS należy do RAZ-16: instalacja, świadoma
zgoda/odmowa, zamknięcie PWA, rzeczywiste przypomnienie, ogólny lockscreen, link po
wygaśnięciu sesji, private kontra partner, cofnięcie zgody i logout. Wyniku fizycznego
nie zastępują mock transportu, Playwright ani lokalny WebKit.

- [Apple: Sending web push notifications in web apps and browsers](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
- [WebKit: Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [WebKit: Meet Web Push — każdy push musi być widoczny](https://webkit.org/blog/12945/meet-web-push/)
- [Oficjalne repozytorium web-push](https://github.com/web-push-libs/web-push)
