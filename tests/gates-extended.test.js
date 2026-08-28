'use strict';
/**
 * Phase 4 of the TypeScript adoption plan (CLAUDE.md, "Engineering:
 * TypeScript adoption path"). Formalizes the throwaway Node scripts this
 * repo has been using to "verify by simulation" every gate-logic change
 * since Proposal 2/3/4 and the Aug 13, 2026 Gate 5 fix into permanent,
 * committed regression coverage — same cases those write-ups already
 * document as having been run, now checked in instead of discarded.
 *
 * Run with `node --test tests/` (no test framework dependency — Node's
 * built-in runner, per the plan's own "even Node's built-in runner
 * without waiting on Phase 3" note).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const gx = require('../gates-extended.js');

// ── evaluateGate1Sessions — all 8 documented branches ──────────────────
test('evaluateGate1Sessions', async (t) => {
  await t.test('insufficient history returns ok:false, not a DOWN', () => {
    const r = gx.evaluateGate1Sessions([100, 101, 102]);
    assert.equal(r.ok, false);
    assert.equal(r.forceDown, false);
  });

  await t.test('flat 60-session structure', () => {
    const closes = Array(61).fill(100);
    const r = gx.evaluateGate1Sessions(closes);
    assert.equal(r.branch, 'FLAT');
    assert.equal(r.color, 'GREEN');
    assert.equal(r.sizing, 'FULL');
    assert.equal(r.forceDown, false);
  });

  await t.test('uptrend, 14-session change >20% -> RED/NONE exhaustion', () => {
    // 61 sessions: closes[0] is the 60-session anchor, closes[46] is the
    // 14-session anchor -- both flat at 100, then a ramp through the last
    // 14 sessions to 30% above the 14-session anchor.
    const closes = new Array(61).fill(100);
    for (let i = 47; i <= 60; i++) closes[i] = 100 * (1 + 0.30 * (i - 46) / 14);
    const r = gx.evaluateGate1Sessions(closes);
    assert.equal(r.branch, 'UPTREND');
    assert.equal(r.color, 'RED');
    assert.equal(r.sizing, 'NONE');
    assert.equal(r.forceDown, false);
  });

  await t.test('uptrend, 14-session change in 10-20% band -> YELLOW/HALF', () => {
    const closes = Array(47).fill(100).concat([112, 112, 112, 112, 112, 112, 112, 112, 112, 112, 112, 112, 112, 112]);
    const r = gx.evaluateGate1Sessions(closes);
    assert.equal(r.branch, 'UPTREND');
    assert.equal(r.color, 'YELLOW');
    assert.equal(r.sizing, 'HALF');
  });

  await t.test('uptrend, 14-session change under 10% -> GREEN/FULL', () => {
    const closes = Array(47).fill(100).concat(Array(14).fill(105));
    const r = gx.evaluateGate1Sessions(closes);
    assert.equal(r.branch, 'UPTREND');
    assert.equal(r.color, 'GREEN');
    assert.equal(r.sizing, 'FULL');
  });

  await t.test('downtrend, 60-session decline >25% -> RED/NONE, forceDown', () => {
    const closes = Array(61).fill(100);
    closes[0] = 140; // anchor60 = 140, last = 100 -> -28.6%
    const r = gx.evaluateGate1Sessions(closes);
    assert.equal(r.branch, 'DOWNTREND');
    assert.equal(r.color, 'RED');
    assert.equal(r.sizing, 'NONE');
    assert.equal(r.forceDown, true);
  });

  await t.test('downtrend, 60-session decline in 10-25% band -> YELLOW/HALF, requires confirmed higher low', () => {
    const closes = Array(61).fill(100);
    closes[0] = 115; // -13% decline
    const r = gx.evaluateGate1Sessions(closes);
    assert.equal(r.branch, 'DOWNTREND');
    assert.equal(r.color, 'YELLOW');
    assert.equal(r.sizing, 'HALF');
    assert.equal(r.forceDown, false);
    assert.equal(r.requiresConfirmedHigherLow, true);
  });

  await t.test('downtrend, 60-session decline under 10% -> GREEN/FULL, normal pullback', () => {
    const closes = Array(61).fill(100);
    closes[0] = 105; // -4.8% decline
    const r = gx.evaluateGate1Sessions(closes);
    assert.equal(r.branch, 'DOWNTREND');
    assert.equal(r.color, 'GREEN');
    assert.equal(r.sizing, 'FULL');
    assert.equal(r.forceDown, false);
  });
});

// ── proxyCoherenceCheck — all 3 cases, including the real Aug 13 crash ──
test('proxyCoherenceCheck', async (t) => {
  await t.test('case 1: same direction, any magnitude -> DOWN, forceDown, confirmed', () => {
    const r = gx.proxyCoherenceCheck(-2.5, -3.0);
    assert.equal(r.case, 1);
    assert.equal(r.verdict, 'DOWN');
    assert.equal(r.forceDown, true);
    assert.equal(r.triggerRevalidation, false);
  });

  await t.test('real Aug 13, 2026 crash-scale example: TSM -6.20% both agree', () => {
    const r = gx.proxyCoherenceCheck(-6.20, -6.20);
    assert.equal(r.case, 1);
    assert.equal(r.forceDown, true);
  });

  await t.test('case 2: ticker flat inside the coherence band -> DOWN, forceDown, unconfirmed lag risk', () => {
    const r = gx.proxyCoherenceCheck(0.3, -4.0);
    assert.equal(r.case, 2);
    assert.equal(r.verdict, 'DOWN');
    assert.equal(r.forceDown, true);
    assert.match(r.label, /lag risk/i);
  });

  await t.test('case 3: ticker moves opposite the proxy beyond the decouple threshold -> HOLD, forceDown suppressed', () => {
    const r = gx.proxyCoherenceCheck(2.5, -4.0);
    assert.equal(r.case, 3);
    assert.equal(r.verdict, 'HOLD');
    assert.equal(r.forceDown, false);
    assert.equal(r.triggerRevalidation, true);
  });
});

// ── regimeValidation — UNKNOWN / INTACT / DEGRADING / BROKEN ────────────
test('regimeValidation', async (t) => {
  await t.test('insufficient history -> UNKNOWN, no action', () => {
    const r = gx.regimeValidation([100, 101, 102], [50, 51, 52]);
    assert.equal(r.state, 'UNKNOWN');
    assert.equal(r.action, 'NONE');
  });

  await t.test('perfectly correlated series -> INTACT', () => {
    const ticker = [];
    const proxy = [];
    let t1 = 100, p1 = 50;
    for (let i = 0; i < 45; i++) {
      const move = 1 + (Math.sin(i) * 0.01);
      t1 *= move; p1 *= move;
      ticker.push(t1); proxy.push(p1);
    }
    const r = gx.regimeValidation(ticker, proxy);
    assert.equal(r.state, 'INTACT');
    assert.equal(r.action, 'NONE');
  });

  await t.test('last 20 sessions deliberately decorrelated -> DEGRADING, mandatory coherence check', () => {
    const ticker = [];
    const proxy = [];
    let t1 = 100, p1 = 50;
    // First 25 sessions: strongly correlated (real baseline).
    for (let i = 0; i < 25; i++) {
      const move = 1 + (Math.sin(i) * 0.015);
      t1 *= move; p1 *= move;
      ticker.push(t1); proxy.push(p1);
    }
    // Last 20 sessions: a small shared component keeps the rolling
    // correlation weakly positive (not BROKEN), while a higher-frequency,
    // independent component pulls it meaningfully below the baseline
    // (DEGRADING, not INTACT) -- tuned against the real pearson()/
    // regimeValidation() implementation, not asserted blind.
    for (let i = 0; i < 20; i++) {
      const shared = Math.sin(i * 0.5) * 0.006;
      t1 *= 1 + shared + Math.sin(i * 0.9) * 0.004;
      p1 *= 1 + shared + Math.sin(i * 7 + 2) * 0.02;
      ticker.push(t1); proxy.push(p1);
    }
    const r = gx.regimeValidation(ticker, proxy);
    assert.equal(r.state, 'DEGRADING');
    assert.equal(r.action, 'REQUIRE_COHERENCE_CHECK');
    assert.ok(r.rolling > 0, 'rolling correlation should still be positive, not BROKEN');
  });

  await t.test('rolling correlation at or below zero -> BROKEN, suspend + re-resolve', () => {
    const ticker = [];
    const proxy = [];
    let t1 = 100, p1 = 50;
    for (let i = 0; i < 25; i++) {
      const move = 1 + (Math.sin(i) * 0.01);
      t1 *= move; p1 *= move;
      ticker.push(t1); proxy.push(p1);
    }
    // Last 20 sessions: proxy inverted relative to the ticker -> rolling
    // correlation goes negative.
    for (let i = 0; i < 20; i++) {
      const tickerMove = 1 + (Math.sin(i * 2.1) * 0.03);
      t1 *= tickerMove;
      p1 *= 2 - tickerMove; // inverse move
      ticker.push(t1); proxy.push(p1);
    }
    const r = gx.regimeValidation(ticker, proxy);
    assert.equal(r.state, 'BROKEN');
    assert.equal(r.action, 'SUSPEND_FORCEDOWN_AND_RERESOLVE');
  });
});

// ── resolveFixedProxyBreak — all 4 tiers ────────────────────────────────
test('resolveFixedProxyBreak', async (t) => {
  function series(seed, n) {
    const out = [100];
    for (let i = 0; i < n; i++) out.push(out[out.length - 1] * (1 + Math.sin(i * seed) * 0.02));
    return out;
  }

  await t.test('primary: a candidate clears the primary correlation floor', () => {
    const ticker = series(1.0, 40);
    const basket = { SPY: ticker.slice(), QQQ: series(9.9, 40) };
    const r = gx.resolveFixedProxyBreak(ticker, basket, null);
    assert.equal(r.tier, 'primary');
    assert.equal(r.proxy, 'SPY');
    assert.equal(r.forceDownAuthority, true);
  });

  await t.test('secondary: best candidate clears the secondary floor but not primary', () => {
    const ticker = series(1.0, 40);
    const tickerReturns = gx.dailyReturns(ticker);
    const independentReturns = gx.dailyReturns(series(9.9, 40));
    // A candidate whose returns are a 40/60 blend of the ticker's own
    // returns and an independent series -- real but partial signal, tuned
    // against the real pearson()/resolveFixedProxyBreak() implementation
    // to land between PROXY_SECONDARY_FLOOR (0.4) and PROXY_PRIMARY_FLOOR
    // (0.6), not asserted blind.
    const blended = tickerReturns.map((r, i) => 0.4 * r + 0.6 * independentReturns[i]);
    const candidateCloses = [100];
    for (const r of blended) candidateCloses.push(candidateCloses[candidateCloses.length - 1] * (1 + r));
    const basket = { XBI: candidateCloses, SOXX: series(9.9, 40) };
    const r = gx.resolveFixedProxyBreak(ticker, basket, null);
    assert.equal(r.tier, 'secondary');
    assert.equal(r.sizing, 'INFORMS_ONLY');
    assert.equal(r.forceDownAuthority, false);
  });

  await t.test('fundamentals-confirmed: no candidate clears the floor, but 3+/4 fundamentals checks pass', () => {
    const ticker = series(1.0, 40);
    const basket = { QQQ: series(9.9, 40), IWM: series(17.3, 40) };
    const r = gx.resolveFixedProxyBreak(ticker, basket, { yearsPublic: 10, marketCap: 5e9, avgVol20d: 2e6, ivRank: 40 });
    assert.equal(r.tier, 'fundamentals-confirmed');
    assert.equal(r.proxy, null);
    assert.equal(r.forceDownAuthority, false);
    assert.equal(r.sizing, 'NORMAL');
  });

  await t.test('fundamentals-speculative: no candidate, fewer than 3/4 fundamentals checks pass -> elevated risk flags', () => {
    const ticker = series(1.0, 40);
    const basket = { QQQ: series(9.9, 40), IWM: series(17.3, 40) };
    const r = gx.resolveFixedProxyBreak(ticker, basket, { yearsPublic: 1, marketCap: 1e8 });
    assert.equal(r.tier, 'fundamentals-speculative');
    assert.equal(r.sizing, 'QUARTER');
    assert.equal(r.autoExecuteStop, true);
    assert.equal(r.elevatedCapCeiling, true);
  });
});

// ── hasForceDownAuthority — all 5 documented scenarios ──────────────────
test('hasForceDownAuthority', async (t) => {
  await t.test('unknown gate key -> not authorized', () => {
    const r = gx.hasForceDownAuthority('NOT_A_REAL_GATE');
    assert.equal(r.authorized, false);
  });

  await t.test('scoped gate, ticker not in that scope -> not authorized', () => {
    const r = gx.hasForceDownAuthority('TAIWAN_PROXY', ['korea-gated']);
    assert.equal(r.authorized, false);
  });

  await t.test('scoped gate, ticker in scope, no regime -> authorized', () => {
    const r = gx.hasForceDownAuthority('TAIWAN_PROXY', ['ai-semi-gated'], null);
    assert.equal(r.authorized, true);
    assert.equal(r.requiresCoherenceCheck, undefined);
  });

  await t.test('fixed-proxy gate with BROKEN regime -> suspended, requires re-resolve', () => {
    const r = gx.hasForceDownAuthority('TAIWAN_PROXY', ['ai-semi-gated'], { state: 'BROKEN', rolling: -0.1 });
    assert.equal(r.authorized, false);
    assert.equal(r.requiresReresolve, true);
  });

  await t.test('fixed-proxy gate with DEGRADING regime -> authorized but mandatory coherence check', () => {
    const r = gx.hasForceDownAuthority('TAIWAN_PROXY', ['ai-semi-gated'], { state: 'DEGRADING', rolling: 0.2 });
    assert.equal(r.authorized, true);
    assert.equal(r.requiresCoherenceCheck, true);
  });

  await t.test('unscoped (all-tickers) gate is never affected by regime state', () => {
    const r = gx.hasForceDownAuthority('GATE_0_RED', [], { state: 'BROKEN', rolling: -0.1 });
    assert.equal(r.authorized, true);
  });
});

// ── buildupPatternCheck / computeGate2Corroboration ─────────────────────
test('buildupPatternCheck', async (t) => {
  await t.test('all computable signals agree -> ok', () => {
    const r = gx.buildupPatternCheck({ volRatio: 2.0, tickerPct: 3.0, proxyPct: 1.0, hasFreshNews: false });
    assert.equal(r.ok, true);
    assert.equal(r.usable, 3);
    assert.equal(r.confirmed, 3);
  });
  await t.test('fewer than 2 usable signals -> not ok regardless of the single signal', () => {
    const r = gx.buildupPatternCheck({ hasFreshNews: false });
    assert.equal(r.usable, 1);
    assert.equal(r.ok, false);
  });
  await t.test('signals disagree -> not ok', () => {
    const r = gx.buildupPatternCheck({ volRatio: 0.5, tickerPct: 1.0, proxyPct: 2.0, hasFreshNews: true });
    assert.equal(r.ok, false);
  });
});

test('computeGate2Corroboration', async (t) => {
  await t.test('both deterministic sources agree -> corroborated', () => {
    const r = gx.computeGate2Corroboration({ buildup: { ok: true }, hasEarningsEvent: true });
    assert.equal(r.corroborated, true);
    assert.equal(r.matchCount, 2);
    assert.equal(r.modifier, 'GATE2-CORROBORATED');
    assert.deepEqual(r.matchedLabels, ['gate3_buildup_pattern', 'earnings_calendar_event']);
  });
  await t.test('only 1 of 2 sources agree -> not corroborated, informational only', () => {
    const r = gx.computeGate2Corroboration({ buildup: { ok: true }, hasEarningsEvent: false });
    assert.equal(r.corroborated, false);
    assert.equal(r.matchCount, 1);
    assert.equal(r.modifier, null);
  });
  await t.test('zero sources -> not corroborated', () => {
    const r = gx.computeGate2Corroboration();
    assert.equal(r.matchCount, 0);
    assert.equal(r.corroborated, false);
  });
  await t.test('never requires user-typed text -- both sources are deterministic market data', () => {
    // No newsMatch/context field exists on the input shape at all anymore;
    // confirms the Aug 28, 2026 rework actually dropped that dependency.
    const r = gx.computeGate2Corroboration({ buildup: { ok: true }, hasEarningsEvent: true });
    assert.equal(r.sources.some(s => s.key === 'news_content_match'), false);
  });
});

// ── dailyReturns / pearson — basic sanity on the two math helpers ───────
test('dailyReturns / pearson', async (t) => {
  await t.test('dailyReturns computes session-over-session % change as a decimal', () => {
    const r = gx.dailyReturns([100, 110, 99]);
    assert.equal(r.length, 2);
    assert.ok(Math.abs(r[0] - 0.10) < 1e-9);
    assert.ok(Math.abs(r[1] - (-0.10)) < 1e-9);
  });
  await t.test('pearson of identical series is 1', () => {
    const a = [1, 2, 3, 4, 5];
    assert.ok(Math.abs((gx.pearson(a, a) || 0) - 1) < 1e-9);
  });
  await t.test('pearson with fewer than 2 overlapping points is null', () => {
    assert.equal(gx.pearson([1], [1]), null);
  });
});
