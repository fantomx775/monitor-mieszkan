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
    p_profile_id,
    p_workspace_id,
    p_city,
    case
      when exists (
        select 1 from public.search_profiles as profile
        where profile.id = p_profile_id
          and profile.workspace_id = p_workspace_id
          and exists (
            select 1 from unnest(profile.preferred_districts) as preferred(district)
            where regexp_replace(translate(lower(preferred.district), 'ąćęłńóśźż', 'acelnoszz'), '[^a-z0-9]+', '', 'g') = 'paderewskiego'
          )
      )
      and (
        regexp_replace(translate(lower(coalesce(p_title, '')), 'ąćęłńóśźż', 'acelnoszz'), '[^a-z0-9]+', '', 'g') like '%osiedlepaderewskiego%'
        or regexp_replace(translate(lower(coalesce(p_title, '')), 'ąćęłńóśźż', 'acelnoszz'), '[^a-z0-9]+', '', 'g') like '%ospaderewskiego%'
      )
      and regexp_replace(translate(lower(coalesce(p_title, '')), 'ąćęłńóśźż', 'acelnoszz'), '[^a-z0-9]+', '', 'g') not like '%muchowiec%'
      then 'Paderewskiego'
      else p_district
    end,
    p_area_m2,
    p_rooms
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

insert into public.listing_profile_matches (workspace_id, listing_id, profile_id)
select listing.workspace_id, listing.id, profile.id
from public.search_profiles as profile
join public.source_listings as listing on listing.workspace_id = profile.workspace_id
where profile.mode = 'strict'
  and profile.enabled = true
  and public.strict_profile_matches_source_listing(
    profile.id, profile.workspace_id, listing.source_key, listing.title,
    listing.city, listing.district, listing.area_m2, listing.rooms
  )
on conflict on constraint listing_profile_matches_pkey do nothing;
