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
function priceConfirmedConfidence(direction: 'UP' | 'DOWN', tickerPct: number | null, proxyPct: number | null): 'HIGH' | 'MEDIUM' | 'LOW' {
  const sign = direction === 'DOWN' ? -1 : 1;
  const isReal = (v: number | null): v is number => v != null && Math.abs(v) > CONFIDENCE_NEGLIGIBLE_MOVE_PCT;
  const agrees = (v: number | null): boolean => isReal(v) && Math.sign(v) === sign;
  const disagrees = (v: number | null): boolean => isReal(v) && Math.sign(v) === -sign;
  if (disagrees(tickerPct) || disagrees(proxyPct)) return 'LOW';
  if (agrees(tickerPct) && agrees(proxyPct)) return 'HIGH';
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
function applyProxyFitCeiling(confidence: 'HIGH' | 'MEDIUM' | 'LOW', proxyFit: number | null | undefined): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (confidence === 'HIGH' && typeof proxyFit === 'number' && proxyFit < PROXY_FIT_FLOOR) return 'MEDIUM';
  return confidence;
}

// Historical-accuracy confidence ceiling (Sep 14, 2026). The proxy-fit
// ceiling above catches a structurally weak proxy relationship; this
// catches a different, real failure shape found the same way ALAB's own
// was: a ticker whose pooled, cross-user grading history in THIS SAME
// DIRECTION has been wrong most of the time, independent of how sound
// today's trigger or proxy look on paper. Direction-specific on purpose
// -- a ticker's overall accuracy can look fine while one direction is
// consistently bad (exactly ALAB's shape: 0/8 real UP verdicts graded
// TRUE), so this must be compared against the SAME direction as the
// verdict being shipped, not a pooled average across both.
// Confirmed via AskUserQuestion (Sep 14, 2026): confidence-cap only, same
// one-step HIGH->MEDIUM shape as applyProxyFitCeiling -- deliberately
// never touches sizing or the verdict direction itself. A stronger
// intervention (capping sizing, or suppressing the verdict to FLAT) was
// explicitly considered and rejected: forcing a ticker to FLAT whenever
// its own history looks bad would create a "stopped clock" problem --
// that ticker could never ship a real verdict in that direction again to
// actually prove it's improved, since nothing would ever get graded
// going forward. 40% is a reasonable-but-arbitrary floor (meaningfully
// worse than a coin flip, not just "any miss"), same calibration posture
// as PROXY_FIT_FLOOR and every other threshold in this file seeded from
// judgment rather than a data fit -- revisit once enough real
// same-direction grades accumulate per ticker to check whether 40 is
// picking up real signal or just noise at small sample sizes.
const HISTORICAL_ACCURACY_FLOOR_PCT = 40;
function applyHistoricalAccuracyCeiling(confidence: 'HIGH' | 'MEDIUM' | 'LOW', sameDirectionPct: number | null | undefined): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (confidence === 'HIGH' && typeof sameDirectionPct === 'number' && sameDirectionPct < HISTORICAL_ACCURACY_FLOOR_PCT) return 'MEDIUM';
  return confidence;
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

// verdict_log.gates (Oct 19, 2026): each gate's color for one verdict, so
// accuracy can later be broken down by any gate. Only the G3 note is kept
// (it says how many bars the gate actually saw); other notes are left out
// to keep rows small. A missing gate is stored as null, never guessed.
// opts.g3Read === false (Oct 19, 2026): Gate 3 had no bar data, so its
// stored color is null ("not read"), never the YELLOW the model writes for
// "no opening bar data" -- that YELLOW looked identical to a real Yellow read.
function gatesForLog(gates: any, opts?: { g3Read?: boolean }): any {
  const g = gates || {};
  const st = (k: string) => (g[k] && typeof g[k].status === "string") ? g[k].status : null;
  const g3Read = !(opts && opts.g3Read === false);
  return {
    pre_gate: st("pre_gate"),
    sector:   st("sector"),
    g1:       st("g1_prewindow"),
    g2:       st("g2_catalyst"),
    g3:       g3Read ? st("g3_openbar") : null,
    g4:       st("g4_phase"),
    g5:       st("g5_korea"),
    g3_note:  g3Read
      ? ((g.g3_openbar && typeof g.g3_openbar.note === "string") ? g.g3_openbar.note : null)
      : "not read: no bar data",
  };
}

