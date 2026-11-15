create or replace function public.strict_profile_matches_listing(
  p_profile_id uuid,
  p_workspace_id uuid,
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
  select coalesce(
    profile.mode <> 'strict'
    or (
      lower(trim(coalesce(p_city, ''))) = lower(trim(profile.city))
      and p_area_m2 is not null
      and (profile.area_min_m2 is null or p_area_m2 >= profile.area_min_m2)
      and (profile.area_max_m2 is null or p_area_m2 <= profile.area_max_m2)
      and p_rooms is not null
      and (cardinality(profile.preferred_rooms) = 0 or p_rooms = any(profile.preferred_rooms))
      and (
        cardinality(profile.preferred_districts) = 0
        or exists (
          select 1
          from unnest(profile.preferred_districts) as preferred(district)
          where regexp_replace(
            translate(lower(trim(coalesce(p_district, ''))), 'ąćęłńóśźż', 'acelnoszz'),
            '[^a-z0-9]+', '', 'g'
          ) in (
            regexp_replace(translate(lower(trim(preferred.district)), 'ąćęłńóśźż', 'acelnoszz'), '[^a-z0-9]+', '', 'g'),
            regexp_replace(translate(lower(trim(regexp_replace(preferred.district, '^osiedle\\s+', '', 'i'))), 'ąćęłńóśźż', 'acelnoszz'), '[^a-z0-9]+', '', 'g')
          )
        )
      )
    ),
    false
  )
  from public.search_profiles as profile
  where profile.id = p_profile_id and profile.workspace_id = p_workspace_id
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

  if not found or not public.strict_profile_matches_listing(
    new.profile_id,
    new.workspace_id,
    v_listing.city,
    v_listing.district,
    v_listing.area_m2,
    v_listing.rooms
  ) then
    return null;
  end if;
  return new;
end;
$$;

create trigger strict_profile_match_guard
before insert or update on public.listing_profile_matches
for each row execute function public.enforce_strict_profile_match();

delete from public.listing_profile_matches as match
using public.search_profiles as profile, public.source_listings as listing
where match.profile_id = profile.id
  and match.workspace_id = profile.workspace_id
  and match.listing_id = listing.id
  and match.workspace_id = listing.workspace_id
  and profile.mode = 'strict'
  and not public.strict_profile_matches_listing(
    profile.id, profile.workspace_id, listing.city, listing.district, listing.area_m2, listing.rooms
  );
