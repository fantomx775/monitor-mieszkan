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
    and not public.strict_profile_matches_listing(
      profile.id, profile.workspace_id, new.city, new.district, new.area_m2, new.rooms
    );
  return new;
end;
$$;

create trigger strict_listing_match_recheck
after update of city, district, area_m2, rooms on public.source_listings
for each row execute function public.remove_nonmatching_profile_listings();

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
    and not public.strict_profile_matches_listing(
      new.id, new.workspace_id, listing.city, listing.district, listing.area_m2, listing.rooms
    );
  return new;
end;
$$;

create trigger strict_profile_match_recheck
after update of mode, city, preferred_districts, area_min_m2, area_max_m2, preferred_rooms on public.search_profiles
for each row execute function public.remove_nonmatching_profile_listings_after_profile_update();
