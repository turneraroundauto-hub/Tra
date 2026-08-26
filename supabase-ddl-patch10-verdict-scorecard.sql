-- Trade Tribunal — Patch 10 (Proposal 7: Verdict Accuracy Scorecard +
-- Corroboration Decay Indicator)
-- Already applied directly against Supabase via MCP (Aug 26, 2026) —
-- this file documents what was run, matching the standing convention that
-- every service-role table here has a committed DDL file, even when the
-- actual apply happened through the Supabase connection rather than a
-- manual SQL-editor paste.
--
-- Patch numbers 10-11 were freed up by the Aug 18, 2026 Pre-Gate solvency
-- saga's full revert (see CLAUDE.md) — reused here rather than skipped.
--
-- Adjustments made vs. the original Notion-logged implementation plan,
-- after validating it against this app's real architecture (see
-- CLAUDE.md's Proposal 7 entry for the full reasoning):
--   1. disable RLS (two-step, its own separate execution) + explicit
--      revoke, NOT "enable RLS with no policies" — matches every other
--      service-role table in this project (subscribers/credits/
--      proxy_resolution/pre_gate_triggers/watchlists/accuracy_log/
--      proxy_regime_state), all proven to actually work this way.
--   2. corroboration_log.source is 3 values (news_match/gate3_buildup/
--      earnings_calendar), not 4 — Alpaca+Finnhub are pooled into one
--      real vote by gx.corroborateSessionContext() (N/3 math), never two
--      independently-gradable sources. Splitting them would double-count
--      what's actually one signal.
--   3. verdict_log gained issued_price (numeric) — not in the original
--      plan at all, but grading a forward return needs a reference price
--      captured at issuance; without it there's nothing to compute R
--      against later. Added before the table carried any real rows.

-- ── STEP 1 — run this first ─────────────────────────────────────────
create table if not exists public.verdict_log (
  id                          bigint generated always as identity primary key,
  ticker                      text not null,
  issued_at                   timestamptz not null default now(),
  issued_price                numeric,
  verdict                     text not null check (verdict in ('UP','DOWN','FLAT')),
  magnitude_pct               numeric,
  size_action                 text,
  crf_version                 text not null,
  pre_gate_state              text,
  gate1_branch                text,
  gate0_read                  text,
  gate2_corroboration_state   text,
  dial_position               text,
  grading_window_days         smallint not null,
  grade_due_at                timestamptz not null,
  actual_return_pct           numeric,
  grade                       text check (grade in ('TRUE','MARGINAL','FALSE')),
  graded_at                   timestamptz,
  user_email                  text,
  tier                        text not null
);

create index if not exists verdict_log_grade_due_idx on public.verdict_log (grade_due_at) where graded_at is null;
create index if not exists verdict_log_ticker_issued_idx on public.verdict_log (ticker, issued_at);
create index if not exists verdict_log_user_email_idx on public.verdict_log (user_email) where user_email is not null;
create index if not exists verdict_log_tier_grade_idx on public.verdict_log (tier, grade) where graded_at is not null;

create table if not exists public.corroboration_log (
  id                  bigint generated always as identity primary key,
  ticker              text not null,
  headline_ref        text,
  source              text not null check (source in ('news_match','gate3_buildup','earnings_calendar')),
  hit_at              timestamptz not null default now(),
  agitator_score      numeric,
  immediacy_subscore  numeric
);

create index if not exists corroboration_log_ticker_hit_idx on public.corroboration_log (ticker, hit_at desc);

-- ── STEP 2 — run this SECOND, as its own separate execution ────────
-- Confirmed on this project (Aug 4, 2026, patch8): bundling this in the
-- same script/run as the CREATE TABLE above does not reliably stick.
alter table public.verdict_log disable row level security;
alter table public.corroboration_log disable row level security;

-- "RLS disabled" alone is NOT sufficient on this project (Aug 4, 2026).
revoke all on public.verdict_log from anon, authenticated;
revoke all on public.corroboration_log from anon, authenticated;

-- Verify the revoke actually took (zero rows back is the only thing that
-- confirms it):
--   select grantee, table_name, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name in ('verdict_log','corroboration_log')
--     and grantee in ('anon','authenticated');
-- Confirmed zero rows Aug 26, 2026.

-- Must be added to Data API -> Exposed tables in the Supabase dashboard
-- (same opt-in requirement every prior table here has needed) — server.js's
-- own supabase-js calls go through PostgREST even with the service_role
-- key, so an un-exposed table silently no-ops the write path. NOT done as
-- part of this migration — flagged for Mr. T to check/toggle manually,
-- same as every prior patch's own note on this.
