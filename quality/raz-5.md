# RAZ-5 — dowody i przekazanie

Gałąź `agent/raz-5`. Środowisko: Node 26.13.0 / npm 11.20.0 (oficjalny tarball w katalogu
tymczasowym, SHA256 zgodny z `SHASUMS256.txt`; systemowy Node hosta to 22 i nie spełnia
`engines`), Playwright 1.64.1 z Chromium i WebKit pobranymi do katalogu tymczasowego.
Tylko syntetyczne konta i treści. Nowa zależność dev: `fake-indexeddb` 6.2.7 (dokładna wersja, lockfile).

## Zrealizowano
Warstwa local-first wspólna dla wszystkich modułów (opis: architecture/sync.md, sekcja
„Implementacja klienta RAZ-5”): baza Dexie per konto z migracją v1→v2, atomowe komendy,
kolejka z rebase po ACK, pull/pełny resync, silnik synchronizacji aktywnej aplikacji z blokadą
kart, logowanie/ponowne logowanie/przełączenie konta/wylogowanie, statusy, ekran „Zmiany do
sprawdzenia” z porównaniem i scalaniem, eksport niewysłanych zmian, kosz z przywracaniem.
Ekrany RAZ-3 działają teraz na lokalnej bazie (lista odświeża się po każdej zmianie, także z innej karty).

## Kontrole
| Kontrola | Wynik |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | PASS: 17 plików, 156 testów |
| `npm run build` | PASS (ostrzeżenie Vite o paczce >500 kB jak w RAZ-3) |
| `npm run test:e2e` | PASS 39, 1 pominięty (safe-area tylko Chromium, jak w RAZ-3) |

### Klient ↔ prawdziwy serwer (vitest, `apps/web/src/offline/sync.test.ts`, 17 testów)
Dexie na fake-indexeddb (osobna fabryka = osobny telefon, wspólna = karty), serwer Fastify +
SQLite z RAZ-4 przez `app.inject` z ciasteczkami, CSRF i wstrzykiwanymi awariami (`test-harness.ts`).
- Rekord i outbox w jednej transakcji; QuotaExceeded przy zapisie outboxu wycofuje rekord (create i update), wynik `storage_full`; eksport działa; „restart” (nowa karta) zachowuje kolejkę, potem jeden ACK.
- Niedostępny IndexedDB: `storage_unavailable`, żadna komenda nie zwraca sukcesu.
- Dwa telefony offline: nowe pozycje, 3 edycje jednego rekordu, 2 edycje listy, prywatna notatka B; zgubiona odpowiedź push po commit; wynik: identyczne dane, wersje 3/1, 2 wiersze w SQLite, powtórzone ID mutacji bez drugiego efektu, prywatna notatka B nieobecna u A.
- Konflikt: obie wersje + baza, brudny rekord nie nadpisany przez pull, blokada edycji, scalenie → zmiana na serwerze w międzyczasie → nowy konflikt → scalenie → wersja 4 u obu.
- Usunięcie kontra edycja: treść zachowana, rekord nie wskrzeszony bez decyzji; „moja wersja” = restore + update. Lokalne usunięcie kontra zdalna edycja: wersja z serwera zachowuje wpis.
- Tombstone po 31 dniach (retencja serwera): wygasła sesja, ponowne logowanie, konflikt z tombstone, moja treść jako nowy wpis z nowym ID.
- To samo odhaczenie na dwóch telefonach: ACK bez konfliktu.
- 502, timeout, 401 (odwołane sesje): kolejka zostaje; drugie konto na tym samym urządzeniu ma własną pustą bazę i nie wysyła kolejki A; ponowne logowanie A wysyła ją raz.
- Sesja innego konta w przeglądarce (logowanie w innej karcie): kolejka A nie jest wysłana, aplikacja przechodzi na konto sesji.
- Wylogowanie z pending wymaga decyzji, offline odmawia, potem usuwa bazę konta i wpis tożsamości.
- Stronicowany bootstrap (limit 2) z zapisem między stronami snapshotu: wszystkie 10 rekordów.
- Nieważny cursor → pełny resync: czysty nieaktualny rekord usunięty, pending wysłany; ręczny resync z czekającą edycją ją zachowuje.
- Dwie karty, Web Locks i fallback lease: żadne ID mutacji nie wysłane dwa razy równolegle, druga karta widzi status.
- Upgrade bazy v1 z oczekującą mutacją: ten sam deviceId i clientMutationId, wysłane, kolejka pusta.
- Odrzucona zmiana (`not_found`): stan „wymaga działania”, brak ponownej wysyłki, inne zmiany przechodzą, można ją odrzucić.

### UI na prawdziwym kontrolerze (vitest jsdom, `apps/web/src/offline/ui.test.tsx`, 3 testy)
Status „Zsynchronizowano” → „Serwer niedostępny · zmiany czekają na wysłanie (1)” → ponownie po ACK;
brak miejsca: formularz nie potwierdza zapisu, treść zostaje, odznaka z „Eksportuj”. Konflikt: odznaka
„1 zmiana wymaga sprawdzenia” → ekran z obiema wersjami → „Połącz ręcznie” → zapis na serwerze (wersja 3).
Wylogowanie z niewysłaną zmianą: ostrzeżenie, plik eksportu z treścią tylko tego konta, potem drugie konto nie widzi danych.
Mapowanie stanu na status: `apps/web/src/ui/ui.test.ts`.

### E2E w przeglądarkach (`tests/e2e/offline.spec.ts`, Chromium + WebKit/iPhone 13)
Prawdziwe IndexedDB i Web Locks, serwer `tests/start-sync-server.mjs` (port 4319, zbudowany serwer i web):
- dwa konteksty offline (`setOffline`) tworzą notatki, status „Offline · zmiany czekają na wysłanie (2)”, po powrocie sieci obie strony mają po jednej kopii; prywatna notatka nie pojawia się u drugiej osoby;
- 502 z proxy dla `/api`: status „Serwer niedostępny · …(1)”, zamknięcie i ponowne otwarcie karty pokazuje wpis z IndexedDB, po przywróceniu jeden rekord na serwerze;
- konflikt edycji offline, obie wersje na ekranie, „Zachowaj moją wersję” dociera do drugiej osoby.

## Granice i uwagi
- Bez Service Workera (RAZ-6) zimny start w trybie samolotowym nie działa; testy offline nawigują w otwartej karcie.
- `navigator.onLine` w tym środowisku jest zawsze `false` (brak interfejsu sieci w sandboxie) – dlatego aplikacja traktuje go jako podpowiedź i zawsze próbuje serwera. Testy e2e czasem czekają na 15-sekundowy tick, bo zdarzenie `online` nie przychodzi.
- WebKit na Linuksie nie przechowuje ciasteczek `Secure` po http (także loopback), stąd osobny serwer testowy z `secureCookies=false`; produkcja bez zmian (cookie `__Host-`, Secure).
- Brak testu na fizycznym iPhonie – NIEWYKONANY (lista do owner action po wdrożeniu, quality/acceptance.md).
- Przełączenie konta zostawia bazę poprzedniego konta na urządzeniu (jego niewysłane zmiany czekają na jego logowanie); usuwa ją tylko świadome wylogowanie.
