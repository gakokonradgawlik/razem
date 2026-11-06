# Razem — pakiet Ubuntu i utrzymanie (RAZ-15)

Pakiet uruchamia Fastify ze zbudowaną PWA oraz osobnego workera. SQLite WAL ma
jeden trwały lokalny wolumen Compose `data`, współdzielony na pojedynczym hoście.
Nie używaj NFS/SMB. Procesy app/worker działają jako node (UID/GID 1000), rootfs
jest read-only, capabilities usunięte, logi json-file ograniczone do 10 MB × 3.
Oba procesy mają healthcheck, restart unless-stopped oraz limity CPU/pamięci.
Node i Caddy są przypięte wersją i digestem. Produkcja nie używa Vite preview.

## Wejście instalatora ToDo

Śledzony `scripts/install_server.sh` działa przez **sh jako root, bez argumentów,
TTY i stdin**, ze źródeł `git archive` bez `.git`, hostowego Node/npm i node_modules.
Wymaga Linux (docelowo Ubuntu 24.04/26.04), Python 3 ze standardową biblioteką,
Docker Engine i Compose >=2.24 (również v5), lokalnego dysku i minimum 2 GiB
wolnego miejsca w katalogu instalacji. Zapewnij także miejsce w Docker Root Dir
na build i kopie. Instalator nie instaluje zależności, kont systemowych, proxy,
DNS, firewalla ani timera. Docker może wymagać dostępu do rejestru i npm przy buildzie.

Kontrakt sprawdzono w `runner/src/installer.ts` i `server/services/installs.ts`
ToDoTaskManager: zatwierdzony commit jest archiwizowany, śledzone pliki kopiowane
bez usuwania lokalnych danych, istniejący `.env` pozostaje, skrypt uruchamia root.
ToDo przekazuje APP_VERSION (7 znaków SHA), INSTALL_USER/UID/GID/HOME i ustawienia
prywatne. INSTALL_* określają właściciela nowego `.env`; kontenery zachowują UID 1000.
Instalator nie zmienia właściciela drzewa źródeł, cudzych katalogów ani kont.
Stan operacyjny `.razem/` jest root:root 0700, pliki 0600. Nowy `.env` ma 0600.
Istniejący `.env` musi być prywatnym zwykłym plikiem właściciela instalacji/root;
instalator odmawia symlinków i nie wykonuje jego zawartości jako kodu.

| Ustawienie | Zachowanie |
| --- | --- |
| APP_VERSION | Wymagany SHA/wydanie; zapis do `.env` dopiero po gotowości usług i HTTP |
| HTTP_PORT | Ma pierwszeństwo; bez niego zachowany port z `.razem/config.json`, następnie `.env` HTTP_PORT/RAZEM_PORT, ostatecznie **3000** |
| RAZEM_PROJECT_NAME | Domyślnie `razem`; ustaw przed pierwszą instalacją dla osobnej instancji, później nie zmieniaj |
| RAZEM_BIND_ADDRESS | Domyślnie **127.0.0.1**; dla kontenerowego Caddy jawny konkretny IPv4 hosta osiągalny z jego sieci; `0.0.0.0` odrzucane |
| RAZEM_PUBLIC_ORIGIN | Rzeczywisty dokładny HTTPS origin PWA; dla aliasu ToDo zgodny z aliasem z Installation |
| RAZEM_TRUST_PROXY | Tylko faktyczny adres/CIDR zaufanego proxy, jeżeli potrzebne; puste domyślnie |
| VAPID_SUBJECT | Opcjonalny prawdziwy mailto/HTTPS; świeża instalacja generuje klucze po podaniu subject |
| VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY | Opcjonalna istniejąca para; nie jest rotowana przez ponowienie/aktualizację |
| RAZEM_BOOTSTRAP_JSON / RAZEM_BOOTSTRAP_FILE | Jeden sposób podania prywatnego JSON dwóch kont; plik 0600, root/właściciel instalacji |

