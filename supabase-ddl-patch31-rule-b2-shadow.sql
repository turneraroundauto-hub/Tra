-- patch31 (Nov 2, 2026): rule B-2 shadow + anonymous de-dup (Mr. T approved B-2).
-- Shadow only: logs what the frozen trend filter (ah.ruleB2) would make the
-- LONG call, and grades it with the same 5+14 rule. Live calls are unchanged.
-- device_id lets anonymous Free calls follow "last call of the day counts"
-- per device. verdict_log is service-role only; no grant change.

-- Step 1
alter table public.verdict_log
  add column if not exists long_b2_verdict text,
  add column if not exists long_b2_check smallint,
  add column if not exists long_b2_range_pos numeric,
  add column if not exists long_b2_trend text,
  add column if not exists long_b2_version text,
  add column if not exists grade_long_b2 text,
  add column if not exists device_id text;

-- Verify (both directions):
-- select grantee, privilege_type from information_schema.role_table_grants
-- where table_schema='public' and table_name='verdict_log'
--   and grantee in ('anon','authenticated','service_role');
