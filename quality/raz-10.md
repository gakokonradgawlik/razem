# RAZ-10 — notatki prywatne i wspólne z wyszukiwaniem

Adam, Senior Developer. Gałąź `agent/raz-10`, implementacja `90fe119`, e2e i restart konfliktu `4eca188`.
Bez scalenia do main i bez wdrożenia. Kontrakt i granice:
[architecture/notes.md](../architecture/notes.md).

## Zmiana

- Istniejąca lista, edytor plain text, wyszukiwanie tytułu/treści, usuwanie i kosz
  działają na rzeczywistym LocalStore. Nowa notatka domyślnie prywatna, Wspólne
  do wyboru przed utworzeniem; potem widoczność stała.
- Dodano potwierdzenie wspólnej kopii z pełnym tekstem i wyjaśnieniem zakresu.
  Kopia ma nowy UUID, oryginał pozostaje prywatny; obie notatki są niezależne.
  Transakcja rekord+outbox, identyczny copyId nie tworzy drugiej mutacji,
  utrata odpowiedzi po commit jest obsługiwana przez istniejące receipts.
  Wspólna mutacja nie zawiera prywatnego sourceId.
- Otwarte formularze nie gubią tekstu po błędach odczytu lub zniknięciu wpisu.
  Nowszy tekst pobrany w trakcie edycji wymaga porównania i ręcznego połączenia,
  a atomowe expectedData blokuje zapis oparty na starej treści. Konflikty
  zapisanych edycji korzystają z istniejącego ekranu ręcznego scalania.
- Brak nowego protokołu, schematu lub zależności. Aktualne sync v2, SQLite v4,
  Dexie v2. Zmiany konta nadal usuwają formularz i blokują stare callbacki.

## Weryfikacja — 05.11.2026

Oficjalny Node 26.13.0 pobrany do własnego `/tmp/raz-10-runtime`, archiwum
zweryfikowane względem SHASUMS256. Tylko syntetyczne dane i konta.

| Kontrola | Wynik |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | 214 PASS, 24 pliki |
| `npm run test:e2e -- --workers=2` | 63 PASS, 1 SKIP, 3,1 min; 4/4 nowe scenariusze notatek PASS |
| `npm run build` | PASS, wszystkie workspaces; istniejące ostrzeżenie bundle >500 kB |
| `docker compose -f deploy/compose.yaml config --quiet` | PASS |
| `git diff --check` | PASS |

Dowody w plikach:

- `apps/web/src/offline/notes.test.ts` (5 testów): realny Fastify/SQLite + Dexie,
  Unicode/emoji, CRUD/kosz/restore offline, restart, niezależna kopia, utrata ACK,
  idempotencja (także współbieżne wywołania), rollback po quota, odrzucanie złego
  UUID/zakresu/payloadu i cudzej notatki, stare callbacki po zmianie konta.
  ACL guessed-ID update/delete/restore bez stanu/wersji, zakaz zmiany visibility,
  snapshot z limit=1, kosz, lokalny odczyt i eksport partnera bez prywatnego tekstu
  oraz identyfikatorów. Konflikt przeżywa restart; quota podczas scalania wycofuje
  rozwiązanie, następna zmiana na serwerze ponownie konfliktuje scalony tekst.
  Upgrade v1→v2 zachowuje prywatny tekst Unicode i deviceId/clientMutationId;
  powtórzenie po utracie ACK tworzy jedną notatkę.
- `apps/web/src/screens/records.test.tsx`: domyślny zakres i świadomy wybór Wspólne,
  lokalne wyszukiwanie bez diakrytyków, wymagane potwierdzenie kopii i Anuluj bez
  zapisu, stały snapshot/ID na retry, zachowanie tekstu po storage_full,
  storage_unavailable, błędzie sieci i konflikcie; zniknięcie wpisu podczas edycji.
