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
function applyHistoricalAccuracyCeiling(confidence, sameDirectionPct) {
    if (confidence === 'HIGH' && typeof sameDirectionPct === 'number' && sameDirectionPct < HISTORICAL_ACCURACY_FLOOR_PCT)
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
// verdict_log.gates (Oct 19, 2026): each gate's color for one verdict, so
// accuracy can later be broken down by any gate. Only the G3 note is kept
// (it says how many bars the gate actually saw); other notes are left out
// to keep rows small. A missing gate is stored as null, never guessed.
// opts.g3Read === false (Oct 19, 2026): Gate 3 had no bar data, so its
// stored color is null ("not read"), never the YELLOW the model writes for
// "no opening bar data" -- that YELLOW looked identical to a real Yellow read.
function gatesForLog(gates, opts) {
    const g = gates || {};
    const st = (k) => (g[k] && typeof g[k].status === "string") ? g[k].status : null;
    const g3Read = !(opts && opts.g3Read === false);
    return {
        pre_gate: st("pre_gate"),
        sector: st("sector"),
        g1: st("g1_prewindow"),
        g2: st("g2_catalyst"),
        g3: g3Read ? st("g3_openbar") : null,
        g4: st("g4_phase"),
        g5: st("g5_korea"),
        g3_note: g3Read
            ? ((g.g3_openbar && typeof g.g3_openbar.note === "string") ? g.g3_openbar.note : null)
            : "not read: no bar data",
    };
}
// The numbers behind each gate's color (Oct 19, 2026), stored in
// verdict_log.gates.inputs so a later query can test which definition
// actually predicts outcomes. Pure shaping only: numbers rounded to 2
// decimals, anything missing is null (never guessed).
function num(x) {
    return (typeof x === "number" && isFinite(x)) ? Math.round(x * 100) / 100 : null;
}
function barsForLog(bars) {
    if (!Array.isArray(bars) || !bars.length)
        return null;
    return bars.map((b) => ({ t: b.t || null, o: num(b.o), h: num(b.h), l: num(b.l), c: num(b.c), v: typeof b.v === "number" ? b.v : null }));
}
function gateInputsForLog(x) {
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
        g4: { range_position: num(m.rangePosition), price: num(m.price), week52hi: num(m.week52hi), week52lo: num(m.week52lo) },
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
function sameSessionFlatScale(issueMinutesET, closeMin, sessions) {
    if (sessions !== 0)
        return null;
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
function computeGate0(data) {
    const d = data || {};
    const pct = (k) => (d[k] && typeof d[k].pct === "number") ? d[k].pct : 0;
    const chg = (k) => (d[k] && d[k].change) ? d[k].change : "?";
    const spyPct = pct("spy"), qqqPct = pct("qqq"), btcPct = pct("btc"), tsmPct = pct("tsm");
    const head = `SPY ${chg("spy")} QQQ ${chg("qqq")} — `;
    let gateStatus, rule;
    if (spyPct <= -1 && qqqPct <= -1) {
        gateStatus = "RED";
        rule = "both down >1%, broad market failure, risk-off";
    }
    else if (spyPct <= -1 || qqqPct <= -1) {
        gateStatus = "YELLOW";
        rule = "one index down >1%, sector rotation risk, cut size 50%";
    }
    else if (spyPct <= -0.5 || qqqPct <= -0.5) {
        gateStatus = "YELLOW";
        rule = "market under pressure, cut size 50%";
    }
    else if (spyPct < 0 && qqqPct < 0) {
        gateStatus = "GREEN";
        rule = "both slightly negative, proceed with caution, half size";
    }
    else if (spyPct < 0 || qqqPct < 0) {
        gateStatus = "GREEN";
        rule = "mixed signals, proceed at reduced size";
    }
    else if (spyPct >= 0.5 && qqqPct >= 0.5) {
        gateStatus = "GREEN";
        rule = "both up >0.5%, strong tailwind, full proceed";
    }
    else {
        gateStatus = "GREEN";
        rule = "flat to mild positive, proceed normally";
    }
    let btcSignal = "neutral";
    if (btcPct >= 2)
        btcSignal = "full conviction";
    else if (btcPct <= -5)
        btcSignal = "risk-off";
    else if (btcPct <= -2)
        btcSignal = "reduce size";
    const tsmWarning = tsmPct <= -3 ? `⚠ TSM ${chg("tsm")} — Taiwan semi stress, risk-off on AI/semi names` : null;
    return { gateStatus, gateNote: head + rule, btcSignal, tsmWarning };
}
// Sector Pulse input (Oct 19, 2026): each move rounded to 1 decimal so a
// 0.01% wiggle doesn't buy a new summary, and the summary quotes the same
// 1-decimal numbers a reader can check against the grid.
function pulsePct(q) {
    if (!q || typeof q.pct !== "number" || q.change === "?" || !isFinite(q.pct))
        return "?";
    const r = Math.round(q.pct * 10) / 10;
    const v = Object.is(r, -0) ? 0 : r;
    return (v > 0 ? "+" : "") + v.toFixed(1) + "%";
}
function buildPulseInput(d) {
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
function r1(q) {
    if (!q || typeof q.pct !== "number" || q.change === "?" || !isFinite(q.pct))
        return null;
    const v = Math.round(q.pct * 10) / 10;
    return Object.is(v, -0) ? 0 : v;
}
function computeMarketLeaning(d) {
    const m = d || {};
    const spy = r1(m.spy), qqq = r1(m.qqq), gld = r1(m.gld), uso = r1(m.uso);
    const sectors = [r1(m.soxx), r1(m.nvda), r1(m.xbi), r1(m.ibb), r1(m.iwm)].filter((x) => x != null);
    const idx = [spy, qqq].filter((x) => x != null);
    const market = idx.length ? idx.reduce((a, b) => a + b, 0) / idx.length : null;
    const direction = market == null ? "flat" : market >= 0.3 ? "up" : market <= -0.3 ? "down" : "flat";
    const all = idx.concat(sectors, [gld, uso].filter((x) => x != null));
    if (!all.length)
        return { label: "Unavailable", direction: "flat" };
    if (all.every(x => Math.abs(x) <= 0.3))
        return { label: "Quiet", direction };
    if (direction === "down" && gld != null && gld >= 0.3)
        return { label: "Risk-off, safety bid", direction };
    if (direction === "down" && spy != null && qqq != null && spy < 0 && qqq < 0
        && sectors.filter(x => x < 0).length > sectors.length / 2)
        return { label: "Broad selloff", direction };
    const stocks = idx.concat(sectors);
    const commodityTop = Math.max(gld ?? -Infinity, uso ?? -Infinity);
    if (direction !== "up" && commodityTop >= 1 && stocks.every(x => x < commodityTop))
        return { label: "Commodity-led", direction };
    const leaders = [qqq, r1(m.soxx), r1(m.nvda), r1(m.iwm)].filter((x) => x != null);
    if (direction === "up" && spy != null && leaders.some(x => x > spy))
        return { label: "Risk-on", direction };
    if (direction === "flat" && stocks.some(x => x >= 1) && stocks.some(x => x <= -1))
        return { label: "Rotation", direction };
    return { label: direction === "up" ? "Mild gains" : direction === "down" ? "Mild losses" : "Mixed", direction };
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
    sameSessionFlatScale: sameSessionFlatScale,
    computeGate0: computeGate0,
    pulsePct: pulsePct,
    buildPulseInput: buildPulseInput,
    computeMarketLeaning: computeMarketLeaning,
};
