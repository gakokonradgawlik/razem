# RAZ-14 — przekrojowa weryfikacja MVP

Data: 2026-11-05. Gałąź: `agent/raz-14`. Bez scalania do main i bez wdrożenia.
Zakres: automatyczna część [acceptance.md](acceptance.md), rzeczywista aplikacja
oraz uzupełniające integracje warstw danych. Wszystkie konta/treści są syntetyczne.

## Zmiana i wykryty błąd

- `2d5e04a`: snapshot pomijał trwałe tombstones. Po retencji i wygaśnięciu cursora
  istniejący konflikt nadal pokazywał stary stan kosza, zamiast trwałego usunięcia.
  Snapshot zawiera teraz dostępne rekordy i tombstones w kolejności `(typ, id)`,
  z ACL, limitem liczby i bajtów. Koperta sync v2 pozostaje zgodna.
- Regresja klienta łączy konflikt delete/edit, 91 dni, wygasłą sesję/cursor,
  przerwany snapshot, zapis pending w trakcie resync i restart. Obie intencje
  pozostają; świadome odzyskanie po tombstone tworzy nowe ID.
- `4794ec8`: testy zakupów, zadań, notatek, wydarzeń i ważnych dat kończą proces
  przeglądarki **przed pierwszym zapisem** i otwierają profil z `offline: true`.
  Po zmianach następuje kolejny restart, synchronizacja i odczyt drugiego konta.
- Nowy E2E ACK wykonuje prawdziwy fetch/commit SQLite, odrzuca odpowiedź przed
  aplikacją, blokuje dalszy transport i restartuje proces offline. Ten sam
  `clientMutationId` trafia ponownie; rekord istnieje raz, z wersją 1.
- Macierz private: oba konta × 8 typów × live/kosz/tombstone. Guessed ID przy
  update/delete/restore, także ze starą wersją, daje taką samą odpowiedź jak brak
  rekordu (pomijając korelację podaną przez atakującego). Snapshot, delta, eksport,
  lokalny cache, konflikty, kosz, pending i link push nie ujawniają partnerowi ID
  ani treści. Worker po restarcie nie kieruje private do partnera również przy
  włączonych tytułach i zakupach; wspólny dispatch jest pozytywną kontrolą.

## Pokrycie acceptance

Ścieżki skrócone: `client/` = `apps/web/src/offline/`, `server/` =
`apps/server/src/`, `contracts/` = `packages/contracts/src/`, `e2e/` = `tests/e2e/`.

