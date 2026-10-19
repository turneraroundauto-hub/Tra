-- Patch 24 (Oct 19, 2026): Gate 3 rolling window + Day verdict, Pro beta.
-- Run each STEP as its own execution (see CLAUDE.md: bundling the RLS
-- change with the create table didn't stick on this project before).

-- STEP 1: pending Day reads (an ANALYZE tapped before the 3rd 15-min bar
-- closes). Service-role only. One row per user+ticker+dial per trading day.
create table if not exists public.day_refinement_jobs (
  wkey        text not null,
  date_et     text not null,
  user_key    text not null,
  user_id     text,
  ticker      text not null,
  long        jsonb not null,
  ready_at    timestamptz not null,
  status      text not null default 'PENDING',
  window_block jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (wkey, date_et)
);

-- STEP 2 (separate run)
alter table public.day_refinement_jobs disable row level security;

-- STEP 3 (separate run) -- RLS disabled alone does NOT block the anon key.
revoke all on public.day_refinement_jobs from anon, authenticated;
-- Verify: zero rows back.
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema='public' and table_name='day_refinement_jobs'
--    and grantee in ('anon','authenticated');

-- STEP 4: Supabase Realtime private channel for the Day push. The server
-- broadcasts to topic 'day:<auth uid>'; this policy lets a signed-in user
-- receive ONLY their own topic. No other realtime.messages policy exists.
create policy "day_read_own_topic" on realtime.messages
  for select to authenticated
  using ( realtime.topic() = 'day:' || (select auth.uid())::text
          and realtime.messages.extension = 'broadcast' );
