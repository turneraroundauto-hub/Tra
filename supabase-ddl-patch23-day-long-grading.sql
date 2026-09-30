-- Sep 30, 2026: every market-hours verdict is graded twice, independent of the dial.
-- Day trade = close of the session it was issued in (target +4% for half credit).
-- Long      = close of the 5th session after issue  (target +16% for half credit).
-- Applied via Supabase MCP; verdict_log grants re-checked (zero anon/authenticated rows).
alter table public.verdict_log
  add column if not exists day_target_date  date,
  add column if not exists day_due_at       timestamptz,
  add column if not exists grade_day        text,
  add column if not exists return_day_pct   numeric,
  add column if not exists graded_at_day    timestamptz,
  add column if not exists long_target_date date,
  add column if not exists long_due_at      timestamptz,
  add column if not exists grade_long       text,
  add column if not exists return_long_pct  numeric,
  add column if not exists graded_at_long   timestamptz;