| # | Automatyczny dowód i granica |
| --- | --- |
| 1 | `client/privacy.test.ts`, `server/sync/sync.test.ts`, `e2e/{offline,shopping,tasks,calendar,notes,export,push}.spec.ts`: dwa konta, przepływ shared w obie strony, brak private w UI/API/cache/koszu/konflikcie/eksportach i linkach. `apps/worker/src/worker.test.ts`: rzeczywista kolejka/ACL i przechwycony transport bez private partnera. |
| 2 | `e2e/{shopping,tasks,calendar,notes}.spec.ts`: pełny zimny start offline, create/edit wszystkich modułów, zakupy/zadania check/undo, delete/restore notatek i zakupów, drugi restart z outboxem. CRUD wydarzeń/dat i przypomnień także w `client/calendar.test.ts`. |
| 3 | `e2e/offline.spec.ts`: proxy 502 i restart, uczciwy status, późniejszy ACK. `client/sync.test.ts`: timeout, 5xx i ponowienie bez utraty; e2e modułów: powrót sieci, pusta kolejka, partner bez duplikatów. |
| 4 | `e2e/pwa.spec.ts`: zgubiony ACK po realnym commicie i retry po restarcie procesu. `client/sync.test.ts`: dwie karty/Web Locks/lease, przejęcie lease. `server/sync/sync.test.ts`: rollback awarii receipt/journala, częściowa partia, podmieniony payload z tym samym ID. |
| 5 | `e2e/{offline,shopping,notes}.spec.ts`: dwie wersje i rozwiązanie/scalenie, edycje różnych rekordów. `client/sync.test.ts`: delete/edit, tombstone, ponowny konflikt po zmianie serwera, jawne odzyskanie. |
| 6 | `server/sync/sync.test.ts`: bootstrap z zapisami w trakcie, cursor obcy/zmieniony/starszy od 90 dni i journal_floor, pusta historia po retencji, snapshot rekordów+tombstones z ACL i limitami. Nowa regresja `client/sync.test.ts`: full-resync przerwany po zachowaniu konfliktu i nowego pending, restart i dokończenie. |
| 7 | `client/sync.test.ts`, `client/ui.test.tsx`, `client/settings.test.ts`, `server/auth*.test.ts`, `server/auth/races.test.ts`: odwołanie/wygaśnięcie sesji, ponowny login, pending i świadomy logout, account switch w różnych momentach żądań, stare callbacki formularzy. `e2e/pwa.spec.ts`: usunięcie bazy po logout i drugie konto offline bez danych poprzedniego. |
| 8 | `e2e/pwa.spec.ts`: prawdziwa IndexedDB v1→v2 z outbox/deviceId/mutationId, restart i ACK. SW A→B: uszkodzony build, dwie karty, niezapisany formularz, pending, brak wymuszonego reload i spójne zasoby po aktywacji. Migracje SQLite i snapshot rollback w `packages/db/src/migrations.test.ts` oraz `server/backup/backup.test.ts`. |
| 9 | `client/sync.test.ts`, `client/ui.test.tsx`, `client/{calendar,notes}.test.ts`: quota w połowie transakcji, rollback, zachowany formularz/treść, brak fałszywego sukcesu, eksport. Niedostępne IndexedDB i błędy walidacji/sieci. Quota/odmowa magazynu są wstrzykiwane, nie zapełniamy dysku hosta ani fizycznego iPhone. |
| 10 | `contracts/{contracts,tasks,calendar}.test.ts`, `apps/worker/src/worker.test.ts`: DST Warszawa (luka/overlap), 29.02 i 31. dzień, roczne/miesięczne reguły, kolejka w strefie domu. `e2e/tasks.spec.ts`: wspólne ukończenie jednego wystąpienia. `e2e/calendar.spec.ts`: wielodniowe/all-day/UTC i Pacific/Kiritimati przy telefonie America/Los_Angeles, agenda/miesiąc. |
| 11 | `apps/worker/src/worker.test.ts`, `server/push.test.ts`, `apps/web/src/push*.test.*`, `e2e/push.spec.ts`: świadomy opt-in, odmowa, zmiana/usunięcie przypomnienia, restart/lease/przerwany dispatch, 404/410, wiele urządzeń, prywatność. Transport push i systemowe API przeglądarki są symulowane. Dostawa zewnętrzna może się powtórzyć po awarii między wysłaniem a zapisem wyniku; brak obietnicy exactly-once. |
| 12 | `server/backup/backup.test.ts`: aktywny WAL i równoczesny zapis, integrity/FK, izolowany restore, szyfrowanie/retencja/CLI i odmowa złej historii. `client/export.test.ts`: ACL 8 typów, pending/konflikty offline, restore→401→login/resync z zachowaną intencją. `e2e/export.spec.ts`: rzeczywiste pobrane pliki konta i pending z ustawień. |

## Interfejs i dostępność

`e2e/interface.spec.ts` i `records.spec.ts`: ekrany i formularze 375/390/430/1280 px,
nazwy kontrolek, cele 44 px, pola min. 16 px, brak poziomego scrolla, fokus błędów,
200% tekstu, reduced motion, motyw ciemny/systemowy i lokalne ustawienie motywu.
`e2e/today-settings.spec.ts`: zalogowana aplikacja z danymi w obu motywach,
13 ekranów na czterech szerokościach, rzeczywiste komunikaty błędu offline i kosz.
`apps/web/src/ui/ui.test.ts`: kontrast par tokenów AA i polskie statusy.
Safe-area override jest badany przez CDP tylko w Chromium; WebKit świadomie pomija
ten pojedynczy test. Hak klawiatury/standalone jest symulowany.

