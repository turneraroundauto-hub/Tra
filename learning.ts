'use strict';
/**
 * learning.js -- pure logic for the app learning from its own tables
 * (Oct 27, 2026; Mr. T: "the hope is for the app to use tables to learn to
 * apply noncursory changes for better accuracy").
 *
 * Stage 1, signal report: hit rate per input value, DAY and LONG calls
 *   separately (signal_stats table). Read-only.
 * Stage 2, shadow tuner: re-runs past DAY calls under alternative settings
 *   (bar size, how big a bar must be, delta-lean band) and scores them
 *   (tuning_runs table). RECORD ONLY -- nothing here changes a live setting.
 *   Mr. T approves every change by hand before it ships (his rule).
 *
 * The server owns all I/O (Supabase reads/writes, Alpaca bars, grading).
 * Same CommonJS rule as the other .ts modules: no import/export statements.
 */

declare var module: { exports: any };
declare var require: any;
const g3w = require('./gate3-window');

const CREDIT: Record<string, number> = { TRUE: 1, MARGINAL: 0.5, FALSE: 0 };
const ET_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function etParts(iso: string): { day: string; minutes: number; date: string } | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p: any = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return { day: p.weekday, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute), date: `${p.year}-${p.month}-${p.day}` };
}
function hourBucket(min: number): string {
  if (min < 630) return '9:30-10:30';
  if (min < 720) return '10:30-12:00';
  if (min < 840) return '12:00-2:00';
  return '2:00-4:00';
}
function band(x: any, cuts: number[], labels: string[]): string | null {
  const v = Number(x);
  if (x == null || !isFinite(v)) return null;
  for (let i = 0; i < cuts.length; i++) if (v < cuts[i]) return labels[i];
  return labels[labels.length - 1];
}
const g = (row: any, path: string[]): any => path.reduce((o, k) => (o == null ? null : o[k]), row);

// [signal name, extractor] -- every value the report breaks calls down by.
const SIGNALS: Array<[string, (r: any, call: string) => any]> = [
  ['direction', (r, c) => (c === 'day' ? r.day_verdict : r.verdict)],
  ['size', (r, c) => (c === 'day' ? r.day_sizing : r.size_action)],
  ['confidence', r => r.confidence],
  ['dial', r => r.dial_position],
  ['tier', r => r.tier],
  ['weekday', r => { const e = etParts(r.issued_at); return e && e.day; }],
  ['time_of_day_et', r => { const e = etParts(r.issued_at); return e && hourBucket(e.minutes); }],
  ['pre_gate', r => r.pre_gate_state],
  ['gate0', r => r.gate0_read],
  ['gate1_branch', r => r.gate1_branch],
  ['gate2_corroborated', r => (r.gate2_corroboration_state ? (String(r.gate2_corroboration_state).startsWith('GATE2-CORROBORATED') ? 'yes' : 'no') : null)],
  ['g1', r => g(r, ['gates', 'g1'])],
  ['g2', r => g(r, ['gates', 'g2'])],
  ['g3', r => g(r, ['gates', 'g3'])],
  ['g4', r => g(r, ['gates', 'g4'])],
  ['g5', r => g(r, ['gates', 'g5'])],
  ['g3_bars', r => g(r, ['gates', 'g3_bars'])],
  ['g3_bar_minutes', r => { const v = g(r, ['gates', 'g3_bar_minutes']); return v == null ? null : v + ' min'; }],
  ['catalyst_type', r => g(r, ['gates', 'inputs', 'g2', 'type'])],
  ['proxy_tier', r => g(r, ['gates', 'inputs', 'g2', 'proxy_tier'])],
  ['regime', r => g(r, ['gates', 'inputs', 'g5', 'regime'])],
  ['override', r => (r.gates && r.gates.inputs ? (r.gates.inputs.override || 'none') : null)],
  ['range_position', r => band(g(r, ['gates', 'inputs', 'g4', 'range_position']), [30, 70], ['<30%', '30-70%', '>70%'])],
  ['options_lean', r => g(r, ['gates', 'inputs', 'options', 'deltaLeanLabel'])],
  ['options_move_vs_normal', r => band(g(r, ['gates', 'inputs', 'options', 'moveRatio']), [0.8, 1.3], ['quiet (<0.8x)', 'normal', 'big (>1.3x)'])],
  ['day_vs_long', (r, c) => (c === 'day' && r.day_verdict ? (r.day_verdict === r.verdict ? 'same' : 'different') : null)],
  // Set by annotateDialShift() below (Proposal 7 audit trail): was this call
  // made within DIAL_SHIFT_WINDOW_DAYS of the account moving its dial?
  ['dial_shift', r => r.dial_shift],
];

