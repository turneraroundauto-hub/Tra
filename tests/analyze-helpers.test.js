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
