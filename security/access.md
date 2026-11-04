<!-- razem/security/access.md · updated 2026-10-28 by Codex -->
# Razem — konta, prywatność i bezpieczeństwo
## Dostęp
Jedno gospodarstwo, dokładnie dwa konta członków. Brak otwartej rejestracji. Interaktywny bootstrap CLI tworzy gospodarstwo i dwa konta z tymczasowymi hasłami przekazanymi stdin, wymuszając własne hasło przy pierwszym logowaniu online. Nie ma hasła domyślnego ani konta demo w produkcji. E-mail/login jest identyfikatorem, bez konieczności wysyłania poczty.
Hasła Argon2id ze współczesnymi zalecanymi parametrami dobranymi i zmierzonymi na serwerze; ratelimit logowania, ogólne komunikaty błędów. Reset i odzyskiwanie przez administratora lokalnym CLI, z unieważnieniem sesji. Zapisuj zdarzenie resetu, nigdy sekret.
Sesje losowe min. 256 bit, na serwerze hash tokenu. Cookie HttpOnly, Secure, SameSite=Strict, bez tokenów w localStorage/URL. Domyślnie rolling 30 dni, odnowienie aktywne najwyżej raz na dobę. Reauth po wygaśnięciu; outbox pozostaje lokalnie do poprawnego logowania.
CSRF/Origin/Fetch-Metadata dla mutacji, brak CORS wildcard, limity payloadu, walidacja schematów, kodowanie treści plain text, CSP bez niepotrzebnych zewnętrznych źródeł.

## Uprawnienia
Private: tylko owner_id == session.user.id. Shared: tylko ten sam household. Owner i household wyznacza serwer; klient nie może ich zmieniać. Private lista nadaje ten sam zakres wszystkim elementom. Prywatne zadanie może przypisać wyłącznie siebie.
Sprawdzaj to samo dla mutacji, pull, konfliktów, wyszukiwania, eksportu, kosza, restore, linków z powiadomień, worker queue i API subskrypcji. Próba zgadywania ID prywatnego wpisu zwraca odpowiedź bez ujawniania jego istnienia/treści. Powiadomienie partnera nigdy nie zawiera prywatnego tytułu, ID umożliwiającego odczyt ani fragmentu.
Prywatność jest ochroną w obrębie aplikacji, nie E2EE przed administratorem Ubuntu. Nie reklamuj szyfrowania end-to-end. Zmiana widoczności istniejącego rekordu jest niedozwolona; udostępnienie notatki to jawna kopia.

## Lokalny telefon
Offline udostępnia wcześniej pobrane dane osobie mającej dostęp do zalogowanej PWA/telefonu. Wygaszenie lub odwołanie sesji na serwerze nie potrafi wymazać telefonu bez połączenia. Po odpowiedzi o odwołaniu sesji zablokuj sync, zachowaj oczekujące zmiany do odzyskania przez tego samego użytkownika; nie przenoś ich na inne konto.
Wylogowanie ostrzega o niewysłanych zmianach: powrót do sync, eksport lub świadome ich porzucenie. Po ostatecznym wylogowaniu wyczyść dane konta/outbox/conflicts oraz sesję i subscription association. Cache shell może zostać. Eksport pending nie trafia do drugiego użytkownika.
Bez publicznego linku do danych i bez anonimowego trybu z prawdziwymi wpisami.

## Push, sekrety i logi
Subskrypcja per użytkownik i urządzenie; klucze VAPID poza Git, nie drukuj endpointów z kluczami w logach. Domyślny komunikat 'Masz przypomnienie w Razem', szczegóły dopiero po zalogowaniu; opcjonalnie użytkownik świadomie włącza tytuły własnych/wspólnych wpisów.
Transport HTTPS z certyfikatem zaufanym na obu iPhone'ach. Docker secrets/pliki z uprawnieniami 0600 lub środowisko chronione, .env.example same nazwy. Nie pobieraj sekretów ze zdalnych usług ani nie zmieniaj sieci w ramach samego przygotowania kodu.
Logi techniczne bez haseł, cookies, treści wpisów, payloadów sync i URL push. Backupy zawierają dane wrażliwe; chroń uprawnienia i szyfruj archiwum przenoszone poza serwer, klucz przechowuj oddzielnie.
Testy ACL negatywne dwoma kontami są warunkiem ukończenia modułów.


