# RAZ-15 — pakiet Ubuntu, kontrakt ToDo i dowody

Zweryfikowany kod instalatora po review: **c2228dd24b8dfe17f0a99f512c327eb3526fce04**;
harness izolowanego daemona: **3baa8e7**. Pierwsza pełna próba przed review:
**a2d0c7f835cb6c447ca3024a64900e335ef32315**.
Gałąź `agent/raz-15`, wyjściowy main `7fadd6ee1d81c0bac499f7f39238ffc76e1b33ad`.
Późniejsza aktualizacja tego raportu nie zmienia kodu instalatora/obrazów.
Nie wykonano wdrożenia na domowym serwerze ani scalenia do main.

## Dostarczone pliki i zachowanie

- `scripts/install_server.sh` → `install_server.py`: POSIX sh, root, brak argumentów,
  TTY/stdin, źródła bez .git i hostowego Node/npm; odtworzony kontrakt faktycznych
  `runner/src/installer.ts` i `server/services/installs.ts` ToDoTaskManager.
- Preflight tylko do odczytu, prywatna konfiguracja, lock, kontrolowany build,
  zachowanie starego obrazu **przed** rebuildem, offline backup tym obrazem przed
  migracją, idempotentny bootstrap, readiness obu usług i HTTP, wersja po sukcesie.
- `deploy/Dockerfile`, `compose.yaml`, `compose.subnet.yaml`: Fastify + zbudowana PWA, worker z heartbeat,
  trwała lokalna SQLite WAL, non-root, read-only, restart, limity i rotacja logów.
- `deploy/compose.caddy.yaml`, `Dockerfile.caddy`, `Caddyfile[.public]`: opcjonalny
  non-root Caddy bez capabilities, z trwałą CA i bez fikcyjnego adresu wdrożenia.
- `deploy/bootstrap.mjs`: dwa konta z prywatnego JSON/stdin, bez resetu istniejących
  kont; wymuszenie zmiany hasła i walidacja przez istniejący AuthService.
- `scripts/compose.sh`, szablon timera backupu, `.env.example`,
  `scripts/package-release.sh`; [runbook](../operations/ubuntu.md),
  [backup/restore](../operations/backup.md), [dostęp](../security/access.md).

Domyślny hostowy bind to **127.0.0.1:3000**, wewnątrz app nadal 3100. HTTP_PORT
z ToDo ma pierwszeństwo; bez niego instalator zachowuje istniejący port.
Dawny runbook podawał domyślne 3100 — zaktualizowano go zgodnie z opisem RAZ-15.
Istniejący Caddy może użyć jawnego konkretnego IPv4 hosta; żadne globalne proxy,
DNS, VPN, firewall ani router nie są zmieniane. Baza nie ma portu sieciowego.

## Wykonane kontrole

| Kontrola | Wynik i zakres |
| --- | --- |
| `npm ci` | PASS, przypięty Node 26.13.0/npm 11.20.0, brak zmian lockfile |
| `npm run typecheck` | PASS |
| `npm test` | **305/305, 33 pliki PASS**, sync/offline/ACL/migracje/backup/worker |
| `npm run build` | PASS wszystkich 5 workspace, produkcyjny frontend Fastify |
| `python3 scripts/test-install-config.py` | **9/9 PASS**: porty, legacy env jako dane, symlinki/uprawnienia, stabilność VAPID/projektu, walidacja, prywatny bootstrap, ochrona kontekstu build oraz wybór override podsieci i zachowanie istniejącej podsieci |
| `sh -n` trzech wejść shell | PASS |
| `python3 -m py_compile` | PASS skryptów instalacji/testu |
| Compose v2.40.3 `config` | PASS czterech kombinacji: automatic/explicit × app+worker/Caddy; asercje rzeczywistego JSON: brak IPAM dla automatic, dokładna podsieć dla explicit |
| Docker build app/worker | PASS, przypięta baza Node po digest, runtime non-root |
| `python3 scripts/test-installation.py a2d0c7f` | **12 scenariuszy + cleanup PASS**, kod 0; rzeczywiste buildy/HTTP/SQLite/Compose v5 |
| `python3 scripts/test-installation.py c2228dd` po review | **12 scenariuszy + cleanup PASS**, kod 0; jawna podsieć 10.249.0.0/28, faktyczny wrapper `compose.sh`, stabilne ID sieci po fresh/repeat/restart |
| `python3 scripts/test-installation.py --isolated-daemon 3baa8e7` po review | **12 scenariuszy + cleanup PASS**, kod 0; brak RAZEM_NETWORK_SUBNET, brak IPAM w Compose, automatycznie przydzielone 10.254.0.0/24; Docker 29.1.3/Compose 5.0.0, fresh/repeat/restart z tą samą siecią i danymi |
| Caddy non-root z `cap_drop ALL`, read-only, 128 MB | PASS; certyfikat lokalnej CA i TLS zweryfikowane przez curl `--cacert`, bez pomijania weryfikacji |
| `git diff --check` | PASS |

