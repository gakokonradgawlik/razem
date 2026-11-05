# RAZ-12 — dowody i przekazanie

05.11.2026, gałąź `agent/raz-12`. Bez scalania do main i bez wdrożenia.
Commity implementacji: `37d482af337ee084000f723a17005f9578a8be31`,
`03fb00949ce04dda183dcf154e979ae331f7537a`.
Poprawka po review: `5961261aa6186ef45e5dffeca2e2a86ed2ca7235` (SQLite v6, autor i nowi odbiorcy).

## Zrealizowane

Web Push/VAPID, świadomy opt-in urządzenia, odmowa/brak wsparcia/instalacja iPhone,
monitor zmiany uprawnień, ustawienia terminów/przypisań zadań, opcjonalne zakupy,
ogólny lockscreen i chronione deep linki. Worker korzysta z repozytorium ACL
oraz wspólnych reguł czasu i planuje kalendarz, daty roczne, terminy i cykle zadań.
SQLite v5: dedup per subskrypcja, checkpoint w transakcji, lease/token,
retry/backoff, wersjonowanie/anulowanie, 404/410. Logout/revoke/zmiana konta
odpinają push. Starsza strict PWA zachowuje format settings/eksportu.
SQLite v6 zapisuje autora z sesji i poprzednie przypisanie atomowo z mutacją.
Autor nie otrzymuje push o własnym przypisaniu ani zakupach; zmiana przypisania
powiadamia tylko nowo dodane osoby. Historyczne/systemowe zdarzenia bez znanego
autora są pomijane także przed dispatch. Przypomnienia terminów pozostają niezależne.

Specyfikacja, wartości domyślne, API i granice:
[architecture/push.md](../architecture/push.md).

## Wyniki automatyczne

Node 26.13.0 / npm 11.20.0. Pobrany oficjalny runtime sprawdzono SHA256
z SHASUMS256.txt. Własny cache i przeglądarki były w `/tmp/raz-12-*`.
Nie zmieniano globalnego środowiska.

