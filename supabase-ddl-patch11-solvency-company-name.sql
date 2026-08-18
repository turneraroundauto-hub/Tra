-- Trade Tribunal — Patch 11 (Pre-Gate solvency: store the matched filing's
-- own reported company name)
-- Run manually in the Supabase SQL editor before deploying this server.js
-- to Render.
--
-- Problem: MU (Micron, a real, healthy company) got persistently flagged
-- with a fabricated solvency hard trigger, while XTI (a genuinely
-- distressed ticker, confirmed via a real quoted 10-K) stayed GREEN --
-- live evidence that a solvency search hit can get attributed to the
-- WRONG company. server.js now cross-checks a matched filing's own
-- reported company name (SEC's `display_names` field) against the ticker's
-- expected company (from SEC's own ticker map) before ever flagging --
-- see checkHitCompanyMatch()/companyNamesLikelyMatch() -- and stores the
-- matched company name alongside the flag so a mismatch (or a legitimate
-- match) stays visible directly in the app's own Pre-Gate note, not just
-- in Render logs.
--
-- server.js guards every query with `if (!supabase) return`, so the app
-- boots and runs fine (the new column is simply never populated/read)
-- even before this patch runs -- but the company-name visibility this
-- adds won't show up in the app until it's applied.

alter table public.pre_gate_solvency_state
  add column if not exists trigger_company_name text;

-- Immediate remediation for the MU false positive reported live (Aug 18,
-- 2026) -- clears the bad flag so MU stops forcing DOWN. Safe to run
-- regardless of whether the root cause has been fully confirmed yet: if
-- MU ever has a real solvency trigger in the future, the app will
-- re-flag it on its own, now with the cross-company guard in place.
delete from public.pre_gate_solvency_state where ticker = 'MU';
