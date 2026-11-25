-- Patch 33 (Nov 25, 2026): shadow DAY trials -- complete shadow, never read
-- by the app's verdicts, Scorecard or learning loop. One row per ticker per
-- twice-a-day run (7:17 / 9:00 AM PT): the snapshot, every frozen trial's DAY
-- call (shadow-trials.ts, version S-1) and, after the close, each trial's grade.
-- Service-role only. Run each step as its own execution.

-- Step 1
create table if not exists public.shadow_day_trials (
  id              bigserial primary key,
  run_date        date        not null,
  slot            text        not null,
  ticker          text        not null,
  run_at          timestamptz not null default now(),
  read_at         timestamptz not null,
  entry_price     numeric     not null,
  due_at          timestamptz not null,
  version         text        not null,
  snapshot        jsonb       not null,
  trials          jsonb       not null,
  close_price     numeric,
  return_pct      numeric,
  normal_move_pct numeric,
  grades          jsonb,
  graded_at       timestamptz,
  unique (run_date, slot, ticker)
);
create index if not exists shadow_day_trials_due_idx on public.shadow_day_trials (due_at) where graded_at is null;

-- Step 2 (separate execution)
alter table public.shadow_day_trials disable row level security;

-- Step 3 (separate execution)
revoke all on public.shadow_day_trials from anon, authenticated;
revoke all on sequence public.shadow_day_trials_id_seq from anon, authenticated;
grant select, insert, update, delete on public.shadow_day_trials to service_role;
grant usage, select on sequence public.shadow_day_trials_id_seq to service_role;

-- Verify: zero rows
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema='public' and table_name='shadow_day_trials' and grantee in ('anon','authenticated');