| Kontrola | Wynik |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` po review | PASS — 32 pliki, 300 testów |
| `npm run build` | PASS — contracts, db, server, worker, web |
| `docker compose -f deploy/compose.yaml config --quiet` | PASS |
| `npm run test:e2e -- tests/e2e/push.spec.ts --workers=2` po review | PASS — Chromium + WebKit, 2 testy, 24,5 s |
| `npm run test:e2e -- --workers=4` przed review (`03fb009`) | PASS — 69 zaliczonych, 1 jawnie pominięty, 4,7 min |
| `git diff --check` | PASS |

Pominięty e2e to istniejący test emulacji safe-area w WebKit: wymaga CDP Chromium,
a w Chromium przeszedł. Nie oznaczono go jako PASS w WebKit. Build emituje istniejące
ostrzeżenie Vite o bundle większym od 500 kB i kończy się powodzeniem.
Pierwsze pełne e2e przerwano podczas wznowienia sesji; nie stanowi dowodu PASS.
Dowodem jest późniejszy kompletny przebieg 69/1. Końcowy build po przeglądzie kodu
również przeszedł; bundle web zachował ten sam hash co w zaliczonym e2e.
Po dopasowaniu wewnętrznego `dispatchSchema` do v5 ponownie przeszły typecheck,
21 testów workera (w tym zgodność kontraktu z rzeczywistym wierszem SQLite),
build wszystkich workspace i walidacja Compose.
Po poprawce `5961261` ponownie przeszły typecheck, pełny Vitest (300), pełny build,
Compose config i e2e push w obu silnikach (2). Pełnego przekroju e2e po tej poprawce
nie uruchamiano. Pierwszy przebieg Vitest po dodaniu v6 wykrył cztery nieaktualne
asercje wersji w testach backupu; poprawiono je na `LATEST_SCHEMA_VERSION` i ponowiono
cały zestaw z wynikiem PASS. Nie zmieniano zamrożonych migracji v1–v5.

## Pokrycie ryzyk

| Plik | Konkretne dowody |
| --- | --- |
| `apps/server/src/push.test.ts` — 9 testów | Prawdziwy Fastify/SQLite: sesja, CSRF, header konta, strict payload, brak przejęcia endpointu, per-device PUT/idempotencja, logout/revoke i login na inne konto z zachowaniem drugiego urządzenia. Resolve sprawdza private/deleted/brak/sesję. LAN/HTTP/credentials/port są odrzucane. Realna biblioteka generuje zaszyfrowane żądanie aes128gcm i podpis VAPID. Integracja sync → SQLite → worker: retry mutacji nie powiela wysyłki. Domyślne przypisanie both i zakupy powiadamiają tylko B; pola autora nie wychodzą w API/pull. Zgodność starej i rozszerzonej odpowiedzi settings/eksportu. |
| `apps/worker/src/worker.test.ts` — 46 testów | Plikowa SQLite, zamknięcie/ponowne otwarcie bazy i dwie instancje/połączenia workerów. Skan zadań bez task_events; jeden dispatch na urządzenie. Równoczesna wysyłka respektuje lease, stary token nie kończy nowszej próby, restart odzyskuje lease. Retry/backoff bez nowego wiersza. 404/410 usuwa subskrypcję. Ukończenie/usunięcie/przesunięcie/wyłączenie/logout/uprawnienie/wygasła sesja sprawdzane ponownie bez plan(). Kalendarz, ukończone wystąpienie cyklu, przypisanie partnerowi, opt-in zakupów i usunięcie produktu z ACL listy. DST Warszawa, 29.02 i strefa domu w rzeczywistej kolejce. Wiele urządzeń, ponowne włączenie przyszłego przypomnienia, brak powtórki wysłanego terminu po edycji tytułu, dawne wielokrotne konfiguracje. Błąd INSERT cofa checkpoint. Domyślne taskAssignments=true w całym zestawie; tworzenie shared both/self/partner i private self nie powiadamia autora na żadnym urządzeniu. 18 kombinacji przejść self/partner/both przez A/B wysyła tylko nowym odbiorcom poza autorem. Opt-in zakupów obu kont: create/update/check/delete/restore tylko do drugiej osoby, także przy zmianie cudzego wpisu. NULL autora blokuje planowanie i już zakolejkowany dispatch. |
| `apps/web/src/push.test.tsx` — 5 testów | Brak promptu przy wejściu; requestPermission synchronicznie po kliknięciu, rejestracja po zgodzie. Odmowa, wymóg instalacji iPhone, brak wsparcia/HTTPS, powrót i zmiana uprawnień. Zmiana konta podczas promptu nie rejestruje starego konta. Błąd serwera usuwa nową subskrypcję i nie pokazuje sukcesu. |
| `apps/web/src/push-sw.test.ts` — 2 testy | Każdy push, także uszkodzony/pusty, pokazuje widoczne powiadomienie. Stały tag. Obcy URL/API/URL względny nie wyprowadza kliknięcia poza własny origin i znane trasy. |
| `packages/db/src/migrations.test.ts` | v4 → v5 zachowuje domenę, sesje i preferencje; kopia przed migracją, integrity/FK i zgodność Drizzle. Dawne subskrypcje bez weryfikowalnej sesji są unieważnione. v5 → v6 zachowuje rekordy, kolejkę, checkpoint, subskrypcje i sesje, sprawdza FK/CHECK, zostawia NULL zamiast zgadywać autora; snapshot pozostaje v5. Migracje v1–v5 niezmienione. |
| `packages/db/src/records.test.ts` | Autor zgodny z kontem piszącym mimo innego właściciela, poprzednie przypisanie, rollback przy błędzie INSERT zdarzenia/journala i brak zdarzeń od odrzuconych mutacji. |
| `apps/server/src/backup/backup.test.ts` | Backup/restore z v6, usunięciem subskrypcji i starszymi snapshotami nadal przechodzą; nieznana przyszła migracja nadal blokuje restore. |
| `tests/e2e/push.spec.ts` — oba silniki | Produkcyjny build i realne HTTP/sesje/SQLite na 4324/4325. Brak promptu przed kliknięciem, rejestracja, zapis godziny, zakaz private linku partnerowi, ponowne logowanie z powrotem do wpisu i brak subskrypcji po logout. Systemowe API push świadomie symulowane. |
| Cały zestaw Vitest/e2e | Regresje dwóch kont, offline/cold start, outbox/receipts, konfliktów, aktualizacji PWA, dat, kosza, eksportu i odtwarzania. |

Przejrzano zrzuty ustawień: Chromium desktop i mobilny WebKit. UI jest polskie,
ustawienia dostępne, a brak zgody/konfiguracji jawny. Zrzuty/trace'y usunięto.

## Granice dowodów i przekazanie do RAZ-16

NIE WYKONANO dostarczenia u prawdziwego dostawcy push ani na fizycznym iPhonie przy
zamkniętej PWA. Transport w integracji jest kontrolowany; test biblioteki sprawdza
szyfrowanie/podpis, a nie akceptację przez APNs. Playwright WebKit i symulowane
Notification/PushManager nie zastępują Safari/PWA na urządzeniu.

Po autoryzowanym wdrożeniu HTTPS w RAZ-16 trzeba na obu kontach/iPhone'ach:

1. Dodać PWA do ekranu początkowego, otworzyć ikoną; sprawdzić odmowę, potem jawny opt-in.
2. Zsynchronizować bliski termin kalendarza/zadania i prywatną ważną datę, zamknąć PWA
   z dostępnym internetem i zapisać faktyczny wynik dostarczenia.
3. Sprawdzić ogólny lockscreen, brak private na drugim koncie i link, także po
   wygaśnięciu sesji i ponownym logowaniu.
4. Przesunąć/usunąć wpis i ukończyć zadanie przed terminem. Sprawdzić wyłączenie
   urządzenia, cofnięcie zgody w iOS, logout i ponowny jawny opt-in.
5. Zanotować iOS, origin, godzinę/strefę i rzeczywisty wynik dla obu urządzeń.
   Nie oceniać offline jako gwarantowanego alarmu.

Brak atomowej transakcji SQLite + usługa push: awaria po akceptacji wiadomości,
przed zapisem sent, może dać powtórne dostarczenie po lease/retry. Dedup w SQLite
nie jest obietnicą exactly-once na telefonie; stały tag ogranicza powtórki wizualne.
Już przyjętej przez usługę wiadomości nie cofnie późniejszy logout/usunięcie.

Nie uruchamiano wdrożenia, kontenerów ani sieci. Własne serwery e2e zakończono,
sprawdzono wolne porty 4317–4325. Usunięto test-results i osiem dokładnie wskazanych
katalogów baz z przerwanego przebiegu; pełny przebieg sam usunął swoje bazy.
Usunięto własny tymczasowy runtime, cache, przeglądarki i logi. Nie ruszano zastanych
procesów/profili Playwright, współdzielonych zasobów ani trwałego data/.
Nie używano globalnego prune.

Po poprawce review ponownie sprawdzono wolne porty 4317–4325 i zakończenie serwerów
e2e. Usunięto własne `test-results/`, runtime, pobrane przeglądarki, logi i katalog
tymczasowy `/tmp/raz-12-review-*` (w tym cache testów). Nie pozostawiono podglądów,
kontenerów ani sieci; zastane procesy i trwałe dane pozostały nietknięte.