// The numbers behind each gate's color (Oct 19, 2026), stored in
// verdict_log.gates.inputs so a later query can test which definition
// actually predicts outcomes. Pure shaping only: numbers rounded to 2
// decimals, anything missing is null (never guessed).
function num(x: any): number | null {
  return (typeof x === "number" && isFinite(x)) ? Math.round(x * 100) / 100 : null;
}
function barsForLog(bars: any): any {
  if (!Array.isArray(bars) || !bars.length) return null;
  return bars.map((b: any) => ({ t: b.t || null, o: num(b.o), h: num(b.h), l: num(b.l), c: num(b.c), v: typeof b.v === "number" ? b.v : null }));
}
// Gate 4 record-only input (Oct 28, 2026): how far the price sits from its
// 50-day average, in %. Logged so the learning loop can test the proposed
// "stretched above the 50-day bumps one phase" modifier; nothing reads it
// for a verdict. A Sep-Oct backtest (217 graded calls) found only 10
// stretched (>=10%) GREEN/YELLOW cases and no hit-rate gap, so there is no
// cutoff to build on yet. Null without 50 closes or a price.
function pctAboveSma(closes: any, price: any, n: number): { sma: number; pct: number } | null {
  if (!Array.isArray(closes)) return null;
  const c = closes.map(Number).filter(v => isFinite(v) && v > 0);
  const p = Number(price);
  if (c.length < n || !isFinite(p) || p <= 0) return null;
  const sma = c.slice(-n).reduce((a, b) => a + b, 0) / n;
  return { sma: +sma.toFixed(4), pct: +((p / sma - 1) * 100).toFixed(2) };
}
// Best-fit proxy (Oct 28, 2026): of the regime checks run against each of a
// rule's proxy symbols, keep the one with the highest rolling correlation.
// UNKNOWN results (too little data) lose to any real reading.
function pickBestRegime(tried: Array<{ symbol: string; result: any }>): { symbol: string; result: any } | null {
  let best: { symbol: string; result: any } | null = null;
  for (const t of tried || []) {
    if (!t || !t.result) continue;
    if (!best) { best = t; continue; }
    const bu = best.result.state === "UNKNOWN", tu = t.result.state === "UNKNOWN";
    if (tu) continue;
    if (bu || Number(t.result.rolling) > Number(best.result.rolling)) best = t;
  }
  return best;
}
// Live price from one Alpaca stock snapshot (Oct 28, 2026, auto-refresh).
// Price = the latest IEX trade (fallback: the day's bar close). % change is
// measured against the SAME previous close the cards use (Finnhub's pc,
// passed in) so a refreshed % lines up with the card; Alpaca's own
// prevDailyBar close (IEX-only) is the fallback when that isn't known.
function livePriceFromSnapshot(snap: any, prevClose: number | null): { price: number; pct: number | null } | null {
  if (!snap) return null;
  const t = snap.latestTrade || snap.LatestTrade;
  const d = snap.dailyBar || snap.DailyBar;
  const pd = snap.prevDailyBar || snap.PrevDailyBar;
  const price = Number(t && t.p) > 0 ? Number(t.p) : Number(d && d.c) > 0 ? Number(d.c) : null;
  if (price == null) return null;
  const base = typeof prevClose === "number" && prevClose > 0 ? prevClose : Number(pd && pd.c) > 0 ? Number(pd.c) : null;
  return { price: +price.toFixed(4), pct: base ? +(((price - base) / base) * 100).toFixed(4) : null };
}

// Market-open push body (Oct 28, 2026; finally live -- Tra #117 sat unmerged
// as a draft since Sep 22 while the mirror carried it). The Sector Pulse's
// first sentence when there is one, else the Gate note. Capped at 140
// characters so Android doesn't cut the notification mid-word.
function pulsePushBody(cache: any): string {
  const pulse = cache && cache.pulse ? String(cache.pulse).trim() : "";
  if (pulse) {
    const splitAt = pulse.indexOf(". ");
    const first = splitAt > 0 ? pulse.slice(0, splitAt + 1) : pulse;
    return first.length > 140 ? first.slice(0, 139).trimEnd() + "\u2026" : first;
  }
  return cache && cache.gateNote ? String(cache.gateNote).slice(0, 110) : "Check today's read.";
}

