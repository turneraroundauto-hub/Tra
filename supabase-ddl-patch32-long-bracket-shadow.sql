-- patch32 (Nov 2, 2026): LONG bracket shadow, BR-1 (Mr. T approved).
-- Shadow only: logs what ah.longBracket (Gate 1 trend + Pre-Gate, scored
-- before the model runs) would make the LONG call, and grades it with the
-- same 5+14 rule. Live calls are unchanged. long_bracket_source is 'live'
-- for calls scored at issue, 'backfill' for already-graded calls scored
-- later (in-sample). verdict_log is service-role only; no grant change.
-- Run BEFORE deploying: logVerdict doesn't check the insert error, so an
-- unknown column would silently drop every verdict.

-- Step 1
alter table public.verdict_log
  add column if not exists long_bracket_verdict text,
  add column if not exists long_bracket_score smallint,
  add column if not exists long_bracket_version text,
  add column if not exists long_bracket_source text,
  add column if not exists grade_long_bracket text;

-- Verify (both directions):
-- select grantee, privilege_type from information_schema.role_table_grants
-- where table_schema='public' and table_name='verdict_log'
--   and grantee in ('anon','authenticated','service_role');
