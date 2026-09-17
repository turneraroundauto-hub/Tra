-- Trade Tribunal — Patch 16 (anonymous per-device visit counting)
--
-- Built to answer one direct question honestly: how many different phones
-- actually access the app, without phishing or asking anyone for anything.
-- The `credits` table's `ip:<address>` keys turned out to badly overcount
-- real people once checked — a phone on T-Mobile's CGNAT gets a new public
-- IP every time it hops a cell tower (confirmed live: ~18% of "unique"
-- anonymous IPs fell inside one /13 carrier block). This table counts a
-- stable, app-generated per-device id instead — see shared/device-id.ts for
-- exactly what it does, and just as importantly, does NOT collect (no IP,
-- no user-agent, no email — device_id is a random UUID the client
-- generates itself and keeps in localStorage, not derived from anything
-- personal).

-- ── STEP 1 — run this first ─────────────────────────────────────────
create table if not exists public.device_visits (
  device_id     text primary key,
  platform      text not null default 'web' check (platform in ('web', 'twa')),
  first_tier    text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  visit_count   integer not null default 1
);

comment on table public.device_visits is
  'Anonymous per-device visit counter. device_id is a random UUID the client generates and stores in localStorage. No IP, user-agent, or email is ever stored here.';

-- ── STEP 2 — run this SECOND, as its own separate execution ────────
-- Confirmed on this project (Aug 4, 2026, patch8): bundling this in the
-- same script/run as the CREATE TABLE above does not reliably stick.
-- Running it as its own statement, after the table already exists, is what
-- actually disables it. Same server-only-via-service_role pattern as every
-- other table here.
alter table public.device_visits disable row level security;

-- "RLS disabled" alone is NOT sufficient on this project — anon/
-- authenticated can end up with full SELECT/INSERT/UPDATE/DELETE on a table
-- despite RLS being off (default grants, never explicitly revoked). This
-- revoke is what actually closes it — the app itself only ever writes
-- through the service_role key server-side, so anon/authenticated need
-- zero access.
revoke all on public.device_visits from anon, authenticated;

-- Verify the revoke actually took (zero rows back is the only thing that
-- confirms it):
--   select grantee, table_name, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'device_visits'
--     and grantee in ('anon','authenticated');

-- Must be added to Data API -> Exposed tables in the Supabase dashboard
-- (same opt-in-new-tables behavior documented for every other table here)
-- before Tra's service-role client can read/write it.