// Which grade/return/direction a call type uses. UP/DOWN calls only (the
// Scorecard headline rule); FLAT calls get their own 'direction' row.
function callView(r: any, call: string): { verdict: string; grade: string; ret: number | null } | null {
  if (call === 'day') {
    if (!r.day_verdict || CREDIT[r.grade_day_call] == null) return null;
    return { verdict: r.day_verdict, grade: r.grade_day_call, ret: r.return_day_call_pct == null ? null : Number(r.return_day_call_pct) };
  }
  if (CREDIT[r.grade_long] == null) return null;
  return { verdict: r.verdict, grade: r.grade_long, ret: r.return_long_pct == null ? null : Number(r.return_long_pct) };
}

// rows: verdict_log rows (non-superseded, market hours). Returns flat stats
// rows ready for signal_stats. pct = credit-weighted % right; avg_move_pct =
// average move in the call's direction (DOWN calls flip the sign).
function computeSignalStats(rows: any[]): any[] {
  const acc = new Map<string, { call: string; signal: string; value: string; n: number; credit: number; moveSum: number; moveN: number }>();
  for (const r of rows || []) {
    for (const call of ['day', 'long']) {
      const v = callView(r, call);
      if (!v) continue;
      const directional = v.verdict === 'UP' || v.verdict === 'DOWN';
      for (const [name, fn] of SIGNALS) {
        if (!directional && name !== 'direction') continue;
        let val: any;
        try { val = fn(r, call); } catch (e) { val = null; }
        if (val == null || val === '') continue;
        const key = `${call}|${name}|${val}`;
        let a = acc.get(key);
        if (!a) { a = { call, signal: name, value: String(val), n: 0, credit: 0, moveSum: 0, moveN: 0 }; acc.set(key, a); }
        a.n++; a.credit += CREDIT[v.grade];
        if (v.ret != null && isFinite(v.ret) && directional) { a.moveSum += v.verdict === 'DOWN' ? -v.ret : v.ret; a.moveN++; }
      }
    }
  }
  return [...acc.values()].map(a => ({
    call_type: a.call, signal: a.signal, value: a.value, n: a.n,
    pct: +(a.credit / a.n * 100).toFixed(1),
    avg_move_pct: a.moveN ? +(a.moveSum / a.moveN).toFixed(3) : null,
  }));
}

// ── Stage 2: replay one DAY call under a parameter set ─────────────────
// input: { long:{verdict,sizing}, locked, fridaySkeptic, issuedAtMs,
//   openMs (9:30 ET that day), cutoffMs, barsBySize:{5:[],15:[],30:[]},
//   impliedDailyMovePct, normalDailyMovePct, deltaLean (number) }
// params: { schedule: {fixed?:n} | {fast,slow}, barShare, leanBand (null = lean off) }
// Mirrors the live flow: read at the later of the tap and the 3rd bar's
// close, using the last 3 completed bars at that moment; no DAY call after
// the cutoff.
const LIVE_PARAMS = { schedule: { fast: 1.3, slow: 0.8 }, barShare: 0.5, leanBand: 0.15 };
// Live compares the options-implied daily move (a standard deviation) with
// the normal move (an average absolute move, about 0.8 of a standard
// deviation), so an ordinary day already reads ~1.25 and most stocks clear
// the 1.3 cutoff (Oct 27, 2026 live check: 12 of 16 Pro calls got 5-min
// bars). schedule.normalScale lets the tuner test the like-for-like version
// before anyone changes live (Mr. T: option B, "educated decisions only").
const SD_PER_MEAN_ABS_MOVE = Math.sqrt(Math.PI / 2); // ~1.2533 for a normal distribution
function pickBarMinutes(schedule: any, implied: number | null, normal: number | null): number {
  if (schedule && schedule.fixed) return schedule.fixed;
  if (!(implied! > 0) || !(normal! > 0)) return 15;
  const ratio = implied! / (normal! * (schedule.normalScale || 1));
  return ratio > schedule.fast ? 5 : ratio < schedule.slow ? 30 : 15;
}
function leanLabel(lean: number | null, bandWidth: number | null): string | null {
  if (lean == null || bandWidth == null) return null;
  return lean > bandWidth ? 'BULLISH' : lean < -bandWidth ? 'BEARISH' : 'NEUTRAL';
}
function replayDayCall(input: any, params: any): any {
  const barMinutes = pickBarMinutes(params.schedule, input.impliedDailyMovePct, input.normalDailyMovePct);
  const bars = (input.barsBySize || {})[barMinutes];
  if (!bars) return { skipped: 'no bars', barMinutes };
  const readMs = Math.max(input.issuedAtMs, input.openMs + g3w.BARS_NEEDED * barMinutes * 60000);
  if (readMs >= input.cutoffMs) return { skipped: 'after cutoff', barMinutes };
  const done = g3w.completedBars(bars, readMs, barMinutes);
  if (done.length < g3w.BARS_NEEDED) return { skipped: 'too few bars', barMinutes };
  const implied = input.impliedDailyMovePct > 0 ? input.impliedDailyMovePct : null;
  const yard = implied ? implied * Math.sqrt(barMinutes / 390) : null;
  const seq = g3w.classifySequence(done.slice(-g3w.BARS_NEEDED), {
    yardstickPct: yard, lean: leanLabel(input.deltaLean, params.leanBand), barMinutes, minShare: params.barShare,
  });
  const day = g3w.refineDayVerdict(input.long, seq, { locked: !!input.locked, fridaySkeptic: !!input.fridaySkeptic });
  if (!day) return { skipped: 'no read', barMinutes };
  const last = done[done.length - 1];
  return { verdict: day.verdict, sizing: day.sizing, barMinutes, readMs: Date.parse(last.t) + barMinutes * 60000, entry: last.c };
}

