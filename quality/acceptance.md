<!-- razem/quality/acceptance.md · updated 2026-10-28 by Codex -->
# Razem — odbiór pierwszej wersji
## Dowody
Kryteria wymagają wyników testów, commitów/plików i opisanych kroków. Mock nie dowodzi prawdziwego push ani TLS na iPhone. Playwright WebKit nie zastępuje Safari/PWA fizycznego urządzenia. Brak fizycznego testu zapisuj jako niewykonany, nigdy PASS. Testy uruchamiaj proporcjonalnie do zmian; pełny przekrój przed wydaniem.

Automatyczna weryfikacja RAZ-14, mapa wszystkich poniższych scenariuszy i granice
środowiska: [raport QA](raz-14.md). Fizyczna bramka wydania pozostaje osobnym
odbiorem po wdrożeniu w RAZ-16.

## Scenariusze automatyczne
1. Dwa odizolowane konteksty A/B: logowanie, wspólne wpisy przepływają w obie strony; prywatny wpis A niedostępny B przez UI, guessed ID, sync pull/push, conflict, trash/restore, export, worker/push.
2. Po pierwszym online pobraniu: tryb offline, cold start PWA, utworzenie i poprawienie każdego typu, odhaczenie zakupów/zadań, usunięcie i przywrócenie. Zamknij/restartuj; dane i outbox zachowane.
3. Powrót serwera/połączenia: wszystkie operacje docierają, kolejka opróżnia się, brak duplikatów. Internet z niedostępnym serwerem i timeout nie daje fałszywego 'Zsynchronizowano'.
4. Zagubiona odpowiedź po commit, ponowna wysyłka, dwie karty i retry po restarcie: dokładnie jeden efekt domenowy. Mutacja z podmienionym payload pod tym samym ID odrzucona.
5. A i B offline edytują ten sam rekord; konflikt zachowuje obie wersje, da się go rozwiązać; delete/edit nie wskrzesza po cichu. Edycja różnych rekordów łączy się.
6. Stronicowany bootstrap/pull podczas nowych zapisów, stary cursor, full-resync, wygaśnięte receipts/tombstones: brak pominiętych zmian i utraty outbox.
7. Wygaśnięta/odwołana sesja, ponowne logowanie, wylogowanie z pending i zmiana konta: brak przecieku i cichej utraty.
8. Migracja starej IndexedDB z oczekującymi zmianami i nowy Service Worker podczas otwartego formularza: brak utraty edycji, pętli reload i niezgodnych bundle.
9. Walidacja, quota error, unavailable storage, błędy sieci: zrozumiały komunikat, bez fałszywego sukcesu.
10. Daty: DST Europe/Warsaw, 29.02, 31. dzień miesiąca, zadania cykliczne odhaczone na obu telefonach, wydarzenia wielodniowe i różne strefy; brak podwójnych wystąpień.
11. Push: opt-in/odmowa, test uprawnień, anulowanie/przesunięcie przypomnienia, restart workera i przerwany dispatch, expired subscription 404/410; brak podwójnego zaplanowania i przecieków. Opisz granicę dostarczenia co najmniej raz u zewnętrznej usługi; nie obiecuj exactly-once dostarczenia push.
12. Backup działającej bazy WAL, integrity_check i restore do czystej instalacji; eksport z ACL, migracja i scenariusz rollback.

## Ręcznie na fizycznym iPhone — oba konta
Po HTTPS z zaufanym certyfikatem: dodanie do ekranu, ikona/nazwa/standalone, safe areas, klawiatura i formularze, jasny/ciemny motyw, duży tekst/VoiceOver, brak poziomego scrolla.
Po synchronizacji włącz tryb samolotowy, zamknij PWA i otwórz ponownie. Dodaj zakupy, zadanie, wydarzenie i notatkę; restartuj; odzyskaj internet, otwórz i sprawdź drugi telefon.
Sprawdź konflikt utworzony na obu telefonach. Na ekranie drugiej osoby nie pojawia się prywatna notatka.
Włącz push świadomym kliknięciem i sprawdź prawdziwe przypomnienie przy zamkniętej PWA i dostępnym internecie, deep link oraz prywatną treść. Nie oczekuj gwarantowanego alarmu offline.
Sprawdź wylogowanie, brak danych poprzedniego konta i aktualizację PWA bez utraty oczekujących zmian.
Jeżeli agent nie ma fizycznych telefonów, przekaż tę listę jako jedną owner action po gotowym wdrożeniu.

Szczegółowa procedura z osobnymi wynikami A/B i metryką rzeczywistej instalacji:
[odbiór RAZ-16](../operations/iphone-acceptance.md).

## Bramka wydania
Sprawdzenie typów, build, testy domeny/sync/ACL oraz e2e Chromium+WebKit; bez błędów krytycznych; pakiet Docker z działającym health; realne HTTPS; odtworzony backup; fizyczne testy PWA/push z udokumentowanym wynikiem.
Wynik rozdziela: zaimplementowane, automatycznie zweryfikowane, faktycznie wdrożone, fizycznie sprawdzone. Dokumentacja planu nie spełnia kryterium działania aplikacji.

