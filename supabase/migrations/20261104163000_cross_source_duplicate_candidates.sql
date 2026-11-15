create or replace function public.detect_cross_source_duplicate_candidates()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.life_cycle <> 'active'
      or nullif(trim(new.city), '') is null
      or new.price_pln is null
      or new.area_m2 is null
      or new.rooms is null then
    return new;
  end if;

  insert into public.listing_duplicate_candidates (
    workspace_id,
    source_listing_id,
    candidate_listing_id,
    confidence,
    reasons_json
  )
  select
    new.workspace_id,
    least(new.id, other.id),
    greatest(new.id, other.id),
    0.900,
    jsonb_build_array(
      jsonb_build_object('field', 'city', 'rule', 'exact'),
      jsonb_build_object('field', 'rooms', 'rule', 'exact'),
      jsonb_build_object('field', 'price_pln', 'rule', 'within_2_percent'),
      jsonb_build_object('field', 'area_m2', 'rule', 'within_1_percent')
    )
  from public.source_listings as other
  where other.workspace_id = new.workspace_id
    and other.id <> new.id
    and other.source_key <> new.source_key
    and other.transaction = new.transaction
    and other.category = new.category
    and other.life_cycle = 'active'
    and other.last_seen_at >= now() - interval '90 days'
    and nullif(trim(other.city), '') is not null
    and lower(trim(other.city)) = lower(trim(new.city))
    and other.price_pln is not null
    and abs(other.price_pln - new.price_pln)
      <= ceil(greatest(other.price_pln, new.price_pln) * 0.02)::bigint
    and other.area_m2 is not null
    and abs(other.area_m2 - new.area_m2)
      <= greatest(0.5, new.area_m2 * 0.01)
    and other.rooms = new.rooms
  on conflict (workspace_id, source_listing_id, candidate_listing_id) do nothing;

  return new;
end;
$$;

revoke all on function public.detect_cross_source_duplicate_candidates()
  from public, anon, authenticated;
grant execute on function public.detect_cross_source_duplicate_candidates()
  to service_role;

drop trigger if exists source_listings_detect_cross_source_duplicates
  on public.source_listings;
create trigger source_listings_detect_cross_source_duplicates
  after insert or update on public.source_listings
  for each row execute function public.detect_cross_source_duplicate_candidates();
