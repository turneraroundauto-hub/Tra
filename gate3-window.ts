'use strict';
/**
 * gate3-window.js -- pure logic for the Gate 3 rolling 3-bar window and the
 * Day verdict (Oct 19, 2026, Pro beta).
 *
 * The problem it fixes: fetchOpeningBar() asked Alpaca for five 15-min bars
 * but only ever returned bar 1, so Gate 3 never saw a real sequence. This
 * module reads the last 3 COMPLETED 15-min bars instead (the in-progress
 * bar is never counted) and turns them into:
 *   - a window state: FORMING (n/3 bars done) / RESOLVED / EXPIRED (after
 *     the 12:30 ET = 9:30 PT cutoff) / CLOSED (outside the session);
 *   - a bar-sequence read (GREEN / YELLOW / RED);
 *   - a Day verdict: the Long verdict refined by that read, using fixed
 *     rules -- no model call, so the Day verdict never adds cost.
 *
 * Gate 3 never stands alone: a FLAT Long stays FLAT, and a verdict set by a
 * hard override (Gate 0 RED, Gate 1 / Gate 5 forceDown, earnings block) is
 * never changed by the bars.
 *
 * Same CommonJS rule as gates-extended.ts / analyze-helpers.ts: no
 * import/export statements in this file (tsc would emit `export {}` and
 * Node would load it as ESM, silently dropping module.exports).
 */

declare var module: { exports: any };

const BAR_MINUTES = 15;
const SESSION_OPEN_MIN = 9 * 60 + 30;  // 9:30 ET
const BARS_NEEDED = 3;
const FIRST_READ_MIN = SESSION_OPEN_MIN + BARS_NEEDED * BAR_MINUTES; // 10:15 ET = 7:15 PT
const WINDOW_CUTOFF_MIN = 12 * 60 + 30; // 12:30 ET = 9:30 PT

type BarLite = { t: string; o: number; h: number; l: number; c: number; v?: number };
type WindowState = 'CLOSED' | 'FORMING' | 'RESOLVED' | 'EXPIRED';

function pad2(n: number): string { return (n < 10 ? '0' : '') + n; }
function hhmm(min: number): string { return pad2(Math.floor(min / 60)) + ':' + pad2(min % 60); }

// Start (ET minutes) of the 15-min candle the clock is currently inside, or
// null outside the regular session. Two taps inside the same candle get the
// same key -- that's what the per-candle verdict cache is keyed on.
// barMinutes (Oct 27, 2026): the IV-aware schedule can read 5-, 15- or
// 30-min bars; 15 stays the default everywhere it isn't passed.
function candleStartMin(etMinutes: number, closeMin: number, barMinutes: number = BAR_MINUTES): number | null {
  if (etMinutes < SESSION_OPEN_MIN || etMinutes >= closeMin) return null;
  return SESSION_OPEN_MIN + Math.floor((etMinutes - SESSION_OPEN_MIN) / barMinutes) * barMinutes;
}
function candleKey(dateStr: string, etMinutes: number, closeMin: number, barMinutes: number = BAR_MINUTES): string | null {
  const s = candleStartMin(etMinutes, closeMin, barMinutes);
  return s == null ? null : dateStr + 'T' + hhmm(s) + (barMinutes === BAR_MINUTES ? '' : '/' + barMinutes + 'm');
}

// Bars whose 15-min period has fully ended by nowMs. The bar still forming
// is dropped -- its open/close would change under the user.
function completedBars(bars: BarLite[], nowMs: number, barMinutes: number = BAR_MINUTES): BarLite[] {
  return (bars || []).filter(b => Date.parse(b.t) + barMinutes * 60000 <= nowMs);
}

function windowState(isTradingDay: boolean, etMinutes: number, closeMin: number, completedCount: number): WindowState {
  if (!isTradingDay || etMinutes < SESSION_OPEN_MIN || etMinutes >= closeMin) return 'CLOSED';
  if (etMinutes >= WINDOW_CUTOFF_MIN) return 'EXPIRED';
  return completedCount >= BARS_NEEDED ? 'RESOLVED' : 'FORMING';
}

// Options lens (Oct 27, 2026, Mr. T: IV and delta give Gate 3 "a more
// dynamic lens"). With an IV yardstick -- the move one bar is expected to
// make -- a bar only counts as up or down when its body is at least
// DAY_BAR_MIN_SHARE of that, and the 3-bar net move has to clear the same
// share of a 3-bar move. Without IV (no options data) any move counts, as
// before. A delta lean that disagrees with a GREEN/RED read drops it to
// YELLOW, so the DAY call sizes down a step. Starting values, to be tuned on
// the logged data.
const DAY_BAR_MIN_SHARE = 0.5;
type SeqOpts = { yardstickPct?: number | null; lean?: string | null; barMinutes?: number; minShare?: number };
function barDir(b: BarLite, minPct: number = 0): number {
  if (!b.o) return 0;
  const body = (b.c - b.o) / b.o * 100;
  if (Math.abs(body) < minPct || body === 0) return 0;
  return body > 0 ? 1 : -1;
}

