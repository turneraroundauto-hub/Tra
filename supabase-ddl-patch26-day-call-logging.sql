-- Patch 26 (Oct 27, 2026): log and grade the DAY call on its own.
-- Until now only the Long call was stored; the Scorecard's Day tile graded
-- that Long call at the day's close. The DAY call (Pro, Gate 3 window) now
-- gets its own verdict, entry and grade so the Day tile measures it.
-- Apply BEFORE the code that writes these columns deploys (an insert naming
-- an unknown column fails and the verdict would not be logged).
alter table public.verdict_log
  add column if not exists day_verdict text,
  add column if not exists day_sizing text,
  add column if not exists day_issued_at timestamptz,
  add column if not exists day_entry_price numeric,
  add column if not exists grade_day_call text,
  add column if not exists return_day_call_pct numeric,
  add column if not exists graded_at_day_call timestamptz;

-- Links a pending DAY read to the verdict_log row it refines
-- (-1 = backfill looked and found no row).
alter table public.day_refinement_jobs
  add column if not exists verdict_log_id bigint;

-- Adding columns doesn't change grants; verify anyway (zero rows):
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--  where table_schema='public' and table_name in ('verdict_log','day_refinement_jobs')
--    and grantee in ('anon','authenticated');
