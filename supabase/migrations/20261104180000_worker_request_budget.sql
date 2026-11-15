alter table public.sync_source_runs
  add column request_count integer not null default 0
    check (request_count >= 0);
