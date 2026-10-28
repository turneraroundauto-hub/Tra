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

test('replay: the Oct 27 options lens (now a candidate) reads as it did live', () => {
  const lens = L.OCT27_LENS_PARAMS;
  const r = L.replayDayCall(base, lens);
  assert.equal(r.barMinutes, 5);                     // 3.78 / 2 = 1.89x -> 5-min bars
  assert.equal(r.verdict, 'UP'); assert.equal(r.sizing, 'HALF'); // bearish lean steps it down
  assert.equal(r.readMs, Date.parse('2026-10-27T13:45:00Z'));
  assert.equal(L.replayDayCall(base, { ...lens, leanBand: null }).sizing, 'FULL');
  assert.equal(L.replayDayCall(base, { ...lens, barShare: 1.0 }).sizing, 'HALF'); // 0.3% bars < 0.43% yardstick
});

test('replay: live is plain 15-min candles, any move counts, no lean (Oct 28)', () => {
  const live = L.replayDayCall(base, L.LIVE_PARAMS);
  assert.equal(live.barMinutes, 15); assert.equal(live.readMs, Date.parse('2026-10-27T14:15:00Z'));
  assert.equal(live.verdict, 'UP'); assert.equal(live.sizing, 'FULL'); // bearish lean ignored live
  assert.equal(live.window.length, 3);
  assert.equal(L.TUNING_CANDIDATES[0].params, L.LIVE_PARAMS);
  assert.ok(L.TUNING_CANDIDATES.find(c => c.candidate === 'Oct 27 options lens (all three)'));
});

