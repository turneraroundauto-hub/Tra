'use strict';
/**
 * analyze-helpers.js — pure, side-effect-free pieces of the /analyze
 * pipeline, extracted out of server.js's monolithic body (Aug 16, 2026,
 * Phase 4 of the TypeScript adoption plan — mirrored from trade-verdict's
 * CLAUDE.md, "Engineering: TypeScript adoption path" — this is the real
 * backend, Tra, the actual deploy target for this change).
 *
 * Why this file exists: server.js has no module.exports at all (it's the
 * Express app entrypoint, and calls app.listen() at the bottom — requiring
 * it as a module would start a real server as a side effect), so none of
 * its internal functions were ever unit-testable directly. These four
 * are exactly the ones that have shipped real, hard-to-spot production
 * bugs before (the Aug 13, 2026 Gate 5 forceDown-unreachable bug lived in
 * evaluateProxyStatus/normalizeMarketReading; the Aug 16, 2026 LOW-confidence
 * gap and the price-confirmed-confidence redefinition both lived in
 * priceConfirmedConfidence) — see trade-verdict's CLAUDE.md for the full
 * incident writeups. Moving them here is a pure code-motion refactor: same
 * names, same bodies, same behavior, just requirable in isolation so
 * trade-verdict's Phase 4 test suite (tests/analyze-helpers.test.js,
 * mirrored here too) can exercise them directly instead of only via a
 * throwaway simulation script.
 *
 * Required via plain CommonJS `require("./analyze-helpers")` in
 * server.js, exactly like gates-extended.js — same CommonJS/ESM
 * constraint applies (see gates-extended.ts's own header comment for the
 * full story: a real `import`/`export` statement here, even type-only,
 * makes tsc emit a trailing `export {}` that flips Node's module-type
 * auto-detection to ESM and silently discards `module.exports` at
 * runtime). Zero `import`/`export` statements in this file for that
 * reason. Compiled via tsconfig.build.json, same as gates-extended.ts's
 * own conversion — tsc emits analyze-helpers.js in place.
 */
declare var module: { exports: any };

interface MarketReading {
  pct: number;
  change: string | undefined;
}

interface ProxyStatusResult {
  status: 'GREEN' | 'YELLOW' | 'RED';
  note: string;
}

// Parses a formatted "+1.23%"/"-4.5%" string (the shape sectorContext's
// per-symbol fields actually arrive in from every tier's client) into a
// number.
function parsePctString(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const n = parseFloat(s.replace('%', ''));
  return Number.isFinite(n) ? n : null;
}

// Same tolerance gates-extended.ts's proxyCoherenceCheck() already uses
// (COHERENCE_FLAT_BAND_PCT) to decide a move is real, not noise -- kept as
// its own local constant rather than importing that one, since exporting a
// value tuned for one specific check to double as a generic threshold here
// would couple the two for no real reason.
const CONFIDENCE_NEGLIGIBLE_MOVE_PCT = 1.0;

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
function priceConfirmedConfidence(direction: 'UP' | 'DOWN', tickerPct: number | null, proxyPct: number | null): 'HIGH' | 'MEDIUM' | 'LOW' {
  const sign = direction === 'DOWN' ? -1 : 1;
  const isReal = (v: number | null): v is number => v != null && Math.abs(v) > CONFIDENCE_NEGLIGIBLE_MOVE_PCT;
  const agrees = (v: number | null): boolean => isReal(v) && Math.sign(v) === sign;
  const disagrees = (v: number | null): boolean => isReal(v) && Math.sign(v) === -sign;
  if (disagrees(tickerPct) || disagrees(proxyPct)) return 'LOW';
  if (agrees(tickerPct) && agrees(proxyPct)) return 'HIGH';
  return 'MEDIUM'; // nothing to confirm or deny it with, or only one side does
}

// Normalizes a marketData[symbol] entry into {pct, change}. Handles both
// shapes actually seen in this codebase: a real {price,change,pct,direction}
// object (the server's own internal marketCache) and a bare "+1.23%"/
// "-4.5%" string (what every tier's client actually sends as
// sectorContext[symbol]). Returns null when neither shape yields a usable
// number, so the caller can filter it out the same way a missing symbol
// already was.
function normalizeMarketReading(raw: any): MarketReading | null {
  if (raw == null) return null;
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
function evaluateProxyStatus(proxyRule: any, marketData: Record<string, any>): ProxyStatusResult {
  const symbols: string[] = proxyRule.proxy.symbols;
  const readings = symbols
    .map((s) => ({ symbol: s, reading: normalizeMarketReading(marketData[s.toLowerCase()]) }))
    .filter((x): x is { symbol: string; reading: MarketReading } => !!x.reading);

  if (!readings.length) return { status: 'GREEN', note: proxyRule.proxy.rationale };

  const avgPct = readings.reduce((a, x) => a + x.reading.pct, 0) / readings.length;
  const anyRedFlag = readings.some((x) => x.reading.pct <= -3);

  let status: ProxyStatusResult['status'] = 'GREEN';
  if (anyRedFlag || avgPct <= -3) status = 'RED';
  else if (avgPct <= -1) status = 'YELLOW';

  const changeStr = readings.map((x) => `${x.symbol} ${x.reading.change || '?'}`).join(', ');

  return {
    status,
    note: `${proxyRule.proxy.name}: ${changeStr}. ${proxyRule.proxy.rationale}`,
  };
}

module.exports = {
  parsePctString: parsePctString,
  CONFIDENCE_NEGLIGIBLE_MOVE_PCT: CONFIDENCE_NEGLIGIBLE_MOVE_PCT,
  priceConfirmedConfidence: priceConfirmedConfidence,
  normalizeMarketReading: normalizeMarketReading,
  evaluateProxyStatus: evaluateProxyStatus,
};