Kontrole Node wykonano w usuwanym kontenerze z wymaganym toolchainem, na
archiwum 1fc4758; dotknięty kod TypeScript nie zmienił się później. Testy instalacji
przed review powtórzono na a2d0c7f, a po review na c2228dd (explicit) i 3baa8e7
(automatic, osobny daemon). Host/daemon: Ubuntu 26.04.1, Docker 29.1.3.
Izolowany wykonawca root: Alpine 3.23/Python 3, Docker CLI 29.1.3 i Compose v5.
Nie wymagał hostowego Node, repo checkoutu ani lokalnych artefaktów deweloperskich.
Nie ponawiano e2e przeglądarek: UI/sync nie zmieniono, sprawdzono istniejące 305
regresji oraz rzeczywisty build i HTTP produkcyjnego pakietu. Nie oznacza to
ponownego pełnego odbioru przeglądarek ani fizycznych iPhone'ów.

## Pełna próba kontraktu ToDo

`scripts/test-installation.py` pobiera lokalny commit przez `git archive`, rozpakowuje
źródła bez `.git` i uruchamia skrypt przez `sh` jako root, bez TTY/argumentów/stdin,
z APP_VERSION, INSTALL_USER/UID/GID/HOME, HTTP_PORT i prywatnym plikiem bootstrapu.
Odtwarza kontrakt wykonania ToDo; nie uruchamia rzeczywistego zadania instalacji,
logowania/MFA ani publikacji aliasu w produkcyjnym ToDo.

1. Preflight nie utworzył `.razem/` i nie zmienił `.env`.
2. Fresh: app/worker healthy, HTTP `/readyz` i frontend 200, dwa konta, wygenerowana
   stabilna para VAPID, prywatne prawa i właściciel .env z INSTALL_*.
3. Po syntetycznym seedzie ponowienie bez pliku bootstrapu i bez HTTP_PORT zachowało
   port, hashe kont, VAPID, private/shared, wszystkie wiersze migracji i kolejkę.
4. Restart obu kontenerów zachował dane i rzeczywistą zaplanowaną kolejkę
   reminder_dispatches bez duplikacji; inspect potwierdził non-root/read-only,
   unless-stopped i brak portu bazy.
5. Cudzy zajęty port: odmowa przed zatrzymaniem własnych usług i zmiany wersji;
   usługa zajmująca port nie została naruszona.
6. Kontrolowany błąd builda: kod niezerowy, poprzednia app działa, wersja zachowana.
7. Aktualizacja: stary obraz zachowany przed buildem, sprawdzony backup SQLite
   i konfiguracji, dane/klucze/kolejka zachowane; APP_VERSION dopiero po readiness.
8. HTTP na wybranym porcie/adresie hosta osiągalny z odrębnego kontenera w sieci
   proxy; jawny bind do bridge hosta, bez publicznego `0.0.0.0`.
9. Błąd startu od niepoprawnego trust proxy: kod niezerowy i brak nowej wersji;
   ponowienie poprawną konfiguracją przywróciło healthy i identyczne dane.
10. Restore backupu do nowego katalogu: integrity/FK, konta i private/shared
    zachowane, sesje/push odwołane. Zachowany poprzedni obraz uruchomiony na
    odtworzonym katalogu na osobnym loopback porcie; readiness 200. Test dotyczy
    zgodnego schematu; nie dowodzi bezstratnego downgrade do niezgodnego schematu.
11. Rzeczywista v3→v6 na syntetycznej SQLite: snapshot v3 przed SQL, dane zachowane,
    ponowienie niczego nie migruje; restore snapshotu ma schemat v3. Uszkodzona
    checksum blokuje migrate; przywrócenie prawidłowej checksum naprawia próbę.
12. Opcjonalny profil Caddy: start bez root/capabilities, CA na własnym wolumenie,
    HTTPS `/readyz` 200 z pełną weryfikacją certyfikatu i proxy do app.

Test korzysta wyłącznie z syntetycznych danych. Kolejka ma termin w przyszłości;
nie wysyłano realnego push. Podczas restore odwołanie subskrypcji usuwa powiązaną
kolejkę przez FK — porównanie bezstratnego restartu dotyczy aktywnej instalacji,
a restore ma świadomą politykę ponownego opt-in.

