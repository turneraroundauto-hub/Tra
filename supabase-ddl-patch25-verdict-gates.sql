-- Patch 25 (Oct 19, 2026): every gate's color on each verdict.
-- { pre_gate, sector, g1, g2, g3, g4, g5, g3_note } -- statuses only, plus
-- the G3 note (how many bars it saw). Shaped by analyze-helpers gatesForLog().
-- Applied BEFORE the code that writes it deployed (an insert naming an
-- unknown column fails and the verdict would not be logged).
alter table public.verdict_log add column if not exists gates jsonb;
-- Adding a column doesn't change grants; verify anyway (zero rows):
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema='public' and table_name='verdict_log'
--    and grantee in ('anon','authenticated');
