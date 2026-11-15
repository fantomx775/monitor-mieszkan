# Nocny Monitor Nieruchomości

Prywatna, lokalna aplikacja do monitorowania ofert mieszkań na sprzedaż. Repozytorium jest niezależne od PanelJazdy. W tej wersji Supabase, Auth, Storage, Next.js i worker działają lokalnie w Dockerze; aplikacja nie publikuje ofert ani nie wysyła powiadomień.

## Wymagania

- Windows z Docker Desktop i PowerShell albo Docker Engine na Linux/WSL2.
- Node.js 22 i pnpm 11.
- Wolne porty `3000`, `54321`–`54324` i `54322`.

## Pierwsze uruchomienie

W katalogu repozytorium uruchom:

```powershell
pnpm install --frozen-lockfile
pnpm dev:up
```

Skrypt uruchamia lokalny Supabase przez CLI, przygotowuje ignorowany przez Git plik `.env.local`, buduje kontener Next.js i tworzy lokalne konto demo w prywatnym workspace. Aplikacja działa pod `http://localhost:3000`, a Supabase Studio pod `http://127.0.0.1:54323`. Dane logowania konta demo znajdują się wyłącznie w `.env.local`.

W normalnym użyciu status konta Supabase i migracje można sprawdzić poleceniami `pnpm exec supabase status` i `pnpm db:reset`. `db:reset` usuwa lokalne dane i ładuje profile startowe ponownie.

## Synchronizacja i raport

```powershell
pnpm sync -- --source domy --profile katowice-400 --json
pnpm sync -- --source domy --profile gliwice-400 --json
pnpm report:daily
```

Ręczny import hostowy (Node 22; wczytuje ignorowany lokalny plik `.env.local`):

```powershell
node --env-file=.env.local --import tsx scripts/sync.ts --profile katowice-400 --max-pages 2 --json
```

Komenda bez `--source` używa źródeł aktywnego profilu; wyłączonych lub zablokowanych źródeł nie pobiera. `--max-pages` domyślnie wynosi 1; podana komenda prosi o 2 strony na każdą parę źródło/profil, z uwzględnieniem niższych limitów adaptera. Cały przebieg ma globalny limit 20 żądań. Uruchom tę samą komendę dwa razy. W raporcie JSON, w polach `sources[].counts`, `found` oznacza znalezione oferty, a `inserted`, `updated` i `unchanged` — wynik zapisu. Zbiorcze pole `totals.new` oznacza liczbę wstawionych rekordów. Przy powtórce te same oferty zwykle trafią do `unchanged`, chyba że portal zmieni ich dane. Tryb `--dry-run` sprawdza profil i źródło, ale niczego nie zapisuje.

Każdy worker jest krótkotrwałym kontenerem. Pojedynczy kanał RSS nie oznacza pełnego pokrycia portalu; nieobecność oferty w krótkim feedzie nie oznacza, że została usunięta. `pnpm report:daily` tworzy prywatny JSON i Markdown w `artifacts/reports/` i niczego nie wysyła.

Raport korzysta z checkpointu poprzedniej sesji zapisanej w lokalnej bazie. Pierwsze uruchomienie zapisuje baseline z zerową liczbą nowych ofert i obniżek; kolejne obejmują zmiany od poprzedniego checkpointu. Uruchomienia `pnpm sync ... --json` zapisują podsumowania w `artifacts/sync-runs/`; nie zawierają tytułów ani URL ofert.

Worker przyjmuje opcje:

```powershell
pnpm sync -- --source domy --profile katowice-400 --since 2026-11-01 --max-pages 2 --verbose --json
pnpm sync -- --source domy --profile katowice-400 --dry-run --json
```

`--since` pomija oferty ze znaną datą publikacji (`published_at`) wcześniejszą od granicy; nieznane daty pozostają w wyniku, a przebieg jest oznaczony jako częściowy. To nie jest filtr ofert nowo odkrytych. Przycisk „Przejdź do nowych” otwiera `/oferty?new=1`, czyli widok ofert z `first_seen_at` z ostatnich 24 godzin. Filtr „Nowe” pozwala wybrać 24 godziny, 3, 7 lub 30 dni. Odznaka „Nowa w bazie” jest widoczna przez pierwsze 48 godzin. Te widoki nie są powiązane z konkretnym przebiegiem synchronizacji ani z datą publikacji w portalu. `--max-pages` domyślnie wynosi 1, ma limit 20 stron na źródło i podlega niższym limitom adaptera; cały przebieg ma osobny limit 20 żądań. Profile i źródła są obsługiwane kolejno, z blokadą na 30 minut dla pary źródło/profil. Błąd źródła nie zatrzymuje kolejnych pozycji. `--verbose` pokazuje bezpieczne podsumowanie każdego źródła i profilu.

