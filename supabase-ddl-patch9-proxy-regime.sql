-- Trade Tribunal — Patch 9 (Proposal 3: Fixed-Proxy Regime Validation)
-- Run manually in the Supabase SQL editor before deploying this server.js
-- to Render. Matches the existing proxy_resolution table's style (bigint
-- id, one row per ticker, upserted on recompute).
--
-- Problem: gates-extended.js's regimeValidation()/resolveFixedProxyBreak()
-- have existed since Patch 4 but were never wired up — they need a place
-- to persist state on a weekly cadence (lighter than Patch 2's quarterly
-- dynamic-proxy recompute, since this is a health check on the fixed
-- Taiwan/Korea proxy assignment itself, not a full re-derivation).
--
-- server.js guards every query with `if (!supabase) return` and wraps in
-- try/catch, so the app boots and runs fine (regime always resolves to
-- null, meaning "no regime signal, proceed normally") even before this
-- table exists — but the actual weekly health check won't persist across
-- requests/deploys until it's created.

-- ── STEP 1 — run this first ─────────────────────────────────────────
create table if not exists public.proxy_regime_state (
  id           bigint generated always as identity primary key,
  ticker       text not null unique,
  state        text not null,  -- INTACT | DEGRADING | BROKEN | UNKNOWN
  action       text,           -- NONE | REQUIRE_COHERENCE_CHECK | SUSPEND_FORCEDOWN_AND_RERESOLVE
  rolling_r    double precision,
  baseline_r   double precision,
  computed_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index if not exists proxy_regime_state_ticker_idx on public.proxy_regime_state (ticker);

-- ── STEP 2 — run this SECOND, as its own separate execution ────────
-- Confirmed on this project (Aug 4, 2026, patch8): bundling this in the
-- same script/run as the CREATE TABLE above does not reliably stick — the
-- table still shows RLS-enabled/"Restricted" afterward. Running it as its
-- own statement, after the table already exists, is what actually disables
-- it. Match subscribers/credits/watchlists/proxy_resolution/accuracy_log —
-- server-only access via the service_role key.
alter table public.proxy_regime_state disable row level security;

-- "RLS disabled" alone is NOT sufficient on this project — confirmed Aug 4,
-- 2026 that anon/authenticated ended up with full SELECT/INSERT/UPDATE/
-- DELETE on other tables despite RLS being off (their default grants,
-- never explicitly revoked). This revoke is what actually closes it.
revoke all on public.proxy_regime_state from anon, authenticated;

-- Verify the revoke actually took (zero rows back is the only thing that
-- confirms it — "RLS shows disabled in the dashboard" does not):
--   select grantee, table_name, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'proxy_regime_state'
--     and grantee in ('anon','authenticated');

-- Must be added to Data API -> Exposed tables in the Supabase dashboard
-- (same Apr 2026 breaking change documented in the Build Log for every
-- other table here — new tables are opt-in unless "Automatically expose
-- new tables" is already toggled on for this project).
