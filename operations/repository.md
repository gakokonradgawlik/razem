# Repozytorium i środowisko Razem

Zweryfikowano w RAZ-1, 2026-11-04 (źródła wersji sprawdzono 2026-11-03/04).

- Dedykowany katalog: `/home/konrad-gawlik/work/razem`.
- Faktyczny `origin`: `https://github.com/gakokonradgawlik/razem.git`.
- Główna gałąź: `main`; implementacja RAZ-1 wyłącznie `agent/raz-1`.
- Początek repo: `eeb817b`. Stan początkowy pusty, bez AGENTS.md i CLAUDE.md.
- Brak zmian w repo innych aplikacji. Brak wdrożenia w ramach tego zadania.
- Dokumenty skopiowano z ToDo; ToDo pozostaje źródłem prawdy dla zadań i decyzji.

## Przypięte wersje

Numery ustalono na podstawie oficjalnych stron projektu oraz metadanych wydań
w rejestrze npm (`https://registry.npmjs.org/<pakiet>/latest`, także engines/peerDependencies).
Nie użyto prerelease. Bezpośrednie zależności mają dokładne wersje; pełne drzewo
i integralność archiwów zapisano w `package-lock.json` (npm lockfile v3).

| Składnik | Wersja | Źródło |
| --- | --- | --- |
| Node / npm | 26.13.0 / 11.20.0 | [indeks Node](https://nodejs.org/dist/index.json), [harmonogram LTS](https://github.com/nodejs/Release) |
| React / React DOM | 19.3.1 | [wersje React](https://react.dev/versions) |
| Vite / plugin React | 8.3.5 / 6.2.1 | [Vite](https://vite.dev/guide/) |
| TypeScript | 7.0.2 | [npm TypeScript](https://registry.npmjs.org/typescript/7.0.2) |
| Fastify / static | 5.12.8 / 10.1.8 | [LTS](https://fastify.dev/docs/latest/Reference/LTS/), [static](https://github.com/fastify/fastify-static) |
| Zod | 4.6.7 | [Zod 4](https://zod.dev/) |
| Drizzle ORM | 0.45.4 | [SQLite](https://orm.drizzle.team/docs/get-started-sqlite) |
| better-sqlite3 | 13.0.3 | [oficjalne wydania](https://github.com/WiseLibs/better-sqlite3/releases) |
| Dexie | 4.4.7 | [dokumentacja](https://dexie.org/docs/) |
| Temporal polyfill | 0.5.1 | [repo projektu](https://github.com/js-temporal/temporal-polyfill) |
| Vitest / jsdom | 5.1.0 / 30.1.3 | [Vitest](https://vitest.dev/guide/), metadane npm |
| Playwright | 1.64.1 | [dokumentacja](https://playwright.dev/docs/intro) |
| tsx | 4.23.15 | [npm](https://registry.npmjs.org/tsx/4.23.15) |

Node 26 Lithium jest Active LTS; systemowy Node 22.23.3 nie jest środowiskiem
docelowym. Testy wykonano na pobranym oficjalnym Node 26.13.0, po sprawdzeniu
SHA256 z `SHASUMS256.txt`. Node 26 spełnia wymagania Vite i Vitest. Typy i pozostałe
narzędzia testowe mają dokładne numery w package.json.

Obie fazy Dockerfile:
`node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9`.
Digest indeksu wielu architektur potwierdzono w oficjalnym Docker Registry.
Warstwa budująca instaluje python3/make/g++, bo natywny SQLite może wymagać kompilacji.
Runtime nie ma tego toolchainu. Pakiet Compose nie otwiera publicznych portów.

Stabilny Drizzle 0.45.4 nie eksportuje `node-sqlite`, choć aktualna dokumentacja
opisuje go dla nowszej linii. Wybrano oficjalny adapter `better-sqlite3` bez
przechodzenia na Drizzle 1.0 RC. Schemat domenowy i migracje w RAZ-2.

Override `@fastify/static → glob 14.0.3` usuwa podatności pośrednich glob/minimatch
z domyślnej linii 13. Obejmuje tylko ten plugin; rzeczywiste serwowanie plików
sprawdzają e2e Chromium/WebKit. Nie uruchamiano `npm audit fix --force`.

## Polecenia i sprzątanie

Instrukcje startu, wszystkie komendy i pipeline: [README](../README.md).
Dev: web 5173, API 3100; e2e: 4317 (loopback). Wyłączenie dev: Ctrl+C.
E2e samo zamyka proces i usuwa swoją bazę z systemowego tmp. Zatrzymaj własne
testy przed oddaniem zadania, usuń własne kontenery/sieci/wolumeny testowe po ID
i sprawdź wolne porty. Nie usuwaj trwałego `data/` ani cudzych zasobów.
Nigdy globalnego prune.
