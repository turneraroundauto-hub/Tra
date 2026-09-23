-- Real migration, applied live via Supabase MCP (project oinomcikdyisrbfeeirp);
-- this file documents what was applied.
--
-- The multi-account re-keying below (device_id, user_email) is still the
-- real, current schema and is NOT reversed by anything later. Only the
-- first_seen_et/last_seen_et columns this migration created are stale --
-- patch20 renames them to first_seen_pt/last_seen_pt and recomputes them
-- in Pacific Time (Eastern was wrong; see patch20's own header for why).
-- Kept as-is rather than edited or deleted, since it's real applied
-- history, not dead state.
--
-- Supersedes patch18 (device_accounts): direct correction, verbatim --
-- "I specifically ask you to change the timestamps and the user email
-- correlation in the device visit table. NO OTHER TABLE WAS MENTIONED."
-- The separate device_accounts table from patch18 was a reasonable design
-- on its own, but it wasn't what was asked for -- the multi-account fix and
-- the ET-display fix both belong inside device_visits itself. This
-- migration folds device_accounts back into device_visits and drops it.
--
-- device_visits used to be keyed by device_id alone, with a single
-- user_email column holding whichever account last pinged -- so a shared/
-- multi-account device silently lost the earlier account's association the
-- moment a second account signed in. Re-keyed to (device_id, user_email):
-- an anonymous ping now writes '' (empty string, not NULL -- Postgres
-- treats every NULL as distinct within a unique/PK constraint, which would
-- insert a fresh "anonymous" row on every single anonymous ping instead of
-- updating one running counter) for user_email; a signed-in ping writes the
-- real account email. A device used by 2+ accounts now gets one row per
-- account, never collapsing one login's history into another's.
--
-- first_seen_et/last_seen_et: plain Eastern-time text columns, written
-- directly on device_visits by device-ping's own etTimestampStr() helper
-- (server.js) alongside the real (always-UTC) timestamptz columns -- so the
-- table itself reads in ET without depending on Supabase Studio's own
-- display settings, which is what was actually being seen as "still UTC."
--
-- Steps, in the order actually run (order matters: the composite primary
-- key has to exist BEFORE migrating in a second row per device, or the old
-- device_id-only primary key rejects the second row):
--   1. Add first_seen_et/last_seen_et text columns.
--   2. Normalize existing NULL user_email rows to '' , then set
--      default ''/not null.
--   3. Drop the old device_id-only primary key, add the new
--      (device_id, user_email) composite primary key.
--   4. Migrate any device_accounts row not already represented in
--      device_visits under the same (device_id, user_email) pair (a
--      device_accounts row that already matched device_visits' existing
--      last-known-account row was a pure duplicate and was skipped).
--   5. Backfill first_seen_et/last_seen_et for every row.
--   6. Drop device_accounts.
--
-- Confirmed via direct query immediately after: the one real multi-account
-- device (turneraroundauto@gmail.com + j_m_turner@outlook.com sharing one
-- device) now shows BOTH rows in device_visits itself, with real ET
-- timestamps ("2026-09-22 21:47:18 ET" etc., not "+00"). device_accounts
-- confirmed dropped (to_regclass returns null). Standard grants-check query
-- re-run immediately after (per the Sep 17, 2026 device_visits incident,
-- since this migration alters device_visits itself): zero anon/authenticated
-- rows, unchanged.
alter table public.device_visits add column if not exists first_seen_et text;
alter table public.device_visits add column if not exists last_seen_et text;

update public.device_visits set user_email = '' where user_email is null;
alter table public.device_visits alter column user_email set default '';
alter table public.device_visits alter column user_email set not null;

alter table public.device_visits drop constraint device_visits_pkey;
alter table public.device_visits add primary key (device_id, user_email);

insert into public.device_visits (device_id, user_email, first_seen_at, last_seen_at, visit_count, platform, first_tier)
select da.device_id, da.user_email, da.first_seen_at, da.last_seen_at, da.visit_count,
       coalesce(dv.platform, 'web'), dv.first_tier
from public.device_accounts da
left join public.device_visits dv on dv.device_id = da.device_id
where not exists (
  select 1 from public.device_visits dv2
  where dv2.device_id = da.device_id and dv2.user_email = da.user_email
);

update public.device_visits
set first_seen_et = to_char(first_seen_at at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') || ' ET',
    last_seen_et  = to_char(last_seen_at  at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') || ' ET'
where first_seen_et is null or last_seen_et is null;

drop table public.device_accounts;

comment on table public.device_visits is
  'Anonymous per-device visit counter, one row per (device_id, user_email) pair -- an anonymous ping uses the empty-string sentinel for user_email, a signed-in ping uses the real account email, so a device used by 2+ accounts gets a row per account rather than collapsing to the last one. device_id is a random UUID the client generates and stores in localStorage. No IP, user-agent is ever stored here. first_seen_et/last_seen_et are plain Eastern-time text siblings of the real (UTC) timestamptz columns, for reading directly in the table editor.';

comment on column public.device_visits.user_email is
  'The signed-in account this row belongs to, or '''' for the device''s own anonymous activity. Part of the primary key alongside device_id -- never overwritten by a different account, never collapsed.';

-- Re-verify after running, same standing rule as every service-role table
-- in this project:
--
--   select grantee, table_name, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'device_visits'
--     and grantee in ('anon','authenticated');
--
-- Zero rows is the only thing that actually confirms it.
