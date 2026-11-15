alter table public.source_listings
  add column expected_rent_pln bigint check (expected_rent_pln is null or expected_rent_pln >= 0),
  add column admin_fees_pln bigint check (admin_fees_pln is null or admin_fees_pln >= 0),
  add column renovation_cost_pln bigint check (renovation_cost_pln is null or renovation_cost_pln >= 0),
  add column acquisition_cost_pln bigint check (acquisition_cost_pln is null or acquisition_cost_pln >= 0);

alter table public.listing_field_events
  add column actor_id uuid references auth.users(id) on delete set null;

create or replace function public.save_listing_investment_inputs(
  p_workspace_id uuid,
  p_listing_id uuid,
  p_expected_rent_pln bigint,
  p_admin_fees_pln bigint,
  p_renovation_cost_pln bigint,
  p_acquisition_cost_pln bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_listing public.source_listings%rowtype;
begin
  if v_actor_id is null or not private.is_workspace_member(p_workspace_id) then
    raise exception using errcode = '42501', message = 'Workspace access denied';
  end if;

  if p_expected_rent_pln < 0
      or p_admin_fees_pln < 0
      or p_renovation_cost_pln < 0
      or p_acquisition_cost_pln < 0 then
    raise exception using errcode = '22023', message = 'Investment amounts must be non-negative';
  end if;

  select listing.*
    into v_listing
  from public.source_listings as listing
  where listing.workspace_id = p_workspace_id
    and listing.id = p_listing_id
  for update;

  if not found then
    raise exception using errcode = '22023', message = 'Listing was not found in this workspace';
  end if;

  insert into public.listing_field_events (
    workspace_id, listing_id, field_key, old_value, new_value, actor_id
  )
  select p_workspace_id, p_listing_id, changes.field_key, changes.old_value, changes.new_value, v_actor_id
  from (values
    ('expected_rent_pln', to_jsonb(v_listing.expected_rent_pln), to_jsonb(p_expected_rent_pln)),
    ('admin_fees_pln', to_jsonb(v_listing.admin_fees_pln), to_jsonb(p_admin_fees_pln)),
    ('renovation_cost_pln', to_jsonb(v_listing.renovation_cost_pln), to_jsonb(p_renovation_cost_pln)),
    ('acquisition_cost_pln', to_jsonb(v_listing.acquisition_cost_pln), to_jsonb(p_acquisition_cost_pln))
  ) as changes(field_key, old_value, new_value)
  where changes.old_value is distinct from changes.new_value;

  update public.source_listings as listing
  set expected_rent_pln = p_expected_rent_pln,
      admin_fees_pln = p_admin_fees_pln,
      renovation_cost_pln = p_renovation_cost_pln,
      acquisition_cost_pln = p_acquisition_cost_pln,
      updated_at = now()
  where listing.workspace_id = p_workspace_id
    and listing.id = p_listing_id;
end;
$$;

revoke all on function public.save_listing_investment_inputs(uuid, uuid, bigint, bigint, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.save_listing_investment_inputs(uuid, uuid, bigint, bigint, bigint, bigint)
  to authenticated;
