# RAZ-16 — przygotowanie odbioru, 06.11.2026

**Zadanie nieukończone. Nie wykonano wdrożenia ani prób fizycznych iPhone’ów.**
Bezpośrednie polecenie sesji zabrania wdrażania i scalenia do main; ma
pierwszeństwo przed opisem zadania. Praca wyłącznie na `agent/raz-16`, początek
`9b2b562` (scalone i zaakceptowane RAZ-15). Kod aplikacji/instalatora bez zmian.

## Potwierdzone źródła i granice

Przeczytano zadanie, zależność RAZ-15 z odbiorem i handoff, dokumenty ToDo oraz
repo: START, Ubuntu, backup, dostęp, acceptance i raport RAZ-15.
W głównym katalogu brak AGENTS.md i CLAUDE.md. Repozytoryjny START nadal opisuje
RAZ-1 jako przygotowane do odbioru, podczas gdy ToDo odnotowuje jego akceptację;
obowiązuje aktualny stan ToDo, nie historyczny status z pliku.

`get_project_installation(project=razem)` odczytano po potwierdzeniu gotowego
pakietu RAZ-15. Wynik odczytu:

| Pole | Faktyczny stan ToDo |
| --- | --- |
| Konfiguracja zapisana | `configured=false` |
| Deployment | Pusta lista, brak zainstalowanej wersji |
| Instalator | Online, host `homeserver`, adres `192.168.0.20`, Caddy dostępny, MFA wymagane |
| Formularz z szablonu | Local, `/home/konrad-gawlik/razem`, użytkownik `konrad-gawlik`, branch `main`, port `8095`, alias `razem`, env puste |

Formularz nie dowodzi istnienia katalogu, wolnego portu, originu HTTPS ani zaufania
telefonów. Nie zapisywano ustawień Installation ani Deployment. Nie uruchamiano
instalatora, zdalnej inspekcji/MFA, bootstrapu, timera ani zmian proxy/sieci.
Nie sprawdzono docelowego Ubuntu, architektury, dysku, konfliktów usług i TLS.
Nie wyprowadzono domniemanego URL z aliasu. Dane rzeczywistych kont i VAPID
nie zostały pobrane ani wygenerowane.

## Dostarczone przygotowanie

[Checklista fizycznego odbioru](../operations/iphone-acceptance.md) zawiera metrykę
instalacji, osobne wyniki A/B, cold start i restart bez sieci, każdy typ wpisu,
prywatność, sync, konflikty edit/edit i delete/edit, logout/pending, aktualizację,
rzeczywisty push i deep link oraz zasady sprzątania. Wszystkie wyniki fizyczne
pozostają NIEWYKONANE. Acceptance i runbook Ubuntu odsyłają do checklisty.

Aktualizacja, zatrzymanie/start: [runbook Ubuntu](../operations/ubuntu.md).
Kopia, timer i izolowane odzyskiwanie: [backup](../operations/backup.md).
Nie zmieniono kontraktów danych, ACL ani mechanizmu offline.

## Weryfikacja tej sesji

Testowano `git archive 9b2b562` w jednorazowym kontenerze `raz16-validation`:
Node `26.13.0`, npm `11.20.0`, przypięty obraz z digestu `deploy/Dockerfile`.
Hostowy Node 22 nie spełnia wymagań i nie był używany do kontroli aplikacji.
Kontener nie montował repo ani danych hosta, nie publikował portów.

| Kontrola | Wynik |
| --- | --- |
| `npm ci` | PASS, bez zmiany lockfile repo |
| `npm run typecheck` | PASS |
| `npm test` | PASS, 305 testów / 33 pliki, w tym sync, offline, ACL, migracje, backup i worker |
| `npm run build` | PASS wszystkich workspace; istniejące ostrzeżenie Vite o rozmiarze bundle >500 kB |
| `PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-install-config.py` | PASS, 9/9 |
| `sh -n scripts/install_server.sh scripts/compose.sh scripts/package-release.sh` | PASS |
| `docker compose -f deploy/compose.yaml config --quiet` | PASS |
| `git diff --check` | PASS |

Log: `artifacts/raz16-validation.log` (lokalny artefakt, bez danych produkcyjnych).
Nie dodawano testów powielających dokumentację. Regresje niezmienionych sync,
prywatności i migracji przeszły w istniejącym zestawie. Nie powtarzano e2e ani
pełnych prób instalatora RAZ-15: zmiana obejmuje wyłącznie dokumenty. Nie jest to
nowy pełny odbiór wydania, dowód produkcyjnego backupu ani fizycznego push/TLS.

## Sprzątanie i dalsza praca

Kontener `raz16-validation` zakończył się kodem 0 i został automatycznie usunięty
(`docker ps -a --filter name=raz16-validation` puste). Nie utworzono własnych
sieci, wolumenów, obrazów ani serwerów podglądu, nie zajęto hostowych portów.
Zależności, build i syntetyczne bazy testów usunięto wraz z kontenerem.
Log pozostaje jako dowód; cudze zasoby, trwałe dane i wcześniejsze artefakty
RAZ-15 pozostawiono. Bez globalnego prune.

Do dalszego odbioru potrzebne są czynności właściciela: przygotowanie prywatnego
bootstrapu i rzeczywistego originu w Installation, osobno autoryzowane wdrożenie
z MFA, ewentualne świadome zaufanie CA i fizyczne próby P1–P11 na obu telefonach.
Po wdrożeniu operator sprawdza host/usługi, health, backup/restore i zapisuje
faktyczny Deployment. Zbiorcza owner action w RAZ-16 pozostaje źródłem dalszych
kroków. Nie przekazujemy całego zadania do `submit_for_review` przy otwartych DoD.
