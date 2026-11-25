'use strict';
/**
 * shadow-trials.ts -- the frozen DAY-call trials for the twice-a-day shadow
 * runs (Nov 25, 2026, Mr. T: "run the trials in complete shadow"). Pure logic:
 * given one snapshot of a ticker at a DAY read (the AI's own read before the
 * market rules, the live DAY call, the bars, the day so far, the price check,
 * options and trend inputs), returns every trial's DAY call. Nothing here
 * touches a live call; the runner in server.js stores the result in
 * shadow_day_trials and grades it at the close.
 *
 * Frozen as TRIALS_VERSION 'S-1'. Any change to a trial = a new version, and
 * the comparison restarts.
 *
 * Same CommonJS rule as gate3-window.ts: no import/export statements.
 */

declare var module: { exports: any };
declare var require: any;
const g3wS = require('./gate3-window');

const TRIALS_VERSION = 'S-1';

type Call = { verdict: string; sizing: string };
type Snapshot = {
  liveDay: Call | null;               // the DAY call live D-2/D-3 made from this snapshot
  aiRaw: Call | null;                 // the AI's own read, before any server market rule
  ruleFired: boolean;                 // Gate 1 breakdown / Gate 0 RED / Gate 5 / Pre-Gate overwrote the AI's read
  barsDir: number | null;             // last 3 bars: 1 GREEN, -1 RED, 0 mixed, null not read
  v2Low: { UP?: boolean; DOWN?: boolean } | null;  // price check: stock/sector already moving against
  session: { bars: number; netPct: number; direction: number } | null; // day so far
  deltaLean: number | null;           // options delta lean
  pctAbove50: number | null;          // % above the 50-day average
  g5Status: string | null;            // Gate 5 sector proxy color
};

const FLAT: Call = { verdict: 'FLAT', sizing: 'NONE' };
const DELTA_BAND = 0.15;

function barsCall(dir: number | null): Call | null {
  if (dir === null || dir === undefined) return null;
  return dir > 0 ? { verdict: 'UP', sizing: 'QUARTER' } : dir < 0 ? { verdict: 'DOWN', sizing: 'NONE' } : FLAT;
}

// Every trial's DAY call. null = the trial couldn't read (missing input).
function computeTrials(s: Snapshot): Record<string, Call | null> {
  const seq = s.barsDir === null || s.barsDir === undefined ? null : { direction: s.barsDir };
  const out: Record<string, Call | null> = {};
  // 1. Live D-2/D-3 exactly as shipped.
  out.live = s.liveDay ? { verdict: s.liveDay.verdict, sizing: s.liveDay.sizing } : null;
  // 2. AI's own read + bars + price check + day so far, no market rules.
  out.no_market_rules = s.aiRaw && seq
    ? (function () { const d = g3wS.dayCall(s.aiRaw, seq, { v2Low: s.v2Low || null, session: s.session || null }); return d ? { verdict: d.verdict, sizing: d.sizing } : null; })()
    : null;
  // 3. AI's own read alone.
  out.ai_alone = s.aiRaw ? { verdict: s.aiRaw.verdict, sizing: s.aiRaw.sizing } : null;
  // 4. Bars alone: green UP, red DOWN, mixed FLAT.
  out.bars_alone = barsCall(s.barsDir);
  // 5. Market rules + bars, no AI: a fired rule starts from DOWN and the bars refine it; otherwise bars alone.
  out.rules_plus_bars = !seq ? null : s.ruleFired
    ? (function () { const d = g3wS.dayCall({ verdict: 'DOWN', sizing: 'NONE' }, seq, {}); return d ? { verdict: d.verdict, sizing: d.sizing } : null; })()
    : barsCall(s.barsDir);
  // 6. Options delta lean: beyond +/-0.15 calls the direction, else FLAT.
  out.options_lean = s.deltaLean === null || s.deltaLean === undefined ? null
    : s.deltaLean > DELTA_BAND ? { verdict: 'UP', sizing: 'QUARTER' } : s.deltaLean < -DELTA_BAND ? { verdict: 'DOWN', sizing: 'NONE' } : FLAT;
  // 7. 50-day + sector proxy + day so far, all three agreeing.
  if (s.pctAbove50 === null || s.pctAbove50 === undefined || !s.g5Status || !s.session) out.ma50_proxy_day = null;
  else {
    const a = Math.sign(s.pctAbove50);
    const p = s.g5Status === 'GREEN' ? 1 : s.g5Status === 'RED' ? -1 : 0;
    const d = Math.sign(s.session.netPct);
    out.ma50_proxy_day = a !== 0 && a === p && a === d ? (a > 0 ? { verdict: 'UP', sizing: 'QUARTER' } : { verdict: 'DOWN', sizing: 'NONE' }) : FLAT;
  }
  return out;
}

const TRIAL_NAMES = ['live', 'no_market_rules', 'ai_alone', 'bars_alone', 'rules_plus_bars', 'options_lean', 'ma50_proxy_day'];

module.exports = {
  TRIALS_VERSION: TRIALS_VERSION,
  TRIAL_NAMES: TRIAL_NAMES,
  DELTA_BAND: DELTA_BAND,
  computeTrials: computeTrials,
};
