# RAZ-15 — pakiet Ubuntu, kontrakt ToDo i dowody

Zweryfikowany kod: **a2d0c7f835cb6c447ca3024a64900e335ef32315**.
Gałąź `agent/raz-15`, wyjściowy main `7fadd6ee1d81c0bac499f7f39238ffc76e1b33ad`.
Raport i późniejsze zmiany dokumentacyjne nie zmieniają kodu instalatora/obrazów.
Nie wykonano wdrożenia na domowym serwerze ani scalenia do main.

## Dostarczone pliki i zachowanie

- `scripts/install_server.sh` → `install_server.py`: POSIX sh, root, brak argumentów,
  TTY/stdin, źródła bez .git i hostowego Node/npm; odtworzony kontrakt faktycznych
  `runner/src/installer.ts` i `server/services/installs.ts` ToDoTaskManager.
- Preflight tylko do odczytu, prywatna konfiguracja, lock, kontrolowany build,
  zachowanie starego obrazu **przed** rebuildem, offline backup tym obrazem przed
  migracją, idempotentny bootstrap, readiness obu usług i HTTP, wersja po sukcesie.
- `deploy/Dockerfile`, `compose.yaml`: Fastify + zbudowana PWA, worker z heartbeat,
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
| `python3 scripts/test-install-config.py` | **7/7 PASS**: porty, legacy env jako dane, symlinki/uprawnienia, stabilność VAPID/projektu, walidacja, prywatny bootstrap i ochrona kontekstu build |
| `sh -n` trzech wejść shell | PASS |
| `python3 -m py_compile` | PASS skryptów instalacji/testu |
| Compose v2.40.3 `config --quiet` | PASS głównego pliku oraz opcjonalnego profilu Caddy |
| Docker build app/worker | PASS, przypięta baza Node po digest, runtime non-root |
| `python3 scripts/test-installation.py a2d0c7f` | **12 scenariuszy + cleanup PASS**, kod 0; rzeczywiste buildy/HTTP/SQLite/Compose v5 |
| Caddy non-root z `cap_drop ALL`, read-only, 128 MB | PASS; certyfikat lokalnej CA i TLS zweryfikowane przez curl `--cacert`, bez pomijania weryfikacji |
| `git diff --check` | PASS |

Kontrole Node wykonano w usuwanym kontenerze z wymaganym toolchainem, na
archiwum 1fc4758; dotknięty kod TypeScript nie zmienił się później. Testy instalacji
powtórzono na finalnym kodzie a2d0c7f. Host/daemon: Ubuntu 26.04.1, Docker 29.1.3.
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

## Wykryte problemy i poprawki

- Domyślne pule sieci Docker były wyczerpane przez istniejące 34 sieci. Nie usuwano
  ich. Test wybiera wolną /28 po odczycie adresacji; pakiet udostępnia opcjonalny
  RAZEM_NETWORK_SUBNET i konkretną diagnozę.
- Compose v5 interpretował surowe image ID jako repository:tag, a rebuild tej samej
  wersji mógł usunąć referencję starego manifestu. Instalator zachowuje lokalny tag
  przed buildem, a backup uruchamia przez `docker run --pull never --network none`.
- Bazowa binarka Caddy ma `cap_net_bind_service=ep`, co z `cap_drop ALL` dawało
  EPERM. Własny obraz usuwa file capability, używając nieuprzywilejowanego 8443.
- Generator VAPID ma `--log-driver none`; JSON jest przechwytywany w pamięci,
  bez sekretu w Docker logs. Bootstrap w kontekście build jest odrzucany.

## Artefakty i sprzątanie

Trwały log końcowej próby:
`/home/konrad-gawlik/work/razem/artifacts/raz15-installation-a2d0c7f.log`.
Próba: `raz15-27138440a9`, użyte porty **33377, 47751, 54089, 55725**.
Wszystkie usunięto/zwolniono; test zakończył się `PASS cleanup` i kodem 0.
Kontenery, sieci, wolumeny i obrazy prób mają unikalne nazwy i są usuwane w finally;
root backstop usuwa także prywatny tymczasowy stan. Poprzednie nieudane próby
również posprzątano. Współdzielone bazy/obrazy i cudze zasoby pozostawiono.
Nie używano globalnego prune. Cache buildów Dockera pozostaje współdzielony.

Przenośne wydanie: `sh scripts/package-release.sh` zapisuje
`/home/konrad-gawlik/work/razem/artifacts/razem-<pełny-SHA>.tar.gz` i `.sha256`.
Dokładny końcowy SHA, suma i ścieżka zweryfikowanego archiwum są w handoff RAZ-15.
Pakiet powstaje z lokalnego Git bez remote; po rozpakowaniu instalator nie używa
Git. Pliki lokalne, .env, dane, node_modules i .git nie trafiają do archiwum.

## Zakres pozostawiony RAZ-16

Rzeczywiste wdrożenie Ubuntu z ToDo/MFA, osiągalny produkcyjny origin/proxy i DNS,
publiczne ACME (jeśli wybrane), ręczne zaufanie CA, instalacja PWA i prawdziwy push
na **obu fizycznych iPhone'ach**. Tych czynności nie wykonano i nie oznaczono PASS.
