-- Sep 29, 2026: trade-path grading + per-ticker FLAT band.
-- path_outcome:    TARGET / STOP / NEITHER (UP/DOWN verdicts only)
-- path_return_pct: the trade's return, signed in the verdict's favor
-- flat_band_pct:   half the ticker's 20-session average daily move (FLAT only)
-- Applied via Supabase MCP; verdict_log grants re-checked (zero anon/authenticated rows).
alter table public.verdict_log
  add column if not exists path_outcome text,
  add column if not exists path_return_pct numeric,
  add column if not exists flat_band_pct numeric;
