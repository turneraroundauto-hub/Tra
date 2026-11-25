'use strict';
// Frozen DAY-call shadow trials (Nov 25, 2026, S-1).
const test = require('node:test');
const assert = require('node:assert/strict');
const st = require('../shadow-trials.js');

const snap = (o) => Object.assign({
  liveDay: { verdict: 'DOWN', sizing: 'NONE' }, aiRaw: { verdict: 'UP', sizing: 'HALF' }, ruleFired: true,
  barsDir: 1, v2Low: { UP: false, DOWN: false }, session: { bars: 7, netPct: 1.2, direction: 1 },
  deltaLean: 0.4, pctAbove50: 2.5, g5Status: 'GREEN',
}, o || {});

test('S-1 exports every trial', () => {
  assert.equal(st.TRIALS_VERSION, 'S-1');
  const t = st.computeTrials(snap());
  assert.deepEqual(Object.keys(t).sort(), [...st.TRIAL_NAMES].sort());
});

test('live is copied as is; no_market_rules starts from the AI read', () => {
  const t = st.computeTrials(snap());
  assert.deepEqual(t.live, { verdict: 'DOWN', sizing: 'NONE' });
  // AI UP + green bars + day agrees -> UP at the AI's size
  assert.deepEqual(t.no_market_rules, { verdict: 'UP', sizing: 'HALF' });
  assert.deepEqual(t.ai_alone, { verdict: 'UP', sizing: 'HALF' });
});

test('no_market_rules applies the price check and the day-so-far trim', () => {
  assert.equal(st.computeTrials(snap({ v2Low: { UP: true } })).no_market_rules.verdict, 'FLAT');
  const trimmed = st.computeTrials(snap({ session: { bars: 7, netPct: -1.0, direction: -1 } })).no_market_rules;
  assert.deepEqual(trimmed, { verdict: 'UP', sizing: 'QUARTER' });
});

test('bars_alone and rules_plus_bars', () => {
  assert.equal(st.computeTrials(snap({ barsDir: -1 })).bars_alone.verdict, 'DOWN');
  assert.equal(st.computeTrials(snap({ barsDir: 0 })).bars_alone.verdict, 'FLAT');
  assert.equal(st.computeTrials(snap({ barsDir: null })).bars_alone, null);
  // rule fired + green bars -> the bars lead UP (QUARTER)
  assert.deepEqual(st.computeTrials(snap()).rules_plus_bars, { verdict: 'UP', sizing: 'QUARTER' });
  // rule fired + mixed bars -> DOWN stays
  assert.equal(st.computeTrials(snap({ barsDir: 0 })).rules_plus_bars.verdict, 'DOWN');
  // no rule -> bars alone
  assert.equal(st.computeTrials(snap({ ruleFired: false, barsDir: -1 })).rules_plus_bars.verdict, 'DOWN');
});

test('options_lean band and ma50_proxy_day agreement', () => {
  assert.equal(st.computeTrials(snap({ deltaLean: 0.1 })).options_lean.verdict, 'FLAT');
  assert.equal(st.computeTrials(snap({ deltaLean: -0.3 })).options_lean.verdict, 'DOWN');
  assert.equal(st.computeTrials(snap({ deltaLean: null })).options_lean, null);
  assert.equal(st.computeTrials(snap()).ma50_proxy_day.verdict, 'UP');
  assert.equal(st.computeTrials(snap({ g5Status: 'YELLOW' })).ma50_proxy_day.verdict, 'FLAT');
  assert.equal(st.computeTrials(snap({ pctAbove50: -1, g5Status: 'RED', session: { bars: 5, netPct: -0.4, direction: -1 } })).ma50_proxy_day.verdict, 'DOWN');
  assert.equal(st.computeTrials(snap({ session: null })).ma50_proxy_day, null);
});

test('missing AI read -> AI trials null', () => {
  const t = st.computeTrials(snap({ aiRaw: null }));
  assert.equal(t.ai_alone, null); assert.equal(t.no_market_rules, null);
});