// Pre-Gate cache lifetime (Oct 28, 2026). A real result is kept 24h; a
// FAILED check (SEC down, timeout) used to be cached as GREEN for the same
// 24h, leaving those tickers unscreened all day after a brief SEC outage.
// A failure is now kept only PRE_GATE_FAILED_RETRY_MS, then re-checked.
const PRE_GATE_FAILED_RETRY_MS = 10 * 60 * 1000;
function preGateCacheMs(result: any, normalMs: number): number {
  return result && result.checkFailed ? PRE_GATE_FAILED_RETRY_MS : normalMs;
}

// Confidence v2 -- SHADOW ONLY (Oct 28, 2026). Live confidence on a "clean"
// call is still the model's own rubric ("LOW: any YELLOW in critical
// gates"), which made every FLAT LOW (364 of 364) and did not predict misses
// (DOWN-LOW right more often than DOWN-MEDIUM). Mr. T chose the
// price-confirmed rule for every call, recorded beside the live label and
// graded, before anything user-facing changes.
// UP/DOWN: priceConfirmedConfidence + the same two ceilings live uses.
// FLAT: HIGH when the stock and its proxy are both quiet (within the same
// +/-1% band), LOW when both move the same way beyond it (a breakout may be
// starting), MEDIUM otherwise (one moving, opposite moves, or missing data).
function flatPriceConfidence(tickerPct: number | null, proxyPct: number | null): 'HIGH' | 'MEDIUM' | 'LOW' {
  const has = (v: number | null): v is number => v != null && isFinite(v);
  const quiet = (v: number | null) => has(v) && Math.abs(v) <= CONFIDENCE_NEGLIGIBLE_MOVE_PCT;
  const moving = (v: number | null) => has(v) && Math.abs(v) > CONFIDENCE_NEGLIGIBLE_MOVE_PCT;
  if (quiet(tickerPct) && quiet(proxyPct)) return 'HIGH';
  if (moving(tickerPct) && moving(proxyPct) && Math.sign(tickerPct as number) === Math.sign(proxyPct as number)) return 'LOW';
  return 'MEDIUM';
}
function confidenceV2(verdict: string, tickerPct: number | null, proxyPct: number | null, proxyFit: number | null | undefined, sameDirectionPct: number | null | undefined): 'HIGH' | 'MEDIUM' | 'LOW' | null {
  if (verdict === 'FLAT') return flatPriceConfidence(tickerPct, proxyPct);
  if (verdict !== 'UP' && verdict !== 'DOWN') return null;
  let c = priceConfirmedConfidence(verdict, tickerPct, proxyPct);
  c = applyProxyFitCeiling(c, proxyFit);
  return applyHistoricalAccuracyCeiling(c, sameDirectionPct);
}

