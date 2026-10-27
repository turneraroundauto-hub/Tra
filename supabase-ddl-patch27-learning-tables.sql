-- Patch 27 (Oct 27, 2026): the app learning from its own tables.
-- signal_stats = Stage 1 signal report (hit rate per input value, DAY and
-- LONG calls separately). tuning_runs = Stage 2 shadow tuner (past DAY calls
-- re-run under other settings and graded). Both written by Tra's nightly job
-- with the service_role key; record only -- nothing reads them to change a
-- verdict. Mr. T approves any setting change by hand.

-- Step 1: tables.
create table if not exists public.signal_stats (
  call_type    text not null,      -- 'day' | 'long'
  signal       text not null,      -- e.g. 'g3_bars', 'options_lean', 'weekday'
  value        text not null,
  n            integer not null,   -- graded calls with this value
  pct          numeric,            -- % right (MARGINAL = half credit)
  avg_move_pct numeric,            -- average move in the call's direction
  window_days  integer,
  computed_at  timestamptz not null default now(),
  primary key (call_type, signal, value)
);
create table if not exists public.tuning_runs (
  id               bigserial primary key,
  run_at           timestamptz not null default now(),
  param            text not null,  -- 'live' | 'bar_schedule' | 'bar_share' | 'lean_band'
  candidate        text not null,
  is_live          boolean not null default false,
  n_calls          integer,        -- DAY-eligible calls replayed
  n_changed        integer,        -- calls whose DAY call differs from live
  n_dir            integer,
  pct_dir          numeric,
  n_flat           integer,
  pct_flat         numeric,
  early_pct        numeric,
  late_pct         numeric,
  delta_vs_live    numeric,
  margin           numeric,
  meets_guardrails boolean not null default false,
  note             text
);

-- Step 2 (run separately, after step 1): service-role only.
alter table public.signal_stats disable row level security;
alter table public.tuning_runs disable row level security;
revoke all on public.signal_stats from anon, authenticated;
revoke all on public.tuning_runs from anon, authenticated;
revoke all on sequence public.tuning_runs_id_seq from anon, authenticated;

-- Verify (zero rows):
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--  where table_schema='public' and table_name in ('signal_stats','tuning_runs')
--    and grantee in ('anon','authenticated');
