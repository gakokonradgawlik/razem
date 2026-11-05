# RAZ-6 — PWA, offline i aktualizacje

Gałąź `agent/raz-6`. Implementacja początkowa: `304b7f4`; dalsze testy i poprawki
w kolejnych commitach tej gałęzi / PR powiązanym z RAZ-6. Bez scalenia i wdrożenia.

## Działanie

- Manifest `/manifest.webmanifest`: id/scope/start_url `/`, standalone, polska nazwa,
  theme/background color. Lokalny znak dwóch połączonych kształtów: istniejący `icon.svg`
  oraz pochodne PNG 180 (apple-touch), 192, 512 i maskable 512 z marginesem bezpieczeństwa.
  Odtwarzanie PNG: `python3 scripts/generate-icons.py` (narzędzie deweloperskie, Pillow).
- `scripts/build-pwa.mjs` po Vite generuje `/sw.js`: SHA256 zawartości plików i szablonu
  tworzy nazwę `razem-shell-<wersja>`. Cały shell, JS/CSS i zasoby lokalne są pobierane
  atomowym `cache.addAll`, bez cookies. Brak pliku, sieci albo miejsca odrzuca instalację,
  usuwa cache nieudanej wersji i zachowuje działającą poprzednią.
- Tylko jawna lista plików tego buildu trafia do Cache API. Nawigacje SPA korzystają z jego
  `index.html`, również online: otwarte karty nie mieszają nowego HTML ze starym JS/CSS.
  Nawigacje do plików statycznych dostają właściwy plik, brakujący plik nie udaje HTML.
  `/api`, `/api/*`, `/healthz`, `/readyz`, inne originy i żądania inne niż GET nie są
  przechwytywane. Nie ma runtime cache prywatnych odpowiedzi ani historii odwiedzonych tras.
  Nagłówek `Cache-Control: no-store` serwera pozostaje również dla API i `/sw.js`.
- Brak `skipWaiting`, `clients.claim` i programowego reload. Aktualizacja czeka na zamknięcie
  wszystkich klientów starej wersji. Komunikat prosi o dokończenie i **zapisanie** formularzy
  przed zamknięciem. Sam niezapisany formularz nie przetrwa świadomego zamknięcia.
  Zapisany outbox i konflikty zostają, nawet gdy nadal nie ma możliwości wysłania.
  Aktywacja usuwa wyłącznie stare cache `razem-shell-*`; nie dotyka IndexedDB ani localStorage.
  Rejestracja sprawdza aktualizacje również po focus/visibility/online; błąd offline jest oczekiwany.
- Ekran instalacji podaje kroki Safari → Udostępnij → Do ekranu początkowego, rozpoznaje
  display-mode standalone i iOS navigator.standalone, pokazuje gotowość shellu offline.
  Pierwsze logowanie, bootstrap i pobranie aplikacji wymagają połączenia. Po instalacji należy
  jeszcze uruchomić ikoną online i poczekać na gotowość oraz „Zsynchronizowano”.
  SW działa w produkcyjnym buildzie pod HTTPS (lub localhost w testach), nie na serwerze dev.
- Wynik prośby o trwały magazyn jest widoczny: przyznany, odmowa, brak wsparcia, błąd.
  Odmowa nie blokuje aplikacji. UI wyjaśnia utratę niewysłanych zmian przy wyczyszczeniu
  danych i kieruje do synchronizacji/eksportu. Ochrona magazynu nie jest backupem.
  Zachowano safe areas, dynamiczny viewport, zoom i obsługę klawiatury z RAZ-3.

## Kontrakty i migracje

RAZ-6 nie podnosi schematu IndexedDB v2 ani protokołu sync v1. Baza nadal jest oddzielona
per gospodarstwo/konto. Migracja v1→v2 z RAZ-5 działa transakcyjnie i zachowuje outbox,
`deviceId`, `clientMutationId`, attempts oraz treść. Test jest wykonywany również w obu
prawdziwych przeglądarkach, offline, po czym kolejka trafia raz na prawdziwy serwer.
Wylogowanie usuwa bazę i tożsamość konta; cache publicznego shellu może zostać.

Kolejne wydania muszą zachować kontrakt dla nadal aktywnych starszych klientów. Nowe migracje
Dexie dopisujemy, nie zmieniamy zastosowanych wersji i nie kasujemy bazy przy błędzie.
Błąd migracji ma wycofać transakcję, pokazać niedostępność magazynu i zachować dane do odzyskania.
Nie wolno robić rollbacku przez usunięcie IndexedDB lub wymuszony downgrade schematu;
trzeba wydać poprawkę obsługującą istniejącą wersję i pending. Cache nie zastępuje migracji danych.
Podczas przyszłego wdrożenia publikować kompletny, spójny build, w tym `sw.js` z tego samego
artefaktu; samo kopiowanie części plików nie jest bezpiecznym procesem publikacji.

## Dowody automatyczne

