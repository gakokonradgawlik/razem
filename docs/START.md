<!-- razem/docs/START.md · updated 2026-10-28 by Codex -->
# Razem — start dla agenta
Status: fundament RAZ-1 przygotowany do odbioru, 04.11.2026. Repozytorium istnieje:
`/home/konrad-gawlik/work/razem`, origin `https://github.com/gakokonradgawlik/razem.git`.
Wdrożenie nadal nie zostało wykonane. Szczegóły: operations/repository.md i quality/raz-1.md.

## Ustalenia właściciela
- Nazwa: Razem.
- Prywatny użytek właściciela i żony; oboje iPhone.
- Aplikacja webowa instalowana jako PWA; działanie offline ma obejmować edycję danych.
- Dane wspólne i prywatne; przypomnienia/powiadomienia.
- Własny serwer Ubuntu w domu.
- Polski interfejs w stylistyce Apple.
- Właściciel deleguje zwykłe decyzje implementacyjne agentom i nie chce pytań o sposób implementacji.

## Dokumenty obowiązujące
1. product/mvp.md — funkcje i granice pierwszego wydania.
2. design/interface.md — ekrany, język i zachowanie interfejsu.
3. architecture/overview.md — stos, repo, model danych, granice komponentów.
4. architecture/sync.md — kontrakt offline/sync i rozwiązywanie konfliktów.
5. security/access.md — konta i prywatność.
6. operations/ubuntu.md — wdrożenie, HTTPS, backup i dostęp do serwera.
7. quality/acceptance.md — scenariusze testów i dowody ukończenia.

## Kolejność
RAZ-1 tworzy repozytorium, polecenia i kontrakty. Następnie baza/konta oraz interfejs. Potem serwer sync, klient offline, instalacja PWA, moduły funkcjonalne, push i backup, testy przekrojowe, pakiet Ubuntu oraz rzeczywiste wdrożenie i próba na iPhone'ach. Zależności są zapisane w zadaniach; nie omijaj ich ani nie wykonuj cudzych zadań bez przydziału.

## Samodzielność
Zwykłe odwracalne wybory doprecyzuj w granicach dokumentów, zapisz uzasadnienie, kontynuuj. Nie pytaj właściciela o bibliotekę, kolory, nazwy tabel czy strukturę katalogów. W razie sprzeczności respektuj jego bezpośrednie instrukcje i nie zmieniaj zasad prywatności po cichu.
Brak hosta, klucza dostępowego, domeny lub dostępu do fizycznego iPhone'a jest sprawą operacyjną, nie pytaniem implementacyjnym. Pracę zależną od tych danych wydzielono na końcu. Gdy rzeczywiście potrzebne, użyj request_owner_action z konkretnymi krokami, nie ponawiaj bez końca tego samego pytania.

## Repozytorium i wdrożenie
Repo: potwierdzone i opisane przez RAZ-1 w operations/repository.md. Nie zmieniaj remote na domniemany adres.
Wdrożenie: do odczytania z Installation i ustalenia przez RAZ-16 na podstawie realnego dostępu. Brak obecnego wpisu wdrożenia nie oznacza zgody na publiczne wystawienie serwera.

## Przekazanie
Każde zadanie: dowody spełnienia DoD, właściwe testy, notatka handoff, aktualne dokumenty, submit_for_review. Nie zatwierdzaj sam swojego review. Wszystkie zadania MVP mają być gotowe do kolejki; dojrzałość implementacji wynika z ich statusów, a nie z tej specyfikacji.

