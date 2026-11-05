# Eksport, backup i odtwarzanie — RAZ-13

## Trzy różne pliki

| Operacja | Zawartość | Połączenie | Zastosowanie |
| --- | --- | --- | --- |
| Ustawienia → Eksport wszystkich moich i wspólnych danych | JSON konta, ustawienia, wszystkie 8 typów własnych private i shared, także kosz | Serwer i ważna sesja | Czytelny eksport użytkownika, bez private partnera, haseł, sesji i kluczy push |
| Ustawienia → Eksport niewysłanych zmian | JSON v2 jednego konta/urządzenia: uporządkowane intencje, create/patch/delete/restore, wersje bazowe, ID mutacji/urządzenia, lokalny stan i pełne konflikty | Działa offline | Ochrona zmian istniejących tylko na telefonie; pobranie nie opróżnia kolejki |
| CLI administratora | Pełna SQLite instalacji i opcjonalnie jawnie wskazana kompletna konfiguracja | Lokalny dostęp do serwera | Disaster recovery: obejmuje oba konta, hashe haseł, ACL, journal, receipts, sesje, subskrypcje i kolejki serwera |

Eksport konta jest stanem **serwera**, nie bieżącym widokiem telefonu. Niewysłany
outbox i konflikty każdego telefonu wymagają osobnego eksportu lokalnego.
Żaden z JSON-ów użytkownika nie jest automatycznie importowany. Zachowują dane
oraz intencję do ręcznego odzyskania, nie służą do odtwarzania całej instalacji.
Pliki zawierają prywatne treści: przechowuj je w chronionym miejscu i usuń po użyciu.
Eksport konta używa jednej transakcji odczytu i tej samej polityki ACL co sync.
Nagłówek `x-razem-account` wiąże odpowiedź z kontem; klient odrzuca opóźnioną
odpowiedź po zmianie konta. Lokalny eksport jest jedną transakcją IndexedDB.

## Lokalna kopia instalacji

Po `npm run build`, na wymaganym Node 26.13.0, jako ten sam użytkownik co aplikacja:

```sh
npm run admin -- backup --directory /data/backups --config-file /data/installation.env
```

Ścieżki są przykładem **wewnątrz kontenera**. W istniejącym Compose polecenie:

```sh
docker compose -f deploy/compose.yaml exec -T app node apps/server/dist/admin.js backup --config-file /data/installation.env
```

Bez `--directory` używany jest `backups` obok `DATABASE_PATH`. Bez `--config-file`
kopia zawiera całą bazę, ale **nie zawiera zewnętrznych sekretów/konfiguracji**.
Przed uruchomieniem pełnego harmonogramu administrator przygotowuje
`/data/installation.env`: kompletną aktualną konfigurację wdrożenia, również
prywatny/publiczny VAPID i subject, jeżeli push jest włączony. Plik ma właściciela
procesu aplikacji i tryb 0600. Nie wypisuj go na terminal, do logów ani do Git.
To nie jest automatyczne zebranie env procesu ani plik `.env.example`.
Wdrożenie musi aktualizować tę kopię konfiguracji przy każdej zmianie sekretów.
Konfiguracja proxy/Compose/systemd i zgodny commit/obraz muszą być zachowane
osobno w pakiecie wdrożenia; manifest zawiera wersję schematu, nie obraz Dockera.

Backup otwiera wyłącznie istniejącą bazę, sprawdza aktualny schemat i **nie migruje**.
`VACUUM INTO` rezerwuje nowy plik 0600 i uwzględnia zatwierdzone zapisy WAL podczas
pracy aplikacji; nigdy nie kopiujemy aktywnego `razem.sqlite` przez `cp`.
Po utworzeniu: `PRAGMA integrity_check`, `foreign_key_check`, historia/checksumy
migracji, identyfikator gospodarstwa i SHA-256 plików. Pliki i katalog są fsyncowane.
Każdy katalog archiwum ma unikalny UUID oraz manifest wersji 1. Kopie są lokalne,
bez połączeń z chmurą. Ich katalog ma tryb 0700, pliki 0600, właściciela procesu;
symlinki, obcy właściciel i dostęp grupy/innych są odrzucane, bez automatycznego chmod.

