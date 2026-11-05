<!-- razem/operations/ubuntu.md · updated 2026-10-28 by Codex -->
# Razem — Ubuntu, HTTPS i utrzymanie
## Docelowy pakiet
Docker Compose: app (zbudowany frontend i API), worker, trwały lokalny wolumen SQLite /data. Opcjonalny profil Caddy jeżeli nie istnieje reverse proxy. Obrazy przypięte wersjami; procesy non-root, restart policy, health/readiness, kontrolowane limity i rotacja logów.
Wariant domyślny bezpieczny do testów: app wystawiona tylko na 127.0.0.1:3100; brak bazy i paneli admin w sieci. Proxy kieruje /api i UI pod jednym originem. Sprawdzaj zajęte porty i istniejące konfiguracje zamiast nadpisywać cudze usługi. SQLite musi być na dysku lokalnym, nie NFS/SMB.

## Dostęp i pierwsze wdrożenie
Najpierw get_project_installation i istniejące ustawienia ToDo; użyj uprawnionego dostępu do Ubuntu i wykonaj read-only preflight: system/architektura, Docker Compose, dysk, porty, proxy, DNS i TLS. Nie wpisuj fikcyjnego hosta ani adresu wdrożenia.
Jeśli nie ma dostępu/hosta, RAZ-16 zgłasza jedną request_owner_action z brakującym adresem i sposobem dostępu; wdrażający kontynuuje wszystko, co niezależne. Dane poufne wyłącznie do przeznaczonych pól/bezpiecznego kanału, bez treści dokumentu czy logów. Obecnie adres serwera, domena i dostęp NIE są znane.
MFA i kroki wymagające właściciela respektuj zgodnie z narzędziem. Tych czynności nie maskuj jako pytań o architekturę.

## HTTPS na iPhone
PWA/Service Worker/push potrzebują bezpiecznego originu. Zwykły http://adres-LAN na iPhonie nie jest rozwiązaniem produkcyjnym.
Preferuj istniejącą zaufaną domenę/proxy. Przy istniejącym prywatnym VPN i HTTPS użyj ich konfiguracji. Nie instaluj ani nie zakładaj konta VPN/chmury bez ustalenia operacyjnego.
Dla domeny publicznej Caddy może obsłużyć certyfikat ACME; zastosuj tylko gdy właściciel już udostępnił domenę i autoryzował jej trasę sieciową. Samo posiadanie serwera nie oznacza zgody na otwieranie portów w routerze. Dla lokalnej CA konieczne jest ręczne zaufanie na obu iPhone'ach — właściciel wykonuje ten krok, agent podaje dokładną instrukcję i nie obchodzi ostrzeżeń certyfikatu.
Adres originu wybierz raz przed instalacją PWA, bo zmiana hosta zmienia magazyn offline/subskrypcje. Dostęp spoza domu wymaga wcześniej skonfigurowanego połączenia do serwera; bez niego aplikacja działa na lokalnej kopii, a sync czeka.
Referencja: https://caddyserver.com/docs/automatic-https

## Procedura instalacji i aktualizacji
Skrypt sprawdza wymagania i uprawnienia, przygotowuje katalog/sekrety przez stdin lub chroniony plik, wykonuje spójny backup przed migracją, przeprowadza migracje kontrolowanie, startuje usługi i sprawdza /readyz. Ponowienie jest idempotentne. Bootstrap kont interaktywny; brak danych produkcyjnych w seedach.
Przy aktualizacji zgodność poprzedniej PWA/API i migracji; nie kasuj wolumenów. Rollback obrazu tylko dla zgodnego schematu, w przeciwnym razie kontrolowane odtworzenie snapshotu po zatrzymaniu zapisów i zapisaniu nowszych zmian, bez obietnicy bezstratnego downgrade.
Nie uruchamiaj instalacji na cudzym hoście w zadaniach przygotowania pakietu. RAZ-16 odpowiada za rzeczywiste wdrożenie w autoryzowanym zakresie; zachowaj inne aplikacje.

## Backup i odzyskiwanie
Spójny SQLite backup przez online backup API lub VACUUM INTO, nigdy samo cp pliku aktywnej bazy WAL. Harmonogram raz dziennie, retencja 7 dziennych + 4 tygodniowe, domyślny katalog chroniony na serwerze. Kopia przed każdą migracją. Waliduj PRAGMA integrity_check i wykonaj pełne odtworzenie w izolowanej bazie; sprawdź wpisy wspólne/prywatne i sessions policy po odtworzeniu.
Archiwum i klucze/konfiguracja VAPID muszą mieć opisaną procedurę zabezpieczenia i odtworzenia. Snapshot na tym samym dysku nie zabezpiecza przed awarią dysku; dostarcz opcję eksportu zaszyfrowanego archiwum poza serwer, bez samowolnego wysyłania danych do usług.
Udokumentuj RPO do 24 h dla zsynchronizowanych danych i fakt, że niewysłany outbox telefonu nie jest w backupie serwera. Eksport użytkownika zawiera jego private i shared, nigdy private partnera.
Referencja: https://www.sqlite.org/backup.html

## Zakończenie
Dodaj prawdziwy wpis Deployment dopiero po weryfikacji działającego adresu. Zapisz wersję/commit, katalog, nazwy usług, adres, backup, porty i komendy stop/restore w ToDo. Nie publikuj sekretów. Zachowaj produkcję; usuwaj tylko własne tymczasowe zasoby testowe.


## Dostarczone w RAZ-13

CLI `backup|backup-encrypt|restore`, kontrola integralności/FK, retencja, szablony
systemd i izolowany restore ze snapshotów migracji: [backup.md](backup.md).
Restore odwołuje wszystkie sesje i subskrypcje push, rotuje cursor key i nie
nadpisuje istniejącego katalogu. Kompletna konfiguracja (w tym VAPID) jest dołączana
przez jawny `--config-file`; lokalny backup bez tego pliku nie zabezpiecza sekretów
poza SQLite. RPO 24 h dotyczy zsynchronizowanych danych przy działającym timerze;
nie obejmuje pending/konfliktów telefonów. Timer dostarczony, nie zainstalowany.