Środowisko: Node 26.13.0 / npm 11.20.0, Playwright 1.64.1, Chromium 156 / WebKit 27.2.
Wszystkie konta i treści syntetyczne; brak danych domowników i sekretów.

- `npm run typecheck`, `npm run build`: PASS. Vite zgłasza znane ostrzeżenie rozmiaru bundle.
- `npm ci`: PASS; `docker compose -f deploy/compose.yaml config --quiet`: PASS.
- `npm test`: 18 plików, 168 testów PASS, w tym nowa regresja persist
  (przyznanie, już przyznany, odmowa, brak API, odrzucone żądanie).
- `tests/e2e/pwa.spec.ts`: 5 scenariuszy × Chromium/WebKit = 10 PASS na buildzie produkcyjnym
  z prawdziwym serwerem Fastify, SQLite, IndexedDB i Service Workerem:
  1. Manifest, lokalność i rzeczywiste rozmiary PNG, instrukcja iPhone i detekcja standalone
     (flaga iOS symulowana; instalacji systemowej nie emuluje).
  2. Online bootstrap → brak sieci → zapis prywatny → zamknięcie **całej przeglądarki** →
     restart trwałego profilu bez sieci przed pierwszym żądaniem. Pięć tras i deep link szczegółów,
     dane oraz te same ID kolejki zachowane; po powrocie API kolejka potwierdzona.
  3. Dwa różne artefakty A/B (inne nazwy JS/CSS i znacznik wykonanej wersji). Niekompletny B
     jest odrzucony; formularz i pending A pozostają. Poprawny B czeka podczas edycji oraz
     po zamknięciu tylko jednej z dwóch kart. Nowe nawigacje mają A; po zamknięciu obu działa B,
     oba zapisane wpisy nadal w outbox, stary cache usunięty, kolejny start B offline działa.
     Awaria API jest rzeczywistym 503 serwera testowego; nie polega na mocku route WebKit.
  4. Zapis prywatny, sync, wylogowanie (usunięta baza A), konto B, cold navigation offline:
     treść A nieobecna w UI i bazie B. API offline nie dostaje odpowiedzi z cache.
     Cache zawiera wyłącznie pliki shellu, bez odpowiedzi API i tras rekordów.
  5. Utworzenie prawdziwej IndexedDB v1 z oczekującym wpisem, upgrade bez sieci do v2:
     treść, deviceId, clientMutationId i attempts zachowane; restart i jeden rekord po ACK.

`npm run test:e2e -- --workers=4`: **49 PASS, 1 SKIP** (safe-area przez CDP dostępne tylko
w Chromium; pozostałe testy działają też w WebKit). Końcowy przebieg po poprawkach: 1,9 min.
Serwery testowe zakończyły pracę; porty 4317–4321 są wolne. Usunięto własne profile,
bazy tymczasowe, raporty i pobrane narzędzia z `/tmp/raz-6-tools`; nie tworzono kontenerów
ani sieci. Wyniki i SHA są również w notatce przekazania RAZ-6 i PR.
Wcześniejsze nieudane próby: npm ci wymagało brakującego toolchainu hosta; zależności
zainstalowano ponownie. Pierwszy test aktualizacji WebKit nie odcinał API przez route mock,
więc prawidłowy ACK opróżniał kolejkę; poprawiono środowisko testu na realną awarię serwera.
Żadnej z tych prób nie zgłoszono jako PASS.

## Fizyczny iPhone — NIEWYKONANE

Automatyczny WebKit nie zastępuje Safari ani zainstalowanej PWA na urządzeniu. Po wdrożeniu
przez HTTPS z zaufanym certyfikatem wykonać na obu iPhone'ach (jako jedną listę odbioru):

1. Safari → instalacja, ikona/nazwa, standalone; uruchomienie ikoną online, logowanie i bootstrap.
2. Safe areas (pion/poziom), klawiatura formularzy, zoom/duży tekst, VoiceOver i oba motywy.
3. Tryb samolotowy, zamknięcie PWA, ponowne otwarcie różnych tras, zapis/edycja,
   zamknięcie i restart; powrót sieci, kolejka opróżnia się, dane na drugim telefonie.
4. Nowa wersja podczas edycji i pending: brak samoczynnego reload; zapisz formularz,
   zamknij wszystkie okna, otwórz ponownie, sprawdź treść i wysłanie kolejki.
5. Odmowa/ograniczenia magazynu, eksport pending; wylogowanie i brak danych A po wejściu B.

Brak fizycznych telefonów nie blokuje RAZ-6. Lista czeka na gotowe wdrożenie zgodnie
z docs/START.md i quality/acceptance.md. Nie wdrożono aplikacji i nie testowano realnego HTTPS,
instalacji systemowej ani push na urządzeniu.

Źródła zachowania przeglądarki:
[cykl Service Workera](https://web.dev/articles/service-worker-lifecycle),
[StorageManager.persist](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist).
