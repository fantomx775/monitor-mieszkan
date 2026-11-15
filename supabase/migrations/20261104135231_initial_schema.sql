create extension if not exists pgcrypto;
create schema if not exists private;

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Europe/Warsaw',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  invited_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_id_idx on public.workspace_members (user_id);

create or replace function private.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select auth.uid()) is not null
    and exists (
      select 1
      from public.workspace_members as member
      where member.workspace_id = p_workspace_id
        and member.user_id = (select auth.uid())
    );
$$;
revoke all on function private.is_workspace_member(uuid) from public, anon;
grant execute on function private.is_workspace_member(uuid) to authenticated;

create or replace function private.is_workspace_owner(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select auth.uid()) is not null
    and exists (
      select 1
      from public.workspace_members as member
      where member.workspace_id = p_workspace_id
        and member.user_id = (select auth.uid())
        and member.role = 'owner'
    );
$$;
revoke all on function private.is_workspace_owner(uuid) from public, anon;
grant execute on function private.is_workspace_owner(uuid) to authenticated;

create table public.sources (
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  source_key text not null check (source_key in (
    'otodom', 'olx', 'morizon', 'gratka', 'nieruchomosci_online',
    'domy', 'domiporta', 'adresowo', 'manual'
  )),
  name text not null,
  base_url text not null,
  enabled boolean not null default false,
  collection_mode text not null check (collection_mode in ('html', 'rss', 'api', 'manual', 'disabled')),
  access_status text not null default 'NOT_TESTED' check (access_status in (
    'LIVE_PASS', 'LIVE_PARTIAL', 'FIXTURE_ONLY',
    'BLOCKED_BY_ACCESS_OR_POLICY', 'FAILED', 'NOT_TESTED'
  )),
  access_note text,
  access_checked_at timestamptz,
  last_live_pass_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, source_key)
);

create table public.search_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  profile_key text not null,
  label text not null,
  enabled boolean not null default true,
  city text not null,
  preferred_districts text[] not null default '{}',
  price_max_pln bigint check (price_max_pln is null or price_max_pln > 0),
  area_min_m2 numeric(8, 2) check (area_min_m2 is null or area_min_m2 > 0),
  area_max_m2 numeric(8, 2) check (area_max_m2 is null or area_max_m2 > 0),
  preferred_rooms smallint[] not null default '{}',
  sources text[] not null default '{}',
  transaction text not null default 'sale' check (transaction = 'sale'),
  category text not null default 'apartment' check (category = 'apartment'),
  mode text not null check (mode in ('strict', 'discovery')),
  filters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, profile_key),
  unique (workspace_id, id)
);
create index search_profiles_workspace_enabled_idx
  on public.search_profiles (workspace_id, enabled, city);

create table public.source_listings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  source_key text not null,
  external_id text not null,
  canonical_url text not null,
  title text,
  transaction text not null default 'sale' check (transaction = 'sale'),
  category text not null default 'apartment' check (category = 'apartment'),
  market text not null default 'unknown' check (market in ('primary', 'secondary', 'unknown')),
  price_pln bigint check (price_pln is null or price_pln > 0),
  area_m2 numeric(8, 2) check (area_m2 is null or area_m2 > 0),
  rooms smallint check (rooms is null or rooms > 0),
  floor smallint,
  city text,
  district text,
  street text,
  latitude double precision check (latitude is null or latitude between -90 and 90),
  longitude double precision check (longitude is null or longitude between -180 and 180),
  published_at timestamptz,
  promoted_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_changed_at timestamptz,
  last_checked_at timestamptz,
  life_cycle text not null default 'active'
    check (life_cycle in ('active', 'potentially_stale', 'gone', 'archived')),
  source_evidence text not null check (source_evidence in ('rss', 'jsonld', 'html', 'browser', 'manual')),
  image_original_url text,
  image_alt text,
  image_storage_path text,
  image_attribution text,
  data_quality jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, source_key)
    references public.sources (workspace_id, source_key) on delete restrict,
  unique (workspace_id, source_key, external_id),
  unique (workspace_id, id),
  check (canonical_url ~ '^https?://[^[:space:]]+$')
);
create index source_listings_workspace_first_seen_idx
  on public.source_listings (workspace_id, first_seen_at desc, id desc);
