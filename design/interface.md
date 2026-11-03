<!-- razem/design/interface.md · updated 2026-10-28 by Codex -->
# Razem — interfejs
## Kierunek
Spokojny, czytelny interfejs inspirowany iOS: systemowy krój -apple-system, system-ui; jasne powierzchnie, zaokrąglone grupy, subtelne separatory, niebieski akcent, oszczędna ikonografia. Bez kopiowania marki Apple ani zewnętrznych fontów/zasobów koniecznych do offline.
Nazwa i ikona: Razem; autorski prosty znak dwóch połączonych kształtów. Ikony lokalne, apple-touch-icon 180 oraz manifest 192/512 i wariant maskable z bezpiecznym marginesem.

## Nawigacja
Dolny pasek: Dzisiaj, Zakupy, Zadania, Kalendarz, Więcej. Więcej: Notatki, Ważne daty, Kosz, Ustawienia. Jeden widoczny przycisk dodawania w kontekście ekranu. Ekrany szczegółów i formularze z jasnym Zapisz/Anuluj; dla szybkiego odhaczania zapis natychmiast lokalny i opcja Cofnij.
Na szerokim ekranie boczna nawigacja i ograniczona szerokość treści; te same możliwości.

## Interakcje
- Cele dotykowe min. 44x44 CSS px, etykiety kontrolek i obsługa VoiceOver.
- Pola tekstowe min. 16 px, bez blokowania zoomu; poprawna klawiatura, fokus i walidacja przy polu.
- Uwzględnij safe-area-inset, dynamiczny viewport i klawiaturę ekranową.
- Gesty przesunięcia opcjonalne: każda operacja ma też przycisk/menu.
- Jasny/ciemny zgodny z systemem, kontrast co najmniej WCAG AA, prefers-reduced-motion.
- Widoczne puste stany z działaniem i realistyczne polskie przykłady; dane przykładowe tylko w trybie demo/test.
- Statusy: Offline; Zapisywanie na tym urządzeniu; Zmiany czekają na wysłanie (liczba); Zsynchronizowano [czas]; Serwer niedostępny; Zaloguj się, aby wysłać zmiany; Zmiana wymaga sprawdzenia.
- Nie utożsamiaj navigator.onLine z dostępnością serwera.
- Prywatność widoczna tekstowo ('Tylko ja'/'Wspólne'), nie samym kolorem.
- Przy konflikcie pokaż moją i zapisaną na serwerze wersję; wybór wersji lub ręczne połączenie, bez utraty tekstu.
- Przy błędzie quota pokaż informację i możliwość eksportu oczekujących zmian; nie potwierdzaj zapisu, który się nie powiódł.

## Powiadomienia i instalacja
Własny ekran objaśnia 'Udostępnij → Do ekranu początkowego'; nie obiecuj przycisku beforeinstallprompt na iOS. Nie wyświetlaj systemowej prośby push przy pierwszej wizycie; dopiero po naciśnięciu Włącz powiadomienia. Rozróżnij brak wsparcia, brak instalacji, odmowę i niedostępną subskrypcję.
Pokaż ostatnią synchronizację i ostrzeżenie o niewysłanych zmianach przed wylogowaniem. Żadnych surowych nazw API, ścieżek, tokenów czy szczegółów implementacji w zwykłych ekranach.

