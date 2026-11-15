alter table public.sync_runs
  add column duration_ms integer check (duration_ms is null or duration_ms >= 0);

alter table public.sync_source_runs
  add column duration_ms integer check (duration_ms is null or duration_ms >= 0),
  add column skipped_counts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(skipped_counts) = 'object');

alter table public.source_listings
  add column price_per_m2 numeric generated always as (
    price_pln::numeric / area_m2
  ) stored,
  add column has_image boolean generated always as (
    image_original_url is not null or image_storage_path is not null
  ) stored;

create index source_listings_workspace_price_per_m2_idx
  on public.source_listings (workspace_id, price_per_m2)
  where price_per_m2 is not null;

create index source_listings_workspace_has_image_idx
  on public.source_listings (workspace_id, has_image)
  where has_image;

create table public.worker_run_locks (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  lock_key text not null check (length(lock_key) between 1 and 240),
  lease_owner uuid not null,
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, lock_key)
);

alter table public.worker_run_locks enable row level security;
revoke all on table public.worker_run_locks from public, anon, authenticated;
grant select, insert, update, delete on public.worker_run_locks to service_role;

create or replace function public.try_acquire_worker_lock(
  p_workspace_id uuid,
  p_lock_key text,
  p_lease_owner uuid,
  p_lease_seconds integer default 1800
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_acquired boolean;
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'lease duration must be between 30 and 3600 seconds';
  end if;

  insert into public.worker_run_locks (
    workspace_id, lock_key, lease_owner, lease_expires_at
  ) values (
    p_workspace_id,
    p_lock_key,
    p_lease_owner,
    pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds)
  )
  on conflict (workspace_id, lock_key) do update
    set lease_owner = excluded.lease_owner,
        lease_expires_at = excluded.lease_expires_at
    where public.worker_run_locks.lease_expires_at <= pg_catalog.now()
       or public.worker_run_locks.lease_owner = excluded.lease_owner
  returning true into v_acquired;

  return coalesce(v_acquired, false);
end;
$$;

create or replace function public.release_worker_lock(
  p_workspace_id uuid,
  p_lock_key text,
  p_lease_owner uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_released boolean;
begin
  delete from public.worker_run_locks
  where workspace_id = p_workspace_id
    and lock_key = p_lock_key
    and lease_owner = p_lease_owner
  returning true into v_released;

  return coalesce(v_released, false);
end;
$$;

revoke all on function public.try_acquire_worker_lock(uuid, text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.release_worker_lock(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.try_acquire_worker_lock(uuid, text, uuid, integer)
  to service_role;
grant execute on function public.release_worker_lock(uuid, text, uuid)
  to service_role;
