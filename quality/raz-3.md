# RAZ-3 — dowody i przekazanie

Gałąź `agent/raz-3`. Środowisko: Node 26.13.0 / npm 11.20.0 (oficjalny tarball w katalogu
tymczasowym, SHA256 zgodny z `SHASUMS256.txt`), Playwright 1.64.1 z Chromium i WebKit
pobranymi do katalogu tymczasowego. Bez danych użytkowników; teksty przykładowe tylko w placeholderach.

## Zrealizowano
System UI i szkielet wszystkich ekranów MVP — opis w design/interface.md, sekcja „Implementacja RAZ-3”.

## Kontrole
| Kontrola | Wynik |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | PASS: 14 plików, 120 testów (w tym 15 nowych testów web w `App.test.tsx`, `ui/ui.test.ts`, `keyboard.test.tsx`) |
| `npm run build` | PASS (ostrzeżenie Vite o paczce >500 kB — polifill Temporal z kontraktów; do rozważenia code-splitting w zadaniu PWA) |
| `npm run test:e2e` | PASS 19, 1 pominięty (safe-area przez CDP działa tylko w Chromium; w WebKit pominięty) |

E2E (`tests/e2e/interface.spec.ts`, Chromium desktop + WebKit z profilem iPhone 13, `pl-PL`, Europe/Warsaw):
- 17 tras × szerokości 375/390/430/1280: brak poziomego scrolla, każdy widoczny cel ≥44×44 px
  (dla radio/checkbox — etykieta), każda kontrolka ma dostępną nazwę, pola ≥16 px; także po walidacji i w widoku miesiąca.
- Duży tekst (root 200 %) na wszystkich trasach przy 375 px, ciemny motyw (systemowy i wybrany),
  `prefers-reduced-motion` (menu bez animacji), zapamiętanie motywu po przeładowaniu.
- Safe area (Chromium `Emulation.setSafeAreaInsetsOverride` 47/34 px): pasek zakładek i pasek formularza.
- Klawiatura: hak CSS ukrywa pasek i dodaje odstęp; logika `visualViewport` testowana jednostkowo.
- Formularz: prywatność „Tylko ja/Wspólne” widoczna przed zapisem, fokus na błędnym polu, po nieudanym
  zapisie treść zachowana, URL bez zmian, brak jakiejkolwiek bazy IndexedDB.
- Kontrast tokenów (jasny i oba warianty ciemnego) liczony wzorem WCAG w `ui/ui.test.ts`: tekst ≥4,5:1, obramowania i ikony ≥3:1.

## Kontrola wizualna
Zrzuty (`RAZEM_SCREENSHOTS=<katalog> npm run test:e2e`) ekranów Dzisiaj, Nowe zadanie (z błędem
walidacji), Nowa notatka, Ustawienia i Logowanie w 375/390/430/1280 px, Chromium i WebKit — obejrzane,
nie są commitowane. Zauważone i poprawione: format daty/godziny w WebKit (locale e2e ustawione na pl-PL).

## Granice — NIE zweryfikowano
- Fizyczny iPhone: Safari/PWA standalone, prawdziwa klawiatura, notch/Dynamic Island, VoiceOver, Dynamic Type
  z ustawień systemu. WebKit w Playwright i emulacja safe-area ich nie zastępują (lista w quality/acceptance.md).
- Rzeczywiste logowanie, zapis lokalny, synchronizacja, eksport, push, wylogowanie z ostrzeżeniem — RAZ-5 i kolejne.
- Manifest, ikony PNG i Service Worker — zadanie PWA.
