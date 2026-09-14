'use strict';
// Parses a formatted "+1.23%"/"-4.5%" string (the shape sectorContext's
// per-symbol fields actually arrive in from every tier's client) into a
// number.
function parsePctString(s) {
    if (typeof s !== 'string')
        return null;
    const n = parseFloat(s.replace('%', ''));
    return Number.isFinite(n) ? n : null;
}
// Same tolerance gates-extended.ts's proxyCoherenceCheck() already uses
// (COHERENCE_FLAT_BAND_PCT) to decide a move is real, not noise -- kept as
// its own local constant rather than importing that one, since exporting a
// value tuned for one specific check to double as a generic threshold here
// would couple the two for no real reason.
const CONFIDENCE_NEGLIGIBLE_MOVE_PCT = 1.0;
// Below this rolling correlation (Sep 13, 2026), Gate 5's own proxy isn't a
// reliable enough relationship for two-signal agreement to justify HIGH --
// a different question from regimeValidation()'s own BROKEN ceiling (0.0)
// and DEGRADING delta (-0.30), which measure whether the fit has CHANGED,
// not whether it was ever STRONG. A ticker can sit "INTACT" (unchanged from
// its own historical baseline) while that baseline itself was never tight
// enough to trust -- confirmed against real verdict_log data: ALAB's Gate 5
// proxy (TSM) reads rolling_r 0.49 against a 0.66 baseline, state INTACT,
// yet 0 of ALAB's 8 real UP verdicts graded TRUE. Consumed by server.js's
// single post-parse confidence-ceiling clamp (applied once, after every
// branch that can set confidence, including the model's own self-assigned
// value on a "clean" verdict with no override at all -- ALAB's actual
// failure shape, since none of its misses ever tripped another gate) --
// not threaded into priceConfirmedConfidence() itself, since that function
// only fires on specific override branches and a "clean" verdict never
// reaches it.
const PROXY_FIT_FLOOR = 0.5;
// CONFIDENCE, redefined (Aug 16, 2026) as price-confirmed corroboration,
// not "did a rule fire": HIGH requires the ticker's own price move AND its
// proxy/sector's move to both independently agree with the asserted
// direction; MEDIUM is a real, clean trigger with no independent price
// data to confirm or deny it; LOW is a signal that IS available moving
// opposite the asserted direction -- the math and the chart disagreeing.
// A move inside +/-CONFIDENCE_NEGLIGIBLE_MOVE_PCT counts as unavailable,
// not agreeing or disagreeing -- confidence should never hinge on noise,
// same reasoning proxyCoherenceCheck's own flat band already applies.
// direction is "UP" or "DOWN"; tickerPct/proxyPct are the already-computed
// session % moves (see the /analyze handler's own comment on why those two
// specific fields are what's actually populated on the request).
function priceConfirmedConfidence(direction, tickerPct, proxyPct) {
    const sign = direction === 'DOWN' ? -1 : 1;
    const isReal = (v) => v != null && Math.abs(v) > CONFIDENCE_NEGLIGIBLE_MOVE_PCT;
    const agrees = (v) => isReal(v) && Math.sign(v) === sign;
    const disagrees = (v) => isReal(v) && Math.sign(v) === -sign;
    if (disagrees(tickerPct) || disagrees(proxyPct))
        return 'LOW';
    if (agrees(tickerPct) && agrees(proxyPct))
        return 'HIGH';
    return 'MEDIUM'; // nothing to confirm or deny it with, or only one side does
}
// Applied once in /analyze, after every branch that can set confidence
// (including the model's own self-assigned value on a "clean" verdict with
// no override at all) -- not threaded into priceConfirmedConfidence()
// itself, since that function only ever fires on specific override
// branches and can't reach a clean verdict's confidence at all. See
// PROXY_FIT_FLOOR's own comment for why this exists and what real data
// motivated it. Extracted as its own small, named, testable function
// rather than an inline conditional in server.js -- same "this function
// class has shipped real bugs before, give it real coverage" reasoning
// this whole file already exists for.
function applyProxyFitCeiling(confidence, proxyFit) {
    if (confidence === 'HIGH' && typeof proxyFit === 'number' && proxyFit < PROXY_FIT_FLOOR)
        return 'MEDIUM';
    return confidence;
}
// Normalizes a marketData[symbol] entry into {pct, change}. Handles both
// shapes actually seen in this codebase: a real {price,change,pct,direction}
// object (the server's own internal marketCache) and a bare "+1.23%"/
// "-4.5%" string (what every tier's client actually sends as
// sectorContext[symbol]). Returns null when neither shape yields a usable
// number, so the caller can filter it out the same way a missing symbol
// already was.
function normalizeMarketReading(raw) {
    if (raw == null)
        return null;
    if (typeof raw === 'string') {
        const pct = parsePctString(raw);
        return pct === null ? null : { pct, change: raw };
    }
    if (typeof raw === 'object' && typeof raw.pct === 'number') {
        return { pct: raw.pct, change: raw.change };
    }
    return null;
}
// ─── EVALUATE PROXY STATUS ────────────────────────────────────────
// BUG FIX (Aug 13, 2026): this previously read marketData[symbol].pct
// directly, assuming an object shape. Every tier's client actually sends
// sectorContext[symbol] as a bare formatted `.change` string -- so `.pct`
// was always undefined, avgPct was always 0, and this function could
// NEVER return RED or YELLOW through /analyze, for any ticker, regardless
// of how far TSM/KOSPI/XBI/etc had actually moved. Fixed by normalizing
// each reading through normalizeMarketReading() above, which parses the
// real string wire format (and still accepts an object, so nothing that
// already passed real objects here breaks). Also fixed a second, smaller
// latent bug in the same function: changeStr rebuilt symbol labels by
// re-indexing the post-filter `readings` array against the pre-filter
// `symbols` array, which mislabels a reading whenever an earlier symbol
// in a multi-symbol rule (e.g. the TSM+KOSPI combined rule) fails to
// resolve -- symbol and reading are now kept paired together instead.
function evaluateProxyStatus(proxyRule, marketData) {
    const symbols = proxyRule.proxy.symbols;
    const readings = symbols
        .map((s) => ({ symbol: s, reading: normalizeMarketReading(marketData[s.toLowerCase()]) }))
        .filter((x) => !!x.reading);
    if (!readings.length)
        return { status: 'GREEN', note: proxyRule.proxy.rationale };
    const avgPct = readings.reduce((a, x) => a + x.reading.pct, 0) / readings.length;
    const anyRedFlag = readings.some((x) => x.reading.pct <= -3);
    let status = 'GREEN';
    if (anyRedFlag || avgPct <= -3)
        status = 'RED';
    else if (avgPct <= -1)
        status = 'YELLOW';
    const changeStr = readings.map((x) => `${x.symbol} ${x.reading.change || '?'}`).join(', ');
    return {
        status,
        note: `${proxyRule.proxy.name}: ${changeStr}. ${proxyRule.proxy.rationale}`,
    };
}
module.exports = {
    parsePctString: parsePctString,
    CONFIDENCE_NEGLIGIBLE_MOVE_PCT: CONFIDENCE_NEGLIGIBLE_MOVE_PCT,
    PROXY_FIT_FLOOR: PROXY_FIT_FLOOR,
    priceConfirmedConfidence: priceConfirmedConfidence,
    applyProxyFitCeiling: applyProxyFitCeiling,
    normalizeMarketReading: normalizeMarketReading,
    evaluateProxyStatus: evaluateProxyStatus,
};
