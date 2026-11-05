# RAZ-13 — dowody i przekazanie

Stan: implementacja i automatyczna weryfikacja zakończone, 2026-11-05.
Gałąź `agent/raz-13`, bez merge i wdrożenia.

## Zrealizowane

- `2e7c307`: eksport konta `/api/export` i przycisk w Ustawieniach. Wszystkie osiem
  typów domain, kosz, własne private i shared; jedna transakcja odczytu i wspólne
  `RecordRepository`/ACL. Projekcja konta/ustawień bez uwierzytelniania/push keys.
  Wymagana sesja, własne hasło i nagłówek oczekiwanego konta. Klient weryfikuje
  konto i generację przed pobraniem pliku.
- `2e7c307`: pending v2, atomowy odczyt IndexedDB bez sieci i usuwania kolejki.
  Pełne intencje, kolejność, ID mutacji/urządzenia/konta, patche i wersje bazowe,
  powiązane rekordy, bazy i pełne konflikty z odrzuconymi intencjami.
- `2b86a78`: CLI `backup|backup-encrypt|restore`, spójna SQLite WAL przez VACUUM INTO,
  `integrity_check` i FK, manifest/SHA-256/historia migracji/household ID,
  chronione pliki i katalogi. Retencja rozpoznanych kopii wyłącznie tego gospodarstwa:
  7 różnych dni UTC i 4 tygodnie UTC, wraz z obsługą powtórzeń tego samego dnia.
- `2b86a78`: strumieniowe gzip/AES-256-GCM, scrypt, losowa sól/nonce, nagłówek AAD,
  hasło wyłącznie z chronionego pliku. Obejmuje bazę i jawnie dołączoną konfigurację.
  Bez usług zewnętrznych i bez automatycznego wysyłania.
- `2b86a78`: restore wyłącznie do nowego izolowanego katalogu, także z zaszyfrowanego
  archiwum i surowego snapshotu przed migracją. Nie nadpisuje żadnego istniejącego
  celu i nie uruchamia usług. Kontroluje znane wersje/checksumy schematu, uprawnienia,
  integralność i relacje. Usuwa sesje/subskrypcje push, rotuje cursor key, zachowuje ACL.
- `2b86a78`: snapshot przed aktualizacją schematu jest teraz sprawdzony przed SQL
  migracji; plik od początku ma 0600. Zamrożone SQL i checksumy migracji bez zmian.
- `deploy/systemd/razem-backup.{service,timer}`: codziennie 02:00 UTC, Persistent,
  gotowy szablon do autoryzowanego wdrożenia, bez instalowania go w tym zadaniu.
- `operations/backup.md`: procedura konfiguracji/VAPID, lokalnych/offsite kopii,
  RPO 24 h i jego granic, restore, sesji i obu telefonów. README, kontrakty,
  architektura, ekran ustawień, bezpieczeństwo i instrukcje Ubuntu uaktualnione
  również w dokumentacji ToDo.

## Faktycznie wykonane kontrole

Oficjalny Node **26.13.0**, zweryfikowany przez SHA-256 z SHASUMS256.txt;
wersje zależności z istniejącego lockfile, bez zmian pakietów.

| Kontrola | Wynik |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | **235/235, 28 plików PASS** |
| `npm run build` | Wszystkie 5 workspace PASS |
| `npm run test:e2e -- tests/e2e/export.spec.ts` | Chromium + WebKit **2/2 PASS** |
| `npm run test:e2e -- tests/e2e/today-settings.spec.ts` | Chromium + WebKit **2/2 PASS** |
| `docker compose -f deploy/compose.yaml config --quiet` | PASS |
| `systemd-analyze verify deploy/systemd/razem-backup.service deploy/systemd/razem-backup.timer` | exit 0, brak błędów tych jednostek; komunikat o braku odczytu istniejącej obcej moj-regal.service |
| `git diff --check` | PASS |

Nowe regresje (11 testów jednostkowych/integracyjnych):

