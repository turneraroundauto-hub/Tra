'use strict';
// Gate 3 rolling 3-bar window + Day verdict (Oct 19, 2026, Pro beta).
const test = require('node:test');
const assert = require('node:assert/strict');
const g3 = require('../gate3-window.js');

const CLOSE = 16 * 60;
const bar = (t, o, c) => ({ t, o, h: Math.max(o, c), l: Math.min(o, c), c });

test('candleKey groups taps inside the same 15-min candle', () => {
  assert.equal(g3.candleKey('2026-10-19', 9 * 60 + 29, CLOSE), null);
  assert.equal(g3.candleKey('2026-10-19', 9 * 60 + 30, CLOSE), '2026-10-19T09:30');
  assert.equal(g3.candleKey('2026-10-19', 10 * 60 + 14, CLOSE), '2026-10-19T10:00');
  assert.equal(g3.candleKey('2026-10-19', 10 * 60 + 15, CLOSE), '2026-10-19T10:15');
  assert.equal(g3.candleKey('2026-10-19', 16 * 60, CLOSE), null);
  assert.equal(g3.candleKey('2026-11-27', 13 * 60 + 5, 13 * 60), null); // early close
});

test('completedBars drops the bar still forming', () => {
  const bars = [bar('2026-10-19T13:30:00Z', 1, 2), bar('2026-10-19T13:45:00Z', 2, 3)];
  const now = Date.parse('2026-10-19T13:59:00Z');
  assert.equal(g3.completedBars(bars, now).length, 1);
  assert.equal(g3.completedBars(bars, Date.parse('2026-10-19T14:00:00Z')).length, 2);
});

test('windowState: 0/1/2/3/4+ bars, cutoff, closed', () => {
  const m = 10 * 60;
  assert.equal(g3.windowState(true, m, CLOSE, 0), 'FORMING');
  assert.equal(g3.windowState(true, m, CLOSE, 1), 'FORMING');
  assert.equal(g3.windowState(true, m, CLOSE, 2), 'FORMING');
  assert.equal(g3.windowState(true, 10 * 60 + 15, CLOSE, 3), 'RESOLVED');
  assert.equal(g3.windowState(true, 11 * 60, CLOSE, 6), 'RESOLVED');
  assert.equal(g3.windowState(true, 12 * 60 + 29, CLOSE, 11), 'RESOLVED');
  assert.equal(g3.windowState(true, 12 * 60 + 30, CLOSE, 12), 'EXPIRED');
  assert.equal(g3.windowState(true, 9 * 60, CLOSE, 0), 'CLOSED');
  assert.equal(g3.windowState(false, 11 * 60, CLOSE, 6), 'CLOSED'); // holiday/weekend
  assert.equal(g3.windowState(true, 13 * 60, 13 * 60, 14), 'CLOSED'); // after early close
});

test('classifySequence reads the latest 3 bars', () => {
  const up = [bar('a', 10, 9.9), bar('b', 9.9, 10.1), bar('c', 10.1, 10.3)];
  assert.equal(g3.classifySequence(up).status, 'GREEN');
  const down = [bar('a', 10, 10.1), bar('b', 10.1, 9.9), bar('c', 9.9, 9.8)];
  assert.equal(g3.classifySequence(down).status, 'RED');
  const mixed = [bar('a', 10, 10.1), bar('b', 10.1, 10.2), bar('c', 10.2, 10.15)];
  assert.equal(g3.classifySequence(mixed).status, 'YELLOW');
  assert.equal(g3.classifySequence(up.slice(0, 2)), null);
  // rolling: only the last 3 of 4 count
  const four = [bar('z', 10, 12), ...down];
  assert.equal(g3.classifySequence(four).status, 'RED');
});