// Candidate settings, each changing ONE thing from live.
const TUNING_CANDIDATES: Array<{ param: string; candidate: string; params: any }> = [
  { param: 'live', candidate: 'live', params: LIVE_PARAMS },
  { param: 'bar_schedule', candidate: 'always 5-min', params: { ...LIVE_PARAMS, schedule: { fixed: 5 } } },
  { param: 'bar_schedule', candidate: 'always 15-min', params: { ...LIVE_PARAMS, schedule: { fixed: 15 } } },
  { param: 'bar_schedule', candidate: 'always 30-min', params: { ...LIVE_PARAMS, schedule: { fixed: 30 } } },
  { param: 'bar_schedule', candidate: 'ratio 1.2 / 0.9', params: { ...LIVE_PARAMS, schedule: { fast: 1.2, slow: 0.9 } } },
  { param: 'bar_schedule', candidate: 'ratio 1.5 / 0.7', params: { ...LIVE_PARAMS, schedule: { fast: 1.5, slow: 0.7 } } },
  { param: 'bar_schedule', candidate: 'like-for-like 1.3 / 0.8', params: { ...LIVE_PARAMS, schedule: { fast: 1.3, slow: 0.8, normalScale: SD_PER_MEAN_ABS_MOVE } } },
  { param: 'bar_share', candidate: 'any move counts', params: { ...LIVE_PARAMS, barShare: 0 } },
  { param: 'bar_share', candidate: '0.25 of a bar', params: { ...LIVE_PARAMS, barShare: 0.25 } },
  { param: 'bar_share', candidate: '0.75 of a bar', params: { ...LIVE_PARAMS, barShare: 0.75 } },
  { param: 'bar_share', candidate: '1.0 of a bar', params: { ...LIVE_PARAMS, barShare: 1.0 } },
  { param: 'lean_band', candidate: 'lean off', params: { ...LIVE_PARAMS, leanBand: null } },
  { param: 'lean_band', candidate: '±0.10', params: { ...LIVE_PARAMS, leanBand: 0.10 } },
  { param: 'lean_band', candidate: '±0.25', params: { ...LIVE_PARAMS, leanBand: 0.25 } },
];