test('replay: locked Long, after-cutoff taps, missing options data', () => {
  assert.equal(L.replayDayCall({ ...base, locked: true }, L.LIVE_PARAMS).sizing, 'FULL');
  assert.equal(L.replayDayCall({ ...base, issuedAtMs: Date.parse('2026-10-27T17:00:00Z') }, L.LIVE_PARAMS).skipped, 'after cutoff');
  const old = L.replayDayCall({ ...base, impliedDailyMovePct: null, deltaLean: null }, L.LIVE_PARAMS);
  assert.equal(old.barMinutes, 15); assert.equal(old.sizing, 'FULL');
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

test('tuner: like-for-like bar schedule scales the normal move (Oct 27 live data)', () => {
  const c = L.TUNING_CANDIDATES.find(x => x.candidate === 'like-for-like 1.3 / 0.8');
  assert.ok(c && Math.abs(c.params.schedule.normalScale - 1.2533) < 0.001);
  // [implied, normal] from Oct 27 Pro calls: live vs like-for-like bar size
  const cases = { IREN: [8.75, 3.738, 5, 5], ARCC: [1.482, 0.952, 5, 15], NU: [3.281, 3.457, 15, 30], MU: [3.489, 2.758, 15, 15] };
  for (const [sym, [imp, norm, live, fixed]] of Object.entries(cases)) {
    assert.equal(L.pickBarMinutes(L.OCT27_LENS_PARAMS.schedule, imp, norm), live, sym + ' Oct 27 lens');
    assert.equal(L.pickBarMinutes(c.params.schedule, imp, norm), fixed, sym + ' like-for-like');
  }
  assert.equal(L.pickBarMinutes(c.params.schedule, null, 2), 15); // no options data: old 15-min read
});


// ── Oct 28 shadow DAY design: Gates 2 + 3 decide ────────────────────────
const g23 = (o) => L.dayFromGates23({ long: { verdict: 'DOWN', sizing: 'NONE' }, g2Status: 'YELLOW', impliedDailyMovePct: 5, normalDailyMovePct: 2, deltaLean: 0, ...o }, o.seq);
const up = { direction: 1 }, down = { direction: -1 }, mixed = { direction: 0 };

test('g23: Gates 2 and 3 set the DAY direction, even against LONG (IMVT/IREN case)', () => {
  assert.deepEqual([g23({ seq: up, g2Status: 'GREEN' }).verdict, g23({ seq: up, g2Status: 'GREEN' }).strength], ['UP', 'both']);
  assert.equal(g23({ seq: up, g2Status: 'GREEN' }).sizing, 'HALF');
  assert.deepEqual([g23({ seq: up }).verdict, g23({ seq: up }).strength], ['UP', 'bars only']);           // LONG DOWN, bars up -> UP
  assert.deepEqual([g23({ seq: mixed, g2Status: 'RED' }).verdict, g23({ seq: mixed, g2Status: 'RED' }).strength], ['DOWN', 'catalyst only']);
  assert.deepEqual([g23({ seq: down, g2Status: 'GREEN' }).verdict, g23({ seq: down, g2Status: 'GREEN' }).strength], ['FLAT', 'conflict']);
  assert.equal(g23({ seq: mixed }).verdict, 'FLAT');                                                       // big day, both quiet -> FLAT
});

test('g23: other gates only weigh in on a quiet day (expected move < 1.3x normal, neutral lean)', () => {
  const quiet = { impliedDailyMovePct: 2.2, normalDailyMovePct: 2, deltaLean: 0.05 };
  assert.equal(L.isQuietDay(quiet), true);
  assert.equal(L.isQuietDay({ ...quiet, deltaLean: -0.4 }), false);       // lean not neutral
  assert.equal(L.isQuietDay({ ...quiet, impliedDailyMovePct: 3 }), false); // 1.5x
  assert.equal(L.isQuietDay({ impliedDailyMovePct: null, normalDailyMovePct: 2 }), false);
  assert.deepEqual([g23({ ...quiet, seq: mixed }).verdict, g23({ ...quiet, seq: mixed }).strength], ['DOWN', 'quiet-day tiebreak']);
  assert.equal(g23({ ...quiet, seq: up, g2Status: 'GREEN' }).sizing, 'QUARTER');  // LONG disagrees on a quiet day: step down
  assert.equal(g23({ seq: up, g2Status: 'GREEN' }).sizing, 'HALF');               // not quiet: LONG ignored
});

test('g23: earnings block keeps the direction but sizes to NONE', () => {
  const r = g23({ seq: up, g2Status: 'GREEN', earningsBlock: true });
  assert.deepEqual([r.verdict, r.sizing], ['UP', 'NONE']);
});

test('g23 runs through the replay as its own candidate', () => {
  const c = L.TUNING_CANDIDATES.find(x => x.params.dayModel === 'g23');
  const r = L.replayDayCall({ ...base, long: { verdict: 'DOWN', sizing: 'NONE' }, g2Status: 'YELLOW' }, c.params);
  assert.equal(r.barMinutes, 15); assert.equal(r.verdict, 'UP'); // three up 15-min bars beat a DOWN LONG
});

test('5-min confidence layer and thrust candle (record only)', () => {
  const t = (m) => new Date(Date.parse('2026-10-27T13:30:00Z') + m * 60000).toISOString();
  const w15 = [{ t: t(0), o: 100, c: 101 }, { t: t(15), o: 101, c: 102 }, { t: t(30), o: 102, c: 101 }];
  const b5 = [0, 5, 10, 15, 20, 25, 30, 35, 40].map((m, i) => ({ t: t(m), o: 100, c: [101, 101, 101, 101, 101, 99, 99, 99, 99][i], v: m === 20 ? 9000 : 100 }));
  assert.equal(L.subBarConviction(w15, b5), 'most agree');   // 8 of 9 agree with their 15-min bar
  assert.equal(L.subBarConviction(w15.slice(0, 1), b5), 'all 5-min agree');
  assert.equal(L.thrustCandle(b5, Date.parse(t(0)), 1), 'thrust agrees');    // heaviest volume at 9:50, up
  assert.equal(L.thrustCandle(b5, Date.parse(t(0)), -1), 'thrust disagrees');
  assert.equal(L.thrustCandle(b5, Date.parse(t(0)), 0), 'thrust up, call FLAT');
  const rows = L.shadowTagStats('shadow_g23', [
    { verdict: 'UP', grade: 'TRUE', ret: 2, tags: { thrust_candle: 'thrust agrees' } },
    { verdict: 'DOWN', grade: 'FALSE', ret: 1, tags: { thrust_candle: 'thrust agrees' } },
    { verdict: 'FLAT', grade: 'TRUE', ret: 0, tags: { thrust_candle: 'thrust agrees' } },     // FLAT left out
  ]);
  assert.deepEqual(rows, [{ call_type: 'shadow_g23', signal: 'thrust_candle', value: 'thrust agrees', n: 2, pct: 50, avg_move_pct: 0.5 }]);
});

test('Gate 4 record-only signals: 50-day distance and the stretched case', () => {
  const gates = (ph, p) => ({ g4: ph, inputs: { g4: { pct_above_50d: p } } });
  const rows = [
    row({ verdict: 'UP', grade_long: 'FALSE', gates: gates('YELLOW', 12) }),
    row({ verdict: 'UP', grade_long: 'TRUE', gates: gates('GREEN', 3) }),
    row({ verdict: 'UP', grade_long: 'TRUE', gates: gates('RED', 25) }),    // RED: modifier would not act
    row({ verdict: 'UP', grade_long: 'TRUE', gates: gates('YELLOW', null) }),
  ];
  const s = L.computeSignalStats(rows);
  const find = (signal, value) => s.find(x => x.call_type === 'long' && x.signal === signal && x.value === value);
  assert.equal(find('g4_stretched', 'stretched').n, 1);
  assert.equal(find('g4_stretched', 'stretched').pct, 0);
  assert.equal(find('g4_stretched', 'not stretched').n, 1);
  assert.equal(find('vs_50d_avg', '>=10%').n, 2);
  assert.equal(find('vs_50d_avg', '0-10%').n, 1);
});