// Agitator topical pool (Oct 28, 2026): put articles that mention the
// topic's own words first and, when at least one does, send only those to
// the model -- its "always pick the closest" rule otherwise picked an
// unrelated story from a generic news batch. Whole-word, case-insensitive,
// words of 3+ letters minus common filler. No match -> the pool unchanged.
const TOPIC_STOPWORDS = new Set(["the", "and", "for", "with", "from", "that", "this", "are", "was", "will", "has", "have", "its", "into", "over", "about", "after", "news", "stock", "stocks", "price", "prices", "market", "markets", "today", "new"]);
function rankTopicalArticles(query: string, articles: any[]): { articles: any[]; matched: number } {
  const list = Array.isArray(articles) ? articles : [];
  const words = String(query || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !TOPIC_STOPWORDS.has(w));
  if (!words.length) return { articles: list, matched: 0 };
  const res = words.map(w => new RegExp("\\b" + w + "\\b", "i"));
  const hits = list.filter(a => { const t = `${a && a.headline || ""} ${a && a.summary || ""}`; return res.some(r => r.test(t)); });
  return hits.length ? { articles: hits, matched: hits.length } : { articles: list, matched: 0 };
}
function gateInputsForLog(x: any): any {
  const r = x || {};
  const g1 = r.gate1 || {}, rule = r.rule || {}, m = r.metrics || {}, ob = r.openingBar, coh = r.coherence;
  const proxy = rule.proxy || {};
  return {
    g1: { branch: g1.branch || null, change14: num(g1.change14), change60: num(g1.change60), force_down: !!g1.forceDown },
    g2: {
      type: r.type || null,
      corroboration: typeof r.corroborationCount === "number" ? r.corroborationCount : null,
      proxy: proxy.name || null,
      proxy_symbols: Array.isArray(proxy.symbols) ? proxy.symbols : null,
      proxy_tier: rule.tier || null,
      proxy_r: num(typeof rule.r === "string" ? Number(rule.r) : rule.r),
      dynamic: !!rule.dynamicallyResolved,
    },
    g3: {
      source: r.windowMode ? "window" : "opening_bar",
      read: !!r.g3Read,
      bars: r.windowMode
        ? barsForLog(r.windowBars)
        : (ob ? [{ t: null, o: num(ob.open), h: num(ob.high), l: num(ob.low), c: num(ob.close), v: typeof ob.volume === "number" ? ob.volume : null }] : null),
    },
    g4: (() => {
      const ext = pctAboveSma(r.dailyCloses, m.price, 50);
      return { range_position: num(m.rangePosition), price: num(m.price), week52hi: num(m.week52hi), week52lo: num(m.week52lo),
               sma50: ext ? ext.sma : null, pct_above_50d: ext ? ext.pct : null };
    })(),
    g5: {
      ticker_pct: num(r.tickerPct), proxy_pct: num(r.proxyPct),
      regime: (r.regime && r.regime.state) || null,
      rolling_r: num(r.regime && r.regime.rolling != null ? Number(r.regime.rolling) : null),
      coherence: coh ? { case: coh.case ?? null, verdict: coh.verdict || null, force_down: !!coh.forceDown } : null,
    },
    red_count: typeof r.redCount === "number" ? r.redCount : null,
    override: r.override || null,
  };
}

// Same-session FLAT band (Oct 19, 2026): a FLAT called late in the day has
// little time left to move, so a fixed band let it score almost
// automatically. For a same-session window the band scales by the square
// root of the share of the session still left at issue (floored at 15 min).
// Multi-session windows return null: the caller keeps its existing scale.
function sameSessionFlatScale(issueMinutesET: number, closeMin: number, sessions: number): number | null {
  if (sessions !== 0) return null;
  const OPEN = 570;
  const len = Math.max(closeMin - OPEN, 15);
  const left = Math.min(Math.max(closeMin - issueMinutesET, 15), len);
  return Math.sqrt(left / len);
}


// Gate 0 (Oct 19, 2026): the ONE set of market-gate rules. /market and the
// boot/9:30 cache warm used to each carry their own copy, and the warm copy
// turned ONE index down >1% into RED ("both down") -- which forces DOWN in
// /analyze. Both paths call this now. `data` is the /market quote map
// ({spy, qqq, btc, tsm, ...}, each {change, pct}).
function computeGate0(data: any): { gateStatus: string; gateNote: string; btcSignal: string; tsmWarning: string | null } {
  const d = data || {};
  const pct = (k: string) => (d[k] && typeof d[k].pct === "number") ? d[k].pct : 0;
  const chg = (k: string) => (d[k] && d[k].change) ? d[k].change : "?";
  const spyPct = pct("spy"), qqqPct = pct("qqq"), btcPct = pct("btc"), tsmPct = pct("tsm");
  const head = `SPY ${chg("spy")} QQQ ${chg("qqq")} — `;
  let gateStatus: string, rule: string;
  if (spyPct <= -1 && qqqPct <= -1)      { gateStatus = "RED";    rule = "both down >1%, broad market failure, risk-off"; }
  else if (spyPct <= -1 || qqqPct <= -1) { gateStatus = "YELLOW"; rule = "one index down >1%, sector rotation risk, cut size 50%"; }
  else if (spyPct <= -0.5 || qqqPct <= -0.5) { gateStatus = "YELLOW"; rule = "market under pressure, cut size 50%"; }
  else if (spyPct < 0 && qqqPct < 0)     { gateStatus = "GREEN";  rule = "both slightly negative, proceed with caution, half size"; }
  else if (spyPct < 0 || qqqPct < 0)     { gateStatus = "GREEN";  rule = "mixed signals, proceed at reduced size"; }
  else if (spyPct >= 0.5 && qqqPct >= 0.5) { gateStatus = "GREEN"; rule = "both up >0.5%, strong tailwind, full proceed"; }
  else                                   { gateStatus = "GREEN";  rule = "flat to mild positive, proceed normally"; }
  let btcSignal = "neutral";
  if (btcPct >= 2) btcSignal = "full conviction";
  else if (btcPct <= -5) btcSignal = "risk-off";
  else if (btcPct <= -2) btcSignal = "reduce size";
  const tsmWarning = tsmPct <= -3 ? `⚠ TSM ${chg("tsm")} — Taiwan semi stress, risk-off on AI/semi names` : null;
  return { gateStatus, gateNote: head + rule, btcSignal, tsmWarning };
}

