# Dzisiaj i ustawienia — RAZ-11

## Dzisiaj

Widok czyta wyłącznie AppServices → LocalStore → IndexedDB konta z ACL. Używa
walidacji wspólnych kontraktów oraz tych samych projekcji co moduły. Nie ma seedów
produkcyjnych ani odrębnego magazynu podsumowań. Zapis z menu „Dodaj” korzysta
ze zwykłych formularzy i atomowych komend rekord + outbox, również offline.
Menu obejmuje zadanie, wydarzenie, listę zakupów, notatkę i ważną datę.

- Zadania: otwarte, dzisiejsze/zaległe, także przypisane partnerowi. Przy cyklicznym
  pokazany najstarszy nieukończony termin, bez tworzenia nowego szablonu. Dzień
  terminu wyznacza strefa zapisana w zadaniu. Odhaczenie zapisuje się lokalnie;
  Cofnij odwraca tę samą operację/wystąpienie.
- Kalendarz: dziś i sześć kolejnych dni w strefie domu, koniec wyłączny. Wydarzenie
  trwające od wcześniejszego dnia pokazuje się raz. Ważne daty używają najbliższego
  wystąpienia z regułami roku początkowego, 29.02 i przełomu roku.
- Zakupy: listy z niekupionymi produktami oraz puste listy, do których można dopisać
  pierwszy produkt. Lista ukończona pozostaje w module Zakupy.

Każda sekcja pokazuje do pięciu pozycji i link do pełnego modułu. Daty aktualizują
się podczas otwarcia widoku, co 30 sekund. Niedostępna baza nie jest pustym
podsumowaniem. Każda pozycja ma zakres prywatności; inne konto nie otrzymuje prywatnych
rekordów, także przy restarcie i spóźnionych odczytach poprzedniej generacji konta.

## Ustawienia

Zgodnie z architecture/overview.md metadane konta są zmieniane online. Nowe
`GET/PATCH /api/settings` wymagają sesji, własnego hasła, a PATCH także CSRF/Origin.
`x-razem-account` musi zgadzać się z kontem sesji tego samego żądania; inaczej
409 account_mismatch bez skutków. Payload jest strict; nie przyjmuje ID właściciela,
loginu, hasła, sesji, partnera ani pushEnabled. Odpowiedź zawiera wyłącznie userId,
dom (ID/nazwa/strefa), nazwy i ID obojga oraz własne dwie preferencje powiadomień.
Nie ma danych domenowych ani cudzych preferencji. Konto zmienia własną nazwę;
partner zmienia swoją na własnym koncie. Strefa domu jest wspólna.

Zapis jest transakcyjny w istniejących tabelach users/households/preferences.
Nie zmieniono SQLite v4, Dexie v2 ani koperty sync v2. Nie ma nowej ścieżki zapisu
rekordów domenowych. Sync aktywnej aplikacji odświeża ustawienia, a potwierdzona
odpowiedź jest cache'owana w meta bazy danego konta. UI odczytuje ją lokalnie;
restart offline zachowuje nazwy, strefę i preferencje. Stary magazyn bez cache
używa Europe/Warsaw do pierwszego pobrania; jego rekordy i pending zostają.
Błąd online zachowuje formularz i poprzednie ustawienia. Spóźniona odpowiedź
starej generacji nie zapisuje się do bazy nowego konta. Formularze przesyłają
wyłącznie pola zmienione względem otwarcia; odświeżenie nie cofa nietkniętych pól.

Motyw pozostaje preferencją urządzenia w razem:theme, stosowaną przed renderem.
Strefa domu zmienia grupowanie godzinowych wydarzeń, „dziś” kalendarza/ważnych dat
oraz domyślną strefę nowych wydarzeń i zadań. Nie przelicza zapisanych UTC,
date-only ani harmonogramów zadań; edycja używa strefy istniejącego wpisu.
Przyszły worker używa strefy domu dla ważnych dat (RAZ-12).

Preferencje konta: tytuły na ekranie blokady i zmiany zakupów, domyślnie false.
Opis tytułów wyjaśnia widoczność prywatnych/wspólnych tytułów na blokadzie telefonu.
Włączenie wysyłki jest uczciwie niedostępne do RAZ-12; nie prosimy o systemową zgodę
ani nie udajemy subskrypcji. Od RAZ-13 pełny eksport własnych i wspólnych danych pobiera JSON z `/api/export`
(wymaga połączenia). Osobny eksport niewysłanych intencji i pełnych konfliktów działa
offline, w formacie pending v2; nie kasuje kolejki. Pliki są związane z kontem
i generacją widoku. Szczegóły: [backup.md](../operations/backup.md).

Kosz, instalacja PWA, zmiana hasła i konflikty są dostępne z Ustawień/Więcej;
konflikty i ponowne logowanie także bezpośrednio z odznaki Dzisiaj. Kosz odróżnia
niedostępność od pustki, pokazuje datę usunięcia i zgłasza błąd restore. Serwer
ostatecznie stosuje retencję 30 dni; po długim offline lokalny kosz wymaga sync.

Logout odczytuje trwałe pending przed żądaniem i ponownie po nim; odmawia kasowania
bez świadomego wyboru przy niewysłanych zmianach. Wyślij/eksportuj/anuluj/świadomie
usuń pozostają dostępne. Żądanie klienta niesie ID oczekiwanego konta; serwer
odrzuca zmianę sesji w innej karcie. Callback i odpowiedź logout są związane
z generacją konta, więc nie kasują bazy nowego konta. Błąd sieci zachowuje dane.

Dowody i ograniczenia: [quality/raz-11.md](../quality/raz-11.md).
