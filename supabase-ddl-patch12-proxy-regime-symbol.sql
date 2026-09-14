-- Trade Tribunal — Patch 12 (generalized Fixed-Proxy Regime Validation)
-- Already applied directly via the Supabase MCP connection (Sep 13, 2026) —
-- this file documents that change for the repo history, same convention as
-- every other supabase-ddl-patch*.sql file here.
--
-- Problem: resolveProxyRegime() (Proposal 3, patch9) was hardcoded to
-- correlate every ticker against TSM, because it only ever ran for the
-- Taiwan/Korea AI/Semiconductor static category. Generalizing it to run for
-- every static PROXY_RULES category (Fintech/Crypto vs BTC+QQQ, BDC/REIT/
-- Income vs IWM+SPY, etc.) means proxy_regime_state now needs to record
-- WHICH proxy symbol a row's correlation was actually computed against —
-- without it, a later reclassification (a ticker's category/proxy
-- assignment changing) could silently reuse a stale cached correlation
-- computed against a now-wrong instrument.

alter table public.proxy_regime_state add column if not exists proxy_symbol text;

-- No RLS/grants change needed — this table was already locked down (RLS
-- disabled, anon/authenticated revoked) by patch9; adding a plain column
-- to an existing table doesn't reopen either. Re-confirmed zero rows on the
-- standard grants-check query immediately after running the ALTER:
--   select grantee, table_name, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'proxy_regime_state'
--     and grantee in ('anon','authenticated');

-- Existing rows (computed before this shipped, e.g. ALAB's real Sep 10,
-- 2026 row) have proxy_symbol = NULL. resolveProxyRegime()'s own cache-read
-- treats a NULL/mismatched proxy_symbol as a cache miss and recomputes once
-- — self-healing, no backfill needed, same "one extra Alpaca call the
-- first time after deploy" cost as any other weekly-cadence cache miss.
