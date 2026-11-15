-- Trusted local workers may create an isolated workspace for invitation and RLS checks.
-- Authenticated users still have no INSERT grant on public.workspaces.
grant select, insert, update on public.workspaces to service_role;
