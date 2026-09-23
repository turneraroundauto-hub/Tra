-- Real migration, applied live via Supabase MCP (project oinomcikdyisrbfeeirp);
-- this file documents what was applied.
--
-- Direct correction of patch19: "I specifically asked for PACIFIC TIME! IN
-- THIS THREAD... this is exactly what I'm talking about!" -- patch19 built
-- first_seen_et/last_seen_et in Eastern Time (matching this app's usual
-- market-hours convention everywhere else), but Pacific Time was what was
-- actually asked for. This admin/analytics table has nothing to do with
-- market hours -- it exists for Mr. T's own reading of the device_visits
-- table -- so there was never a reason to default to the app's ET
-- convention here in the first place.
--
-- Renames first_seen_et/last_seen_et -> first_seen_pt/last_seen_pt and
-- recomputes both from the real (UTC) timestamptz columns in
-- America/Los_Angeles instead of America/New_York. The underlying
-- first_seen_at/last_seen_at columns are completely untouched -- only the
-- two human-readable text siblings change.
--
-- server.js's etTimestampStr() helper is renamed to ptTimestampStr()
-- (America/Los_Angeles, "PT" suffix) and /device-ping's upsert now writes
-- first_seen_pt/last_seen_pt instead of the old et columns.
alter table public.device_visits rename column first_seen_et to first_seen_pt;
alter table public.device_visits rename column last_seen_et to last_seen_pt;

update public.device_visits
set first_seen_pt = to_char(first_seen_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI:SS') || ' PT',
    last_seen_pt  = to_char(last_seen_at  at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI:SS') || ' PT';

comment on column public.device_visits.first_seen_pt is
  'Human-readable Pacific-time sibling of first_seen_at (which stays UTC, standard timestamptz behavior). Pacific, not Eastern -- this admin table is not tied to market hours.';
comment on column public.device_visits.last_seen_pt is
  'Human-readable Pacific-time sibling of last_seen_at (which stays UTC, standard timestamptz behavior). Pacific, not Eastern -- this admin table is not tied to market hours.';

-- Verified directly against the real, live rows after running, not just
-- trusted from the migration's own success flag: a row with
-- first_seen_at = 2026-09-23 01:47:18+00 correctly shows
-- first_seen_pt = "2026-09-22 18:47:18 PT" (UTC-7, PDT, correct for late
-- September). Re-ran the standard grants-check query immediately after
-- (per the Sep 17, 2026 device_visits incident, since this migration
-- alters device_visits itself): zero anon/authenticated rows, unchanged.
--
--   select grantee, table_name, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'device_visits'
--     and grantee in ('anon','authenticated');
