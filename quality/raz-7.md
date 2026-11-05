# RAZ-7 — zakupy i listy wspólne lub prywatne

Adam, Senior Developer. Gałąź `agent/raz-7`, bez scalenia i wdrożenia.
Implementacja: `00dbd7e`; e2e i opis zachowania: `33c8a28`;
ochrona formularzy podczas startu bazy: `472118e`.

## Zmiana

Istniejący CRUD list i pozycji korzysta z AppServices → command → Dexie/outbox → sync.
RAZ-7 uzupełnia szybkie dodawanie w miejscu (Enter/przycisk, zachowany fokus i tekst
przy błędzie), deterministyczne rozstrzyganie remisu sortKey przez UUID i kosz pojedynczych
pozycji z przywracaniem offline. Widoki/komendy pozycji sprawdzają aktywną listę właściwego
typu. Usunięcie listy zachowuje dzieci do jej przywrócenia lub retencji serwera.
Poprawiono wysyłkę starej kolejki, w której create dziecka poprzedza create rodzica.
Nie zmieniono protokołu v1 ani schematu Dexie v2; nie ma alternatywnego CRUD.
Podczas zimnego startu ekrany czekają na otwarcie bazy konta, zanim udostępnią
formularze. Zapobiega to wpisywaniu w formularz, który zostałby ponownie zamontowany
przy zakończeniu inicjalizacji i utraciłby tekst.

Opis: [architecture/shopping.md](../architecture/shopping.md),
[design/interface.md](../design/interface.md).

## Dowody automatyczne

Narzędzia: przypięty Node 26.13.0 / npm 11.20.0; Chromium i WebKit Playwright 1.64.1.
Narzędzia pobrano do własnego `/tmp/raz-7-tools`, bez zmiany konfiguracji hosta.

- `npm run typecheck`: PASS.
- `npm test`: **175 PASS**, 19 plików. Obejmuje istniejące testy kontraktów,
  uprawnień/SQLite/migracji, auth, sync/konfliktów, izolacji kont i PWA oraz nowe testy:
  - `apps/web/src/offline/shopping.test.ts`: rzeczywisty Fastify/SQLite z dwoma kontami
    i Dexie/fake-indexeddb; offline CRUD, checkbox/Cofnij, kosz pozycji i listy,
    blokowanie dziecka pod usuniętą lub niewłaściwego typu listą, restart i trwała kolejka,
    utrata odpowiedzi i jeden efekt, widok partnera, negatywne ACL i listId,
    niezależne edycje i rozwiązanie konfliktu tej samej pozycji.
    Migracja v1→v2 zachowuje treść pozycji, sortKey, powiązanie, deviceId/clientMutationId;
    dziecko z wcześniejszym UUID i równym queuedAt czeka na utworzenie rodzica.
  - `apps/web/src/screens/records.test.tsx`: szybki zapis, walidacja, błąd quota z zachowaniem
    tekstu, czyszczenie po sukcesie i fokus; remis sortKey przy odwrotnym porządku odczytu.
  - `apps/web/src/offline/ui.test.tsx`: formularz zakupów jest niedostępny przed otwarciem
    bazy podczas startu offline, a wpisana po otwarciu nazwa pozostaje podczas refresh i zapisuje się.
- `npm run build`: PASS wszystkich workspace; istniejące ostrzeżenie Vite o JS >500 kB.
- `docker compose -f deploy/compose.yaml config --quiet`: PASS; bez uruchamiania kontenerów.
- `tests/e2e/shopping.spec.ts`: scenariusze na rzeczywistym buildzie PWA i tymczasowej
  SQLite, syntetyczne konta i treści; Chromium oraz WebKit:
  1. Offline utworzenie wspólnej listy i pozycji, polskie znaki, ilości „2 opakowania”
     i „3 opakowania”, uwaga, szybki Enter, poprawianie, odhaczenie, Cofnij i kolejność,
     usunięcie/przywrócenie pozycji, zmiana nazwy listy, prywatna lista z dzieckiem.
     Zamknięcie całego procesu przeglądarki i uruchomienie trwałego profilu przy wyłączonej
     sieci: zawartość i ID całej kolejki zachowane. Powrót online opróżnia kolejkę,
     a konto partnera widzi wspólne zakupy. Private niedostępne przez listę, guessed URL,
     podmieniony parent w URL, pull, push update/delete/restore i kosz.
  2. A/B offline edytują różne pozycje: zmiany się łączą. Potem sprzeczne ilości tej samej
     pozycji pokazują obie wersje; wybór mojej trafia do partnera bez duplikatów.
  Oba scenariusze przeszły w obu silnikach w przebiegach celowanych.

Końcowy pełny `npm run test:e2e -- --workers=4`: **53 PASS, 1 SKIP**, 2,1 min.
Pominięty wyłącznie istniejący test safe-area przez CDP w WebKit (brak CDP w tym silniku).
Przeszły oba nowe scenariusze zakupów w Chromium i WebKit oraz starszy test aktualizacji
PWA z zachowaniem formularza. Układ, nazwy kontrolek i cele ≥44 px sprawdzono także
na ekranie zakupów przy 375/390/430/1280 px i tekście 200%.

Pierwszy przebieg e2e niezaliczony: test żądał synchronicznego stanu checkboxa metodą
`check()`, chociaż UI czeka na transakcję. Zmieniono na kliknięcie i oczekiwanie widocznego
efektu; dodano jawne oczekiwanie końca zapisu listy. Nie zaliczono nieudanej próby.
Pierwszy pełny przebieg: 49 PASS, 2 FAIL, 1 SKIP i 2 niewykonane. Zakupy w Chromium
wymagały oczekiwania końca usuwania przed pełną nawigacją do kosza (bez przerywania
transakcji); starszy test PWA w WebKit wykrył opisany wyścig inicjalizacji i utratę
wpisanej nazwy. Naprawiono przyczynę w kodzie oraz dodano regresję, bez pomijania testu.

## Granice odbioru

Nie testowano fizycznego iPhone'a, Safari/PWA na urządzeniu, rzeczywistej klawiatury iOS,
VoiceOver ani HTTPS na serwerze właściciela. WebKit jest automatyczną kontrolą, nie dowodem
odbioru fizycznego. Te próby należą do końcowego odbioru po wdrożeniu (quality/acceptance.md).
Nie dodano skanera, katalogu produktów ani płatnych integracji.

## Sprzątanie i przekazanie

Wszystkie własne serwery testowe zatrzymano. Kontrola `ss` po e2e potwierdziła brak
nasłuchu na 4317, 4318, 4319, 4320 i 4321. Brak katalogów profili
`razem-shopping-profile-*`, `razem-pwa-profile-*`, baz `razem-e2e-*` i `razem-client-*`
w `/tmp`. Usunięto własne pobrane narzędzia `/tmp/raz-7-tools` oraz `test-results/`.
Nie tworzono kontenerów/sieci ani nie zmieniano trwałych danych; nie pozostawiono podglądu.
Wyniki i odnośniki commitów/PR są również w notatce przekazania zadania RAZ-7.
