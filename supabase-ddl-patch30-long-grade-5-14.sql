-- patch30 (Nov 1, 2026): LONG grade = 5th AND 14th session, one merged grade
-- (Mr. T's rules, ah.gradeLongCall): UP >+2% at 5 and >=+3% at 14; DOWN <+1%
-- at both; FLAT within normal daily move x sqrt(sessions) at both. Every past
-- LONG grade is re-graded by the sweep; the old 5-session grades are kept in
-- *_v1 columns for comparison. verdict_log is service-role only; no grant change.

-- Step 1: new columns
alter table public.verdict_log
  add column if not exists long14_target_date date,
  add column if not exists long14_due_at timestamptz,
  add column if not exists return_long14_pct numeric,
  add column if not exists grade_long_v1 text,
  add column if not exists return_long_pct_v1 numeric;

-- Step 2: keep the old grades, then clear them so the sweep re-grades everything.
-- long14_* are stamped by backfillDayLongFields() on the next sweep.
update public.verdict_log
set grade_long_v1 = grade_long, return_long_pct_v1 = return_long_pct
where grade_long is not null or graded_at_long is not null;

update public.verdict_log
set grade_long = null, return_long_pct = null, graded_at_long = null
where graded_at_long is not null;

-- Verify (both directions):
-- select grantee, privilege_type from information_schema.role_table_grants
-- where table_schema='public' and table_name='verdict_log'
--   and grantee in ('anon','authenticated','service_role');
