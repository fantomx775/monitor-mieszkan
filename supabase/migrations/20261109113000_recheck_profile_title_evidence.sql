drop trigger if exists strict_listing_match_recheck on public.source_listings;
create trigger strict_listing_match_recheck
after update of title, city, district, area_m2, rooms on public.source_listings
for each row execute function public.remove_nonmatching_profile_listings();