Puste VAPID wyłącza push, bez blokowania organizera. Klucze i cursor key SQLite
powstają raz; nie ma losowania sekretów przy restarcie. Zmiana niepustej istniejącej
konfiguracji VAPID przez instalator jest odrzucana. Rotacja wymaga oddzielnego,
świadomego działania i ponownego opt-in telefonów. Nie zapisuj sekretów w Git/logach.

Pierwsza instalacja wymaga prywatnego JSON zgodnego z `BootstrapInput`:
`householdName`, `timezone` (opcjonalne, domyślnie Europe/Warsaw), `members` —
dokładnie dwa obiekty `login`, `displayName`, `temporaryPassword`. Każde hasło musi
spełniać politykę `security/access.md`. Przekaż go jako **prywatną zmienną**
RAZEM_BOOTSTRAP_JSON w Installation albo przygotuj prywatny plik i wskaż jego
ścieżkę RAZEM_BOOTSTRAP_FILE. Bez hasła domyślnego/demo i bez haseł w argv.
Instalator przesyła JSON do kontenera przez stdin; CLI niczego z niego nie loguje.
Istniejące dwa konta pozostają bez zmian. Po udanym bootstrapie usuń wejściowy
plik/prywatne ustawienie ToDo i przekaż tymczasowe hasła osobiście; pierwsze
logowanie wymusza zmianę. Interaktywny tryb administratora nadal jest dostępny:

```sh
sudo sh scripts/compose.sh run --rm -it app node apps/server/dist/admin.js reset-password LOGIN
sudo sh scripts/compose.sh exec -T app node apps/server/dist/admin.js status
```

Przed rzeczywistą instalacją RAZ-16 odczytuje get_project_installation, potwierdza
repo/gałąź i respektuje MFA. Port 8095 z obecnego formularza ToDo jest propozycją,
nie dowodem wolnego portu. RAZ-15 nie instaluje niczego na domowym serwerze.
ToDo publikuje alias `.home.arpa` we własnym Caddy: ustaw rzeczywisty bind/upstream
odpowiedni do jego sieci i PUBLIC_ORIGIN przed wdrożeniem. Hostowe proxy może
korzystać z loopback. Nie uruchamiaj równolegle opcjonalnego profilu Caddy.
Baza nie ma żadnego portu sieciowego. Nie otwieraj routera/firewalla ani VPN.

## Preflight, instalacja i aktualizacja

Sam odczyt wymaga tych samych zmiennych co instalacja (przede wszystkim APP_VERSION):

```sh
sudo -E sh scripts/install_server.sh --preflight
# ToDo wykonuje bez argumentów; ręcznie z zatwierdzonym APP_VERSION w środowisku:
sudo -E sh scripts/install_server.sh
sudo sh scripts/compose.sh ps
```

Preflight sprawdza Docker/Compose, dysk, prywatne pliki, konfigurację, kolizje nazwy
projektu i bind portu. Niczego nie zapisuje. Następnie instalator zakłada lock,
buduje lokalny obraz `razem-<projekt>:<APP_VERSION>`, zatrzymuje wyłącznie własne
app/worker i przed każdą aktualizacją tworzy sprawdzony backup **starym obrazem**.
Kopia zawiera `/data/installation.env` (zapisany przez instalator, UID 1000, 0600).
Poprzednia konfiguracja i niezmienny ID obrazu są w `.razem/previous.json`.
Nie usuwaj obrazu ani konfiguracji poprzedniej wersji przed odbiorem aktualizacji.

Migracje wykonuje kontrolowane CLI app z checksumami i snapshotem przed zmianą
schematu. Nie edytujemy historii SQL. Start app powtarza sprawdzenie schematu,
nie stosuje ponownie zastosowanych migracji; worker nie migruje. Bootstrap jest
transakcyjny. Ponowienie zachowuje dane, port, konta, sekrety i klucze parowania.
Po `up --wait` app **i worker** muszą być healthy; `/readyz` musi zwrócić 200
na wybranym hostowym porcie. Dopiero wtedy aktualizowany jest APP_VERSION w `.env`,
z zachowaniem innych kluczy i właściciela. Błąd zwraca niezerowy kod i etap bez
sekretów. Dla awarii po zatrzymaniu usług dane i backup pozostają do naprawy;
instalator nie wykonuje automatycznego downgrade ani przywracania danych.

