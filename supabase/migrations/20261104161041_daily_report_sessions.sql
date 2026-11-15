alter table public.sync_runs
  drop constraint if exists sync_runs_status_check;
alter table public.sync_runs
  add constraint sync_runs_status_check
  check (status in ('running', 'success', 'partial', 'failed', 'blocked'));

create table public.daily_reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  period_start timestamptz not null,
  period_end timestamptz not null,
  generated_at timestamptz not null default now(),
  baseline boolean not null default false,
  new_listing_count integer not null default 0 check (new_listing_count >= 0),
  price_reduction_count integer not null default 0 check (price_reduction_count >= 0),
  payload_json jsonb not null default '{}'::jsonb check (jsonb_typeof(payload_json) = 'object'),
  created_at timestamptz not null default now(),
  unique (workspace_id, generated_at),
  check (period_end >= period_start)
);

create index daily_reports_workspace_generated_idx
  on public.daily_reports (workspace_id, generated_at desc);

alter table public.daily_reports enable row level security;
revoke all on table public.daily_reports from public, anon, authenticated;
grant select on public.daily_reports to authenticated;
grant select, insert, update on public.daily_reports to service_role;

create policy daily_reports_member_select on public.daily_reports
  for select to authenticated
  using ((select private.is_workspace_member(workspace_id)));
