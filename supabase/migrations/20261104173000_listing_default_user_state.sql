create or replace function public.ensure_listing_default_user_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.listing_user_state (workspace_id, listing_id)
  values (new.workspace_id, new.id)
  on conflict (workspace_id, listing_id) do nothing;
  return new;
end;
$$;

revoke all on function public.ensure_listing_default_user_state()
  from public, anon, authenticated, service_role;

drop trigger if exists source_listings_ensure_default_user_state
  on public.source_listings;
create trigger source_listings_ensure_default_user_state
  after insert on public.source_listings
  for each row execute function public.ensure_listing_default_user_state();

insert into public.listing_user_state (workspace_id, listing_id)
select listing.workspace_id, listing.id
from public.source_listings as listing
on conflict (workspace_id, listing_id) do nothing;
