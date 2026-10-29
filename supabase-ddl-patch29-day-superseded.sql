-- patch29 (Oct 29, 2026): DAY calls survive a later same-day LONG-only re-run.
-- "Last call of the day wins" (superseded) stays the LONG rule. A re-run
-- after the 12:30 ET DAY cutoff has no DAY call, so it no longer wipes the
-- morning's DAY call: day_superseded marks a DAY call only when a later
-- same-day row (same ticker + account, same UTC day as supersedeSameDayVerdicts)
-- has its own DAY call. Set by markDaySuperseded() in server.js.
-- verdict_log is an existing service-role-only table; no grant change.

-- Step 1
alter table public.verdict_log
  add column if not exists day_superseded boolean not null default false;

-- Step 2 (backfill): earlier DAY calls replaced by a later same-day DAY call.
update public.verdict_log a
set day_superseded = true
where a.day_verdict is not null
  and a.user_email is not null
  and exists (
    select 1 from public.verdict_log b
    where b.ticker = a.ticker and b.user_email = a.user_email
      and b.day_verdict is not null and b.issued_at > a.issued_at
      and date_trunc('day', b.issued_at at time zone 'UTC') = date_trunc('day', a.issued_at at time zone 'UTC')
  );

-- Verify (both directions):
-- select grantee, privilege_type from information_schema.role_table_grants
-- where table_schema='public' and table_name='verdict_log'
--   and grantee in ('anon','authenticated','service_role');