// Sector Pulse input (Oct 19, 2026): each move rounded to 1 decimal so a
// 0.01% wiggle doesn't buy a new summary, and the summary quotes the same
// 1-decimal numbers a reader can check against the grid.
function pulsePct(q: any): string {
  if (!q || typeof q.pct !== "number" || q.change === "?" || !isFinite(q.pct)) return "?";
  const r = Math.round(q.pct * 10) / 10;
  const v = Object.is(r, -0) ? 0 : r;
  return (v > 0 ? "+" : "") + v.toFixed(1) + "%";
}

function buildPulseInput(d: any): string {
  const m = d || {};
  return [
    `AI/Tech: QQQ ${pulsePct(m.qqq)}, SOXX ${pulsePct(m.soxx)}, NVDA ${pulsePct(m.nvda)}`,
    `Biotech: XBI ${pulsePct(m.xbi)}, IBB ${pulsePct(m.ibb)}`,
    `Commodities: GLD ${pulsePct(m.gld)}, USO ${pulsePct(m.uso)}`,
    `Crypto: BTC ${pulsePct(m.btc)}`,
    `Broad: SPY ${pulsePct(m.spy)}, IWM ${pulsePct(m.iwm)}`,
  ].join("\n");
}

// Market leaning for the Sector Pulse (Oct 19, 2026). Computed here with
// fixed rules so the Pulse model only phrases it -- it can't pick a leaning
// the numbers contradict (it once called a down-gold day "defensive").
// Uses the same 1-decimal values the Pulse quotes; BTC is left out (it
// trades 24/7 and would unfreeze the Pulse overnight). Checked in order;
// the first match wins.
function r1(q: any): number | null {
  if (!q || typeof q.pct !== "number" || q.change === "?" || !isFinite(q.pct)) return null;
  const v = Math.round(q.pct * 10) / 10;
  return Object.is(v, -0) ? 0 : v;
}
function computeMarketLeaning(d: any): { label: string; direction: string } {
  const m = d || {};
  const spy = r1(m.spy), qqq = r1(m.qqq), gld = r1(m.gld), uso = r1(m.uso);
  const sectors = [r1(m.soxx), r1(m.nvda), r1(m.xbi), r1(m.ibb), r1(m.iwm)].filter((x): x is number => x != null);
  const idx = [spy, qqq].filter((x): x is number => x != null);
  const market = idx.length ? idx.reduce((a, b) => a + b, 0) / idx.length : null;
  const direction = market == null ? "flat" : market >= 0.3 ? "up" : market <= -0.3 ? "down" : "flat";
  const all = idx.concat(sectors, [gld, uso].filter((x): x is number => x != null));
  if (!all.length) return { label: "Unavailable", direction: "flat" };
  if (all.every(x => Math.abs(x) <= 0.3)) return { label: "Quiet", direction };
  if (direction === "down" && gld != null && gld >= 0.3) return { label: "Risk-off, safety bid", direction };
  if (direction === "down" && spy != null && qqq != null && spy < 0 && qqq < 0
      && sectors.filter(x => x < 0).length > sectors.length / 2) return { label: "Broad selloff", direction };
  const stocks = idx.concat(sectors);
  const commodityTop = Math.max(gld ?? -Infinity, uso ?? -Infinity);
  if (direction !== "up" && commodityTop >= 1 && stocks.every(x => x < commodityTop)) return { label: "Commodity-led", direction };
  const leaders = [qqq, r1(m.soxx), r1(m.nvda), r1(m.iwm)].filter((x): x is number => x != null);
  if (direction === "up" && spy != null && leaders.some(x => x > spy)) return { label: "Risk-on", direction };
  if (direction === "flat" && stocks.some(x => x >= 1) && stocks.some(x => x <= -1)) return { label: "Rotation", direction };
  return { label: direction === "up" ? "Mild gains" : direction === "down" ? "Mild losses" : "Mixed", direction };
}

