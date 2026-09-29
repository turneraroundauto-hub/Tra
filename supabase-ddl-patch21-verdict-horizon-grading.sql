-- Patch 21 (trade-verdict patch23) (Sep 29, 2026): horizon grading + market-hours flag on verdict_log.
--
-- issued_market_open: was the regular session open when the verdict was
--   issued? Off-hours verdicts (pre-market, after close, weekends,
--   holidays) are kept for the record but excluded from every accuracy stat.
-- horizon_*: each market-hours verdict is graded at the close of the
--   session matching the user's Aggression Dial (0 = same session,
--   1 = next, 2, or 5 sessions out). grade_horizon is what every accuracy
--   stat reads; the older 24h/5-trading-day grades stay for the record.
-- Existing rows are backfilled by the server's grading sweep
-- (backfillHorizonFields), not here, so history and new rows share one rule.
alter table public.verdict_log
  add column if not exists issued_market_open        boolean,
  add column if not exists horizon_sessions          integer,
  add column if not exists horizon_target_date       date,
  add column if not exists horizon_due_at            timestamptz,
  add column if not exists grade_horizon             text,
  add column if not exists actual_return_pct_horizon numeric,
  add column if not exists graded_at_horizon         timestamptz;

create index if not exists verdict_log_horizon_due_idx
  on public.verdict_log (horizon_due_at)
  where issued_market_open = true and graded_at_horizon is null;

-- Service-role only, same as every other table here. Adding columns
-- doesn't change grants, but re-check anyway (must return zero rows):
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema='public' and table_name='verdict_log'
--    and grantee in ('anon','authenticated');