`sudo sh scripts/compose.sh ...` używa utrwalonej konfiguracji, bez zależności od
zmiennych bieżącej powłoki. Nie loguj `config` bez `--quiet`: może wypisać VAPID.
Stan zdrowia sprawdzaj przez `ps`, `logs --tail 50 app worker`, HTTP `/healthz`
(proces) i `/readyz` (SQLite). Worker zapisuje heartbeat dopiero po udanym cyklu
(albo kontroli schematu przy wyłączonym push); stary heartbeat daje unhealthy.
Docker sam restartuje zakończony proces; unhealthy wymaga diagnozy administratora.
Zatrzymanie: `sudo sh scripts/compose.sh stop worker app`; start: `... up -d --wait`.
Nie używaj `down -v` na instalacji z danymi ani globalnego prune.

## Opcjonalny Caddy i HTTPS

`deploy/compose.caddy.yaml` jest osobnym opt-in profilem `caddy`, bez zmian
istniejącego proxy. `deploy/Caddyfile` to szablon lokalnej CA, a
`deploy/Caddyfile.public` — domeny z publicznym certyfikatem. Żaden plik nie zawiera
wymyślonego adresu wdrożenia. Ustaw RAZEM_SITE_ADDRESS na prawdziwy hostname
(bez protokołu/portu), RAZEM_HTTPS_BIND na konkretny adres, RAZEM_HTTPS_PORT na wolny
port (domyślnie 8443); podaj je w prywatnym pliku env Compose. PUBLIC_ORIGIN
uwzględnia port używany przez klienta. Zaufanie proxy ogranicz do jego sieci/adresu.

```sh
sudo sh scripts/compose.sh --env-file /secure/caddy.env -f deploy/compose.caddy.yaml --profile caddy config --quiet
sudo sh scripts/compose.sh --env-file /secure/caddy.env -f deploy/compose.caddy.yaml --profile caddy up -d --build --wait
```

Caddy używa non-root 1000, wewnętrznego 8443 i trwałych `caddy_data/caddy_config`.
Nowe wolumeny inicjalizuje własny obraz; nie chownuje istniejących hostowych danych.
Proxy łączy się z `app:3100` wewnątrz tej samej sieci, serwując UI i /api pod jednym
originem. Brak site address daje błąd. Dla domeny publicznej ustaw RAZEM_CADDYFILE
w pliku env na `./Caddyfile.public`; ACME wymaga wcześniej autoryzowanego DNS oraz
osiągalnego challenge (np. istniejący forwarding 443 na wewnętrzny 8443 dla TLS-ALPN).
Nie otwieraj w tym celu nowych portów routera. Jeśli warunki nie są spełnione,
użyj istniejącego zaufanego proxy albo lokalnej CA. Nie wyłączaj weryfikacji TLS.

Dla lokalnej CA właściciel eksportuje **wyłącznie publiczny root.crt** z
`/data/caddy/pki/authorities/local/root.crt` kontenera Caddy, sprawdza fingerprint
SHA-256 z zaufanego serwera i przekazuje go bezpiecznie na oba telefony. Nie wysyłaj
root.key. Na każdym iPhonie: zainstaluj pobrany profil w Ustawienia → Ogólne → VPN
i zarządzanie urządzeniem, następnie Ustawienia → Ogólne → To urządzenie →
Ustawienia zaufania certyfikatów → włącz pełne zaufanie dla tej CA. To ręczna
czynność właściciela. Potem Safari ma otwierać właściwy origin bez ostrzeżeń.
DNS lokalnego hostname musi już wskazywać osiągalny serwer. Zachowaj wolumen CA:
zmiana CA oznacza ponowne ręczne zaufanie obu telefonów.