Po review cały powyższy zestaw wykonano ponownie **w obu wariantach sieci**.
Automatic: zmienna RAZEM_NETWORK_SUBNET nie jest przekazywana; test sprawdza
rzeczywisty JSON Compose bez `ipam.config`, podsieć przydzieloną przez Docker
i niezmienność ID sieci po fresh/repeat/restart. Osobny daemon ma własny magazyn
i wolne pule, słucha wyłącznie na Unix sockecie, nie montuje hostowego Docker socketa
ani nie publikuje portów na hoście. Explicit: test sprawdza dokładną podsieć z
override i te same warunki trwałości. Oba testy używają operatorowego `compose.sh`.
Pierwsza próba DinD c2228dd zakończyła się przed instalacją przez montowanie /tmp;
poprawka 3baa8e7 dotyczy wyłącznie harnessu, ponowiona pełna próba ma kod 0.

## Wykryte problemy i poprawki

- Domyślne pule sieci Docker były wyczerpane przez istniejące 34 sieci. Nie usuwano
  ich. Test na współdzielonym daemonie wybiera wolną /28 po odczycie adresacji;
  pakiet udostępnia opcjonalny RAZEM_NETWORK_SUBNET i konkretną diagnozę.
- Review wykazało brak testu domyślnego IPAM i ryzyko pustego `ipam.config: [{}]`.
  Główny plik Compose pomija teraz IPAM, a osobny `compose.subnet.yaml` jest
  dołączany przez wspólne argumenty instalatora i `compose.sh` wyłącznie dla
  niepustego RAZEM_NETWORK_SUBNET. Testy sprawdzają konfigurację i faktyczną sieć
  po fresh/repeat/restart. `--isolated-daemon` zapewnia osobne wolne pule;
  entrypoint DinD montuje własne /tmp, więc źródła testu są montowane w /work.
- Compose v5 interpretował surowe image ID jako repository:tag, a rebuild tej samej
  wersji mógł usunąć referencję starego manifestu. Instalator zachowuje lokalny tag
  przed buildem, a backup uruchamia przez `docker run --pull never --network none`.
- Bazowa binarka Caddy ma `cap_net_bind_service=ep`, co z `cap_drop ALL` dawało
  EPERM. Własny obraz usuwa file capability, używając nieuprzywilejowanego 8443.
- Generator VAPID ma `--log-driver none`; JSON jest przechwytywany w pamięci,
  bez sekretu w Docker logs. Bootstrap w kontekście build jest odrzucany.

## Artefakty i sprzątanie

Trwały log próby przed review:
`/home/konrad-gawlik/work/razem/artifacts/raz15-installation-a2d0c7f.log`.
Próba: `raz15-27138440a9`, użyte porty **33377, 47751, 54089, 55725**.
Wszystkie usunięto/zwolniono; test zakończył się `PASS cleanup` i kodem 0.
Kontenery, sieci, wolumeny i obrazy prób mają unikalne nazwy i są usuwane w finally;
root backstop usuwa także prywatny tymczasowy stan. Poprzednie nieudane próby
również posprzątano. Współdzielone bazy/obrazy i cudze zasoby pozostawiono.
Nie używano globalnego prune. Cache buildów Dockera pozostaje współdzielony.

Końcowe logi po review:

- `artifacts/raz15-explicit-c2228dd.log`, projekt `raz15-92fc0f7a63`,
  porty **47773, 39277, 56173, 56351**; 12 scenariuszy i cleanup PASS, kod 0.
- `artifacts/raz15-automatic-3baa8e7.log`, projekt `raz15-390657c6e3`,
  porty **45037, 51083, 53127, 54719** wewnątrz izolowanego daemona;
  12 scenariuszy, cleanup i usunięcie daemona/magazynu PASS, kod 0.

Zewnętrzny kontener daemona `raz15-390657c6e3-daemon` i jego własny wolumen
`raz15-390657c6e3-daemon-data` usunięto. Pierwszą nieudaną próbę
`raz15-fa809867f0` także usunięto. Nie pozostawiono podglądu ani testowego portu.

Przenośne wydanie: `sh scripts/package-release.sh` zapisuje
`/home/konrad-gawlik/work/razem/artifacts/razem-<pełny-SHA>.tar.gz` i `.sha256`.
Dokładny końcowy SHA, suma i ścieżka zweryfikowanego archiwum są w handoff RAZ-15.
Pakiet powstaje z lokalnego Git bez remote; po rozpakowaniu instalator nie używa
Git. Pliki lokalne, .env, dane, node_modules i .git nie trafiają do archiwum.

## Zakres pozostawiony RAZ-16

Rzeczywiste wdrożenie Ubuntu z ToDo/MFA, osiągalny produkcyjny origin/proxy i DNS,
publiczne ACME (jeśli wybrane), ręczne zaufanie CA, instalacja PWA i prawdziwy push
na **obu fizycznych iPhone'ach**. Tych czynności nie wykonano i nie oznaczono PASS.
