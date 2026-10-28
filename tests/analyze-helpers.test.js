'use strict';
/**
 * Phase 4 of the TypeScript adoption plan (CLAUDE.md, "Engineering:
 * TypeScript adoption path"). Covers analyze-helpers.js -- the pure
 * /analyze logic extracted out of server.js on Aug 16, 2026 specifically
 * so it could be given real regression coverage. priceConfirmedConfidence
 * and evaluateProxyStatus/normalizeMarketReading are the two functions
 * that shipped real production bugs before (the Aug 13, 2026 Gate 5
 * forceDown-unreachable bug, and the Aug 16, 2026 LOW-confidence gap) --
 * see CLAUDE.md for the full incident writeups.
 *
 * Run with `node --test tests/`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ah = require('../analyze-helpers.js');

test('parsePctString', async (t) => {
  await t.test('parses a positive formatted percent string', () => {
    assert.equal(ah.parsePctString('+1.23%'), 1.23);
  });
  await t.test('parses a negative formatted percent string', () => {
    assert.equal(ah.parsePctString('-4.5%'), -4.5);
  });
  await t.test('non-string input returns null', () => {
    assert.equal(ah.parsePctString(42), null);
  });
  await t.test('unparseable string returns null', () => {
    assert.equal(ah.parsePctString('abc'), null);
  });
});

// ── priceConfirmedConfidence — HIGH/MEDIUM/LOW per the Aug 16, 2026 redefinition ──
test('priceConfirmedConfidence', async (t) => {
  await t.test('both ticker and proxy agree with the asserted direction -> HIGH', () => {
    assert.equal(ah.priceConfirmedConfidence('DOWN', -2, -2), 'HIGH');
    assert.equal(ah.priceConfirmedConfidence('UP', 2, 2), 'HIGH');
  });

  await t.test('the real Aug 13, 2026 crash-scale TSM example: both signals agree -> HIGH', () => {
    assert.equal(ah.priceConfirmedConfidence('DOWN', -6.20, -6.20), 'HIGH');
  });

  await t.test('both signals missing -> MEDIUM, unconfirmed not contradicted', () => {
    assert.equal(ah.priceConfirmedConfidence('DOWN', null, null), 'MEDIUM');
  });

  await t.test('one signal missing, the other agrees -> MEDIUM (not HIGH -- needs both)', () => {
    assert.equal(ah.priceConfirmedConfidence('DOWN', -2, null), 'MEDIUM');
  });

  await t.test('ticker disagrees with the asserted direction -> LOW', () => {
    assert.equal(ah.priceConfirmedConfidence('DOWN', 2, -2), 'LOW');
  });

  await t.test('proxy disagrees with the asserted direction -> LOW', () => {
    assert.equal(ah.priceConfirmedConfidence('UP', 2, -2), 'LOW');
  });

  await t.test('negligible moves on both sides never register as confirming or contradicting -> MEDIUM', () => {
    assert.equal(ah.priceConfirmedConfidence('DOWN', 0.5, -0.5), 'MEDIUM');
  });

  await t.test('exactly at the negligible-move boundary (1.0%) still counts as negligible -> MEDIUM', () => {
    assert.equal(ah.priceConfirmedConfidence('DOWN', -1.0, -1.0), 'MEDIUM');
  });

  await t.test('just past the negligible-move boundary -> a real signal, HIGH', () => {
    assert.equal(ah.priceConfirmedConfidence('DOWN', -1.01, -1.01), 'HIGH');
  });
});

// ── applyProxyFitCeiling — Sep 13, 2026, the generalized-regime confidence
// clamp. The real motivating case: ALAB's Gate 5 proxy (TSM) sits at
// rolling_r 0.49 vs a 0.66 baseline -- INTACT (unchanged from its own
// history), but never actually strong. ─────────────────────────────────
test('applyProxyFitCeiling', async (t) => {
  await t.test('the real ALAB number: HIGH downgrades to MEDIUM below the fit floor', () => {
    assert.equal(ah.applyProxyFitCeiling('HIGH', 0.49), 'MEDIUM');
  });

  await t.test('a strong fit leaves HIGH untouched', () => {
    assert.equal(ah.applyProxyFitCeiling('HIGH', 0.66), 'HIGH');
  });

  await t.test('exact floor boundary is not "below" it -- stays HIGH', () => {
    assert.equal(ah.applyProxyFitCeiling('HIGH', ah.PROXY_FIT_FLOOR), 'HIGH');
  });

  await t.test('just under the floor downgrades', () => {
    assert.equal(ah.applyProxyFitCeiling('HIGH', ah.PROXY_FIT_FLOOR - 0.0001), 'MEDIUM');
  });

  await t.test('no regime data at all (null/undefined) leaves HIGH untouched', () => {
    assert.equal(ah.applyProxyFitCeiling('HIGH', null), 'HIGH');
    assert.equal(ah.applyProxyFitCeiling('HIGH', undefined), 'HIGH');
  });

  await t.test('never upgrades or downgrades MEDIUM or LOW, regardless of fit', () => {
    assert.equal(ah.applyProxyFitCeiling('MEDIUM', 0.01), 'MEDIUM');
    assert.equal(ah.applyProxyFitCeiling('LOW', 0.01), 'LOW');
  });
});

// ── applyHistoricalAccuracyCeiling — Sep 14, 2026, the same-direction
// historical-accuracy confidence clamp. The real motivating case: ALAB's
// own pooled UP-verdict history is 0/8 graded TRUE -- a 0% same-direction
// accuracy that a direction-agnostic average would never surface. ──────
test('applyHistoricalAccuracyCeiling', async (t) => {
  await t.test('the real ALAB shape: 0% same-direction accuracy downgrades HIGH to MEDIUM', () => {
    assert.equal(ah.applyHistoricalAccuracyCeiling('HIGH', 0), 'MEDIUM');
  });

  await t.test('a solid same-direction track record leaves HIGH untouched', () => {
    assert.equal(ah.applyHistoricalAccuracyCeiling('HIGH', 65), 'HIGH');
  });

  await t.test('exact floor boundary is not "below" it -- stays HIGH', () => {
    assert.equal(ah.applyHistoricalAccuracyCeiling('HIGH', ah.HISTORICAL_ACCURACY_FLOOR_PCT), 'HIGH');
  });

  await t.test('just under the floor downgrades', () => {
    assert.equal(ah.applyHistoricalAccuracyCeiling('HIGH', ah.HISTORICAL_ACCURACY_FLOOR_PCT - 1), 'MEDIUM');
  });

  await t.test('insufficient graded history (null) leaves HIGH untouched -- never penalize a lack of data', () => {
    assert.equal(ah.applyHistoricalAccuracyCeiling('HIGH', null), 'HIGH');
    assert.equal(ah.applyHistoricalAccuracyCeiling('HIGH', undefined), 'HIGH');
  });

  await t.test('never upgrades or downgrades MEDIUM or LOW, regardless of same-direction accuracy', () => {
    assert.equal(ah.applyHistoricalAccuracyCeiling('MEDIUM', 0), 'MEDIUM');
    assert.equal(ah.applyHistoricalAccuracyCeiling('LOW', 0), 'LOW');
  });
});

// ── normalizeMarketReading — the exact shape mismatch behind the Aug 13 bug ──
test('normalizeMarketReading', async (t) => {
  await t.test('parses the real wire-format string shape sectorContext actually sends', () => {
    const r = ah.normalizeMarketReading('-6.20%');
    assert.deepEqual(r, { pct: -6.20, change: '-6.20%' });
  });

  await t.test('still accepts the real {pct,change} object shape -- lenient superset, not a breaking change', () => {
    const r = ah.normalizeMarketReading({ pct: -6.2, change: '-6.20%' });
    assert.deepEqual(r, { pct: -6.2, change: '-6.20%' });
  });

  await t.test('null/missing input -> null', () => {
    assert.equal(ah.normalizeMarketReading(null), null);
    assert.equal(ah.normalizeMarketReading(undefined), null);
  });

  await t.test('a shape that yields no usable number -> null', () => {
    assert.equal(ah.normalizeMarketReading(42), null);
    assert.equal(ah.normalizeMarketReading({ foo: 'bar' }), null);
  });
});

// ── evaluateProxyStatus — the Aug 13, 2026 Gate 5 forceDown-unreachable bug ──
test('evaluateProxyStatus', async (t) => {
  const singleRule = { proxy: { name: 'TSM (Taiwan Semiconductor)', symbols: ['TSM'], rationale: 'leads AI/semi capex cycles by 10-21 days.' } };

  await t.test('real crash-scale move (-6.20%, the actual Jul 29 2026 KOSPI-crash reference) -> RED', () => {
    const r = ah.evaluateProxyStatus(singleRule, { tsm: '-6.20%' });
    assert.equal(r.status, 'RED');
  });

  await t.test('mild move (-1.50%) -> YELLOW', () => {
    const r = ah.evaluateProxyStatus(singleRule, { tsm: '-1.50%' });
    assert.equal(r.status, 'YELLOW');
  });

  await t.test('flat move (+0.20%) -> GREEN', () => {
    const r = ah.evaluateProxyStatus(singleRule, { tsm: '+0.20%' });
    assert.equal(r.status, 'GREEN');
  });

  await t.test('this is the string wire format, not an object -- the exact shape the Aug 13 bug fed the wrong way', () => {
    // Before the fix, marketData[symbol].pct on a bare string was always
    // undefined, so avgPct was always 0 and status could never leave GREEN
    // regardless of how far the proxy had actually moved. A crash-scale
    // string input correctly returning RED (not GREEN) is the regression
    // this test exists to catch.
    const r = ah.evaluateProxyStatus(singleRule, { tsm: '-6.20%' });
    assert.notEqual(r.status, 'GREEN');
  });

  await t.test('multi-symbol rule with an earlier symbol missing -- label stays paired with its own reading', () => {
    // The second Aug 13 bug: changeStr used to re-index the post-filter
    // readings array against the pre-filter symbols array, mislabeling a
    // reading whenever an earlier symbol in the list failed to resolve.
    const multiRule = { proxy: { name: 'TSM+KOSPI', symbols: ['KOSPI', 'TSM'], rationale: 'combined Taiwan/Korea rule' } };
    const r = ah.evaluateProxyStatus(multiRule, { tsm: '-1.20%' }); // KOSPI has no reading
    assert.match(r.note, /TSM -1\.20%/);
    assert.doesNotMatch(r.note, /KOSPI -1\.20%/);
  });

  await t.test('no readings resolve at all -> GREEN pass-through with the proxy\'s own rationale', () => {
    const r = ah.evaluateProxyStatus(singleRule, {});
    assert.equal(r.status, 'GREEN');
    assert.equal(r.note, singleRule.proxy.rationale);
  });

  await t.test('any single symbol at or beyond -3% forces RED even if the multi-symbol average would not', () => {
    const multiRule = { proxy: { name: 'TSM+KOSPI', symbols: ['KOSPI', 'TSM'], rationale: 'combined' } };
    const r = ah.evaluateProxyStatus(multiRule, { kospi: '-4.00%', tsm: '+1.00%' }); // avg = -1.5% (YELLOW range) but KOSPI alone is a red flag
    assert.equal(r.status, 'RED');
  });
});

test('gatesForLog', async (t) => {
  await t.test('keeps all seven colors and only the G3 note', () => {
    const gates = {
      pre_gate: { status: 'GREEN', note: 'clear' }, sector: { status: 'YELLOW', note: 'SPY -0.4%' },
      g1_prewindow: { status: 'GREEN', note: 'up' }, g2_catalyst: { status: 'RED', note: 'miss' },
      g3_openbar: { status: 'YELLOW', note: 'Bar 1 only' }, g4_phase: { status: 'GREEN', note: 'low' },
      g5_korea: { status: 'RED', note: 'TSM -3%' },
    };
    assert.deepEqual(ah.gatesForLog(gates), {
      pre_gate: 'GREEN', sector: 'YELLOW', g1: 'GREEN', g2: 'RED', g3: 'YELLOW', g4: 'GREEN', g5: 'RED', g3_note: 'Bar 1 only',
    });
  });
  await t.test('stores null for a missing gate instead of guessing', () => {
    const out = ah.gatesForLog({ sector: { status: 'GREEN' } });
    assert.equal(out.sector, 'GREEN');
    assert.equal(out.g2, null);
    assert.equal(out.g3_note, null);
    assert.deepEqual(Object.keys(out), ['pre_gate', 'sector', 'g1', 'g2', 'g3', 'g4', 'g5', 'g3_note']);
  });
  await t.test('handles no gates at all', () => {
    assert.equal(ah.gatesForLog(null).pre_gate, null);
  });
});

// ── computeGate0 / Pulse input (Oct 19, 2026) ──
const q = (pct) => ({ pct, change: (pct > 0 ? '+' : '') + pct.toFixed(2) + '%' });
test('computeGate0: both down >1% is RED', () => {
  assert.strictEqual(ah.computeGate0({ spy: q(-1.2), qqq: q(-1.5) }).gateStatus, 'RED');
});
test('computeGate0: one index down >1% is YELLOW, not RED (real Sep 14, 2026 open)', () => {
  const g = ah.computeGate0({ spy: q(-0.74), qqq: q(-1.66) });
  assert.strictEqual(g.gateStatus, 'YELLOW');
  assert.match(g.gateNote, /one index down >1%/);
});
test('computeGate0: -0.5% band is YELLOW, mild negatives GREEN, strong up GREEN', () => {
  assert.strictEqual(ah.computeGate0({ spy: q(-0.6), qqq: q(0.1) }).gateStatus, 'YELLOW');
  assert.strictEqual(ah.computeGate0({ spy: q(-0.2), qqq: q(-0.1) }).gateStatus, 'GREEN');
  assert.match(ah.computeGate0({ spy: q(0.6), qqq: q(0.7) }).gateNote, /strong tailwind/);
});
test('computeGate0: BTC signal and TSM warning', () => {
  const g = ah.computeGate0({ spy: q(0), qqq: q(0), btc: q(-5.5), tsm: q(-3.2) });
  assert.strictEqual(g.btcSignal, 'risk-off');
  assert.match(g.tsmWarning, /TSM -3.20%/);
  assert.strictEqual(ah.computeGate0({}).gateStatus, 'GREEN');
});
test('pulsePct rounds to 1 decimal, missing data is ?', () => {
  assert.strictEqual(ah.pulsePct(q(1.07)), '+1.1%');
  assert.strictEqual(ah.pulsePct(q(1.08)), '+1.1%');
  assert.strictEqual(ah.pulsePct(q(-0.04)), '0.0%');
  assert.strictEqual(ah.pulsePct({ pct: 0, change: '?' }), '?');
});
test('buildPulseInput ignores sub-0.05% wiggles', () => {
  const a = ah.buildPulseInput({ spy: q(0.41), btc: q(1.07) });
  const b = ah.buildPulseInput({ spy: q(0.44), btc: q(1.08) });
  assert.strictEqual(a, b);
});

// ── Gate logging: not-read Gate 3, gate inputs, same-session FLAT band (Oct 19, 2026) ──
test('gatesForLog: Gate 3 with no bar data is stored as null, not the model YELLOW', () => {
  const g = { g3_openbar: { status: 'YELLOW', note: 'no opening bar data' }, g4_phase: { status: 'RED' } };
  const out = ah.gatesForLog(g, { g3Read: false });
  assert.strictEqual(out.g3, null);
  assert.strictEqual(out.g3_note, 'not read: no bar data');
  assert.strictEqual(out.g4, 'RED');
  assert.strictEqual(ah.gatesForLog(g).g3, 'YELLOW');
});
test('gateInputsForLog: rounds numbers, keeps missing as null', () => {
  const x = ah.gateInputsForLog({
    gate1: { branch: 'UPTREND', change14: 12.345, change60: 30.1, forceDown: false },
    rule: { proxy: { name: 'TSM', symbols: ['TSM'] }, tier: 'primary', r: '0.66', dynamicallyResolved: false },
    metrics: { rangePosition: 72, price: 101.234 }, g3Read: true,
    openingBar: { open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
    regime: { state: 'INTACT', rolling: 0.49 }, coherence: { case: 1, verdict: 'DOWN', forceDown: true },
    redCount: 1, override: 'gate5_coherence_down',
  });
  assert.strictEqual(x.g1.change14, 12.35);
  assert.strictEqual(x.g2.proxy_r, 0.66);
  assert.strictEqual(x.g3.source, 'opening_bar');
  assert.strictEqual(x.g4.week52hi, null);
  assert.strictEqual(x.g5.rolling_r, 0.49);
  assert.strictEqual(x.override, 'gate5_coherence_down');
  const empty = ah.gateInputsForLog({});
  assert.strictEqual(empty.g3.bars, null);
  assert.strictEqual(empty.red_count, null);
});
test('sameSessionFlatScale: shrinks as the session runs out, multi-session unchanged', () => {
  assert.strictEqual(ah.sameSessionFlatScale(570, 960, 0), 1);
  assert.ok(Math.abs(ah.sameSessionFlatScale(840, 960, 0) - Math.sqrt(120 / 390)) < 1e-9);
  assert.ok(Math.abs(ah.sameSessionFlatScale(959, 960, 0) - Math.sqrt(15 / 390)) < 1e-9); // 15-min floor
  assert.ok(Math.abs(ah.sameSessionFlatScale(720, 780, 0) - Math.sqrt(60 / 210)) < 1e-9); // early close
  assert.strictEqual(ah.sameSessionFlatScale(600, 960, 5), null);
});

// ── Market leaning for the Sector Pulse (Oct 19, 2026) ──
const mk = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, q(v)]));
test('computeMarketLeaning: real Oct 16 close is a broad selloff', () => {
  const d = mk({ spy: -1.11, qqq: -2.5, soxx: -4.14, nvda: -1.43, xbi: -3.65, ibb: -2.61, iwm: -1.69, gld: -0.18, uso: 2.83, btc: 1.02 });
  assert.deepStrictEqual(ah.computeMarketLeaning(d), { label: 'Broad selloff', direction: 'down' });
});
test('computeMarketLeaning: down with gold up is risk-off, safety bid', () => {
  assert.strictEqual(ah.computeMarketLeaning(mk({ spy: -0.8, qqq: -1.2, soxx: -2, gld: 0.9 })).label, 'Risk-off, safety bid');
});
test('computeMarketLeaning: up with semis leading is risk-on', () => {
  assert.strictEqual(ah.computeMarketLeaning(mk({ spy: 0.6, qqq: 0.9, soxx: 1.8, gld: -0.2 })).label, 'Risk-on');
});
test('computeMarketLeaning: flat market with split sectors is rotation', () => {
  assert.strictEqual(ah.computeMarketLeaning(mk({ spy: 0.1, qqq: -0.1, soxx: 1.5, xbi: -1.4 })).label, 'Rotation');
});
test('computeMarketLeaning: oil strongest while stocks flat is commodity-led', () => {
  assert.strictEqual(ah.computeMarketLeaning(mk({ spy: 0.1, qqq: 0.0, soxx: 0.4, uso: 2.1 })).label, 'Commodity-led');
});
test('computeMarketLeaning: everything within 0.3% is quiet; BTC ignored', () => {
  assert.strictEqual(ah.computeMarketLeaning(mk({ spy: 0.2, qqq: -0.1, soxx: 0.3, gld: 0.1, btc: 5 })).label, 'Quiet');
});
test('computeMarketLeaning: fallbacks and missing data', () => {
  assert.strictEqual(ah.computeMarketLeaning(mk({ spy: 0.5, qqq: 0.4, soxx: 0.2, iwm: 0.1 })).label, 'Mild gains');
  assert.strictEqual(ah.computeMarketLeaning({}).label, 'Unavailable');
});

test("plain-word Sector Pulse", async (t) => {
  const qq = (pct) => ({ pct, change: (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%" });
  const day = { spy: qq(0.8), qqq: qq(1.2), soxx: qq(1.7), nvda: qq(1.4), xbi: qq(2.5), ibb: qq(1.0), iwm: qq(0.5), gld: qq(-0.6), uso: qq(-0.6), btc: qq(3) };
  await t.test("names leaders and laggards in words, no numbers", () => {
    const w = ah.buildPulseWords(day);
    assert.ok(!/[0-9%]/.test(w), w);
    assert.match(w, /Market leaning: Risk-on/);
    assert.match(w, /Leading: chip stocks, biotech|Leading: biotech, chip stocks/);
    assert.match(w, /Lagging: (gold, oil|oil, gold)/);
  });
  await t.test("fallback is plain English with no numbers", () => {
    const t = ah.pulseFallbackText(day);
    assert.ok(!ah.pulseHasNumbers(t), t);
    assert.match(t, /^Risk-on: investors are willing to take chances/);
    assert.match(t, /leading, while .* lagging\.$/);
  });
  await t.test("quiet day has no leaders sentence", () => {
    const quiet = { spy: qq(0.1), qqq: qq(-0.1), gld: qq(0.2) };
    assert.strictEqual(ah.pulseFallbackText(quiet), "Quiet: a calm day with no real direction.");
  });
  await t.test("detects numbers", () => {
    assert.ok(ah.pulseHasNumbers("SOXX +1.7%"));
    assert.ok(!ah.pulseHasNumbers("Chip stocks led."));
  });
});

test("options probe math (DAY call, logging only)", async (t) => {
  const now = Date.parse("2026-10-27T15:00:00Z");
  const snaps = {
    "MU261120C00100000": { impliedVolatility: 0.6, greeks: { delta: 0.55 }, dailyBar: { v: 1000 }, latestQuote: { t: "2026-10-27T14:45:00Z" } },
    "MU261120P00100000": { impliedVolatility: 0.62, greeks: { delta: -0.45 }, dailyBar: { v: 200 }, latestQuote: { t: "2026-10-27T14:44:00Z" } },
    "MU261030C00100000": { impliedVolatility: 1.5, greeks: { delta: 0.5 }, dailyBar: { v: 0 } }, // 3 DTE: not the headline IV
    "MU261120C00150000": { impliedVolatility: 0.9, greeks: { delta: 0.05 } },               // far OTM
    "junk": { impliedVolatility: 0.5 },
  };
  await t.test("headline IV is near-the-money, 5-45 days out", () => {
    const s = ah.summarizeOptionsChain(snaps, 100, now);
    assert.strictEqual(s.contracts, 5);
    assert.strictEqual(s.atmIv, 0.6);
    assert.strictEqual(s.impliedDailyMovePct, +(60 / Math.sqrt(252)).toFixed(3));
    assert.strictEqual(s.newestQuoteAgeMin, 15);
    assert.strictEqual(s.withVolume, 2);
  });
  await t.test("volume-weighted delta lean", () => {
    const s = ah.summarizeOptionsChain(snaps, 100, now);
    // (0.55*1000 - 0.45*200) / (0.55*1000 + 0.45*200) = 460/640
    assert.strictEqual(s.deltaLeanVolume, +(460 / 640).toFixed(3));
    assert.strictEqual(ah.deltaLeanLabel(s.deltaLeanVolume), "BULLISH");
    assert.strictEqual(s.deltaLeanOi, null);
  });
  await t.test("OI-weighted lean when open interest is supplied", () => {
    const s = ah.summarizeOptionsChain(snaps, 100, now, { "MU261120C00100000": 100, "MU261120P00100000": 300 });
    assert.strictEqual(s.withOi, 2);
    assert.strictEqual(s.deltaLeanOi, +((55 - 135) / (55 + 135)).toFixed(3));
    assert.strictEqual(ah.deltaLeanLabel(s.deltaLeanOi), "BEARISH");
  });
  await t.test("empty chain is safe", () => {
    const s = ah.summarizeOptionsChain({}, 100, now);
    assert.strictEqual(s.contracts, 0);
    assert.strictEqual(s.atmIv, null);
  });
  await t.test("bar schedule and yardstick", () => {
    assert.deepStrictEqual(ah.dayBarSchedule(4, 2), { ratio: 2, barMinutes: 5 });
    assert.deepStrictEqual(ah.dayBarSchedule(2, 2), { ratio: 1, barMinutes: 15 });
    assert.deepStrictEqual(ah.dayBarSchedule(1, 2), { ratio: 0.5, barMinutes: 30 });
    assert.deepStrictEqual(ah.dayBarSchedule(null, 2), { ratio: null, barMinutes: 15 });
    assert.strictEqual(ah.barYardstickPct(3.78, 15), +(3.78 * Math.sqrt(15 / 390)).toFixed(3));
    assert.strictEqual(ah.deltaLeanLabel(0.1), "NEUTRAL");
  });
});

test("Gate 4 record-only: distance from the 50-day average", () => {
  const closes = Array.from({ length: 60 }, (_, i) => (i < 10 ? 999 : 100));
  assert.deepStrictEqual(ah.pctAboveSma(closes, 110, 50), { sma: 100, pct: 10 });
  assert.strictEqual(ah.pctAboveSma(closes.slice(0, 40), 110, 50), null);
  assert.strictEqual(ah.pctAboveSma(closes, null, 50), null);
  const log = ah.gateInputsForLog({ metrics: { price: 90, rangePosition: 40 }, dailyCloses: closes });
  assert.strictEqual(log.g4.sma50, 100);
  assert.strictEqual(log.g4.pct_above_50d, -10);
  assert.strictEqual(ah.gateInputsForLog({ metrics: { price: 90 } }).g4.pct_above_50d, null);
});
