'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../learning.js');

const row = (o) => ({ superseded: false, issued_market_open: true, issued_at: '2026-10-21T14:00:00Z', ...o });

test('signal report: DAY and LONG calls are counted separately', () => {
  const rows = [
    row({ verdict: 'UP', grade_long: 'TRUE', return_long_pct: 3, day_verdict: 'UP', grade_day_call: 'FALSE', return_day_call_pct: -1, confidence: 'HIGH' }),
    row({ verdict: 'UP', grade_long: 'FALSE', return_long_pct: -2, day_verdict: 'FLAT', grade_day_call: 'TRUE', confidence: 'HIGH' }),
    row({ verdict: 'DOWN', grade_long: 'MARGINAL', return_long_pct: -4, confidence: 'LOW' }),
  ];
  const s = L.computeSignalStats(rows);
  const find = (call, signal, value) => s.find(x => x.call_type === call && x.signal === signal && x.value === value);
  assert.deepEqual(find('long', 'confidence', 'HIGH'), { call_type: 'long', signal: 'confidence', value: 'HIGH', n: 2, pct: 50, avg_move_pct: 0.5 });
  assert.equal(find('long', 'confidence', 'LOW').pct, 50);           // MARGINAL = half credit
  assert.equal(find('long', 'confidence', 'LOW').avg_move_pct, 4);   // DOWN call, stock fell 4% = +4 in its direction
  assert.equal(find('day', 'confidence', 'HIGH').n, 1);              // FLAT DAY call left out of UP/DOWN signals
  assert.equal(find('day', 'direction', 'FLAT').n, 1);               // ...but counted on its own direction row
  assert.equal(find('day', 'day_vs_long', 'same').pct, 0);
  assert.equal(find('long', 'weekday', 'Wed').n, 3);
  assert.equal(find('long', 'time_of_day_et', '9:30-10:30').n, 3);
});

// 15-min bars for Oct 27 starting 9:30 ET (13:30Z): three up bars of +0.3%.
const bars = (step, n, pct) => { const out = []; let px = 100; for (let i = 0; i < n; i++) { const o = px; px = +(px * (1 + pct / 100)).toFixed(4); out.push({ t: new Date(Date.parse('2026-10-27T13:30:00Z') + i * step * 60000).toISOString(), o, h: px, l: o, c: px }); } return out; };
const base = {
  long: { verdict: 'UP', sizing: 'FULL' }, locked: false, fridaySkeptic: false,
  issuedAtMs: Date.parse('2026-10-27T13:41:00Z'), openMs: Date.parse('2026-10-27T13:30:00Z'), cutoffMs: Date.parse('2026-10-27T16:30:00Z'),
  barsBySize: { 5: bars(5, 30, 0.3), 15: bars(15, 10, 0.3), 30: bars(30, 6, 0.3) },
  impliedDailyMovePct: 3.78, normalDailyMovePct: 2, deltaLean: -0.42,
};

test('replay matches the live rules', () => {
  const live = L.replayDayCall(base, L.LIVE_PARAMS);
  assert.equal(live.barMinutes, 5);                  // 3.78 / 2 = 1.89x -> 5-min bars
  assert.equal(live.verdict, 'UP'); assert.equal(live.sizing, 'HALF'); // bearish lean steps it down
  assert.equal(live.readMs, Date.parse('2026-10-27T13:45:00Z'));
  const noLean = L.replayDayCall(base, { ...L.LIVE_PARAMS, leanBand: null });
  assert.equal(noLean.sizing, 'FULL');
  const big = L.replayDayCall(base, { ...L.LIVE_PARAMS, barShare: 1.0 }); // 0.3% bars < 0.43% yardstick
  assert.equal(big.sizing, 'HALF');
  const fifteen = L.replayDayCall(base, { ...L.LIVE_PARAMS, schedule: { fixed: 15 } });
  assert.equal(fifteen.barMinutes, 15); assert.equal(fifteen.readMs, Date.parse('2026-10-27T14:15:00Z'));
});

