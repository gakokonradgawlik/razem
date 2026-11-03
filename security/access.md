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

