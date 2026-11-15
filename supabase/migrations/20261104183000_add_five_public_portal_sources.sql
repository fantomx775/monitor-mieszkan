alter table public.sources
  drop constraint if exists sources_source_key_check;

alter table public.sources
  add constraint sources_source_key_check check (source_key in (
    'otodom', 'olx', 'morizon', 'gratka', 'nieruchomosci_online',
    'lento', 'gethome', 'sprzedajemy', 'tabelaofert',
    'domy', 'domiporta', 'adresowo', 'manual'
  ));

insert into public.sources (
  workspace_id, source_key, name, base_url, enabled, collection_mode,
  access_status, access_note, access_checked_at
)
values
  ('00000000-0000-4000-8000-000000000001', 'nieruchomosci_online', 'Nieruchomosci-online.pl', 'https://nieruchomosci-online.pl/', true, 'html', 'NOT_TESTED', 'Import jednej strony publicznych wyników mieszkań na sprzedaż. Zapisujemy wyłącznie podstawowe pola ogłoszenia.', null),
  ('00000000-0000-4000-8000-000000000001', 'lento', 'Lento.pl', 'https://lento.pl/', true, 'html', 'NOT_TESTED', 'Import jednej strony publicznych wyników mieszkań na sprzedaż. Zapisujemy wyłącznie podstawowe pola ogłoszenia.', null),
  ('00000000-0000-4000-8000-000000000001', 'gethome', 'GetHome.pl', 'https://gethome.pl/', true, 'html', 'NOT_TESTED', 'Import jednej strony publicznych wyników mieszkań na sprzedaż. Zapisujemy wyłącznie podstawowe pola ogłoszenia.', null),
  ('00000000-0000-4000-8000-000000000001', 'sprzedajemy', 'Sprzedajemy.pl', 'https://sprzedajemy.pl/', true, 'html', 'NOT_TESTED', 'Import jednej strony publicznych wyników mieszkań na sprzedaż. Zapisujemy wyłącznie podstawowe pola ogłoszenia.', null),
  ('00000000-0000-4000-8000-000000000001', 'tabelaofert', 'TabelaOfert.pl', 'https://tabelaofert.pl/', true, 'html', 'NOT_TESTED', 'Import jednej strony publicznych wyników mieszkań na sprzedaż. Zapisujemy wyłącznie podstawowe pola ogłoszenia.', null)
on conflict (workspace_id, source_key) do update
set name = excluded.name,
    base_url = excluded.base_url,
    enabled = excluded.enabled,
    collection_mode = excluded.collection_mode,
    access_status = excluded.access_status,
    access_note = excluded.access_note,
    access_checked_at = null,
    updated_at = now();

update public.search_profiles as profile
set sources = (
  select array_agg(distinct selected.source_key order by selected.source_key)
  from unnest(coalesce(profile.sources, array[]::text[]) || array[
    'nieruchomosci_online', 'lento', 'gethome', 'sprzedajemy', 'tabelaofert'
  ]) as selected(source_key)
)
where profile.workspace_id = '00000000-0000-4000-8000-000000000001';
