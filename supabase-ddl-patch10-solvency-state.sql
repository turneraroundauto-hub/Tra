-- Trade Tribunal — Patch 10 (Persistent Pre-Gate Solvency Flag)
-- Run manually in the Supabase SQL editor before deploying this server.js
-- to Render. Matches proxy_regime_state's style (bigint id, one row per
-- ticker, upserted on flag/re-flag, updated in place on clearance checks).
--
-- Problem: a hard Pre-Gate solvency trigger (going-concern language,
-- bankruptcy, default, delisting) only forced DOWN as long as it stayed
-- inside the 45-day rolling EDGAR search window — a real, still-unresolved
-- distress situation would silently stop forcing anything the moment it
-- aged out, even though nothing about the company's actual condition had
-- changed. Direct instruction (Aug 18, 2026): a hard solvency trigger
-- should persist indefinitely, forcing DOWN on every analysis, until BOTH
-- (a) a subsequent 10-Q/10-K no longer contains the going-concern/distress
-- language, AND (b) a corroborated, congruent positive catalyst confirms
-- it. This table is where that flag actually lives across requests/deploys.
--
-- server.js guards every query with `if (!supabase) return null/void`, so
-- the app boots and runs fine (the persistent-flag mechanism silently
-- no-ops, meaning Pre-Gate falls back to its normal 45-day-window-only
-- behavior) even before this table exists — but the actual persistence
-- won't take effect until it's created.

-- ── STEP 1 — run this first ─────────────────────────────────────────
create table if not exists public.pre_gate_solvency_state (
  id                 bigint generated always as identity primary key,
  ticker             text not null unique,
  flagged            boolean not null default true,
  first_flagged_at   timestamptz not null default now(),
  last_checked_at    timestamptz,
  trigger_accession  text,   -- SEC filing accession that first triggered the flag
  filing_clear       boolean not null default false,
  catalyst_clear     boolean not null default false,
  cleared_at         timestamptz,
  created_at         timestamptz not null default now()
);

create index if not exists pre_gate_solvency_state_ticker_idx on public.pre_gate_solvency_state (ticker);
create index if not exists pre_gate_solvency_state_flagged_idx on public.pre_gate_solvency_state (flagged);

-- ── STEP 2 — run this SECOND, as its own separate execution ────────
-- Confirmed on this project (Aug 4, 2026, patch8): bundling this in the
-- same script/run as the CREATE TABLE above does not reliably stick — the
-- table still shows RLS-enabled/"Restricted" afterward. Running it as its
-- own statement, after the table already exists, is what actually disables
-- it. Match subscribers/credits/watchlists/proxy_resolution/accuracy_log/
-- proxy_regime_state — server-only access via the service_role key.
alter table public.pre_gate_solvency_state disable row level security;

-- "RLS disabled" alone is NOT sufficient on this project — confirmed Aug 4,
-- 2026 that anon/authenticated ended up with full SELECT/INSERT/UPDATE/
-- DELETE on other tables despite RLS being off (their default grants,
-- never explicitly revoked). This revoke is what actually closes it.
revoke all on public.pre_gate_solvency_state from anon, authenticated;

-- Verify the revoke actually took (zero rows back is the only thing that
-- confirms it — "RLS shows disabled in the dashboard" does not):
--   select grantee, table_name, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'pre_gate_solvency_state'
--     and grantee in ('anon','authenticated');

-- Must be added to Data API -> Exposed tables in the Supabase dashboard
-- (same Apr 2026 breaking change documented in the Build Log for every
-- other table here — new tables are opt-in unless "Automatically expose
-- new tables" is already toggled on for this project).