// Plain-word Pulse input (Oct 20, 2026). Mr. T: the Pulse kept repeating
// the % numbers printed in the Gate grid right above it. The model now gets
// no numbers at all -- only the leaning, the direction, and which groups are
// leading or lagging, named in words -- so it can't echo them. Groups move
// less than 0.3% either way are left out (noise at the 1-decimal level the
// grid shows).
const PULSE_GROUPS: Array<[string, string[]]> = [
  ["big tech", ["qqq"]],
  ["chip stocks", ["soxx", "nvda"]],
  ["biotech", ["xbi", "ibb"]],
  ["small companies", ["iwm"]],
  ["gold", ["gld"]],
  ["oil", ["uso"]],
];
function pulseGroups(d: any): { leading: string[]; lagging: string[] } {
  const m = d || {};
  const rows: Array<{ name: string; v: number }> = [];
  for (const [name, keys] of PULSE_GROUPS) {
    const vals = keys.map(k => r1(m[k])).filter((x): x is number => x != null);
    if (vals.length) rows.push({ name, v: vals.reduce((a, b) => a + b, 0) / vals.length });
  }
  const leading = rows.filter(r => r.v >= 0.3).sort((a, b) => b.v - a.v).slice(0, 2).map(r => r.name);
  const lagging = rows.filter(r => r.v <= -0.3).sort((a, b) => a.v - b.v).slice(0, 2).map(r => r.name);
  return { leading, lagging };
}
const DIRECTION_WORDS: Record<string, string> = { up: "stocks are rising", down: "stocks are falling", flat: "stocks are roughly unchanged" };
function buildPulseWords(d: any): string {
  const lean = computeMarketLeaning(d);
  const g = pulseGroups(d);
  return [
    `Market leaning: ${lean.label}`,
    `Overall: ${DIRECTION_WORDS[lean.direction] || DIRECTION_WORDS.flat}`,
    `Leading: ${g.leading.join(", ") || "nothing stands out"}`,
    `Lagging: ${g.lagging.join(", ") || "nothing stands out"}`,
  ].join("\n");
}
// What each leaning means to someone who doesn't trade for a living. Used by
// the fallback sentence below and quoted in the Pulse prompt.
const LEANING_MEANING: Record<string, string> = {
  "Quiet": "a calm day with no real direction.",
  "Risk-off, safety bid": "investors are pulling back from stocks and moving into safer places like gold.",
  "Broad selloff": "most of the market is being sold at once, not just one corner of it.",
  "Commodity-led": "raw materials like oil and gold are doing better than stocks.",
  "Risk-on": "investors are willing to take chances, buying faster-growing stocks.",
  "Rotation": "money is moving from some groups into others while the overall market goes nowhere.",
  "Mild gains": "stocks are edging higher without much conviction.",
  "Mild losses": "stocks are drifting lower without much conviction.",
  "Mixed": "some groups are up and some are down, with no clear winner.",
  "Unavailable": "market data is not available right now.",
};
function joinWords(a: string[]): string {
  return a.length <= 1 ? (a[0] || "") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
}
// Built only from fixed rules -- used whenever the model's text is missing
// or contains a number.
function pulseFallbackText(d: any): string {
  const lean = computeMarketLeaning(d);
  const g = pulseGroups(d);
  const first = `${lean.label}: ${LEANING_MEANING[lean.label] || LEANING_MEANING.Mixed}`;
  if (lean.label === "Unavailable") return first;
  const verb = lean.direction === "down" ? "holding up" : "leading";
  const lead = g.leading.length ? `${joinWords(g.leading)} ${g.leading.length > 1 ? "are" : "is"} ${verb}` : "";
  const lag = g.lagging.length ? `${joinWords(g.lagging)} ${g.lagging.length > 1 ? "are" : "is"} lagging` : "";
  const second = [lead, lag].filter(Boolean).join(", while ");
  return second ? `${first} ${second.charAt(0).toUpperCase() + second.slice(1)}.` : first;
}
function pulseHasNumbers(text: string): boolean {
  return /[0-9%]/.test(text || "");
}