// Guardrails a candidate must clear before it is even PROPOSED to Mr. T
// (nothing is applied automatically): enough graded UP/DOWN calls, a gain
// bigger than the margin of error, and better in both halves of the period.
const PROPOSAL_MIN_CALLS = 100;
function aggregateResults(results: Array<{ verdict: string; grade: string | null; date: string }>): any {
  const dir = results.filter(x => (x.verdict === 'UP' || x.verdict === 'DOWN') && CREDIT[x.grade as string] != null);
  const flat = results.filter(x => x.verdict === 'FLAT' && CREDIT[x.grade as string] != null);
  const pct = (xs: any[]) => (xs.length ? +(xs.reduce((a, x) => a + CREDIT[x.grade], 0) / xs.length * 100).toFixed(1) : null);
  const dates = dir.map(x => x.date).sort();
  const mid = dates.length ? dates[Math.floor(dates.length / 2)] : null;
  return {
    nDir: dir.length, pctDir: pct(dir), nFlat: flat.length, pctFlat: pct(flat),
    earlyPct: mid ? pct(dir.filter(x => x.date < mid)) : null,
    latePct: mid ? pct(dir.filter(x => x.date >= mid)) : null,
  };
}
function evaluateCandidate(live: any, cand: any, minCalls: number = PROPOSAL_MIN_CALLS): any {
  if (live.pctDir == null || cand.pctDir == null) return { delta: null, margin: null, meets: false, why: 'no graded UP/DOWN calls' };
  const p = cand.pctDir / 100;
  const margin = +(1.96 * Math.sqrt(p * (1 - p) / Math.max(cand.nDir, 1)) * 100).toFixed(1);
  const delta = +(cand.pctDir - live.pctDir).toFixed(1);
  const why: string[] = [];
  if (cand.nDir < minCalls) why.push(`only ${cand.nDir} of ${minCalls} graded calls`);
  if (!(delta > margin)) why.push(`gain ${delta} pts is inside the ±${margin} margin`);
  if (!(cand.earlyPct != null && live.earlyPct != null && cand.earlyPct > live.earlyPct && cand.latePct != null && live.latePct != null && cand.latePct > live.latePct)) why.push('not better in both halves of the period');
  return { delta, margin, meets: why.length === 0, why: why.join('; ') || 'clears every guardrail' };
}

// ── Proposal 7: Gate-Override Audit Trail (Oct 27, 2026) ────────────────
// Observational only: logs Aggression Dial changes and lines them up with
// how calls did before and after. Never blocks a dial move, never changes
// a verdict. "Losses" are the app's own grades (Mr. T's call: app grades
// only, no Robinhood join).

// Most aggressive first -- a lower index is a more aggressive setting.
const DIAL_ORDER = ['ACTIVE_SWING', 'ACTIVE_LEAN', 'NEUTRAL', 'POSITION_LEAN', 'POSITION_LONG'];
const DIAL_SHIFT_WINDOW_DAYS = 7; // about 5 trading days
// An app-logged change this close to a verdict at the new position counts
// as the same move (the log call and ANALYZE can land in either order).
const DIAL_MATCH_TOLERANCE_MS = 10 * 60 * 1000;

function dialDirection(from: string | null, to: string): string | null {
  const a = DIAL_ORDER.indexOf(from as string), b = DIAL_ORDER.indexOf(to);
  if (a < 0 || b < 0 || a === b) return null;
  return b < a ? 'more_aggressive' : 'more_passive';
}

// Rebuilds dial changes the app never logged (pre-audit history, a stale
// cached page, a failed log call) from each account's verdict sequence.
// verdicts: [{user_email, tier, dial_position, issued_at}] (any order);
// changes: existing dial_changes rows. Returns new rows with
// source 'rebuilt': changed_at = first verdict seen at the new position,
// changed_after = the last evidence of the old one (the move happened
// somewhere in between). Idempotent: run it again and it returns [].
function inferDialChanges(verdicts: any[], changes: any[]): any[] {
  const byUser = new Map<string, { v: any[]; c: any[] }>();
  const slot = (u: string) => { let x = byUser.get(u); if (!x) { x = { v: [], c: [] }; byUser.set(u, x); } return x; };
  for (const v of verdicts || []) if (v && v.user_email && DIAL_ORDER.includes(v.dial_position)) slot(v.user_email).v.push(v);
  for (const c of changes || []) if (c && c.user_email) slot(c.user_email).c.push(c);
  const out: any[] = [];
  for (const [user, x] of byUser) {
    const vs = x.v.slice().sort((a, b) => Date.parse(a.issued_at) - Date.parse(b.issued_at));
    const cs = x.c.slice().sort((a, b) => Date.parse(a.changed_at) - Date.parse(b.changed_at));
    let known: string | null = null, knownAt: string | null = null, ci = 0;
    for (const v of vs) {
      const t = Date.parse(v.issued_at);
      while (ci < cs.length && Date.parse(cs[ci].changed_at) <= t) { known = cs[ci].to_position; knownAt = cs[ci].changed_at; ci++; }
      if (known == null) { known = v.dial_position; knownAt = v.issued_at; continue; }
      if (v.dial_position === known) { knownAt = v.issued_at; continue; }
      // An app log for this exact move just after the verdict: same move.
      const soon = cs.slice(ci).find(c => c.to_position === v.dial_position && Date.parse(c.changed_at) - t <= DIAL_MATCH_TOLERANCE_MS);
      if (soon) { known = v.dial_position; knownAt = v.issued_at; continue; }
      out.push({ user_email: user, tier: v.tier || null, from_position: known, to_position: v.dial_position,
        direction: dialDirection(known, v.dial_position), source: 'rebuilt', changed_at: v.issued_at, changed_after: knownAt });
      known = v.dial_position; knownAt = v.issued_at;
    }
  }
  return out;
}