create index source_listings_workspace_city_price_idx
  on public.source_listings (workspace_id, city, price_pln);
create index source_listings_workspace_canonical_url_idx
  on public.source_listings (workspace_id, canonical_url);
create index source_listings_workspace_lifecycle_idx
  on public.source_listings (workspace_id, life_cycle, last_seen_at desc);

create table public.listing_price_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  listing_id uuid not null,
  old_price_pln bigint not null check (old_price_pln > 0),
  new_price_pln bigint not null check (new_price_pln > 0),
  observed_at timestamptz not null default now(),
  foreign key (workspace_id, listing_id)
    references public.source_listings (workspace_id, id) on delete restrict,
  check (old_price_pln <> new_price_pln)
);
create index listing_price_events_listing_time_idx
  on public.listing_price_events (workspace_id, listing_id, observed_at desc);

create table public.listing_field_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  listing_id uuid not null,
  field_key text not null,
  old_value jsonb,
  new_value jsonb,
  observed_at timestamptz not null default now(),
  foreign key (workspace_id, listing_id)
    references public.source_listings (workspace_id, id) on delete restrict
);
create index listing_field_events_listing_time_idx
  on public.listing_field_events (workspace_id, listing_id, observed_at desc);

create table public.listing_user_state (
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  listing_id uuid not null,
  favorite boolean not null default false,
  review_status text not null default 'to_review'
    check (review_status in (
      'to_review', 'interesting', 'to_contact', 'contacted',
      'to_view', 'rejected', 'archived'
    )),
  reviewed_at timestamptz,
  viewing_scheduled_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, listing_id),
  foreign key (workspace_id, listing_id)
    references public.source_listings (workspace_id, id) on delete restrict
);
create index listing_user_state_workspace_favorite_idx
  on public.listing_user_state (workspace_id, favorite, updated_at desc);
create index listing_user_state_workspace_status_idx
  on public.listing_user_state (workspace_id, review_status, updated_at desc);

create table public.listing_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  listing_id uuid not null,
  author_id uuid not null references auth.users(id) on delete restrict,
  body text not null check (length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, listing_id)
    references public.source_listings (workspace_id, id) on delete restrict
);
create index listing_notes_workspace_listing_time_idx
  on public.listing_notes (workspace_id, listing_id, created_at desc);

create table public.listing_duplicate_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  source_listing_id uuid not null,
  candidate_listing_id uuid not null,
  confidence numeric(4, 3) not null check (confidence between 0 and 1),
  reasons_json jsonb not null default '[]'::jsonb,
  resolved_state text not null default 'open'
    check (resolved_state in ('open', 'confirmed', 'rejected', 'linked')),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, source_listing_id)
    references public.source_listings (workspace_id, id) on delete restrict,
  foreign key (workspace_id, candidate_listing_id)
    references public.source_listings (workspace_id, id) on delete restrict,
  check (source_listing_id <> candidate_listing_id),
  unique (workspace_id, source_listing_id, candidate_listing_id)
);
create index listing_duplicate_candidates_workspace_state_idx
  on public.listing_duplicate_candidates (workspace_id, resolved_state, created_at desc);

create table public.listing_profile_matches (
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  listing_id uuid not null,
  profile_id uuid not null,
  first_matched_at timestamptz not null default now(),
  last_matched_at timestamptz not null default now(),
  primary key (workspace_id, listing_id, profile_id),
  foreign key (workspace_id, listing_id)
    references public.source_listings (workspace_id, id) on delete restrict,
  foreign key (workspace_id, profile_id)
    references public.search_profiles (workspace_id, id) on delete restrict
);
create index listing_profile_matches_profile_idx
  on public.listing_profile_matches (workspace_id, profile_id, last_matched_at desc);

