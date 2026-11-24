'use strict';
const BAR_MINUTES = 15;
const SESSION_OPEN_MIN = 9 * 60 + 30; // 9:30 ET
const BARS_NEEDED = 3;
const FIRST_READ_MIN = SESSION_OPEN_MIN + BARS_NEEDED * BAR_MINUTES; // 10:15 ET = 7:15 PT
const WINDOW_CUTOFF_MIN = 13 * 60 + 30; // 1:30 PM ET = 10:30 AM PT (Nov 2, 2026; was 12:30 ET)
// Nov 3, 2026 (Mr. T): a bar only counts 62 s after it closes. Alpaca
// publishes a just-closed bar a few seconds late; a read right at 7:15 PT saw
// 2/3 bars and the per-candle cache pinned that for the whole candle (IMVT,
// Nov 3). Every candle boundary shifts by the same 62 s.
const BAR_SETTLE_MS = 62 * 1000;
// Bars that SHOULD be complete by nowMs (already settle-shifted) for a
// session that opened at openMs. A fetch with fewer than this is missing the
// newest bar (Alpaca still behind) and must not be cached.
function expectedCompletedCount(openMs, nowMs, barMinutes = BAR_MINUTES) {
    if (!(nowMs > openMs))
        return 0;
    return Math.floor((nowMs - openMs) / (barMinutes * 60000));
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function hhmm(min) { return pad2(Math.floor(min / 60)) + ':' + pad2(min % 60); }
// Start (ET minutes) of the 15-min candle the clock is currently inside, or
// null outside the regular session. Two taps inside the same candle get the
// same key -- that's what the per-candle verdict cache is keyed on.
// barMinutes (Oct 27, 2026): the IV-aware schedule can read 5-, 15- or
// 30-min bars; 15 stays the default everywhere it isn't passed.
function candleStartMin(etMinutes, closeMin, barMinutes = BAR_MINUTES) {
    if (etMinutes < SESSION_OPEN_MIN || etMinutes >= closeMin)
        return null;
    return SESSION_OPEN_MIN + Math.floor((etMinutes - SESSION_OPEN_MIN) / barMinutes) * barMinutes;
}
function candleKey(dateStr, etMinutes, closeMin, barMinutes = BAR_MINUTES) {
    const s = candleStartMin(etMinutes, closeMin, barMinutes);
    return s == null ? null : dateStr + 'T' + hhmm(s) + (barMinutes === BAR_MINUTES ? '' : '/' + barMinutes + 'm');
}
// Bars whose 15-min period has fully ended by nowMs. The bar still forming
// is dropped -- its open/close would change under the user.
function completedBars(bars, nowMs, barMinutes = BAR_MINUTES) {
    return (bars || []).filter(b => Date.parse(b.t) + barMinutes * 60000 <= nowMs);
}
function windowState(isTradingDay, etMinutes, closeMin, completedCount) {
    if (!isTradingDay || etMinutes < SESSION_OPEN_MIN || etMinutes >= closeMin)
        return 'CLOSED';
    if (etMinutes >= WINDOW_CUTOFF_MIN)
        return 'EXPIRED';
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
function barDir(b, minPct = 0) {
    if (!b.o)
        return 0;
    const body = (b.c - b.o) / b.o * 100;
    if (Math.abs(body) < minPct || body === 0)
        return 0;
    return body > 0 ? 1 : -1;
}
// Same 3-bar logic SYSTEM_PROMPT's Gate 3 section describes (bar 2 confirms
// or rejects bar 1, bar 3 convicts), applied to the latest 3 completed bars.
// GREEN = bars 2 and 3 both closed up and the window net up. RED = the
// mirror image. Anything else is YELLOW (still building or reversing).
function classifySequence(bars3, opts = {}) {
    if (!bars3 || bars3.length < BARS_NEEDED)
        return null;
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
    let out;
    if (d2 === 1 && d3 === 1 && netPct > netMin) {
        out = { ...base, status: 'GREEN', direction: 1, note: `Last 3 bars: bars 2 and 3 both closed up (${net} over ${span} min${sized}). Buyers in control.` };
    }
    else if (d2 === -1 && d3 === -1 && netPct < -netMin) {
        out = { ...base, status: 'RED', direction: -1, note: `Last 3 bars: bars 2 and 3 both closed down (${net} over ${span} min${sized}). Sellers in control.` };
    }
    else {
        const shape = d2 !== 0 && d2 === d1 ? 'direction building but not confirmed' : yard ? 'moves too small to count, mixed or reversing' : 'mixed or reversing';
        return { ...base, status: 'YELLOW', direction: 0, note: `Last 3 bars: ${shape} (${net} over ${span} min${sized}). No clear short-term push.` };
    }
    if ((out.direction === 1 && opts.lean === 'BEARISH') || (out.direction === -1 && opts.lean === 'BULLISH')) {
        return { ...base, status: 'YELLOW', direction: 0, leanApplied: true,
            note: out.note.replace(/\. (Buyers|Sellers) in control\.$/, '') + `, but options traders lean ${opts.lean === 'BEARISH' ? 'bearish' : 'bullish'}. Not confirmed.` };
    }
    return out;
}
function stepDownSizing(s) {
    if (s === 'FULL')
        return 'HALF';
    if (s === 'HALF')
        return 'QUARTER';
    return s || 'NONE';
}
// Day verdict = Long verdict refined by the bar sequence. Fixed rules, no
// model call. opts.locked: a hard override set the Long verdict (bars never
// change it). opts.fridaySkeptic: Friday with a week that has NOT been flat
// -- SYSTEM_PROMPT's 67%-reversal rule, so a one-way sequence only counts as
// mixed.
function refineDayVerdict(long, seq, opts = {}) {
    const lv = (long && long.verdict) || 'FLAT';
    const ls = (long && long.sizing) || 'NONE';
    if (opts.locked)
        return { verdict: lv, sizing: ls, note: 'A hard override set this verdict; the bars do not change it.' };
    if (!seq)
        return null;
    let dir = seq.direction;
    let fri = '';
    if (opts.fridaySkeptic && dir !== 0) {
        dir = 0;
        fri = ' Friday reversal risk: treated as mixed.';
    }
    if (lv === 'UP') {
        if (dir === 1)
            return { verdict: 'UP', sizing: ls, note: 'Bars confirm the Long call.' + fri };
        if (dir === 0)
            return { verdict: 'UP', sizing: stepDownSizing(ls), note: 'Bars not confirming yet: size down for the day.' + fri };
        return { verdict: 'FLAT', sizing: 'NONE', note: 'Bars are pushing against the Long call: wait for today.' + fri };
    }
    if (lv === 'DOWN') {
        if (dir === -1)
            return { verdict: 'DOWN', sizing: ls, note: 'Bars confirm the Long call.' + fri };
        if (dir === 0)
            return { verdict: 'DOWN', sizing: stepDownSizing(ls), note: 'Bars not confirming yet: size down for the day.' + fri };
        return { verdict: 'FLAT', sizing: 'NONE', note: 'Bars are pushing against the Long call: wait for today.' + fri };
    }
    return { verdict: 'FLAT', sizing: ls, note: 'Long is FLAT; the bars alone never make a call.' + fri };
}
// DAY call D-2 (Nov 24, 2026, Mr. T: "delineate day from long completely";
// "a day call should never be locked for the day"). Pro only. Starts from the
// AI's own read (modelLongVerdict) and the latest 3 bars; never from the LONG
// controller, and no rule holds it against the bars:
//  - bars agree -> the AI's call at its size; bars mixed -> same call, one size
//    down; bars clearly the other way -> the bars' direction, QUARTER.
//  - a price already moving against the DAY direction (confidence v2 LOW for
//    that direction) -> FLAT. No earnings lock on DAY.
// Replay on 155 past DAY calls (Oct 21-Nov 20): 62.9% right on 132 calls vs
// 58.1% live. Re-read for free on every later tap before the cutoff.
// D-3 (Nov 24, 2026, Mr. T: "keep the whole day in focus"): the last 3 bars
// still set the direction (the 3-bar window only paces how often a read can
// happen), and the day so far -- every completed bar since the 9:30 ET open --
// confirms it. Agree: size unchanged. Against: one size down (never below
// QUARTER). At the first read the 3 bars ARE the day, so it only acts once
// more than 3 bars are done (7:30 PT onward and on re-reads).
const DAY_CALL_VERSION = 'D-3';
const DAY_CALL_VERSIONS = ['D-2', 'D-3'];
function isDayCallVersion(v) { return DAY_CALL_VERSIONS.indexOf(v) >= 0; }
function sessionRead(doneBars) {
    if (!doneBars || !doneBars.length || !doneBars[0].o)
        return null;
    const first = doneBars[0], last = doneBars[doneBars.length - 1];
    const netPct = (last.c - first.o) / first.o * 100;
    return { bars: doneBars.length, netPct, direction: netPct > 0 ? 1 : netPct < 0 ? -1 : 0 };
}
function dayCall(long, seq, opts = {}) {
    if (!seq)
        return null;
    const lv = (long && long.verdict) || 'FLAT';
    const ls = (long && long.sizing) || 'NONE';
    let dir = seq.direction;
    let fri = '';
    if (opts.fridaySkeptic && dir !== 0) {
        dir = 0;
        fri = ' Friday reversal risk: treated as mixed.';
    }
    const bar = dir === 1 ? 'UP' : dir === -1 ? 'DOWN' : null;
    let day;
    if (lv !== 'UP' && lv !== 'DOWN') {
        day = { verdict: 'FLAT', sizing: 'NONE', rule: 'ai_flat', note: 'The AI reads today as FLAT; the bars alone never make a call.' + fri };
    }
    else if (!bar) {
        day = { verdict: lv, sizing: stepDownSizing(ls), rule: 'bars_mixed', note: 'Bars mixed so far: ' + lv + ', one size down.' + fri };
    }
    else if (bar === lv) {
        day = { verdict: lv, sizing: ls, rule: 'bars_agree', note: 'Bars confirm ' + lv + ' for today.' };
    }
    else {
        day = { verdict: bar, sizing: 'QUARTER', rule: 'bars_lead',
            note: 'Last 3 bars point ' + bar + ', against the AI\'s ' + lv + ' read. The bars lead today; tap ↻ Re-read bars later to update.' };
    }
    const ses = opts.session;
    if ((day.verdict === 'UP' || day.verdict === 'DOWN') && ses && ses.bars > BARS_NEEDED && ses.direction !== 0) {
        const sesDir = ses.direction === 1 ? 'UP' : 'DOWN';
        const since = (ses.netPct >= 0 ? '+' : '') + ses.netPct.toFixed(2) + '% since the open';
        if (sesDir === day.verdict) {
            day = { ...day, session: 'agrees', note: day.note + ' The day so far agrees (' + since + ').' };
        }
        else {
            const smaller = stepDownSizing(day.sizing);
            day = { ...day, sizing: smaller, session: 'against',
                note: day.note + ' The day so far is ' + sesDir + ' (' + since + ')' + (smaller === day.sizing ? '; already at the smallest size.' : ': one size down.') };
        }
    }
    if ((day.verdict === 'UP' || day.verdict === 'DOWN') && opts.v2Low && opts.v2Low[day.verdict]) {
        return { verdict: 'FLAT', sizing: 'NONE', rule: 'price_against',
            note: 'The stock or its sector is already moving against a ' + day.verdict + ' call today. No day trade.' };
    }
    return day;
}
module.exports = {
    BAR_MINUTES: BAR_MINUTES,
    SESSION_OPEN_MIN: SESSION_OPEN_MIN,
    BARS_NEEDED: BARS_NEEDED,
    FIRST_READ_MIN: FIRST_READ_MIN,
    WINDOW_CUTOFF_MIN: WINDOW_CUTOFF_MIN,
    BAR_SETTLE_MS: BAR_SETTLE_MS,
    expectedCompletedCount: expectedCompletedCount,
    candleStartMin: candleStartMin,
    candleKey: candleKey,
    completedBars: completedBars,
    windowState: windowState,
    classifySequence: classifySequence,
    DAY_BAR_MIN_SHARE: DAY_BAR_MIN_SHARE,
    stepDownSizing: stepDownSizing,
    refineDayVerdict: refineDayVerdict,
    DAY_CALL_VERSION: DAY_CALL_VERSION,
    DAY_CALL_VERSIONS: DAY_CALL_VERSIONS,
    isDayCallVersion: isDayCallVersion,
    sessionRead: sessionRead,
    dayCall: dayCall,
};