// ── Options probe for the DAY call (Oct 27, 2026, logging only) ─────────
// Mr. T: IV and delta should give Gate 3 a more dynamic lens -- IV sets how
// big a bar has to be to count and which bar schedule to use, delta says
// whether options traders lean with the bars. Step one only RECORDS these
// numbers on each DAY-eligible call (verdict_log.gates.inputs.options) so
// the thresholds below get tuned on real data before any verdict uses them.
// Alpaca's indicative options feed is ~15 min delayed.
const TRADING_MINUTES_PER_DAY = 390;
const DAY_SCHEDULE_FAST_RATIO = 1.3; // options expect a bigger day than usual
const DAY_SCHEDULE_SLOW_RATIO = 0.8; // options expect a quieter day than usual
const DELTA_LEAN_BAND = 0.15;

function occParts(occ: string): { expiry: string; type: string; strike: number } | null {
  const m = /^[A-Z.]+(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(occ || "");
  if (!m) return null;
  return { expiry: `20${m[1]}-${m[2]}-${m[3]}`, type: m[4], strike: parseInt(m[5], 10) / 1000 };
}

// snapshots: Alpaca's { [occSymbol]: snapshot } map. Pure; nowMs injected.
function summarizeOptionsChain(snapshots: any, price: number, nowMs: number, oiBySymbol?: Record<string, number> | null): any {
  const entries = Object.entries(snapshots || {});
  const out: any = { contracts: entries.length, withIv: 0, withDelta: 0, withVolume: 0, newestQuoteAgeMin: null,
    atmIv: null, atmDte: null, impliedDailyMovePct: null, deltaLeanVolume: null, deltaLeanOi: null, withOi: 0 };
  if (!entries.length || !(price > 0)) return out;
  let newest = 0, best: any = null, bestScore = Infinity;
  let volNum = 0, volDen = 0, oiNum = 0, oiDen = 0;
  for (const [occ, snap] of entries as Array<[string, any]>) {
    const parts = occParts(occ);
    if (!parts) continue;
    const iv = typeof snap?.impliedVolatility === "number" ? snap.impliedVolatility : snap?.greeks?.impliedVolatility;
    const delta = snap?.greeks?.delta;
    const vol = snap?.dailyBar?.v;
    const qt = Date.parse(snap?.latestQuote?.t || snap?.latestTrade?.t || "");
    if (isFinite(qt) && qt > newest) newest = qt;
    if (typeof iv === "number" && iv > 0) out.withIv++;
    if (typeof delta === "number") out.withDelta++;
    if (typeof vol === "number" && vol > 0) out.withVolume++;
    const dte = (Date.parse(parts.expiry + "T20:00:00Z") - nowMs) / 86400000;
    if (dte < 0) continue;
    // Headline IV: nearest-the-money contract 5-45 days out (0-4 DTE IV
    // swings wildly near expiry).
    if (typeof iv === "number" && iv > 0 && dte >= 5 && dte <= 45) {
      const score = Math.abs(parts.strike - price) / price * 100 + dte * 0.05;
      if (score < bestScore) { bestScore = score; best = { iv, dte }; }
    }
    if (typeof delta === "number") {
      if (typeof vol === "number" && vol > 0) { volNum += delta * vol; volDen += Math.abs(delta) * vol; }
      const oi = oiBySymbol ? oiBySymbol[occ] : undefined;
      if (typeof oi === "number" && oi > 0) { out.withOi++; oiNum += delta * oi; oiDen += Math.abs(delta) * oi; }
    }
  }
  if (newest) out.newestQuoteAgeMin = Math.round((nowMs - newest) / 60000);
  if (best) {
    out.atmIv = +best.iv.toFixed(4);
    out.atmDte = +best.dte.toFixed(1);
    out.impliedDailyMovePct = +(best.iv * 100 / Math.sqrt(252)).toFixed(3);
  }
  if (volDen > 0) out.deltaLeanVolume = +(volNum / volDen).toFixed(3);
  if (oiDen > 0) out.deltaLeanOi = +(oiNum / oiDen).toFixed(3);
  return out;
}

// Which bar schedule the IV-aware Gate 3 WOULD use (not used for verdicts yet).
function dayBarSchedule(impliedDailyMovePct: number | null, normalDailyMovePct: number | null): { ratio: number | null; barMinutes: number } {
  if (!(impliedDailyMovePct! > 0) || !(normalDailyMovePct! > 0)) return { ratio: null, barMinutes: 15 };
  const ratio = +(impliedDailyMovePct! / normalDailyMovePct!).toFixed(3);
  return { ratio, barMinutes: ratio > DAY_SCHEDULE_FAST_RATIO ? 5 : ratio < DAY_SCHEDULE_SLOW_RATIO ? 30 : 15 };
}

// The move one bar of `barMinutes` is expected to make, from the daily move.
function barYardstickPct(impliedDailyMovePct: number | null, barMinutes: number): number | null {
  if (!(impliedDailyMovePct! > 0)) return null;
  return +(impliedDailyMovePct! * Math.sqrt(barMinutes / TRADING_MINUTES_PER_DAY)).toFixed(3);
}

function deltaLeanLabel(lean: number | null): string | null {
  if (lean == null) return null;
  return lean > DELTA_LEAN_BAND ? "BULLISH" : lean < -DELTA_LEAN_BAND ? "BEARISH" : "NEUTRAL";
}

module.exports = {
  parsePctString: parsePctString,
  CONFIDENCE_NEGLIGIBLE_MOVE_PCT: CONFIDENCE_NEGLIGIBLE_MOVE_PCT,
  PROXY_FIT_FLOOR: PROXY_FIT_FLOOR,
  HISTORICAL_ACCURACY_FLOOR_PCT: HISTORICAL_ACCURACY_FLOOR_PCT,
  priceConfirmedConfidence: priceConfirmedConfidence,
  applyProxyFitCeiling: applyProxyFitCeiling,
  applyHistoricalAccuracyCeiling: applyHistoricalAccuracyCeiling,
  normalizeMarketReading: normalizeMarketReading,
  evaluateProxyStatus: evaluateProxyStatus,
  gatesForLog: gatesForLog,
  gateInputsForLog: gateInputsForLog,
  pctAboveSma: pctAboveSma,
  pickBestRegime: pickBestRegime,
  rankTopicalArticles: rankTopicalArticles,
  flatPriceConfidence: flatPriceConfidence,
  confidenceV2: confidenceV2,
  pulsePushBody: pulsePushBody,
  livePriceFromSnapshot: livePriceFromSnapshot,
  preGateCacheMs: preGateCacheMs,
  PRE_GATE_FAILED_RETRY_MS: PRE_GATE_FAILED_RETRY_MS,
  sameSessionFlatScale: sameSessionFlatScale,
  computeGate0: computeGate0,
  pulsePct: pulsePct,
  buildPulseInput: buildPulseInput,
  computeMarketLeaning: computeMarketLeaning,
  pulseGroups: pulseGroups,
  buildPulseWords: buildPulseWords,
  pulseFallbackText: pulseFallbackText,
  pulseHasNumbers: pulseHasNumbers,
  LEANING_MEANING: LEANING_MEANING,
  summarizeOptionsChain: summarizeOptionsChain,
  dayBarSchedule: dayBarSchedule,
  barYardstickPct: barYardstickPct,
  deltaLeanLabel: deltaLeanLabel,
};