Jedno uruchomienie tworzy kopię dzienną i tygodniową z tej samej zamrożonej bazy.
Retencja zachowuje najnowszą kopię z każdego z ostatnich **7 różnych dni UTC**
oraz **4 różnych tygodni UTC (poniedziałek–niedziela)**. Kolejne kopie tego samego
okresu zastępują poprzednie dopiero po pozytywnej walidacji nowych archiwów.
Retencja dotyczy tylko rozpoznanych katalogów `razem-<householdId>-…`, zgodnego
manifestu, nazwy i pełnej integralności danego gospodarstwa. Nie usuwa obcych
plików, symlinków, obcych gospodarstw, niekompletnych/uszkodzonych kopii ani
snapshotów przed migracją. Takie pliki wymagają osobnej oceny administratora;
brak miejsca jest błędem backupu, nie pretekstem do globalnego czyszczenia.
Nie ma trybu nadpisania istniejącej instalacji ani opcji `--force`.

## Harmonogram i RPO

Gotowe jednostki: `deploy/systemd/razem-backup.service` i `razem-backup.timer`.
Timer uruchamia kopię codziennie o **02:00 UTC**, z `Persistent=true` (nadrabia
po starcie hosta), bez losowego opóźnienia. Usługa jest oneshot, więc systemd nie
uruchamia drugiego egzemplarza tej samej usługi podczas trwającego backupu.
Podczas autoryzowanego wdrożenia administrator ustawia rzeczywisty WorkingDirectory
(zamiast przykładowego `/opt/razem`), sprawdza ścieżkę Dockera, uprawnienia i plik
konfiguracji; kopiuje jednostki, wykonuje `systemctl daemon-reload` i włącza timer.
**W RAZ-13 nie instalowano ani nie uruchamiano tych jednostek na serwerze.**

```sh
systemctl enable --now razem-backup.timer
systemctl start razem-backup.service
systemctl status razem-backup.service
systemctl list-timers razem-backup.timer
journalctl -u razem-backup.service
```

Cel RPO: do 24 h dla danych zsynchronizowanych przy działającym harmonogramie.
Awaria/wyłączenie hosta lub błąd zadania oznacza przekroczenie tego celu.
Kontroluj datę ostatniej **sprawdzonej** kopii i niezerowy exit usługi, wolne miejsce
oraz odtwarzaj próbnie po zmianie schematu i okresowo (zalecane co miesiąc).
Kopia na tym samym dysku nie chroni przed utratą dysku: regularnie przenoś
zaszyfrowane archiwum na inny nośnik. Częstotliwość takiego przenoszenia wyznacza
RPO przy utracie całego serwera/nośnika. Sam timer lokalny nie gwarantuje offsite RPO.

## Zaszyfrowane archiwum poza serwerem

Przygotuj silne losowe hasło w pliku 0600 w katalogu 0700, należącym do użytkownika
CLI. Plik ma 16–4096 bajtów; używamy **dokładnych bajtów**, także końcowego newline.
Nie przekazuj hasła w argumencie ani zmiennej środowiskowej. Przechowuj kopię hasła
na osobnym nośniku/w menedżerze haseł, oddzielnie od archiwum. Utrata hasła oznacza
brak możliwości odtworzenia. Nie zapisuj jedynej kopii hasła w archiwum.

```sh
npm run admin -- backup-encrypt --archive /data/backups/razem-… --output /data/export/razem-offsite.razem --password-file /data/secrets/backup-password
```

Wyjście musi być nowym plikiem w istniejącym chronionym katalogu. Format `RAZEMB01`:
losowa sól 16 B, nonce 12 B, scrypt N=32768/r=8/p=1, klucz 32 B,
gzip + AES-256-GCM, nagłówek jako AAD, tag 16 B. Strumień zawiera manifest,
SQLite i dołączoną konfigurację; nie ma jawnej kopii roboczej przy szyfrowaniu.
Limit rozpakowanej zawartości to 4 GiB; przetwarzanie jest strumieniowe.
Zmieniony nagłówek/plik lub złe hasło blokują odtwarzanie. Plik wyjściowy ma 0600.
Przenieś go samodzielnie poza serwer i przeprowadź próbne odtworzenie z tej kopii;
program niczego nie wysyła. Po zweryfikowanym przeniesieniu usuń tymczasowy plik
przenośny z serwera, zachowując archiwa objęte retencją.

## Restore do czystego celu

Przed awaryjnym przełączeniem zatrzymaj zapisy app **i workera**, zachowaj aktualną
bazę i nowo zsynchronizowane dane do osobnego odzyskania. Wyeksportuj pending i
konflikty z **obu telefonów**. Odtwarzanie starszej kopii cofa zmiany po jej dacie;
nie jest bezstratnym downgrade. Nie otwieraj odtworzonej kopii jako drugiej aktywnej
instalacji wysyłającej push. Testuj ją offline/bez wychodzącego push.