create table public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  trigger text not null default 'manual' check (trigger in ('manual', 'scheduled', 'local')),
  status text not null default 'success' check (status in ('success', 'partial', 'failed', 'blocked')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  total_new integer not null default 0 check (total_new >= 0),
  total_updated integer not null default 0 check (total_updated >= 0),
  total_unchanged integer not null default 0 check (total_unchanged >= 0),
  total_errors integer not null default 0 check (total_errors >= 0),
  error_summary text,
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create index sync_runs_workspace_started_idx
  on public.sync_runs (workspace_id, started_at desc);

create table public.sync_source_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  sync_run_id uuid not null,
  source_key text not null,
  profile_id uuid not null,
  status text not null check (status in ('success', 'partial', 'failed', 'blocked')),
  pages_examined integer not null default 0 check (pages_examined >= 0),
  found_count integer not null default 0 check (found_count >= 0),
  inserted_count integer not null default 0 check (inserted_count >= 0),
  updated_count integer not null default 0 check (updated_count >= 0),
  unchanged_count integer not null default 0 check (unchanged_count >= 0),
  error_kind text,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (workspace_id, sync_run_id)
    references public.sync_runs (workspace_id, id) on delete restrict,
  foreign key (workspace_id, source_key)
    references public.sources (workspace_id, source_key) on delete restrict,
  foreign key (workspace_id, profile_id)
    references public.search_profiles (workspace_id, id) on delete restrict
);
create index sync_source_runs_workspace_started_idx
  on public.sync_source_runs (workspace_id, started_at desc);