// Tags each verdict row with dial_shift for the signal report:
// 'more_aggressive' / 'more_passive' when the account moved its dial within
// DIAL_SHIFT_WINDOW_DAYS before the call, else 'steady'. Rows with no
// account or from a tier without a dial get null (left out of the report).
function annotateDialShift(rows: any[], changes: any[], windowDays: number = DIAL_SHIFT_WINDOW_DAYS): any[] {
  const byUser = new Map<string, any[]>();
  for (const c of changes || []) if (c && c.user_email && c.direction) {
    let a = byUser.get(c.user_email); if (!a) { a = []; byUser.set(c.user_email, a); } a.push(c);
  }
  for (const a of byUser.values()) a.sort((x, y) => Date.parse(x.changed_at) - Date.parse(y.changed_at));
  const win = windowDays * 86400000;
  for (const r of rows || []) {
    if (!r || !r.user_email || !DIAL_ORDER.includes(r.dial_position) || r.tier === 'free') { if (r) r.dial_shift = null; continue; }
    const t = Date.parse(r.issued_at);
    const cs = byUser.get(r.user_email) || [];
    let last: any = null;
    for (const c of cs) { if (Date.parse(c.changed_at) <= t) last = c; else break; }
    r.dial_shift = last && t - Date.parse(last.changed_at) <= win ? last.direction : 'steady';
  }
  return rows;
}

// Accuracy (dial-horizon grade, MARGINAL = half) and stop-out rate for a set
// of verdict rows. UP/DOWN calls only, same rule as the Scorecard headline.
function dialStats(rows: any[]): { n: number; pct: number | null; stopPct: number | null } {
  const d = (rows || []).filter(r => (r.verdict === 'UP' || r.verdict === 'DOWN') && CREDIT[r.grade_horizon] != null);
  if (!d.length) return { n: 0, pct: null, stopPct: null };
  const credit = d.reduce((s, r) => s + CREDIT[r.grade_horizon], 0);
  const withPath = d.filter(r => r.path_outcome);
  return { n: d.length, pct: +(credit / d.length * 100).toFixed(1),
    stopPct: withPath.length ? +(withPath.filter(r => r.path_outcome === 'STOP').length / withPath.length * 100).toFixed(1) : null };
}

// One account's audit summary: its changes (newest first) and, for the
// latest change, how calls did since at the new position vs before it at
// the old one. rows: that account's graded verdict rows.
function dialAuditSummary(changes: any[], rows: any[]): any {
  const cs = (changes || []).slice().sort((a, b) => Date.parse(b.changed_at) - Date.parse(a.changed_at));
  const latest = cs[0] || null;
  if (!latest) return { changes: [], latest: null };
  const at = Date.parse(latest.changed_at);
  const prevAt = cs[1] ? Date.parse(cs[1].changed_at) : -Infinity;
  const after = (rows || []).filter(r => Date.parse(r.issued_at) >= at && r.dial_position === latest.to_position);
  const before = (rows || []).filter(r => { const t = Date.parse(r.issued_at); return t < at && t >= prevAt && r.dial_position === latest.from_position; });
  return {
    changes: cs.slice(0, 10).map(c => ({ from: c.from_position, to: c.to_position, direction: c.direction, at: c.changed_at, source: c.source })),
    latest: { from: latest.from_position, to: latest.to_position, direction: latest.direction, at: latest.changed_at,
      after: dialStats(after), before: dialStats(before) },
  };
}

module.exports = {
  SIGNALS: SIGNALS.map(s => s[0]),
  computeSignalStats: computeSignalStats,
  etParts: etParts,
  LIVE_PARAMS: LIVE_PARAMS,
  TUNING_CANDIDATES: TUNING_CANDIDATES,
  PROPOSAL_MIN_CALLS: PROPOSAL_MIN_CALLS,
  SD_PER_MEAN_ABS_MOVE: SD_PER_MEAN_ABS_MOVE,
  pickBarMinutes: pickBarMinutes,
  leanLabel: leanLabel,
  replayDayCall: replayDayCall,
  aggregateResults: aggregateResults,
  evaluateCandidate: evaluateCandidate,
  DIAL_ORDER: DIAL_ORDER,
  DIAL_SHIFT_WINDOW_DAYS: DIAL_SHIFT_WINDOW_DAYS,
  dialDirection: dialDirection,
  inferDialChanges: inferDialChanges,
  annotateDialShift: annotateDialShift,
  dialStats: dialStats,
  dialAuditSummary: dialAuditSummary,
};
