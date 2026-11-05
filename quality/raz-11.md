# RAZ-11 — dowody i przekazanie

## Zakres

Dzisiaj agreguje rzeczywiste lokalne zadania dziś/zaległe, wydarzenia i ważne daty
w siedmiu dniach, aktywne zakupy. Ukończ/Cofnij i menu pięciu typów używają
istniejących komend offline (rekord + outbox). Każda sekcja ma pełny moduł;
prywatność tekstowo, brak seedów produkcyjnych, niedostępność bazy odróżniona od pustki.

Ustawienia: własna nazwa i odczyt nazw domowników, wspólna strefa domu, motyw,
preferencje przyszłych powiadomień, sync i konflikty, instalacja PWA, kosz i logout.
Profil/strefa/preferencje zapisują się online, z cache per konto do restartu offline.
Motyw jest zapisany na urządzeniu. Istniejące UTC/date-only i harmonogramy zostają
bez zmian. Wszystkie widoczne akcje działają albo mają uczciwy stan niedostępności.
Pełny eksport czeka na RAZ-13; wysyłka push na RAZ-12. Eksport pending działa.

Szczegóły zachowania i kontraktu HTTP: [architecture/today-settings.md](../architecture/today-settings.md).
Commity implementacji: `59fb0f3`, `a4cd197`, `0cd2893` na `agent/raz-11`.

## Weryfikacja — 05.11.2026

Oficjalny Node 26.13.0 pobrany do własnego `/tmp/raz-11-runtime`, archiwum
zweryfikowane względem SHASUMS256. Dane i konta wyłącznie syntetyczne.

| Kontrola | Wynik |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | 224 PASS, 26 plików |
| `npm run build` | PASS, wszystkie workspaces; istniejące ostrzeżenie bundle >500 kB |
| `npm run test:e2e -- --workers=2` | 65 PASS, 1 SKIP, 4,7 min, Chromium + mobilny WebKit |
| Końcowe e2e interfejsu i Dzisiaj po korekcie CSS/automatycznego odświeżania | 19 PASS, 1 SKIP, 1,7 min; oba silniki |
| `docker compose -f deploy/compose.yaml config --quiet` | PASS |
| `git diff --check` | PASS |

Pełny przebieg e2e wykonano przed ostatnią korektą CSS i przekazaniem cache ustawień
z automatycznego sync do snapshot; po nich ponownie przeszły typy, 224 testy i build,
a dotknięte przepływy przeszły dodatkowy przebieg przeglądarek.
SKIP dotyczy istniejącego testu emulacji safe-area przez CDP (tylko Chromium),
nie funkcji aplikacji ani nowego scenariusza.

## Konkretne dowody

- `apps/web/src/offline/settings.test.ts` — 6 testów realnego Fastify/SQLite + Dexie:
  sesja/CSRF/strict patch/account mismatch, bez cudzych preferencji i sekretów;
  cache profilu/strefy po restarcie offline; niezmienione rekordy i outbox;
  partner otrzymuje nazwy/strefę, nie prywatne zadanie; spóźniona odpowiedź i stale
  callbacki konta A nie zapisują do B ani go nie wylogowują; IndexedDB v1→v2
  zachowuje treść/deviceId/clientMutationId przed pobraniem nowych ustawień;
  logout czyta trwałą kolejkę, zachowuje zapis w czasie HTTP i bazę nowego konta;
  automatyczny cykl odświeża cache/snapshot bez ręcznego refresh.
- `apps/web/src/screens/Today.test.tsx` — 4 testy: najstarszy otwarty cykl zadań,
  DST i strefa wpisu, pominięcie ukończonych/przyszłych/bez terminu; siedem dni,
  koniec wyłączny, wydarzenie trwające, przełom roku i 29.02; realne lokalne
  podsumowania/odhacz/Cofnij/menu offline i ACL; edycja nazwy nie cofa strefy
  zmienionej przez partnera podczas otwartego formularza.
