insert into public.workspaces (id, name, timezone)
values (
  '00000000-0000-4000-8000-000000000001',
  'Prywatny monitoring mieszkań',
  'Europe/Warsaw'
)
on conflict (id) do update
set name = excluded.name,
    timezone = excluded.timezone,
    updated_at = now();

insert into public.sources (
  workspace_id, source_key, name, base_url, enabled, collection_mode,
  access_status, access_note, access_checked_at
)
values
  ('00000000-0000-4000-8000-000000000001', 'otodom', 'Otodom', 'https://www.otodom.pl/', true, 'html', 'NOT_TESTED', 'Wklej publiczny link do wyników sprzedaży mieszkań w edycji profilu. Adapter czyta tylko listę wyników i zatrzymuje się na odmowie, CAPTCHA lub limicie.', null),
  ('00000000-0000-4000-8000-000000000001', 'olx', 'OLX', 'https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/', true, 'api', 'NOT_TESTED', 'Wklej link wyników i uzupełnij category_id, region_id oraz city_id z przechwyconego wyszukiwania.', null),
  ('00000000-0000-4000-8000-000000000001', 'morizon', 'Morizon', 'https://www.morizon.pl/mieszkania/', false, 'disabled', 'BLOCKED_BY_ACCESS_OR_POLICY', 'Odpowiedź strony wyników zawierała CAPTCHA; import pozostaje wyłączony i adapter nie ponawia próby.', now()),
  ('00000000-0000-4000-8000-000000000001', 'gratka', 'Gratka', 'https://gratka.pl/nieruchomosci/mieszkania', false, 'disabled', 'BLOCKED_BY_ACCESS_OR_POLICY', 'Odpowiedź strony wyników zawierała CAPTCHA; import pozostaje wyłączony i adapter nie ponawia próby.', now()),
  ('00000000-0000-4000-8000-000000000001', 'nieruchomosci_online', 'Nieruchomosci-online.pl', 'https://nieruchomosci-online.pl/', true, 'html', 'NOT_TESTED', 'Import jednej strony publicznych wyników mieszkań na sprzedaż. Zapisujemy wyłącznie podstawowe pola ogłoszenia.', null),
  ('00000000-0000-4000-8000-000000000001', 'lento', 'Lento.pl', 'https://lento.pl/', true, 'html', 'NOT_TESTED', 'Import jednej strony publicznych wyników mieszkań na sprzedaż. Zapisujemy wyłącznie podstawowe pola ogłoszenia.', null),
  ('00000000-0000-4000-8000-000000000001', 'gethome', 'GetHome.pl', 'https://gethome.pl/', true, 'html', 'NOT_TESTED', 'Import jednej strony publicznych wyników mieszkań na sprzedaż. Zapisujemy wyłącznie podstawowe pola ogłoszenia.', null),
  ('00000000-0000-4000-8000-000000000001', 'sprzedajemy', 'Sprzedajemy.pl', 'https://sprzedajemy.pl/', true, 'html', 'NOT_TESTED', 'Import jednej strony publicznych wyników mieszkań na sprzedaż. Zapisujemy wyłącznie podstawowe pola ogłoszenia.', null),
  ('00000000-0000-4000-8000-000000000001', 'tabelaofert', 'TabelaOfert.pl', 'https://tabelaofert.pl/', false, 'disabled', 'BLOCKED_BY_ACCESS_OR_POLICY', 'Publiczna lista zwróciła HTTP 403; adapter przerywa bez ponowienia.', now()),
  ('00000000-0000-4000-8000-000000000001', 'homeportal', 'HomePortal.pl', 'https://homeportal.pl/', true, 'html', 'NOT_TESTED', 'Import jednej strony publicznych wyników mieszkań na sprzedaż. Zapisujemy wyłącznie podstawowe pola ogłoszenia.', null),
  ('00000000-0000-4000-8000-000000000001', 'domy', 'Domy.pl', 'https://domy.pl/rss', true, 'rss', 'NOT_TESTED', 'Używać wyłącznie oficjalnych feedów, minimalnych danych i w celu prywatnego wyszukiwania zakupu. Brak kopiowania opisów/zdjęć; feed Tychów nie został potwierdzony.', now()),
  ('00000000-0000-4000-8000-000000000001', 'domiporta', 'Domiporta', 'https://www.domiporta.pl/', false, 'disabled', 'BLOCKED_BY_ACCESS_OR_POLICY', 'Odpowiedź strony wyników zawierała CAPTCHA; import pozostaje wyłączony i adapter nie ponawia próby.', now()),
  ('00000000-0000-4000-8000-000000000001', 'adresowo', 'Adresowo', 'https://adresowo.pl/', true, 'html', 'NOT_TESTED', 'Wklej publiczny link do wyników wyszukiwania w edycji profilu. Adapter czyta minimalne pola listy i zatrzymuje się na odmowie, CAPTCHA lub limicie.', null),
  ('00000000-0000-4000-8000-000000000001', 'manual', 'Dodane ręcznie', 'https://manual.invalid/', true, 'manual', 'NOT_TESTED', 'Link i pola podaje użytkownik. Serwer nie pobiera dowolnych URL-i.', now())
on conflict (workspace_id, source_key) do update
set name = excluded.name,
    base_url = excluded.base_url,
    enabled = excluded.enabled,
    collection_mode = excluded.collection_mode,
    access_status = excluded.access_status,
    access_note = excluded.access_note,
    access_checked_at = excluded.access_checked_at,
    updated_at = now();

