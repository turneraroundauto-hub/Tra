-- Patch 28 (Oct 27, 2026): Proposal 7 Gate-Override Audit Trail.
-- One row per Aggression Dial change. Observational only: nothing reads
-- this to block a dial move or change a verdict. Written by Tra with the
-- service_role key: source 'app' from POST /dial-change (the client only
-- sends where the dial landed; the server fills in from_position), source
-- 'rebuilt' from the nightly gap-fill that infers missed changes from each
-- account's verdict_log sequence (changed_after..changed_at brackets when
-- the move happened).

-- Step 1: table.
create table if not exists public.dial_changes (
  id             bigserial primary key,
  user_email     text not null,
  tier           text,
  from_position  text,             -- null = no earlier position known
  to_position    text not null,
  direction      text,             -- 'more_aggressive' | 'more_passive' | null
  source         text not null check (source in ('app', 'rebuilt')),
  changed_at     timestamptz not null default now(),
  changed_after  timestamptz,      -- rebuilt rows: last evidence of the old position
  changed_pt     text,             -- plain Pacific-time copy, like device_visits
  created_at     timestamptz not null default now()
);
create index if not exists dial_changes_user_time on public.dial_changes (user_email, changed_at);

-- Step 2 (run separately, after step 1): service-role only.
alter table public.dial_changes disable row level security;
revoke all on public.dial_changes from anon, authenticated;
revoke all on sequence public.dial_changes_id_seq from anon, authenticated;

-- Verify (zero rows):
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--  where table_schema='public' and table_name='dial_changes' and grantee in ('anon','authenticated');