Przejrzano zrzuty: formularz zadania z błędem na 375 px (Chromium/WebKit),
zakupy z długą treścią na 390 px, ustawienia desktop 1280 px oraz zalogowane
Dzisiaj/ustawienia 390 px w jasnym i ciemnym motywie. Etykiety prywatności,
fokus błędu i komunikat offline z licznikiem są czytelne; w tym przeglądzie
nie wykryto blokującego błędu UI. Pełne zrzuty przewijanej strony przedstawiają
stałą nawigację na wysokości viewportu, co jest sposobem wykonania screenshotu.
Nie jest to audyt VoiceOver na urządzeniu.

## Środowisko i ograniczenia

Linux; przypięte Node 26.13.0 / npm 11.20.0 (archiwum Node sprawdzone SHA-256),
Playwright 1.64.1, Chromium i WebKit 27.2. Serwery to zbudowany Fastify + SQLite
na loopback HTTP 4317–4325; 4318 służy tylko syntetycznym fixtures UI.
Brak wdrożenia, prawdziwego HTTPS i fizycznych iPhone. Automatyzacja nie spełnia
fizycznej bramki wydania.

Do RAZ-16 po gotowym wdrożeniu: oba iPhone/konta, zaufane HTTPS, instalacja ikoną,
standalone i safe areas, prawdziwa klawiatura, duży tekst i VoiceOver, oba motywy,
tryb samolotowy i cold start, zmiany offline i drugi telefon, konflikt, brak private,
logout/account switch, aktualizacja z pending. Osobno rzeczywiste Web Push przy
zamkniętej PWA, deep link i prywatność ekranu blokady. Żaden z tych fizycznych testów
nie jest oznaczony PASS. Zgodnie z instrukcjami projektu owner action należy
przekazać w zadaniu wdrożenia, gdy środowisko będzie gotowe.

## Wyniki wykonanych kontroli

| Polecenie | Wynik |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | **305 PASS**, 33 pliki |
| `npm run build` | PASS, wszystkie workspaces i shell PWA |
| `npm run test:e2e -- --workers=4` | **71 PASS, 1 SKIP**, 72 scenariusze / 12 plików, Chromium + WebKit; pełny przebieg 4,6 min |

Pominięcie: tylko safe-area przez CDP w WebKit. Ostrzeżenia nieblokujące:
chunk Vite >500 kB, `scrollTo` niezaimplementowane w jsdom i kolorowanie terminala.
Nie stwierdzono krytycznego błędu ani wycieku private w sprawdzonym zakresie.
Pierwszy rozszerzony przebieg E2E ujawnił błąd samego nowego testu: badge szukany
na Notatkach, gdzie go nie ma; test przeszedł po przejściu na Dzisiaj.
Regresja resync najpierw nie przechodziła na poprzedniej implementacji snapshotu.
Te nieudane próby nie zostały zaliczone jako PASS.

Końcowy SHA i wynik ponowienia wymaganej bramki na finalnym commicie zapisano
w notatce przekazania RAZ-14. Nie zmieniano starszych commitów.

## Sprzątanie

Playwright zamknął własne serwery i przeglądarki, usunął syntetyczne bazy i trwałe
profile testowe. Po pełnym przebiegu `ss -ltnp '( sport >= :4317 and sport <= :4325 )'`
nie wykazał listenerów. Nie tworzono kontenerów, sieci ani instalacji.
Zrzuty i logi przejrzano lokalnie; katalog narzędzi/runtime/zrzutów
`/tmp/raz-14-tools` i `test-results/` są usuwane przed przekazaniem. Końcowe
potwierdzenie usunięcia i wolnych portów znajduje się w notatce zadania.
Nie ruszano cudzych procesów/profili w `/tmp` ani trwałych danych projektu.