- `apps/web/src/offline/ui.test.tsx`: rzeczywisty port aplikacji, oba teksty
  w konflikcie i scalanie, quota z zachowaniem formularza, zmiana konta/listy/
  szczegółów bez przecieku; nowa regresja pull podczas otwartego edytora blokuje
  stary zapis, zachowuje szkic i zapisuje ręcznie połączoną treść.
- `tests/e2e/notes.spec.ts`: Chromium i mobilny WebKit. Pełny restart procesu
  przeglądarki z trwałym profilem przy odciętej sieci, zachowane ID kolejki/tekst,
  lokalne szukanie polskich znaków/emoji, prywatne/wspólne notatki, kopia z
  potwierdzeniem i podwójnym kliknięciem, kosz/restore przed i po restarcie,
  utrata odpowiedzi po rzeczywistym commit i późniejszy sync, partner nie widzi
  prywatnych oryginałów pod guessed URL, w wyszukiwaniu/pull ani eksporcie pliku.
  Obie wersje konfliktu, ręczne scalanie i wynik na obu kontach; tekst zawierający
  img/b pozostaje plain text w szczegółach i porównaniu, brak poziomego scrolla.

Pierwsze niezaliczone próby: systemowy Node 22 nie ma crypto.argon2 (5 testów
nie uruchomiło setupu); środowisko poprawiono na przypięty Node. Pierwsza asercja
ACL nie uwzględniała kontraktowego pola retryable; poprawiono test. Pierwszy
przebieg e2e notatek: 3 PASS, 1 FAIL — szerokie wyszukiwanie w WebKit znajdowało
też prywatną notatkę tego samego konta utworzoną wcześniej przez Chromium.
Zapytanie zawężono unikalnym znacznikiem, zachowując sprawdzenie braku diakrytyków.
Pierwszy pełny przebieg: 62 PASS, 1 FAIL, 1 SKIP — wstrzykiwanie awarii przez
Playwright route nie przechwyciło żądania strony WebKit kontrolowanej przez SW.
Test używa teraz wrappera fetch, który odrzuca dokładnie jedną poprawną odpowiedź
po rzeczywistym commit serwera i zapisuje marker między nawigacjami.
Nie zaliczano tych prób jako dowodu spełnienia kryteriów.

## Granice odbioru

Nie testowano fizycznego iPhone'a, VoiceOver ani instalacji właściciela.
WebKit nie jest ich zamiennikiem; nie wykonywano wdrożenia ani wysyłki push.
Niezapisany szkic nie przetrwa zamknięcia aplikacji; trwałość obejmuje zatwierdzony
zapis lokalny i outbox. Lokalny eksport obejmuje niewysłane zmiany/konflikty;
pełny eksport serwera pozostaje niedostępny (404), co również sprawdzono jako
negatywny test prywatności. Nie dodawano eksportu poza zakresem RAZ-10.

Pominięty test to istniejąca emulacja safe-area przez CDP w WebKit (brak CDP);
nie oznaczano go jako zaliczonego. Końcowy pełny przebieg nie ma błędów.

## Sprzątanie i przekazanie

Po zakończeniu testów potwierdzono wolne porty 4317, 4318, 4319, 4320 i 4321.
Serwery i przeglądarki zakończył Playwright; tymczasowe bazy/profile usunęły
skrypty teardown. Sprawdzono brak katalogów `razem-client-*`, `razem-e2e-sync-*`
i `razem-notes-profile-*`. Własne pozostałości pięciu nieudanych setupów na Node22
usunięto osobno po identyfikacji. Usunięto `/tmp/raz-10-runtime`,
`/tmp/raz-10-browsers`, `test-results/` i własne logi. Nie tworzono kontenerów
ani sieci, nie ruszano trwałych danych i cudzych zasobów. Brak podglądu do pozostawienia.

Dokumentacja zachowania: `architecture/notes.md`, uzupełnienia `architecture/sync.md`,
`design/interface.md` i README; kopie dokumentów zaktualizowane w ToDo.
Odbiór dotyczy implementacji i automatycznej weryfikacji, bez scalenia i wdrożenia.