Zasady: [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https),
[reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

## Backup, kontrolowane restore i rollback

Pełne polecenia, szyfrowanie, retencja 7 dni + 4 tygodnie i RPO 24 h:
[backup.md](backup.md). Instalator aktualizuje `/data/installation.env` dla przyszłych
kopii; konfiguracja aktualizacji sprzed zmiany pozostaje w backupie i previous.json.
Dzienny timer z `deploy/systemd/` jest szablonem do jawnego wdrożenia, nie jest
instalowany automatycznie. Jednostka używa `scripts/compose.sh`, więc odczytuje
zachowany port/sekrety. Ustaw rzeczywisty WorkingDirectory przed jej instalacją.

```sh
sudo sh scripts/compose.sh exec -T app node apps/server/dist/admin.js backup --config-file /data/installation.env
sudo sh scripts/compose.sh stop worker app
sudo sh scripts/compose.sh run --rm --no-deps -T app node apps/server/dist/admin.js restore --archive /data/backups/ARCHIWUM --target /data/recovery-test
```

Zastąp ARCHIWUM rzeczywistą nazwą sprawdzonej kopii. Restore tworzy **nowy** katalog,
sprawdza integrity/FK/historię, odwołuje sesje i push oraz rotuje cursor key. Nie
podmienia działającej bazy. Zabezpiecz też aktualne dane i lokalne pending/konflikty
obu telefonów; starsza kopia cofa późniejsze zapisy. Próbę wykonaj z wyłączonym
wysyłaniem push. Sprawdź dwa konta, private/shared, schemat i odmowę starych sesji.

Po próbie administrator, przy zatrzymanych app i workerze, zachowuje obecny katalog
danych/wolumen, przygotowuje nowy wolumen z zawartością sprawdzonego celu i prawami
0700/0600 UID 1000, a przez osobny lokalny override Compose `volumes.data.external`
+ `name` przełącza **obie** usługi na nowy wolumen. Używa obrazu zgodnego ze schematem
(ID z previous.json), konfiguracji z backupu i tej samej zatwierdzonej sieci/originu.
Zweryfikuj override przez config --quiet, potem up --wait i HTTP. Nie podmieniaj
aktywnego pliku WAL. Nie uruchamiaj jednocześnie dwóch instalacji z wysyłaniem push.
Rollback samego obrazu jest dozwolony wyłącznie przy zgodnym schemacie; starszy
schemat odtwarzaj snapshotem i zgodnym obrazem według backup.md. Zmiany wykonane po
kopii wymagają świadomego odzyskania; downgrade nie jest bezstratny.

## Przenośne wydanie i odbiór na iPhone

`sh scripts/package-release.sh [commit]` tworzy `artifacts/razem-<pełny-SHA>.tar.gz`
z prefiksem `razem/` i sumą SHA-256. Używa lokalnego Git, nie wymaga repo remote.
Archiwum ma śledzone źródła, lockfile, instrukcje i skrypt, bez .git, danych,
node_modules czy sekretów. Sprawdź sumę, rozpakuj do wybranego katalogu, zapewnij
wymagania i prywatny bootstrap, podaj APP_VERSION odpowiadający commitowi i uruchom
instalator jako root. Wyniki: [quality/raz-15.md](../quality/raz-15.md).

RAZ-16 odpowiada za rzeczywisty Ubuntu/HTTPS i oba fizyczne iPhone'y. Na każdym:
Safari → właściwy zaufany HTTPS origin → zalogowanie i wymuszona zmiana hasła →
pełna synchronizacja i komunikat gotowości offline → Udostępnij → Do ekranu
początkowego → otwórz ikoną online. Potem tryb samolotowy, zamknięcie i zimny start,
wpisy każdego typu, restart i powrót połączenia, weryfikacja na drugim koncie.
Sprawdź private/shared, konflikt, wylogowanie oraz aktualizację PWA bez utraty
outbox; przed zamknięciem zapisz formularze. Włącz push świadomym przyciskiem i
sprawdź przypomnienie zamkniętej PWA po HTTPS. WebKit ani symulacja transportu
nie zastępują tego odbioru. Nie obiecujemy alarmów offline ani sync zamkniętej PWA.
