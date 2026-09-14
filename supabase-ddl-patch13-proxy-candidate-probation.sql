-- Trade Tribunal — Patch 13 (Candidate Probation for dynamically-resolved proxies)
-- Already applied directly via the Supabase MCP connection (Sep 13, 2026) —
-- this file documents that change for the repo history, same convention as
-- every other supabase-ddl-patch*.sql file here.
--
-- Problem: "if a ticker breaks proxy there should be a search for new
-- placeholder that would need to earn sustainable correlation" (direct
-- request). The Dynamic Proxy Resolution Algorithm (resolveFixedProxyBreak)
-- already finds a real replacement proxy that clears the correlation floor,
-- but buildDynamicProxyRule() reported ANY 'primary'-tier find as fully
-- trusted immediately — forceDown authority and all — off a single
-- snapshot. proxy_resolution needs to track a consecutive-confirmation
-- streak per ticker so a fresh candidate can be reported as unproven
-- ("candidate" tier, no forceDown authority, QUARTER sizing) until the SAME
-- symbol has cleared the primary floor on PROXY_CANDIDATE_REQUIRED_CONFIRMS
-- consecutive checks — resetting to 0 on any regression below the floor, or
-- to 1 if a DIFFERENT candidate symbol wins the next check.

alter table public.proxy_resolution
  add column if not exists candidate_confirms integer not null default 0,
  add column if not exists candidate_since timestamptz;

-- No RLS/grants change needed — this table was already locked down (RLS
-- disabled, anon/authenticated revoked) since the Aug 4, 2026 grants sweep;
-- adding plain columns to an existing table doesn't reopen either. Confirmed
-- zero rows on the standard grants-check query immediately after running
-- the ALTER:
--   select grantee, table_name, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'proxy_resolution'
--     and grantee in ('anon','authenticated');

-- Existing rows (computed before this shipped) have candidate_confirms = 0,
-- candidate_since = NULL. getCachedProxyResolution()'s own cache-read
-- treats an unpromoted row as due for a re-check on the shorter weekly
-- (not quarterly) cadence, so an old 'primary' row that predates this
-- feature self-heals into the probation flow on its next natural check —
-- no backfill needed.
