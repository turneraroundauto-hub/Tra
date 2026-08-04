-- Trade Tribunal — Patch 8 (server-side track record sync, Pro only)
-- Run manually in the Supabase SQL editor before deploying this server.js
-- to Render. Matches the existing watchlists table's style documented in
-- the Build Log (RLS disabled, service-role-only access).
--
-- Problem: the track record (tv_accuracy_log, capped at 200 entries) lives
-- only in localStorage — a browser "clear cookies and site data" wipes it
-- along with everything else, with no recovery, and it never follows a
-- user across devices.
--
-- Fix: one row per authenticated account, storing the same already-capped
-- entries array shared/track-record.js already builds. Pro-only for now —
-- only pro/app.js calls initTrackRecordSync() (shared/track-record-sync.js);
-- Free/Starter/Shark are untouched and stay localStorage-only.

-- ── STEP 1 — run this first ─────────────────────────────────────────
create table if not exists public.accuracy_log (
  id          bigint generated always as identity primary key,
  email       text not null unique,
  entries     jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists accuracy_log_email_idx on public.accuracy_log (email);

-- ── STEP 2 — run this SECOND, as its own separate execution ────────
-- Confirmed on this project (Aug 4, 2026, patch8): bundling this in the
-- same script/run as the CREATE TABLE above does not reliably stick —
-- the table still shows RLS-enabled/"Restricted" afterward. Running it
-- as its own statement, after the table already exists, is what actually
-- disables it. Match subscribers/credits/watchlists/proxy_resolution —
-- server-only access via the service_role key.
alter table public.accuracy_log disable row level security;

-- Must be added to Data API -> Exposed tables in the Supabase dashboard
-- (same Apr 2026 breaking change documented in the Build Log for every
-- other table here — new tables are opt-in unless "Automatically expose
-- new tables" is already toggled on for this project).