create index sync_source_runs_source_profile_idx
  on public.sync_source_runs (workspace_id, source_key, profile_id, started_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'listing-thumbnails',
  'listing-thumbnails',
  false,
  1048576,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

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
  if v_source is null or v_source not in ('otodom', 'olx', 'morizon', 'gratka',
      'nieruchomosci_online', 'domy', 'domiporta', 'adresowo') then
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

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.sources enable row level security;
alter table public.search_profiles enable row level security;
alter table public.source_listings enable row level security;
alter table public.listing_price_events enable row level security;
alter table public.listing_field_events enable row level security;
alter table public.listing_user_state enable row level security;
alter table public.listing_notes enable row level security;
alter table public.listing_duplicate_candidates enable row level security;
alter table public.listing_profile_matches enable row level security;
alter table public.sync_runs enable row level security;
alter table public.sync_source_runs enable row level security;

revoke all on table public.workspaces, public.workspace_members, public.sources,
  public.search_profiles, public.source_listings, public.listing_price_events,
  public.listing_field_events, public.listing_user_state, public.listing_notes,
  public.listing_duplicate_candidates, public.listing_profile_matches,
  public.sync_runs, public.sync_source_runs from anon;

revoke all on table public.workspaces, public.workspace_members, public.sources,
  public.search_profiles, public.source_listings, public.listing_price_events,
  public.listing_field_events, public.listing_user_state, public.listing_notes,
  public.listing_duplicate_candidates, public.listing_profile_matches,
  public.sync_runs, public.sync_source_runs from authenticated;

revoke all on table public.workspaces, public.workspace_members, public.sources,
  public.search_profiles, public.source_listings, public.listing_price_events,
  public.listing_field_events, public.listing_user_state, public.listing_notes,
  public.listing_duplicate_candidates, public.listing_profile_matches,
  public.sync_runs, public.sync_source_runs from service_role;

grant select, update on public.workspaces to authenticated;
grant select on public.workspace_members, public.sources,
  public.source_listings, public.listing_price_events, public.listing_field_events,
  public.listing_profile_matches, public.sync_runs, public.sync_source_runs
  to authenticated;
grant select, insert, update, delete on public.search_profiles to authenticated;
grant insert on public.source_listings to authenticated;
grant select, insert, update on public.listing_user_state to authenticated;
grant select, insert on public.listing_notes to authenticated;
grant select, update on public.listing_duplicate_candidates to authenticated;

grant select, insert, update on public.workspaces to service_role;
grant select, update on public.sources to service_role;
grant select, insert, update on public.workspace_members, public.search_profiles,
  public.source_listings, public.listing_price_events, public.listing_field_events,
  public.listing_user_state, public.listing_notes, public.listing_duplicate_candidates,
  public.listing_profile_matches, public.sync_runs, public.sync_source_runs
  to service_role;

create policy workspaces_member_select on public.workspaces
  for select to authenticated
  using ((select private.is_workspace_member(id)));
create policy workspaces_owner_update on public.workspaces
  for update to authenticated
  using ((select private.is_workspace_owner(id)))
  with check ((select private.is_workspace_owner(id)));

create policy workspace_members_member_select on public.workspace_members
  for select to authenticated
  using ((select private.is_workspace_member(workspace_id)));

create policy sources_member_select on public.sources
  for select to authenticated
  using ((select private.is_workspace_member(workspace_id)));

create policy search_profiles_member_select on public.search_profiles
  for select to authenticated
  using ((select private.is_workspace_member(workspace_id)));
create policy search_profiles_member_insert on public.search_profiles
  for insert to authenticated
  with check ((select private.is_workspace_member(workspace_id)));
create policy search_profiles_member_update on public.search_profiles
  for update to authenticated
  using ((select private.is_workspace_member(workspace_id)))
  with check ((select private.is_workspace_member(workspace_id)));
create policy search_profiles_owner_delete on public.search_profiles
  for delete to authenticated
  using ((select private.is_workspace_owner(workspace_id)));

create policy source_listings_member_select on public.source_listings
  for select to authenticated
  using ((select private.is_workspace_member(workspace_id)));
create policy source_listings_manual_insert on public.source_listings
  for insert to authenticated
  with check (
    source_key = 'manual'
    and source_evidence = 'manual'
    and (select private.is_workspace_member(workspace_id))
  );

create policy listing_price_events_member_select on public.listing_price_events
  for select to authenticated
  using ((select private.is_workspace_member(workspace_id)));
create policy listing_field_events_member_select on public.listing_field_events
  for select to authenticated
  using ((select private.is_workspace_member(workspace_id)));

create policy listing_user_state_member_select on public.listing_user_state
  for select to authenticated
  using ((select private.is_workspace_member(workspace_id)));
create policy listing_user_state_member_insert on public.listing_user_state
  for insert to authenticated
  with check ((select private.is_workspace_member(workspace_id)));
create policy listing_user_state_member_update on public.listing_user_state
  for update to authenticated
  using ((select private.is_workspace_member(workspace_id)))
  with check ((select private.is_workspace_member(workspace_id)));

create policy listing_notes_member_select on public.listing_notes
  for select to authenticated
  using ((select private.is_workspace_member(workspace_id)));
create policy listing_notes_member_insert on public.listing_notes
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and (select private.is_workspace_member(workspace_id))
  );

create policy listing_duplicate_candidates_member_select on public.listing_duplicate_candidates
  for select to authenticated
  using ((select private.is_workspace_member(workspace_id)));
create policy listing_duplicate_candidates_member_update on public.listing_duplicate_candidates
  for update to authenticated
  using ((select private.is_workspace_member(workspace_id)))
  with check ((select private.is_workspace_member(workspace_id)));

create policy listing_profile_matches_member_select on public.listing_profile_matches
  for select to authenticated
  using ((select private.is_workspace_member(workspace_id)));
create policy sync_runs_member_select on public.sync_runs
  for select to authenticated
  using ((select private.is_workspace_member(workspace_id)));
create policy sync_source_runs_member_select on public.sync_source_runs
  for select to authenticated
  using ((select private.is_workspace_member(workspace_id)));

create policy workspace_member_read_listing_thumbnails on storage.objects
  for select to authenticated
  using (
    bucket_id = 'listing-thumbnails'
    and name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
    and (select private.is_workspace_member(split_part(name, '/', 1)::uuid))
  );