test('replay: locked Long, after-cutoff taps, missing options data', () => {
  assert.equal(L.replayDayCall({ ...base, locked: true }, L.LIVE_PARAMS).sizing, 'FULL');
  assert.equal(L.replayDayCall({ ...base, issuedAtMs: Date.parse('2026-10-27T17:00:00Z') }, L.LIVE_PARAMS).skipped, 'after cutoff');
  const old = L.replayDayCall({ ...base, impliedDailyMovePct: null, deltaLean: null }, L.LIVE_PARAMS);
  assert.equal(old.barMinutes, 15); assert.equal(old.sizing, 'FULL'); // pre-options calls replay as before
});

test('guardrails: a proposal needs enough calls, a real gain, and both halves', () => {
  const mk = (n, rightShare, date) => Array.from({ length: n }, (_, i) => ({ verdict: 'UP', grade: i < n * rightShare ? 'TRUE' : 'FALSE', date }));
  const live = L.aggregateResults([...mk(60, 0.5, '2026-11-01'), ...mk(60, 0.5, '2026-12-01')]);
  const better = L.aggregateResults([...mk(60, 0.75, '2026-11-01'), ...mk(60, 0.75, '2026-12-01')]);
  assert.equal(L.evaluateCandidate(live, better).meets, true);
  const small = L.aggregateResults([...mk(20, 0.9, '2026-11-01'), ...mk(20, 0.9, '2026-12-01')]);
  assert.match(L.evaluateCandidate(live, small).why, /only 40 of 100/);
  const oneHalf = L.aggregateResults([...mk(60, 0.95, '2026-11-01'), ...mk(60, 0.45, '2026-12-01')]);
  assert.match(L.evaluateCandidate(live, oneHalf).why, /both halves/);
});

// ── Proposal 7 audit trail ─────────────────────────────────────────────
const v = (t, dial, o) => ({ user_email: 'a@x', tier: 'pro', dial_position: dial, issued_at: t, ...o });

test('audit: direction is relative to the dial order (lower = more aggressive)', () => {
  assert.equal(L.dialDirection('NEUTRAL', 'ACTIVE_SWING'), 'more_aggressive');
  assert.equal(L.dialDirection('ACTIVE_LEAN', 'POSITION_LONG'), 'more_passive');
  assert.equal(L.dialDirection('NEUTRAL', 'NEUTRAL'), null);
  assert.equal(L.dialDirection(null, 'NEUTRAL'), null);
});

test('audit: changes are rebuilt from the verdict sequence, idempotently', () => {
  const verdicts = [
    v('2026-08-31T14:00:00Z', 'NEUTRAL'), v('2026-09-01T14:00:00Z', 'ACTIVE_SWING'),
    v('2026-09-02T14:00:00Z', 'ACTIVE_SWING'), v('2026-09-14T15:00:00Z', 'ACTIVE_LEAN'),
    { ...v('2026-09-03T14:00:00Z', 'NEUTRAL'), user_email: 'b@x' },   // other account, no change
  ];
  const got = L.inferDialChanges(verdicts, []);
  assert.equal(got.length, 2);
  assert.deepEqual(got.map(c => [c.from_position, c.to_position, c.direction, c.source]), [
    ['NEUTRAL', 'ACTIVE_SWING', 'more_aggressive', 'rebuilt'], ['ACTIVE_SWING', 'ACTIVE_LEAN', 'more_passive', 'rebuilt']]);
  assert.equal(got[0].changed_after, '2026-08-31T14:00:00Z');        // the move happened between these two
  assert.equal(got[1].changed_after, '2026-09-02T14:00:00Z');
  assert.deepEqual(L.inferDialChanges(verdicts, got), []);           // run again: nothing new
});