- `apps/web/src/offline/export.test.ts` (4): private A/shared wszystkich 8 typów
  i kosza, brak private B/sekretów, 401/403/409, account switch; eksport pending
  offline zachowujący kolejne create/update/delete/restore i pełny konflikt bez
  requestów i kasowania; spóźniona odpowiedź konta; **prawdziwy restore → 401 →
  ponowne logowanie/resync bez utraty intencji i z zachowaniem prywatności**.
- `apps/server/src/backup/backup.test.ts` (6): rzeczywiste równoczesne zapisy
  z Workera do aktywnego WAL podczas backupu (licznik commitów rośnie w tym czasie),
  integrity/FK, odtworzenie w czystym katalogu, porównanie wszystkich typów A/B
  i odmowa zapisu/odczytu private partnera; polityka sesji/push/cursora; szyfrowany
  round-trip z konfiguracją; złe hasło/podmieniony plik; retencja i zachowanie obcych
  zasobów; istniejący cel/symlink/uprawnienia; nieznana lub zmieniona historia
  migracji także po aktualizacji SHA manifestu; restore snapshotu v1 bez migracji;
  prawdziwe komendy CLI.
- `packages/db/src/migrations.test.ts`: nowa regresja niespójnych FK w snapshotcie
  blokuje migrację przed SQL i usuwa wyłącznie własny niepoprawny plik. Pozostałe
  testy migracji również PASS. Istniejący test prywatności notatek uaktualniony:
  `/api/export` zwraca teraz 200 bez prywatnych danych partnera zamiast 404.

E2E pobrało i odczytało rzeczywiste pliki JSON konta oraz pending w trybie offline,
sprawdziło brak private B i zachowanie kolejki po eksporcie/błędzie sieci.
Regresja ustawień obejmuje ponadto offline cold start, dwa konta, logout/kosz,
jasny/ciemny motyw i kontrolę układu w szerokościach 375/390/430/1280.
Wszystkie dane, hasła, sekrety i domeny w testach są syntetyczne.

Pierwszy przebieg na systemowym Node 22 nie obsłużył Argon2 — powtórzono na
wymaganej wersji. Pierwsza próba E2E nie miała binarek przeglądarek — pobrano je
do własnego tmp i wykonano testy ponownie. Błąd selektora odznaki w nowym E2E
poprawiono (odznaka jest w Ustawieniach). Te próby nie są liczone jako PASS.
Build zgłasza znane ostrzeżenie dużego bundle, jsdom o scrollTo; brak błędów testów.

## Granice i dalsze wdrożenie

Nie wykonano wdrożenia, instalacji timera, fizycznych testów iPhone, rzeczywistego
VAPID/push ani testu produkcyjnej kopii. Brak tych czynności nie jest podawany jako
zaliczenie. Podczas wdrożenia należy przygotować prawdziwy chroniony plik pełnej
konfiguracji, dostosować ścieżki systemd i wykonać próbę kopii z hosta. Sam backup
lokalny nie zabezpiecza przed utratą dysku; częstotliwość przenoszenia zaszyfrowanej
kopii określa RPO przy utracie całego serwera. Pending/konflikty telefonów eksportuje
się osobno. Po cofnięciu bazy mogą być potrzebne ręczne konflikty i ponowny reset
haseł zmienionych po dacie kopii; procedura opisuje to jawnie.

## Sprzątanie

Playwright zakończył wszystkie własne serwery i konteksty; testy usunęły swoje
katalogi SQLite, profile, archiwa, pliki pobrań i staging restore. Usunięto także
trzy katalogi syntetyczne pozostawione przez pierwszą próbę na Node 22, własny
katalog narzędzi `/tmp/raz-13-tools` (Node/przeglądarki/logi) i `test-results`.
`ss -ltnp` potwierdza wolne porty **4317–4323**. Nie tworzono kontenerów/sieci,
nie ruszano trwałych danych ani cudzych procesów/zasobów. Nie pozostawiono podglądu.