## Implementacja RAZ-2 (stan kodu)
- Konta: `npm run admin -- bootstrap` tworzy jedyne gospodarstwo i dwa konta z `must_change_password=1`. Baza wymusza triggerami jedno gospodarstwo, maks. dwóch członków, niezmienne przypisanie i brak usuwania kont. Brak trasy rejestracji; czysta instalacja nie ma kont.
- Polityka hasła (`passwordProblem` w kontraktach): 12–256 punktów kodowych Unicode po NFC (nie jednostek UTF-16), bez spacji na brzegach, min. 4 różne znaki, bez części lokalnej loginu (≥4 znaki); nowe ≠ obecne.
- HTTP login i oba pola zmiany hasła normalizują wejście do NFC przed sprawdzeniem limitu 256 punktów kodowych; CLI bootstrap/reset stosuje ten sam limit. Zasady siły hasła również sprawdzane są po NFC. Krótkie hasło przy logowaniu jest dopuszczone do weryfikacji, ale nowe hasło musi spełniać pełną politykę.
- Argon2id z wbudowanego `node:crypto` (Node 26), format PHC; domyślnie RFC 9106: 64 MiB, t=3, p=4 — zmierzone ~0,1 s na hoście deweloperskim (8 vCPU). Na serwerze zmierz `admin measure-argon2` i ewentualnie ustaw `ARGON2_*` (min. 19 MiB/t=2 wg OWASP). Hash z bazy z parametrami ponad limity jest odrzucany; zmiana parametrów → rehash przy logowaniu.
- Sesja: 32 bajty losowe (256 bit) base64url, w bazie SHA-256. Cookie `__Host-razem_session`, `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=30 dni`. Rolling 30 dni; najwyżej raz na dobę odnowienie z rotacją tokenu, poprzedni ważny 2 min (równoległe żądania). Wygasła sesja → 401 i czyszczenie cookie. Zmiana hasła odwołuje wszystkie sesje konta i wydaje nową bieżącemu urządzeniu; reset CLI odwołuje wszystkie.
- Wyścigi z Argon2id: login i zmiana hasła weryfikują hasło na migawce konta, a w transakcji zapisu (IMMEDIATE) sprawdzają ponownie, że hash konta jest wciąż ten sam, a przy zmianie hasła także że autoryzująca sesja istnieje i nie wygasła. Reset/zmiana/revoke/logout zatwierdzone w trakcie Argon2id → żądanie odrzucone bez zapisu i bez nowej sesji (login: `invalid_credentials`, zmiana hasła: 401 `authentication_required` z czyszczeniem cookie). Rehash przy logowaniu nie nadpisze nowszego hasła; zmiana hasha wyłącznie przez równoległy rehash → ponowna weryfikacja (maks. 3 próby). Reset CLI jest bezwarunkowy (administrator wygrywa).
- Hasło tymczasowe: dostęp tylko do `GET /api/me`, `POST /api/auth/password`, `POST /api/auth/logout`; reszta 403 `password_change_required`.
- Limity: 5 błędów na login w 15 min → blokada konta 15 min (także dla poprawnego hasła), 20 błędów z IP → blokada IP. Klucze w `auth_throttle` to SHA-256, bez wpisanego tekstu. Nieznany login kosztuje tyle samo Argon2id (atrapa). Jeden ogólny błąd `invalid_credentials`; 429 z `Retry-After`.
- CSRF: dla metod innych niż GET/HEAD/OPTIONS pod `/api` wymagany `Origin` równy `PUBLIC_ORIGIN` (albo, gdy brak, originowi żądania z nagłówka Host), `Sec-Fetch-Site` jeśli obecny = `same-origin`, treść tylko `application/json` (inaczej 415). Brak nagłówków CORS. Limity treści: 256 KiB ogólnie, 4 KiB auth.
- Za reverse proxy ustaw `PUBLIC_ORIGIN=https://…` i `TRUST_PROXY=<adres proxy>` (IP do limitów). `COOKIE_SECURE=false` jest dozwolone tylko poza produkcją.
- Zdarzenia `auth_events`: rodzaj i czas (bootstrap, login, logout, password_changed, password_reset, sessions_revoked, login_locked), bez haseł, tokenów i IP. Logger Fastify wyłączony; serwer i CLI wypisują stałe komunikaty.
- Uprawnienia rekordów: `accessPolicy` + `RecordRepository` w `@razem/db` — jedyna ścieżka odczytu/zapisu domeny. Owner/household z sesji; dane i patch są strict (owner/household/visibility/version odrzucane); dziecko (element zakupów, wystąpienie zadania, przypomnienie) dziedziczy household/visibility rodzica, prywatne także ownera; rodzic niezmienny. Brak dostępu = `not_found` jak dla braku rekordu. Baza dodatkowo wymusza to kluczami złożonymi i triggerami.