Dostępne komendy:

- `pnpm dev:up` / `pnpm dev:down` — start i zatrzymanie usług. `dev:down` zachowuje wolumen bazy.
- `pnpm sync -- --dry-run --json` — bez zapisu rekordów.
- `pnpm report:daily` — raport lokalny oraz checkpoint następnego zakresu.
- `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build` — lokalna walidacja.
- `pnpm test:e2e` — Playwright w Chromium, przy uruchomionym lokalnym Supabase i koncie demo.
- `pnpm test:rls` — test izolacji workspace oraz prywatnego Storage.
- `pnpm test:data` — syntetyczny test integracji i historii danych w tymczasowym lokalnym workspace; po teście usuwa własne rekordy.

## Dostęp do portali

Portalom przypisano niezależne adaptery i stany dostępu. Otodom pozostaje zablokowane: zwykły odczyt Playwright z 8.11 zwrócił HTTP 403 bez kart; wcześniejsza odpowiedź HTTP 200 zawierała CAPTCHA i próby zatrzymano. OLX jest technicznie dostępny przez GraphQL i ma bounded adapter; po imporcie Katowic jego status pozostaje `LIVE_PARTIAL`. Osobna uwaga dotycząca warunków portalu jest opisana w [`docs/sources/olx.md`](docs/sources/olx.md) i nie jest bramką implementacyjną. Morizon, Gratka i Domiporta zatrzymały się na CAPTCHA, a TabelaOfert na HTTP 403; ostatnie sprawdzenia tych źródeł opisano w [`docs/sources-status.md`](docs/sources-status.md). Domy.pl używa oficjalnego RSS dla Katowic, Gliwic i Krakowa; Tychy pozostają nieobsłużone. Nie omijamy CAPTCHA, logowania ani limitów częstotliwości.

Import jest idempotentny w obrębie workspace według klucza (`source_key`, `external_id`): ponowne znalezienie tej samej oferty z tego samego portalu aktualizuje istniejący rekord, zachowując `first_seen_at`, i zwraca `unchanged`, gdy pola oferty się nie zmieniły. To nie scala ofert między portalami — ta sama nieruchomość z dwóch źródeł pozostaje dwoma rekordami. Dla podobieństw między źródłami system zapisuje osobnego, miękkiego kandydata, kiedy miasto i liczba pokoi są zgodne, cena mieści się w 2%, a metraż w 1% (minimum 0,5 m²). Katalog pokazuje liczbę źródeł; kandydaci nie są automatycznie scalani.

Na szczegółach oferty można ręcznie zapisać oczekiwany miesięczny czynsz, miesięczne opłaty administracyjne, koszt remontu i szacunkowy koszt zakupu. Zmiany są przypisane do użytkownika workspace. Wskaźnik brutto to 12 × miesięczny czynsz podzielone przez koszt zakupu i remontu; brak kosztu remontu jest przyjmowany jako 0. Wskaźnik pomija opłaty, podatki, pustostan i finansowanie, więc nie opisuje zysku netto.

## Bezpieczeństwo i dane

- Rejestracja publiczna jest wyłączona. Dostęp wymaga konta i członkostwa workspace.
- Tabele mają RLS, a service-role jest używany przez lokalny skrypt/worker, nigdy przez przeglądarkę.
- `.env.local`, logi z danymi, lokalne zrzuty i screenshoty nie są śledzone w Git.
- Ręczne dodanie zapisuje link i podane przez użytkownika pola; aplikacja nie wykonuje fetch do dowolnego URL.
- Portalowe opisy, dane kontaktowe i fotografie nie są kopiowane do bazy.

Zasady przyszłego hostingu, gdyby użytkownik osobno go zlecił, opisano w [`docs/deployment-later.md`](docs/deployment-later.md). Żaden deployment ani chmurowy cron nie jest częścią bieżącego projektu.

Raport pierwszego lokalnego odbioru znajduje się w [`MORNING_REPORT.md`](MORNING_REPORT.md).
Instrukcja ręcznego sprawdzenia bieżących funkcji jest w [`docs/manual-acceptance.md`](docs/manual-acceptance.md).