CLI nie zatrzymuje usług i niczego nie podmienia; tworzy wyłącznie **nowy katalog**
w istniejącym chronionym katalogu rodzica (0700). Istniejący cel, nawet pusty,
symlink lub cudza instalacja powoduje odmowę. Przykłady na hoście z właściwym Node:

```sh
npm run admin -- restore --archive /secure/backups/razem-… --target /secure/recovery-test
npm run admin -- restore --encrypted /secure/offsite.razem --password-file /secure/password --target /secure/recovery-test-2
npm run admin -- restore --snapshot /secure/razem.sqlite.pre-migration-v1-….bak --target /secure/rollback-v1 --config-file /secure/installation-v1.env
```

Wynik: `razem.sqlite`, opcjonalny `configuration.env`, `restore.json` bez sekretów.
Walidacja poprzedza publikację celu: format, hashe, integralność, FK, rozpoznana
historia migracji/checksumy i gospodarstwo. Nieznany nowszy schemat jest odrzucany;
znany starszy może być odtworzony, **restore nie uruchamia migracji**. Wersja schematu
jest zapisana w wyniku; do rollback użyj zgodnego obrazu. Pierwszy start nowszej
aplikacji przeprowadzi zwykłe migracje i nowy snapshot. Pliki robocze restore są
0700/0600 i usuwane po sukcesie/błędzie. Odłączenie zasilania/SIGKILL może pozostawić
`.razem-restore-*`/`.razem-snapshot-*` lub niekompletny nowy cel — po sprawdzeniu
administrator usuwa wyłącznie te pozostałości i ponawia z nową ścieżką.

Restore **odwołuje wszystkie sesje**, czyści limity logowania i usuwa subskrypcje
push (wymagane ponowne logowanie/włączenie na każdym urządzeniu), rotuje klucz
cursorów sync, zachowuje konta/hashe haseł/ACL oraz domain/journal/receipts/kolejki.
Nie czyści IndexedDB ani outbox telefonów. Stary cursor wymusza pełny resync;
niezgodne wersje lokalnych intencji mogą wymagać jawnego rozwiązania konfliktów.
Przed ponownym logowaniem zachowaj lokalny eksport; nie obiecuj automatycznego
połączenia zmian utraconych przez cofnięcie serwera. Cofnięcie kopii przywraca też
stare hasła — hasła zmienione po dacie kopii trzeba ustawić ponownie przez CLI.

VAPID i konfigurację odtwórz z `configuration.env` do przeznaczonego chronionego
pliku/secret store dopiero po kontroli originu, ścieżek i kompatybilności obrazu;
CLI nie wykonuje pliku env i nie uruchamia jego zawartości. Zachowaj 0600 i właściwego
użytkownika, nie drukuj sekretów. Restore sam nie ładuje konfiguracji do procesu.
Brak klucza VAPID wymaga wygenerowania nowej pary i ponownego włączenia push przez
oba konta; nie udawaj zachowania dawnych subskrypcji. Szczegóły mechanizmu push
należą do RAZ-12, nie zostały dodane w tym zadaniu.

Sprawdź `integrity_check`, wersję schematu, liczby/relacje wpisów, własne private i
shared konta A oraz brak dostępu do private B, odmowę starych sesji i ponowne
logowanie. Dopiero po tej próbie, w autoryzowanym zadaniu wdrożenia, administrator
przełącza zatrzymane usługi na sprawdzony nowy katalog. Nigdy nie używaj globalnego
prune ani kopiowania bazy na aktywny plik WAL.

Snapshot przed aktualizacją istniejącej bazy powstaje obok niej jako
`*.pre-migration-vN-<czas>.bak`, z integrity/FK check i 0600 jeszcze przed SQL migracji.
Historia SQL i checksumy nie zostały zmienione. Snapshot nie zawiera plików
konfiguracji; zabezpiecz wersję konfiguracji/kluczy i zgodny obraz przed aktualizacją.

## Podstawa techniczna

- [SQLite Online Backup API](https://www.sqlite.org/backup.html) i
  [VACUUM INTO](https://www.sqlite.org/lang_vacuum.html): spójna kopia aktywnej bazy WAL.
- [Node crypto: scrypt i AES-GCM](https://nodejs.org/docs/latest-v26.x/api/crypto.html).
- Dowody syntetycznych testów i granice: [quality/raz-13.md](../quality/raz-13.md).
