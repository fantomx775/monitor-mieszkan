create or replace function public.ingest_listing_from_worker(
  p_workspace_id uuid,
  p_profile_id uuid,
  p_listing jsonb
)
returns table (listing_id uuid, outcome text, price_changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source text := p_listing ->> 'source';
  v_external_id text := nullif(trim(p_listing ->> 'externalId'), '');
  v_canonical_url text := nullif(trim(p_listing ->> 'canonicalUrl'), '');
  v_title text := nullif(trim(p_listing ->> 'title'), '');
  v_price bigint := nullif(p_listing ->> 'pricePln', '')::bigint;
  v_area numeric(8, 2) := nullif(p_listing ->> 'areaM2', '')::numeric;
  v_rooms smallint := nullif(p_listing ->> 'rooms', '')::smallint;
  v_floor smallint := nullif(p_listing ->> 'floor', '')::smallint;
  v_market text := coalesce(nullif(p_listing ->> 'market', ''), 'unknown');
  v_source_evidence text := p_listing ->> 'sourceEvidence';
  v_existing public.source_listings%rowtype;
  v_listing_id uuid;
  v_changed boolean;
  v_price_changed boolean := false;
  v_outcome text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Worker role required';
  end if;
  if v_source is null or v_source not in (
      'otodom', 'olx', 'morizon', 'gratka', 'nieruchomosci_online',
      'lento', 'gethome', 'sprzedajemy', 'tabelaofert',
      'domy', 'domiporta', 'adresowo'
  ) then
    raise exception using errcode = '22023', message = 'Unsupported worker source';
  end if;
  if v_external_id is null or v_canonical_url is null
      or v_canonical_url !~ '^https://[^[:space:]]+$' then
    raise exception using errcode = '22023', message = 'Listing identity or URL is invalid';
  end if;
  if v_market not in ('primary', 'secondary', 'unknown') then
    raise exception using errcode = '22023', message = 'Listing market is invalid';
  end if;
  if v_source_evidence not in ('rss', 'jsonld', 'html', 'browser') then
    raise exception using errcode = '22023', message = 'Worker evidence type is invalid';
  end if;
  if not exists (
    select 1
    from public.sources as source
    where source.workspace_id = p_workspace_id
      and source.source_key = v_source
      and source.enabled = true
  ) then
    raise exception using errcode = '42501', message = 'Source is disabled for this workspace';
  end if;
  if not exists (
    select 1
    from public.search_profiles as profile
    where profile.workspace_id = p_workspace_id
      and profile.id = p_profile_id
      and profile.enabled = true
  ) then
    raise exception using errcode = '22023', message = 'Search profile is disabled or missing';
  end if;

  select listing.*
    into v_existing
  from public.source_listings as listing
  where listing.workspace_id = p_workspace_id
    and listing.source_key = v_source
    and listing.external_id = v_external_id
  for update;

  if not found then
    insert into public.source_listings (
      workspace_id, source_key, external_id, canonical_url, title, transaction,
      category, market, price_pln, area_m2, rooms, floor, city, district, street,
      latitude, longitude, published_at, promoted_at, source_evidence,
      image_original_url, image_alt, last_checked_at
    ) values (
      p_workspace_id, v_source, v_external_id, v_canonical_url, v_title, 'sale',
      'apartment', v_market, v_price, v_area, v_rooms, v_floor,
      nullif(trim(p_listing ->> 'city'), ''),
      nullif(trim(p_listing ->> 'district'), ''),
      nullif(trim(p_listing ->> 'street'), ''),
      nullif(p_listing ->> 'latitude', '')::double precision,
      nullif(p_listing ->> 'longitude', '')::double precision,
      nullif(p_listing ->> 'publishedAt', '')::timestamptz,
      nullif(p_listing ->> 'promotedAt', '')::timestamptz,
      v_source_evidence,
      nullif(p_listing ->> 'imageOriginalUrl', ''),
      nullif(p_listing ->> 'imageAlt', ''),
      now()
    )
    returning id into v_listing_id;

    insert into public.listing_user_state (workspace_id, listing_id)
      values (p_workspace_id, v_listing_id)
      on conflict on constraint listing_user_state_pkey do nothing;
    v_outcome := 'inserted';
  else
    v_listing_id := v_existing.id;
    v_price_changed := v_existing.price_pln is not null
      and v_price is not null
      and v_existing.price_pln is distinct from v_price;
    v_changed :=
      v_existing.canonical_url is distinct from v_canonical_url
      or (v_title is not null and v_existing.title is distinct from v_title)
      or (v_price is not null and v_existing.price_pln is distinct from v_price)
      or (v_area is not null and v_existing.area_m2 is distinct from v_area)
      or (v_rooms is not null and v_existing.rooms is distinct from v_rooms)
      or (v_market <> 'unknown' and v_existing.market is distinct from v_market)
      or (nullif(trim(p_listing ->> 'city'), '') is not null
          and v_existing.city is distinct from nullif(trim(p_listing ->> 'city'), ''))
      or (nullif(trim(p_listing ->> 'district'), '') is not null
          and v_existing.district is distinct from nullif(trim(p_listing ->> 'district'), ''))
      or (nullif(trim(p_listing ->> 'street'), '') is not null
          and v_existing.street is distinct from nullif(trim(p_listing ->> 'street'), ''));

    update public.source_listings as listing
    set canonical_url = v_canonical_url,
        title = coalesce(v_title, listing.title),
        market = case when v_market <> 'unknown' then v_market else listing.market end,
        price_pln = coalesce(v_price, listing.price_pln),
        area_m2 = coalesce(v_area, listing.area_m2),
        rooms = coalesce(v_rooms, listing.rooms),
        floor = coalesce(v_floor, listing.floor),
        city = coalesce(nullif(trim(p_listing ->> 'city'), ''), listing.city),
        district = coalesce(nullif(trim(p_listing ->> 'district'), ''), listing.district),
        street = coalesce(nullif(trim(p_listing ->> 'street'), ''), listing.street),
        latitude = coalesce(nullif(p_listing ->> 'latitude', '')::double precision, listing.latitude),
        longitude = coalesce(nullif(p_listing ->> 'longitude', '')::double precision, listing.longitude),
        published_at = coalesce(nullif(p_listing ->> 'publishedAt', '')::timestamptz, listing.published_at),
        promoted_at = coalesce(nullif(p_listing ->> 'promotedAt', '')::timestamptz, listing.promoted_at),
        source_evidence = v_source_evidence,
        image_original_url = coalesce(nullif(p_listing ->> 'imageOriginalUrl', ''), listing.image_original_url),
        image_alt = coalesce(nullif(p_listing ->> 'imageAlt', ''), listing.image_alt),
        last_seen_at = now(),
        last_checked_at = now(),
        last_changed_at = case when v_changed then now() else listing.last_changed_at end,
        updated_at = case when v_changed then now() else listing.updated_at end
    where listing.id = v_listing_id;

    if v_price_changed then
      insert into public.listing_price_events (
        workspace_id, listing_id, old_price_pln, new_price_pln
      ) values (p_workspace_id, v_listing_id, v_existing.price_pln, v_price);
    end if;
    v_outcome := case when v_changed then 'updated' else 'unchanged' end;
  end if;

  insert into public.listing_profile_matches (
    workspace_id, listing_id, profile_id
  ) values (p_workspace_id, v_listing_id, p_profile_id)
  on conflict on constraint listing_profile_matches_pkey
  do update set last_matched_at = now();

  return query select v_listing_id, v_outcome, v_price_changed;
end;
$$;

revoke all on function public.ingest_listing_from_worker(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_listing_from_worker(uuid, uuid, jsonb)
  to service_role;
