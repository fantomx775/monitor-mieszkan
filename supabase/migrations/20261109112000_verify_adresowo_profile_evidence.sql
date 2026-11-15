create or replace function public.strict_profile_matches_source_listing(
  p_profile_id uuid,
  p_workspace_id uuid,
  p_source_key text,
  p_title text,
  p_city text,
  p_district text,
  p_area_m2 numeric,
  p_rooms smallint
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.strict_profile_matches_listing(
    p_profile_id, p_workspace_id, p_city, p_district, p_area_m2, p_rooms
  ) and (
    p_source_key <> 'adresowo'
    or exists (
      select 1
      from public.search_profiles as profile
      where profile.id = p_profile_id
        and profile.workspace_id = p_workspace_id
        and profile.mode = 'strict'
        and regexp_replace(translate(lower(coalesce(p_title, '')), 'ąćęłńóśźż', 'acelnoszz'), '[^a-z0-9]+', '', 'g')
          like '%' || regexp_replace(translate(lower(profile.city), 'ąćęłńóśźż', 'acelnoszz'), '[^a-z0-9]+', '', 'g') || '%'
        and (
          cardinality(profile.preferred_districts) = 0
          or exists (
            select 1
            from unnest(profile.preferred_districts) as preferred(district)
            where regexp_replace(translate(lower(coalesce(p_title, '')), 'ąćęłńóśźż', 'acelnoszz'), '[^a-z0-9]+', '', 'g')
              like '%' || regexp_replace(translate(lower(regexp_replace(preferred.district, '^osiedle\\s+', '', 'i')), 'ąćęłńóśźż', 'acelnoszz'), '[^a-z0-9]+', '', 'g') || '%'
          )
        )
    )
  )
$$;

create or replace function public.enforce_strict_profile_match()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_listing public.source_listings%rowtype;
begin
  select listing.* into v_listing
  from public.source_listings as listing
  where listing.id = new.listing_id and listing.workspace_id = new.workspace_id;

  if not found or not public.strict_profile_matches_source_listing(
    new.profile_id, new.workspace_id, v_listing.source_key, v_listing.title,
    v_listing.city, v_listing.district, v_listing.area_m2, v_listing.rooms
  ) then
    return null;
  end if;
  return new;
end;
$$;

create or replace function public.remove_nonmatching_profile_listings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.listing_profile_matches as match
  using public.search_profiles as profile
  where match.workspace_id = new.workspace_id
    and match.listing_id = new.id
    and profile.id = match.profile_id
    and profile.workspace_id = match.workspace_id
    and profile.mode = 'strict'
    and not public.strict_profile_matches_source_listing(
      profile.id, profile.workspace_id, new.source_key, new.title,
      new.city, new.district, new.area_m2, new.rooms
    );
  return new;
end;
$$;

create or replace function public.remove_nonmatching_profile_listings_after_profile_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.listing_profile_matches as match
  using public.source_listings as listing
  where match.profile_id = new.id
    and match.workspace_id = new.workspace_id
    and listing.id = match.listing_id
    and listing.workspace_id = match.workspace_id
    and new.mode = 'strict'
    and not public.strict_profile_matches_source_listing(
      new.id, new.workspace_id, listing.source_key, listing.title,
      listing.city, listing.district, listing.area_m2, listing.rooms
    );
  return new;
end;
$$;

delete from public.listing_profile_matches as match
using public.search_profiles as profile, public.source_listings as listing
where match.profile_id = profile.id
  and match.workspace_id = profile.workspace_id
  and match.listing_id = listing.id
  and match.workspace_id = listing.workspace_id
  and profile.mode = 'strict'
  and not public.strict_profile_matches_source_listing(
    profile.id, profile.workspace_id, listing.source_key, listing.title,
    listing.city, listing.district, listing.area_m2, listing.rooms
  );
