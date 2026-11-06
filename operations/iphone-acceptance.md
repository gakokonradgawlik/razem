# RAZ-16 — odbiór na dwóch fizycznych iPhone’ach

Status początkowy: **NIEWYKONANE**. Formularz jest procedurą, nie dowodem
wdrożenia. Wypełnij go po autoryzowanej instalacji według [runbooka Ubuntu](ubuntu.md).
Użyj dwóch rzeczywistych kont i sztucznych wpisów testowych. Oznaczenia A/B
zastępują dane osobowe. Nie dołączaj haseł, cookies, eksportów danych, URL
subskrypcji push ani screenshotów z prywatnymi treściami.

## Warunki rozpoczęcia i zapis instalacji

Agent/operator zapisuje fakty, właściciel wykonuje kroki na telefonach.
Brak warunku oznacza NIEWYKONANE dla zależnych prób. FAIL wymaga opisu objawu;
PASS wymaga obserwacji na każdym urządzeniu i daty z godziną/strefą.

| Pole | Zweryfikowana wartość / dowód |
| --- | --- |
| Pełny commit, APP_VERSION, suma pakietu i ID obrazu | NIEWYKONANE |
| Host, Ubuntu/architektura, dysk i Docker/Compose | NIEWYKONANE |
| Katalog, projekt Compose, wolumen i usługi app/worker | NIEWYKONANE |
| Bind/port upstream, proxy i faktyczny HTTPS origin | NIEWYKONANE |
| Health app/worker, HTTP /healthz i /readyz | NIEWYKONANE |
| Certyfikat/CA i zaufanie Safari A oraz B | NIEWYKONANE |
| Dokładnie dwa konta, wymuszona zmiana hasła | NIEWYKONANE |
| Usunięte wejście bootstrapu, VAPID skonfigurowany (bez kluczy) | NIEWYKONANE |
| Timer backupu, ostatni sukces, nazwa kopii, integralność i izolowany restore | NIEWYKONANE |
| Inne usługi hosta przed/po instalacji | NIEWYKONANE |
| Telefon A: model, wersja iOS, data i strefa testu | NIEWYKONANE |
| Telefon B: model, wersja iOS, data i strefa testu | NIEWYKONANE |

Origin skopiuj z potwierdzonego wdrożenia; alias formularza Installation sam go
nie potwierdza. Safari obu telefonów musi otworzyć go bez ostrzeżeń TLS.
Jeśli potrzebna jest lokalna CA, właściciel zatwierdza zaufanie i wykonuje kroki
z runbooka. Nie obchodź ostrzeżeń ani nie wyłączaj weryfikacji TLS.
Nie zmieniaj routera, VPN ani firewalla w ramach odbioru.

## Instalacja i próby właściciela

W kolumnach zapisz PASS/FAIL/NIEWYKONANE, czas i obserwację. Próby parowe
przeprowadź również po zamianie ról A/B. Nie usuwaj danych aplikacji podczas
prób offline, aktualizacji ani odzyskiwania.