insert into public.search_profiles (
  id, workspace_id, profile_key, label, enabled, city, preferred_districts,
  price_max_pln, area_min_m2, area_max_m2, preferred_rooms, sources,
  transaction, category, mode, filters
)
values
  (
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000001',
    'katowice-400',
    'Katowice — inwestycyjne do 400 tys.',
    true,
    'Katowice',
    array['Koszutka', 'Ligota', 'Osiedle Tysiąclecia'],
    400000,
    25,
    55,
    array[2]::smallint[],
    array['otodom', 'olx', 'morizon', 'gratka', 'nieruchomosci_online', 'lento', 'gethome', 'sprzedajemy', 'homeportal', 'domy', 'domiporta', 'adresowo'],
    'sale',
    'apartment',
    'discovery',
    '{"description":"Preferencje startowe; szeroki recall, wyjątki pozostają widoczne."}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000012',
    '00000000-0000-4000-8000-000000000001',
    'gliwice-400',
    'Gliwice — inwestycyjne do 400 tys.',
    true,
    'Gliwice',
    array['Sikornik', 'Śródmieście', 'Zatorze'],
    400000,
    25,
    55,
    array[2]::smallint[],
    array['otodom', 'olx', 'morizon', 'gratka', 'nieruchomosci_online', 'lento', 'gethome', 'sprzedajemy', 'homeportal', 'domy', 'domiporta', 'adresowo'],
    'sale',
    'apartment',
    'discovery',
    '{"description":"Preferencje startowe; szeroki recall, wyjątki pozostają widoczne."}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000013',
    '00000000-0000-4000-8000-000000000001',
    'krakow-800',
    'Kraków — mieszkanie do 800 tys.',
    true,
    'Kraków',
    array['Prądnik Czerwony', 'Czyżyny', 'Krowodrza'],
    800000,
    30,
    60,
    array[2]::smallint[],
    array['otodom', 'olx', 'morizon', 'gratka', 'nieruchomosci_online', 'lento', 'gethome', 'sprzedajemy', 'homeportal', 'domy', 'domiporta', 'adresowo'],
    'sale',
    'apartment',
    'discovery',
    '{"description":"Preferencje startowe; szeroki recall, wyjątki pozostają widoczne."}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000014',
    '00000000-0000-4000-8000-000000000001',
    'tychy-400',
    'Tychy — dodatkowy obszar do 400 tys.',
    true,
    'Tychy',
    array[]::text[],
    400000,
    25,
    55,
    array[2]::smallint[],
    array['otodom', 'olx', 'morizon', 'gratka', 'nieruchomosci_online', 'lento', 'gethome', 'sprzedajemy', 'homeportal', 'domy', 'domiporta', 'adresowo'],
    'sale',
    'apartment',
    'discovery',
    '{"description":"Preferencje startowe; brak twardych filtrów dzielnic."}'::jsonb
  ),
  (
    '72d8fdb3-9024-40eb-8a7c-e70b76ca60df',
    '00000000-0000-4000-8000-000000000001',
    'katowice-35-45-tysiaclecia',
    'Katowice · os. Tysiąclecia · 2 pokoje 35–45 m²',
    true,
    'Katowice',
    array['Osiedle Tysiąclecia', 'Tysiąclecia'],
    null,
    35,
    45,
    array[2]::smallint[],
    array['olx', 'adresowo'],
    'sale',
    'apartment',
    'strict',
    '{"description":"Sprzedaż, Katowice, os. Tysiąclecia; 2 pokoje; 35–45 m².","olx_search_url":"https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/katowice/","olx_search_params":{"categoryId":14,"regionId":6,"cityId":7691,"query":"osiedle tysiąclecia","suggestFilters":"true","sl":"1a1a7b3b405x580f7ef0"},"adresowo_search_url":"https://adresowo.pl/f/mieszkania/katowice/os-tysiaclecia-d/fzb_lrd"}'::jsonb
  ),
  (
    '72d8fdb3-9024-40eb-8a7c-e70b76ca60e0',
    '00000000-0000-4000-8000-000000000001',
    'katowice-35-45-paderewskiego',
    'Katowice · os. Paderewskiego · 2 pokoje 35–45 m²',
    true,
    'Katowice',
    array['Osiedle Paderewskiego', 'Paderewskiego'],
    null,
    35,
    45,
    array[2]::smallint[],
    array['olx'],
    'sale',
    'apartment',
    'strict',
    '{"description":"Sprzedaż, Katowice, os. Paderewskiego; 2 pokoje; 35–45 m².","olx_search_url":"https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/katowice/","olx_search_params":{"categoryId":14,"regionId":6,"cityId":7691,"query":"osiedle paderewskiego","suggestFilters":"true"}}'::jsonb
  )
on conflict (workspace_id, profile_key) do update
set label = excluded.label,
    enabled = excluded.enabled,
    city = excluded.city,
    preferred_districts = excluded.preferred_districts,
    price_max_pln = excluded.price_max_pln,
    area_min_m2 = excluded.area_min_m2,
    area_max_m2 = excluded.area_max_m2,
    preferred_rooms = excluded.preferred_rooms,
    sources = excluded.sources,
    transaction = excluded.transaction,
    category = excluded.category,
    mode = excluded.mode,
    filters = excluded.filters,
    updated_at = now();
