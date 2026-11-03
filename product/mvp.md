<!-- razem/product/mvp.md · updated 2026-10-28 by Codex -->
# Razem — zakres pierwszego wydania
## Cel
Zmniejszyć liczbę ustaleń rozrzuconych po wiadomościach. Dwie osoby organizują dom i plany, także bez internetu. Nie tworzymy komercyjnej platformy ani klona wszystkich funkcji Krivo.

## Funkcje MVP
### Dzisiaj
Najbliższe wydarzenia i ważne daty, zaległe i dzisiejsze zadania, skrót do zakupów, szybkie dodawanie. Widoczne połączenie z serwerem, oczekujące zmiany i konflikty. Brak internetu nie blokuje ekranów.
### Zakupy i listy
Wiele list; pozycja: nazwa, ilość jako tekst, opcjonalna uwaga, status kupione. Dodawanie, poprawianie, odhaczanie, cofnięcie i usuwanie; kupione na dole. Lista ma widoczność wspólną albo prywatną; elementy dziedziczą jej zakres.
### Zadania
Tytuł, opis, opcjonalny termin (dzień albo dzień i godzina), przypisanie ja/druga osoba/oboje dla wspólnych, tylko ja dla prywatnych. Filtry moje/wspólne/ukończone, zaległe, ukończenie/cofnięcie. Opcjonalne powtarzanie codziennie, co tydzień, co miesiąc z jednoznaczną polityką kalendarzową z architecture/overview.md.
### Kalendarz i ważne daty
Widok agenda i miesiąc; wydarzenia całodniowe, godzinowe i wielodniowe. Nazwa, opis, początek, koniec, widoczność, przypomnienie. Ważne daty: rocznica/urodziny/inne z powtórzeniem rocznym i opcjonalnym rokiem początkowym. Bez zewnętrznej synchronizacji z Apple/Google w MVP.
### Notatki
Tytuł i zwykły tekst; wyszukiwanie lokalne. Lista i edycja offline. Nowa notatka domyślnie prywatna. Bez załączników i edytora HTML.
### Ustawienia
Profil, konto, preferencje push, strefa Europe/Warsaw, motyw systemowy/jasny/ciemny, status synchronizacji, eksport własnych i wspólnych danych, kosz 30 dni, instrukcja instalacji na iPhone, wylogowanie.

## Prywatność
Wyraźna etykieta 'Wspólne' albo 'Tylko ja' przed zapisem i przy wpisie. Domyślnie listy zakupów, zadania, wydarzenia i ważne daty są wspólne; notatki prywatne.
Widoczność po utworzeniu jest w MVP niezmienna, również przed synchronizacją; dzięki temu nie ma wycofywania kopii ze sprzętu partnera. Udostępnienie prywatnej notatki tworzy po świadomym potwierdzeniu osobną wspólną kopię. Brak automatycznej zmiany zakresu list i wpisów.
Właściciel serwera może technicznie odczytać bazę. 'Prywatne' oznacza ochronę przed drugim kontem w aplikacji, nie E2EE.

## Offline
Po pierwszym zalogowaniu i pobraniu danych online można otworzyć zainstalowaną PWA w trybie samolotowym oraz tworzyć/edytować/usuwać/odhaczać wpisy. Lokalny zapis przetrwa zamknięcie i ponowne uruchomienie. Kolejka synchronizuje się, gdy serwer jest dostępny i aplikacja aktywna, również po wznowieniu. Zmiany drugiej osoby wymagają połączenia. Pokaż informację o danych czekających na wysłanie; nie nazywaj ich zbackupowanymi.

## Powiadomienia
Push po świadomym włączeniu przez użytkownika. Terminy zadań, kalendarz i ważne daty, przypisanie zadania; zmiany zakupów opcjonalnie, domyślnie wyłączone. Prywatne przypomnienia tylko właścicielowi. Treść na ekranie blokady domyślnie ogólna. Domyślne przypomnienia: wydarzenia godzinowe 30 min wcześniej, całodniowe i ważne daty o 09:00 danego dnia, zadania o 09:00 w dniu terminu lub o godzinie terminu; edytowalne i opcjonalne. Bez gwarancji punktualnego alarmu offline.

## Poza MVP
Rysowanie na żywo, zdjęcia, dokumenty/paszporty, śledzenie cyklu, finanse, geolokalizacja, AI, publiczne konta, płatności, sklep App Store, natywne widżety iOS, import kalendarzy. Nie dodawaj ich w ramach zadania bez zmiany zakresu.

## Ukończenie wydania
Wszystkie scenariusze quality/acceptance.md zaliczone, pakiet Ubuntu z odtworzonym backupem i zweryfikowane działanie PWA/push na fizycznym iPhone. Jeżeli brak fizycznego urządzenia/dostępu, zapisz ograniczenie i przekaż konkretną procedurę właścicielowi; nie ogłaszaj pełnego odbioru.

