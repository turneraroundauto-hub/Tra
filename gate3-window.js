'use strict';
const BAR_MINUTES = 15;
const SESSION_OPEN_MIN = 9 * 60 + 30; // 9:30 ET
const BARS_NEEDED = 3;
const FIRST_READ_MIN = SESSION_OPEN_MIN + BARS_NEEDED * BAR_MINUTES; // 10:15 ET = 7:15 PT
const WINDOW_CUTOFF_MIN = 12 * 60 + 30; // 12:30 ET = 9:30 PT
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function hhmm(min) { return pad2(Math.floor(min / 60)) + ':' + pad2(min % 60); }
// Start (ET minutes) of the 15-min candle the clock is currently inside, or
// null outside the regular session. Two taps inside the same candle get the
// same key -- that's what the per-candle verdict cache is keyed on.
function candleStartMin(etMinutes, closeMin) {
    if (etMinutes < SESSION_OPEN_MIN || etMinutes >= closeMin)
        return null;
    return SESSION_OPEN_MIN + Math.floor((etMinutes - SESSION_OPEN_MIN) / BAR_MINUTES) * BAR_MINUTES;
}
function candleKey(dateStr, etMinutes, closeMin) {
    const s = candleStartMin(etMinutes, closeMin);
    return s == null ? null : dateStr + 'T' + hhmm(s);
}
// Bars whose 15-min period has fully ended by nowMs. The bar still forming
// is dropped -- its open/close would change under the user.
function completedBars(bars, nowMs) {
    return (bars || []).filter(b => Date.parse(b.t) + BAR_MINUTES * 60000 <= nowMs);
}
function windowState(isTradingDay, etMinutes, closeMin, completedCount) {
    if (!isTradingDay || etMinutes < SESSION_OPEN_MIN || etMinutes >= closeMin)
        return 'CLOSED';
    if (etMinutes >= WINDOW_CUTOFF_MIN)
        return 'EXPIRED';
    return completedCount >= BARS_NEEDED ? 'RESOLVED' : 'FORMING';
}
function barDir(b) { return b.c > b.o ? 1 : b.c < b.o ? -1 : 0; }
// Same 3-bar logic SYSTEM_PROMPT's Gate 3 section describes (bar 2 confirms
// or rejects bar 1, bar 3 convicts), applied to the latest 3 completed bars.
// GREEN = bars 2 and 3 both closed up and the 45 minutes net up. RED = the
// mirror image. Anything else is YELLOW (still building or reversing).
function classifySequence(bars3) {
    if (!bars3 || bars3.length < BARS_NEEDED)
        return null;
    const [b1, b2, b3] = bars3.slice(-BARS_NEEDED);
    const d1 = barDir(b1), d2 = barDir(b2), d3 = barDir(b3);
    const netPct = b1.o ? (b3.c - b1.o) / b1.o * 100 : 0;
    const net = (netPct >= 0 ? '+' : '') + netPct.toFixed(2) + '%';
    if (d2 === 1 && d3 === 1 && netPct > 0) {
        return { status: 'GREEN', direction: 1, netPct, note: `Last 3 bars: bars 2 and 3 both closed up (${net} over 45 min). Buyers in control.` };
    }
    if (d2 === -1 && d3 === -1 && netPct < 0) {
        return { status: 'RED', direction: -1, netPct, note: `Last 3 bars: bars 2 and 3 both closed down (${net} over 45 min). Sellers in control.` };
    }
    const shape = d2 !== 0 && d2 === d1 ? 'direction building but not confirmed' : 'mixed or reversing';
    return { status: 'YELLOW', direction: 0, netPct, note: `Last 3 bars: ${shape} (${net} over 45 min). No clear short-term push.` };
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
    stepDownSizing: stepDownSizing,
    refineDayVerdict: refineDayVerdict,
};
