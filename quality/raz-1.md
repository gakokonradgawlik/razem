# RAZ-1 — dowody i przekazanie

Data: 2026-11-04. Gałąź: `agent/raz-1`. Pierwszy commit: `4eed646`;
końcowy commit z dokumentacją i pakietem wskazuje PR powiązany w ToDo.

## Zrealizowano

- Dedykowane, potwierdzone repo; ścieżka i prawdziwy remote w operations/repository.md.
- Pięć workspace: web, server, worker, contracts, db. TypeScript strict.
- Dokładne wersje, jeden lockfile, aktywne Node LTS, przypięty digest obrazu.
- Kontrakty modelu MVP, prywatności, dat/DST i sync v1; osobny eksport serwerowy
  dla zapisów uwierzytelnienia i kolejek. Web i API używają kontraktów.
- Realny Fastify z health/readiness, serwowaniem buildu i zamkniętym API danych.
- Szkielet Dexie oddzielony per household/user; brak anonimowego otwierania bazy.
- SQLite WAL, foreign_keys, busy_timeout 5000 ms, plik 0600 i katalog nowej bazy 0700.
- Lokalny pipeline i Compose app/worker bez obowiązkowej usługi zewnętrznej.

## Wyniki wykonanych kontroli

| Kontrola | Wynik i zakres |
| --- | --- |
| `npm ci` | PASS, 182 zainstalowane pakiety, audyt 0 podatności; czysta instalacja w izolowanym kontenerze Debian bookworm z Node 26.13.0/npm 11.20.0 i python3/make/g++ |
| `npm run ci` po tej instalacji | PASS: typy, testy, build, e2e i Compose config |
| `npm run typecheck` | PASS, strict i typy kontraktów/serwera/web/workera/db/testów |
| `npm test` | PASS, 24 testy w 4 plikach; końcowo powtórzono po dodaniu kontroli uprawnień pliku SQLite |
| `npm run build` | PASS wszystkich 5 workspace; frontend serwowany potem przez Fastify |
| `npm run test:e2e` | PASS 2/2: Chromium i WebKit, prawdziwy HTTP i render buildu, dwa konteksty, odmowa dostępu do danych |
| `npm run dev` | PASS smoke: web 5173, proxy `/readyz` do API 3100, start workera; procesy zakończone, testowa baza usunięta |
| `docker compose -f deploy/compose.yaml config` | PASS (także w lokalnym pipeline) |
| `docker build -f deploy/Dockerfile ...` | PASS, obraz testowy z bieżącym kodem zbudowany z przypiętej bazy |
| Test kontenera | PASS: uid=1000(node), read-only rootfs, odrębny tmpfs, publikacja tylko loopback 4318, readiness 200, frontend 200, sync 401 |
| Smoke app + worker w Compose | PASS: app healthy, worker running, wspólny własny wolumen testowy; odczyt `/readyz` i UI 200, sync 401 przez exec |
| `git diff --check` | PASS |

Host ma Node 22.23.3 i nie ma toolchainu make/g++; katalog domowy jest read-only.
Nie zmieniano hosta. Pierwsze clean npm ci na hoście nie powiodły się na cache
i toolchainie — **nie są zaliczone**. Udokumentowany PASS dotyczy czystego
środowiska kontenerowego z wymaganymi narzędziami, a kontrole po instalacji
wykonano lokalnie na oficjalnym Node 26.13.0 (sprawdzony SHA256).
Pobrane biblioteki natywne z tego środowiska działały w lokalnych testach SQLite.

Domyślna pula sieci Dockera na hoście była wyczerpana. Smoke Compose użył
wyłącznie tymczasowego override `network_mode: none`, bez publikacji portu;
health/readiness i HTTP sprawdzono wewnątrz app. Publikację loopback sprawdzono
osobnym kontenerem przed tym testem. Nie zmieniano cudzych sieci ani ustawień demona.

## Regresje objęte testami

- Prywatny rekord niedostępny partnerowi i innemu gospodarstwu; shared ograniczone
  do gospodarstwa. Projekcja konta odrzuca hash hasła/tokenu.
- Mutacja nie przyjmuje owner/household/czasu/version serwera, zmiany widoczności,
  podmiany rodzica, pustego patch i powtórzonego mutationId w partii.
- ACK/conflict wymaga kanonicznego rekordu/tombstone zgodnego z entityId/type;
  błąd dostępu nie może zawierać rekordu. Pull ma ograniczone strony i stan resync.
- UTC i date-only, DST Europe/Warsaw, 29.02, dzień 31, wyłączny koniec wydarzenia,
  wzajemnie wykluczające terminy oraz prywatne przypisanie wyłącznie sobie.
- Realna transakcja SQLite/Drizzle wycofuje nieudaną syntetyczną migrację DDL;
  dane przetrwały zamknięcie/otwarcie, integrity_check=ok, uprawnienia 0600.
  To test infrastruktury; domenowych migracji jeszcze nie ma.

## Granice odbioru

Nie wykonano i nie zgłasza się jako PASS: logowanie dwóch realnych kont,
działająca kolejka sync/idempotencja serwera, migracje domenowe, edycja offline,
cold start PWA, push, backup/restore użytkowników, HTTPS i fizyczne iPhone'y.
To zakres kolejnych zadań MVP. E2e sprawdza fundament, nie pełny organizer.
API jest zamknięte do czasu implementacji uwierzytelnienia i autoryzacji.
Nie dodano kont produkcyjnych, seedów domowników ani sekretów; fixtures syntetyczne.

## Sprzątanie

Zatrzymano i usunięto własne kontenery `razem-raz1-app-test`,
`razem-raz1-install-test` i projekt Compose `razem-raz1-test` z jego testowym
wolumenem. Nie pozostały sieci tego projektu. Usunięto obraz `razem-raz1-test:0.1.0`
i 43 własne warstwy/obrazy pośrednie; bazowy oficjalny obraz pozostawiono jako
standardowy cache środowiska. Nie używano globalnego prune.
Dev i e2e zakończone, własne bazy w tmp usunięte. Porty 3100/5173/4317/4318
nie mają listenerów; ponowny bind z SO_REUSEADDR potwierdzony (samo TIME_WAIT nie
oznacza działającego serwera). Cache narzędzi/przeglądarek i wyniki testów są
usuwane przed przekazaniem; zależności node_modules i buildy pozostają jako
środowisko developerskie, są ignorowane przez Git. Nie pozostawiono podglądu.