// Same 3-bar logic SYSTEM_PROMPT's Gate 3 section describes (bar 2 confirms
// or rejects bar 1, bar 3 convicts), applied to the latest 3 completed bars.
// GREEN = bars 2 and 3 both closed up and the window net up. RED = the
// mirror image. Anything else is YELLOW (still building or reversing).
function classifySequence(bars3: BarLite[], opts: SeqOpts = {}) {
  if (!bars3 || bars3.length < BARS_NEEDED) return null;
  const [b1, b2, b3] = bars3.slice(-BARS_NEEDED);
  const yard = opts.yardstickPct != null && opts.yardstickPct > 0 ? opts.yardstickPct : null;
  // minShare: the shadow tuner (learning.ts) replays other values; live uses DAY_BAR_MIN_SHARE.
  const share = opts.minShare != null ? opts.minShare : DAY_BAR_MIN_SHARE;
  const barMin = yard ? share * yard : 0;
  const netMin = yard ? share * yard * Math.sqrt(BARS_NEEDED) : 0;
  const d1 = barDir(b1, barMin), d2 = barDir(b2, barMin), d3 = barDir(b3, barMin);
  const netPct = b1.o ? (b3.c - b1.o) / b1.o * 100 : 0;
  const net = (netPct >= 0 ? '+' : '') + netPct.toFixed(2) + '%';
  const span = (opts.barMinutes || BAR_MINUTES) * BARS_NEEDED;
  const sized = yard ? `; a bar counts at ${barMin.toFixed(2)}%+ for this stock today` : '';
  const base = { netPct, yardstickPct: yard, lean: opts.lean || null };
  let out: any;
  if (d2 === 1 && d3 === 1 && netPct > netMin) {
    out = { ...base, status: 'GREEN', direction: 1, note: `Last 3 bars: bars 2 and 3 both closed up (${net} over ${span} min${sized}). Buyers in control.` };
  } else if (d2 === -1 && d3 === -1 && netPct < -netMin) {
    out = { ...base, status: 'RED', direction: -1, note: `Last 3 bars: bars 2 and 3 both closed down (${net} over ${span} min${sized}). Sellers in control.` };
  } else {
    const shape = d2 !== 0 && d2 === d1 ? 'direction building but not confirmed' : yard ? 'moves too small to count, mixed or reversing' : 'mixed or reversing';
    return { ...base, status: 'YELLOW', direction: 0, note: `Last 3 bars: ${shape} (${net} over ${span} min${sized}). No clear short-term push.` };
  }
  if ((out.direction === 1 && opts.lean === 'BEARISH') || (out.direction === -1 && opts.lean === 'BULLISH')) {
    return { ...base, status: 'YELLOW', direction: 0, leanApplied: true,
      note: out.note.replace(/\. (Buyers|Sellers) in control\.$/, '') + `, but options traders lean ${opts.lean === 'BEARISH' ? 'bearish' : 'bullish'}. Not confirmed.` };
  }
  return out;
}

function stepDownSizing(s: string): string {
  if (s === 'FULL') return 'HALF';
  if (s === 'HALF') return 'QUARTER';
  return s || 'NONE';
}

// Day verdict = Long verdict refined by the bar sequence. Fixed rules, no
// model call. opts.locked: a hard override set the Long verdict (bars never
// change it). opts.fridaySkeptic: Friday with a week that has NOT been flat
// -- SYSTEM_PROMPT's 67%-reversal rule, so a one-way sequence only counts as
// mixed.
function refineDayVerdict(long: { verdict: string; sizing: string }, seq: any, opts: { locked?: boolean; fridaySkeptic?: boolean } = {}) {
  const lv = (long && long.verdict) || 'FLAT';
  const ls = (long && long.sizing) || 'NONE';
  if (opts.locked) return { verdict: lv, sizing: ls, note: 'A hard override set this verdict; the bars do not change it.' };
  if (!seq) return null;
  let dir = seq.direction;
  let fri = '';
  if (opts.fridaySkeptic && dir !== 0) { dir = 0; fri = ' Friday reversal risk: treated as mixed.'; }
  if (lv === 'UP') {
    if (dir === 1) return { verdict: 'UP', sizing: ls, note: 'Bars confirm the Long call.' + fri };
    if (dir === 0) return { verdict: 'UP', sizing: stepDownSizing(ls), note: 'Bars not confirming yet: size down for the day.' + fri };
    return { verdict: 'FLAT', sizing: 'NONE', note: 'Bars are pushing against the Long call: wait for today.' + fri };
  }
  if (lv === 'DOWN') {
    if (dir === -1) return { verdict: 'DOWN', sizing: ls, note: 'Bars confirm the Long call.' + fri };
    if (dir === 0) return { verdict: 'DOWN', sizing: stepDownSizing(ls), note: 'Bars not confirming yet: size down for the day.' + fri };
    return { verdict: 'FLAT', sizing: 'NONE', note: 'Bars are pushing against the Long call: wait for today.' + fri };
  }
  return { verdict: 'FLAT', sizing: ls, note: 'Long is FLAT; the bars alone never make a call.' + fri };
}

module.exports = {
  BAR_MINUTES: BAR_MINUTES,
  SESSION_OPEN_MIN: SESSION_OPEN_MIN,
  BARS_NEEDED: BARS_NEEDED,
  FIRST_READ_MIN: FIRST_READ_MIN,
  WINDOW_CUTOFF_MIN: WINDOW_CUTOFF_MIN,
  candleStartMin: candleStartMin,
  candleKey: candleKey,
  completedBars: completedBars,
  windowState: windowState,
  classifySequence: classifySequence,
  DAY_BAR_MIN_SHARE: DAY_BAR_MIN_SHARE,
  stepDownSizing: stepDownSizing,
  refineDayVerdict: refineDayVerdict,
};