| ID | Kroki i oczekiwany wynik | A | B |
| --- | --- | --- | --- |
| P1 | Safari → potwierdzony HTTPS origin. Zaloguj każde konto na jego telefonie i zmień hasło tymczasowe. Zakończ pełny sync. Udostępnij → Do ekranu początkowego. Otwórz ikoną online; sprawdź nazwę Razem, ikonę, standalone i gotowość offline. | NIEWYKONANE | NIEWYKONANE |
| P2 | Sprawdź pion/poziom, safe areas, klawiaturę/formularze, oba motywy, duży tekst i VoiceOver. Kontrolki dostępne, bez ucięcia i poziomego przewijania. | NIEWYKONANE | NIEWYKONANE |
| P3 | Utwórz prywatną notatkę i wspólną listę. Partner widzi listę, nie widzi notatki w listach, wyszukiwaniu, koszu ani swoim eksporcie. Przekazany bez treści link do prywatnej notatki nie daje partnerowi dostępu. | NIEWYKONANE | NIEWYKONANE |
| P4 | Po pełnym sync włącz tryb samolotowy i wyłącz Wi-Fi. Zamknij PWA z przełącznika aplikacji, otwórz ikoną bez sieci. Zapisz i edytuj zakupy, zadanie, wydarzenie, ważną datę i notatkę; odhacz zakupy/zadanie, usuń i przywróć wpis. Dane i pending przetrwają ponowne zamknięcie/otwarcie oraz restart telefonu nadal bez sieci. | NIEWYKONANE | NIEWYKONANE |
| P5 | Przywróć połączenie, otwórz PWA i poczekaj na sync. Kolejka opróżnia się, shared dociera do partnera, private pozostaje własne, bez duplikatów. Nie oczekuj sync zamkniętej PWA. | NIEWYKONANE | NIEWYKONANE |
| P6 | Zsynchronizuj wspólną notatkę na A/B. Odłącz oba telefony, zmień to samo pole na różne wartości i zapisz. Połącz A i zakończ sync, potem B. W „Zmiany do sprawdzenia” na B są obie wersje; wybierz/połącz je i sprawdź wynik na A/B. Powtórz dla usunięcia na A i edycji na B: brak cichego wskrzeszenia, treść do odzyskania pozostaje. | NIEWYKONANE | NIEWYKONANE |
| P7 | Offline zapisz zmianę. Próba wylogowania ostrzega o pending; anuluj ją i wyeksportuj niewysłane zmiany do chronionego miejsca. Online zsynchronizuj, wyloguj się i zaloguj jako partner: brak private i lokalnych zmian poprzedniego konta. Przywróć właściwe konto. | NIEWYKONANE | NIEWYKONANE |
| P8 | Przy oddzielnie autoryzowanej aktualizacji zachowaj otwarty formularz i pending offline. Nowa wersja nie przeładowuje samoczynnie formularza. Zapisz, zamknij wszystkie okna Razem, otwórz ponownie; sprawdź treść, outbox i końcowy sync. Zapisz stary/nowy commit. Bez rzeczywistej aktualizacji pozostaw NIEWYKONANE. | NIEWYKONANE | NIEWYKONANE |
| P9 | W zainstalowanej PWA sprawdź odmowę zgody push, potem świadomy opt-in przyciskiem (ewentualnie przywracając zgodę w iOS). Zaplanuj wspólne zadanie/wydarzenie i prywatną ważną datę z bliskim przypomnieniem; potwierdź sync. Zamknij PWA, pozostaw internet. Sprawdź prawdziwe dostarczenie, kliknięcie i właściwy uprawniony wpis. Private A nie trafia do B ani odwrotnie. | NIEWYKONANE | NIEWYKONANE |
| P10 | Sprawdź ogólny komunikat na ekranie blokady. Kliknięcie po odwołaniu sesji przez operatora wymaga logowania i zachowuje uprawnienia po nim, bez cudzej prywatnej treści. | NIEWYKONANE | NIEWYKONANE |
| P11 | Przed terminem przesuń/usuń wpis i ukończ zadanie. Po sync stare przypomnienie nie powinno być wysłane, o ile nie zostało już przyjęte przez usługę push. Sprawdź wyłączenie urządzenia w aplikacji, cofnięcie zgody iOS, logout i ponowny jawny opt-in. | NIEWYKONANE | NIEWYKONANE |

Dla P9–P11 zapisz osobno rodzaj wpisu, termin ze strefą, czas sync, zamknięcia,
dostarczenia i kliknięcia oraz wynik na A/B. Brak powiadomienia to FAIL albo
NIEWYKONANE z przyczyną, nigdy domniemane PASS. Internet z niedostępnym serwerem
nie oznacza poprawnego sync. Mock/WebKit nie dowodzi dostarczenia push.
Nie ma gwarancji alarmu offline ani dokładnie jednego dostarczenia.

## Utrzymanie i zakończenie

Aktualizacja, zatrzymanie/start i diagnoza zdrowia: [Ubuntu](ubuntu.md#preflight-instalacja-i-aktualizacja).
Harmonogram, kopia i odzyskiwanie: [backup](backup.md). Próbny restore wykonuje
operator w nowym izolowanym celu bez wysyłania push, z kontrolą integrity/FK,
dwóch kont, ACL i odwołania starych sesji; nie nadpisuje czynnej bazy/WAL.
Przed zmianą wersji/odzyskiwaniem zachowaj lokalne pending obu telefonów.

Po próbach usuń własne sztuczne wpisy, testowe przypomnienia i lokalne eksporty,
gdy nie są już potrzebne. Operator usuwa własny cel restore i zasoby tymczasowe,
potwierdza zwolnienie ich portów; trwałe dane i backupy pozostają.
Zapisz wyjątki sprzątania. Deployment uzupełnij dopiero faktycznie zweryfikowanym
originem, commitem i runbookiem. Zapisz wyniki P1–P11 w ToDo; niespełnione warunki
przekaż jedną `request_owner_action`. Cały RAZ-16 pozostaje nieukończony, dopóki
nie ma dowodów wdrożenia, backupu i prób obu fizycznych iPhone’ów.
