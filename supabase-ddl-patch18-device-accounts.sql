-- Real table, created live via Supabase MCP (project oinomcikdyisrbfeeirp)
-- and applied as this same PR's own migration; mirrored into
-- trade-verdict's supabase-ddl-patch19-device-accounts.sql (this repo's
-- own patch numbering runs independently of that repo's).
--
-- Direct report, right after patch17's device_visits.user_email
-- correlation shipped: "if a person has multiple accounts, there's a
-- duplicate collapse that removes the other login's [association]."
-- Confirmed real: device_visits is one row per device_id with a single
-- user_email column, upserted with onConflict:"device_id" and
-- user_email:req.userEmail||undefined on every signed-in ping -- so
-- Account A signing in on a device, then Account B signing in on that
-- same device later, silently overwrites A's association with zero way
-- to see it ever existed. A single column can only ever hold one email;
-- it structurally cannot represent "this device has been used by 2+
-- accounts."
--
-- device_accounts is the real record: a row per (device_id, user_email)
-- pair, never collapsed. device_visits.user_email is left completely
-- untouched (still a convenient "last known account" pointer for a quick
-- single-value lookup) -- this is a strict addition, not a replacement,
-- zero risk to anything already reading device_visits.
create table if not exists public.device_accounts (
  device_id     text not null,
  user_email    text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  visit_count   integer not null default 1,
  primary key (device_id, user_email)
);
create index if not exists device_accounts_user_email_idx on public.device_accounts (user_email);

comment on table public.device_accounts is
  'Every (device, signed-in account) pairing a device has ever pinged from, one row per pair, never overwritten -- unlike device_visits.user_email (a single last-known-account pointer), this table preserves the full account history for a shared/multi-account device.';

-- Same two-step RLS-disable + explicit-revoke pattern every service-role
-- table in this project uses -- run as its own separate step, per this
-- file's own note that bundling it into the same run as CREATE TABLE
-- hasn't reliably stuck here before.
alter table public.device_accounts disable row level security;
revoke all on public.device_accounts from anon, authenticated;

-- Confirmed via the standard grants-check query, zero rows:
--
--   select grantee, table_name, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'device_accounts'
--     and grantee in ('anon','authenticated');
--
-- Per the Sep 17, 2026 device_visits incident: if this table ever needs
-- adding to Project Settings -> Data API -> Exposed tables (unconfirmed
-- whether it does -- watch Render logs for "device_accounts" upsert
-- errors on POST /device-ping after deploy), immediately re-run the
-- query above and revoke again if anything reopens -- exposing a table
-- via Data API has been directly observed to silently re-grant
-- anon/authenticated default privileges on this project as a side effect.