- `tests/e2e/today-settings.spec.ts` — oba silniki: wszystkie pięć typów przez menu
  Dzisiaj, zapis offline i cold restart całego procesu z trwałym profilem przy
  odciętej sieci; nazwy/strefa/motyw/preferencje zostają; błędny zapis profilu
  offline zachowuje treść; logout pending/Anuluj; sync drugiego konta bez prywatnego
  zadania, własne preferencje, automatyczne pobranie nowej nazwy partnera bez ręcznego sync, usuwanie i restore kosza. Osobne serwery
  4322/4323 zapobiegają wpływowi wspólnej strefy na pozostałe testy.
- Istniejące testy sync/UI/PWA, w tym `offline/sync.test.ts`, `offline/ui.test.tsx`,
  `tests/e2e/offline.spec.ts` i `pwa.spec.ts`, nadal przechodzą: offline kontra
  serwer niedostępny, licznik pending, 401 bez usuwania kolejki, ACK dopiero po
  commit, utrata odpowiedzi/retry, konflikty, separacja kont i migracje z outbox.
- `apps/web/src/App.test.tsx` oraz e2e interfejsu: wszystkie trasy MVP i menu,
  polskie komunikaty, działające odnośniki, formularze i zachowanie treści po błędzie.

## Przegląd wizualny

Automatycznie: 13 głównych ekranów z prawdziwą lokalną treścią na szerokościach
375/390/430/1280 px, jasny i ciemny motyw, Chromium i mobilny WebKit. Kontrole
braku poziomego scrolla, celów co najmniej 44 px i układu filtrów. Istniejący
przekrój interfejsu sprawdza także wszystkie formularze/szczegóły, duży tekst,
klawiaturę, ograniczony ruch i nawigację. Zrzuty 390 px przejrzano narzędziem
view_image: Dzisiaj w obu motywach, ustawienia w obu motywach, profil,
powiadomienia, zakupy, zadania, kalendarz, notatki, ważne daty, Więcej, kosz,
instalacja i zmiany. Poprawiono łamanie etykiety „Ukończone” i zbyt ciężkie hinty.
Podstawowe akcje są na ekranach modułów i Dzisiaj, bez szukania w ustawieniach.
Zrzuty z syntetycznymi danymi są tymczasowe, nie w repo.

Wstępne niezaliczone próby: systemowy Node22 nie ma crypto.argon2 (setup testów);
po zmianie na przypięty Node26 testy przeszły. Pierwsze e2e poprawiono pod pełną
etykietę przełącznika z hintem, asynchroniczne odhaczenie usuwające wiersz i oczekiwanie
na lokalny commit usunięcia przed nawigacją do kosza. Dodatkowa regresja wykryła brak
aktualizacji ustawień po samym engine.sync; poprawiono odświeżenie trwałego cache.
Nie zaliczono tych nieudanych prób jako dowodów PASS.

## Granice i sprzątanie

Brak wdrożenia i scalenia do main. Nie wykonano testu na fizycznym iPhone;
WebKit go nie zastępuje. Rzeczywiste push i pełny eksport nie należą do RAZ-11.
Nie zmieniono schematu SQLite v4, Dexie v2 ani protokołu sync v2.

Usunięto 70 własnych katalogów z nieudanych setupów Node22, wybranych po nazwach
prefiksów testowych i czasie utworzenia tej sesji. Playwright zatrzymał siedem własnych serwerów i usunął tymczasowe bazy. Usunięto
dwa profile pozostałe po pierwszym timeout, własny `/tmp/raz-11-runtime` (Node,
przeglądarki, logi, zrzuty) i `test-results/`. `ss -ltnp` potwierdziło brak
nasłuchu na 4317–4323. Nie tworzono kontenerów ani sieci; nie pozostawiono podglądu.
Cudze procesy, cache i trwałe dane zachowano.