test('refineDayVerdict never adds a call on its own and respects overrides', () => {
  const green = { direction: 1 }, yellow = { direction: 0 }, red = { direction: -1 };
  assert.deepEqual(
    [g3.refineDayVerdict({ verdict: 'UP', sizing: 'FULL' }, green).verdict, g3.refineDayVerdict({ verdict: 'UP', sizing: 'FULL' }, green).sizing],
    ['UP', 'FULL']);
  assert.equal(g3.refineDayVerdict({ verdict: 'UP', sizing: 'FULL' }, yellow).sizing, 'HALF');
  assert.equal(g3.refineDayVerdict({ verdict: 'UP', sizing: 'FULL' }, red).verdict, 'FLAT');
  assert.equal(g3.refineDayVerdict({ verdict: 'DOWN', sizing: 'HALF' }, green).verdict, 'FLAT');
  assert.equal(g3.refineDayVerdict({ verdict: 'DOWN', sizing: 'HALF' }, yellow).sizing, 'QUARTER');
  assert.equal(g3.refineDayVerdict({ verdict: 'FLAT', sizing: 'NONE' }, green).verdict, 'FLAT');
  const locked = g3.refineDayVerdict({ verdict: 'DOWN', sizing: 'NONE' }, green, { locked: true });
  assert.equal(locked.verdict, 'DOWN');
  assert.equal(g3.refineDayVerdict({ verdict: 'UP', sizing: 'FULL' }, green, { fridaySkeptic: true }).sizing, 'HALF');
  assert.equal(g3.refineDayVerdict({ verdict: 'UP', sizing: 'FULL' }, null), null);
});

// Options lens (Oct 27, 2026): IV yardstick, delta lean, other bar sizes.
const mkb = (t, o, c) => ({ t, o, h: Math.max(o, c), l: Math.min(o, c), c });
test('IV yardstick: small bars no longer count as a push', () => {
  const tiny = [mkb('2026-10-27T13:30:00Z', 100, 100.05), mkb('2026-10-27T13:45:00Z', 100.05, 100.1), mkb('2026-10-27T14:00:00Z', 100.1, 100.15)];
  assert.equal(g3.classifySequence(tiny).status, 'GREEN');                       // no IV: any move counts
  const s = g3.classifySequence(tiny, { yardstickPct: 0.74 });                    // a bar needs 0.37%+
  assert.equal(s.status, 'YELLOW');
  assert.match(s.note, /too small to count/);
  const real = [mkb('2026-10-27T13:30:00Z', 100, 100.5), mkb('2026-10-27T13:45:00Z', 100.5, 101), mkb('2026-10-27T14:00:00Z', 101, 101.5)];
  assert.equal(g3.classifySequence(real, { yardstickPct: 0.74 }).status, 'GREEN');
});
test('delta lean against the bars drops GREEN/RED to YELLOW', () => {
  const up = [mkb('2026-10-27T13:30:00Z', 100, 100.5), mkb('2026-10-27T13:45:00Z', 100.5, 101), mkb('2026-10-27T14:00:00Z', 101, 101.5)];
  const s = g3.classifySequence(up, { yardstickPct: 0.74, lean: 'BEARISH' });
  assert.equal(s.status, 'YELLOW'); assert.equal(s.direction, 0); assert.equal(s.leanApplied, true);
  assert.match(s.note, /lean bearish/);
  assert.equal(g3.classifySequence(up, { yardstickPct: 0.74, lean: 'BULLISH' }).status, 'GREEN');
  assert.equal(g3.classifySequence(up, { lean: 'NEUTRAL' }).status, 'GREEN');
  const down = up.map(b => ({ ...b, o: b.c, c: b.o }));
  assert.equal(g3.classifySequence(down, { lean: 'BULLISH' }).status, 'YELLOW');
  // DAY call steps down a size instead of confirming
  assert.deepEqual(g3.refineDayVerdict({ verdict: 'UP', sizing: 'FULL' }, s), { verdict: 'UP', sizing: 'HALF', note: 'Bars not confirming yet: size down for the day.' });
});
test('5- and 30-min schedules: candles and completed bars', () => {
  assert.equal(g3.candleKey('2026-10-27', 9 * 60 + 44, CLOSE, 5), '2026-10-27T09:40/5m');
  assert.equal(g3.candleKey('2026-10-27', 10 * 60 + 59, CLOSE, 30), '2026-10-27T10:30/30m');
  assert.equal(g3.candleKey('2026-10-27', 10 * 60 + 59, CLOSE), '2026-10-27T10:45');
  const bars = [{ t: '2026-10-27T13:30:00Z' }, { t: '2026-10-27T13:35:00Z' }, { t: '2026-10-27T13:40:00Z' }];
  assert.equal(g3.completedBars(bars, Date.parse('2026-10-27T13:45:00Z'), 5).length, 3);
  assert.equal(g3.completedBars(bars, Date.parse('2026-10-27T13:45:00Z')).length, 1);
});