test('audit: an app-logged change is not rebuilt a second time', () => {
  const verdicts = [v('2026-10-01T14:00:00Z', 'NEUTRAL'), v('2026-10-02T14:00:00Z', 'ACTIVE_LEAN')];
  const before = [{ user_email: 'a@x', from_position: 'NEUTRAL', to_position: 'ACTIVE_LEAN', changed_at: '2026-10-02T13:00:00Z', source: 'app' }];
  assert.deepEqual(L.inferDialChanges(verdicts, before), []);
  // Logged a few minutes AFTER the verdict at the new position (ANALYZE won the race): same move.
  const after = [{ ...before[0], changed_at: '2026-10-02T14:04:00Z' }];
  assert.deepEqual(L.inferDialChanges(verdicts, after), []);
  // A verdict that disagrees with the last app log is a missed change.
  const missed = L.inferDialChanges([...verdicts, v('2026-10-05T14:00:00Z', 'POSITION_LEAN')], before);
  assert.deepEqual(missed.map(c => [c.from_position, c.to_position]), [['ACTIVE_LEAN', 'POSITION_LEAN']]);
});

test('audit: dial_shift tags calls within a week of a move', () => {
  const changes = [{ user_email: 'a@x', direction: 'more_aggressive', changed_at: '2026-10-01T14:00:00Z' }];
  const rows = L.annotateDialShift([
    v('2026-09-30T14:00:00Z', 'NEUTRAL'), v('2026-10-03T14:00:00Z', 'ACTIVE_SWING'),
    v('2026-10-09T14:00:00Z', 'ACTIVE_SWING'), { ...v('2026-10-03T14:00:00Z', 'NEUTRAL'), tier: 'free' },
    { ...v('2026-10-03T14:00:00Z', 'NEUTRAL'), user_email: null },
  ], changes);
  assert.deepEqual(rows.map(r => r.dial_shift), ['steady', 'more_aggressive', 'steady', null, null]);
  const s = L.computeSignalStats(rows.map(r => ({ ...r, verdict: 'UP', grade_long: 'TRUE' })));
  assert.equal(s.find(x => x.call_type === 'long' && x.signal === 'dial_shift' && x.value === 'more_aggressive').n, 1);
});

test('audit: summary compares since the latest change vs before it', () => {
  const changes = [
    { from_position: 'NEUTRAL', to_position: 'ACTIVE_SWING', direction: 'more_aggressive', changed_at: '2026-09-01T00:00:00Z', source: 'rebuilt' },
    { from_position: 'ACTIVE_SWING', to_position: 'ACTIVE_LEAN', direction: 'more_passive', changed_at: '2026-09-14T00:00:00Z', source: 'app' },
  ];
  const g = (t, dial, grade, path, verdict = 'UP') => ({ issued_at: t, dial_position: dial, verdict, grade_horizon: grade, path_outcome: path });
  const rows = [
    g('2026-08-20T14:00:00Z', 'NEUTRAL', 'TRUE', 'TARGET'),          // before the previous change: ignored
    g('2026-09-05T14:00:00Z', 'ACTIVE_SWING', 'FALSE', 'STOP'), g('2026-09-06T14:00:00Z', 'ACTIVE_SWING', 'MARGINAL', 'NEITHER'),
    g('2026-09-20T14:00:00Z', 'ACTIVE_LEAN', 'TRUE', 'TARGET'), g('2026-09-21T14:00:00Z', 'ACTIVE_LEAN', 'TRUE', 'NEITHER'),
    g('2026-09-22T14:00:00Z', 'ACTIVE_LEAN', 'TRUE', null, 'FLAT'),  // FLAT left out
  ];
  const s = L.dialAuditSummary(changes, rows);
  assert.equal(s.changes[0].to, 'ACTIVE_LEAN');
  assert.deepEqual(s.latest.after, { n: 2, pct: 100, stopPct: 0 });
  assert.deepEqual(s.latest.before, { n: 2, pct: 25, stopPct: 50 });
  assert.deepEqual(L.dialAuditSummary([], rows), { changes: [], latest: null });
});
