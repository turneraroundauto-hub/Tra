'use strict';
function dailyReturns(closes) {
    const out = [];
    for (let i = 1; i < closes.length; i++)
        out.push(closes[i] / closes[i - 1] - 1);
    return out;
}
function pearson(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 2)
        return null;
    const A = a.slice(-n), B = b.slice(-n);
    const ma = A.reduce((s, x) => s + x, 0) / n;
    const mb = B.reduce((s, x) => s + x, 0) / n;
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < n; i++) {
        const da = A[i] - ma, db = B[i] - mb;
        cov += da * db;
        va += da * da;
        vb += db * db;
    }
    if (va === 0 || vb === 0)
        return null;
    return cov / Math.sqrt(va * vb);
}
/* ---------- 1. Gate 1 — session-based (BUG FIX) ---------- */
const GATE1_LONG_SESSIONS = 60;
const GATE1_SHORT_SESSIONS = 14;
function evaluateGate1Sessions(closes) {
    if (!Array.isArray(closes) || closes.length < GATE1_LONG_SESSIONS + 1) {
        return {
            ok: false, unit: 'sessions', forceDown: false,
            note: 'Insufficient history: need ' + (GATE1_LONG_SESSIONS + 1) +
                ' session bars, got ' + (closes ? closes.length : 0) +
                '. Gate 1 returns HOLD, not DOWN, on insufficient data.'
        };
    }
    const last = closes[closes.length - 1];
    // POSITIONAL indexing = trading sessions. This is the resolved unit. Do NOT date-anchor.
    const anchor60 = closes[closes.length - 1 - GATE1_LONG_SESSIONS];
    const anchor14 = closes[closes.length - 1 - GATE1_SHORT_SESSIONS];
    const change60 = (last / anchor60 - 1) * 100;
    const change14 = (last / anchor14 - 1) * 100;
    const base = { ok: true, unit: 'sessions', change60: change60, change14: change14 };
    // STEP 1 — branch on 60-session direction
    if (change60 === 0) {
        return Object.assign({}, base, { branch: 'FLAT', color: 'GREEN', sizing: 'FULL',
            forceDown: false, note: 'Flat 60-session structure — proceed to Gate 2.' });
    }
    if (change60 > 0) {
        // STEP 2 — uptrend: 14-session catalyst-window exhaustion
        if (change14 > 20) {
            return Object.assign({}, base, { branch: 'UPTREND', color: 'RED', sizing: 'NONE',
                forceDown: false,
                note: '14-session +' + change14.toFixed(1) + '% exceeds +20% exhaustion threshold — no entry, wait for post-catalyst flush.' });
        }
        if (change14 >= 10) {
            return Object.assign({}, base, { branch: 'UPTREND', color: 'YELLOW', sizing: 'HALF',
                forceDown: false,
                note: '14-session +' + change14.toFixed(1) + '% in the +10-20% band — reduce size 50%.' });
        }
        return Object.assign({}, base, { branch: 'UPTREND', color: 'GREEN', sizing: 'FULL',
            forceDown: false,
            note: '14-session +' + change14.toFixed(1) + '% under +10% — clean.' });
    }
    // STEP 3 — downtrend: 60-session structural breakdown
    const decline = Math.abs(change60);
    if (decline > 25) {
        return Object.assign({}, base, { branch: 'DOWNTREND', color: 'RED', sizing: 'NONE',
            forceDown: true,
            note: '60-session -' + decline.toFixed(1) + '% structural breakdown exceeds 25% — forceDown. Sector tailwinds cannot override. Requires higher high + 50-day MA reclaim to reset.' });
    }
    if (decline >= 10) {
        return Object.assign({}, base, { branch: 'DOWNTREND', color: 'YELLOW', sizing: 'HALF',
            forceDown: false, requiresConfirmedHigherLow: true,
            note: '60-session -' + decline.toFixed(1) + '% in the 10-25% band — half size AND a confirmed higher low required before entry (a single green session does not qualify).' });
    }
    return Object.assign({}, base, { branch: 'DOWNTREND', color: 'GREEN', sizing: 'FULL',
        forceDown: false,
        note: '60-session -' + decline.toFixed(1) + '% under 10% — normal pullback.' });
}
/* ---------- 2. Proposal 2 — Proxy Coherence Check ---------- */
const COHERENCE_FLAT_BAND_PCT = 1.0;
const COHERENCE_DECOUPLE_PCT = 2.0;
/**
 * tickerPct/proxyPct must be real numbers, already parsed — the Aug 13,
 * 2026 Gate 5 bug (see CLAUDE.md) was exactly this call site being fed a
 * formatted "+1.23%" *string* instead, so `proxyPct < 0` and every other
 * numeric comparison here silently evaluated against a string. Callers must
 * parse via parsePctString()/normalizeMarketReading() (server.js) first.
 */
function proxyCoherenceCheck(tickerPct, proxyPct) {
    const proxyDown = proxyPct < 0;
    // CASE 2 — ticker flat while proxy is deeply red
    if (Math.abs(tickerPct) <= COHERENCE_FLAT_BAND_PCT) {
        return {
            case: 2, verdict: 'DOWN', forceDown: true, triggerRevalidation: false,
            label: 'DOWN — unconfirmed, lag risk',
            note: 'Ticker ' + tickerPct.toFixed(2) + '% is inside the +/-' + COHERENCE_FLAT_BAND_PCT +
                '% flat band while proxy moved ' + proxyPct.toFixed(2) +
                '%. Trigger still applies (no entries), but the ticker has not confirmed — it may simply not have caught up.'
        };
    }
    // CASE 3 — ticker moves opposite the proxy beyond threshold
    const opposite = (proxyDown && tickerPct > 0) || (!proxyDown && tickerPct < 0);
    if (opposite && Math.abs(tickerPct) >= COHERENCE_DECOUPLE_PCT) {
        return {
            case: 3, verdict: 'HOLD', forceDown: false, triggerRevalidation: true,
            label: 'HOLD — possible proxy decoupling',
            note: 'Ticker ' + tickerPct.toFixed(2) + '% moved OPPOSITE the proxy\'s ' + proxyPct.toFixed(2) +
                '% by more than ' + COHERENCE_DECOUPLE_PCT +
                '%. forceDown suppressed. Off-cycle proxy re-validation triggered (same mechanism as a Pre-Gate hard trigger, Step 6 of the Dynamic Proxy Algorithm).'
        };
    }
    // CASE 1 — same direction, any magnitude
    return {
        case: 1, verdict: 'DOWN', forceDown: true, triggerRevalidation: false,
        label: 'DOWN — proxy confirmed',
        note: 'Ticker ' + tickerPct.toFixed(2) + '% moved with the proxy\'s ' + proxyPct.toFixed(2) +
            '%. Trigger confirmed at full force.'
    };
}
/* ---------- 3. Proposal 3 — Fixed-Proxy Regime Validation ---------- */
const REGIME_WINDOW = 20;
const REGIME_DEGRADE_DELTA = -0.30;
const REGIME_BROKEN_CEILING = 0.0;
/**
 * KNOWN LIMITATION (measured Jul 29, 2026): correlations CONVERGE under market stress.
 * CIEN's 20-day correlation to TSM rose +0.283 -> +0.728 during the AI-capex selloff.
 * This check will rarely return BROKEN during a crisis. Its useful detection window is
 * CALM markets. It is NOT a crisis safeguard — do not rely on it as one.
 */
function regimeValidation(tickerCloses, proxyCloses) {
    const tr = dailyReturns(tickerCloses);
    const pr = dailyReturns(proxyCloses);
    if (tr.length < REGIME_WINDOW * 2) {
        return { state: 'UNKNOWN', rolling: null, baseline: null, delta: null, action: 'NONE',
            note: 'Insufficient history for regime validation: need ' + (REGIME_WINDOW * 2) +
                ' return observations, got ' + tr.length + '. Fixed proxy continues to operate unchanged.' };
    }
    const rolling = pearson(tr.slice(-REGIME_WINDOW), pr.slice(-REGIME_WINDOW));
    const baseline = pearson(tr, pr);
    if (rolling === null || baseline === null) {
        return { state: 'UNKNOWN', rolling: rolling, baseline: baseline, delta: null, action: 'NONE',
            note: 'Correlation undefined (zero variance in one series).' };
    }
    const delta = rolling - baseline;
    if (rolling <= REGIME_BROKEN_CEILING) {
        return { state: 'BROKEN', rolling: rolling, baseline: baseline, delta: delta,
            action: 'SUSPEND_FORCEDOWN_AND_RERESOLVE',
            note: 'Rolling ' + REGIME_WINDOW + '-session correlation ' + rolling.toFixed(3) +
                ' has gone flat or negative. Fixed proxy forceDown authority SUSPENDED. Hand off to resolveFixedProxyBreak(). Flag to Mr. T at Pre-Gate-hard-trigger tier.' };
    }
    if (delta <= REGIME_DEGRADE_DELTA) {
        return { state: 'DEGRADING', rolling: rolling, baseline: baseline, delta: delta,
            action: 'REQUIRE_COHERENCE_CHECK',
            note: 'Rolling correlation ' + rolling.toFixed(3) + ' is ' + Math.abs(delta).toFixed(3) +
                ' below baseline ' + baseline.toFixed(3) +
                '. Hard trigger still fires, but proxyCoherenceCheck() becomes MANDATORY — no DOWN verdict without ticker-level confirmation. Flag to Mr. T.' };
    }
    return { state: 'INTACT', rolling: rolling, baseline: baseline, delta: delta, action: 'NONE',
        note: 'Rolling correlation ' + rolling.toFixed(3) + ' vs baseline ' + baseline.toFixed(3) +
            ' — proxy healthy, hard triggers behave as designed.' };
}
/* ---------- 4. Proposal 3 fallback — hand off to Dynamic Proxy Algorithm ---------- */
const PROXY_PRIMARY_FLOOR = 0.6;
const PROXY_SECONDARY_FLOOR = 0.4;
function resolveFixedProxyBreak(tickerCloses, candidateBasket, fundamentals) {
    const tr = dailyReturns(tickerCloses);
    const scored = Object.keys(candidateBasket)
        .map(function (sym) { return { sym: sym, r: pearson(tr, dailyReturns(candidateBasket[sym])) }; })
        .filter(function (x) { return x.r !== null; })
        .sort(function (a, b) { return b.r - a.r; });
    const best = scored[0];
    if (best && best.r >= PROXY_PRIMARY_FLOOR) {
        return { tier: 'primary', proxy: best.sym, r: best.r, sizing: 'NORMAL',
            forceDownAuthority: true, ranked: scored,
            note: 'Fixed proxy broke. New PRIMARY proxy ' + best.sym + ' adopted (r=' + best.r.toFixed(3) +
                ' >= ' + PROXY_PRIMARY_FLOOR + '). Inherits or is newly classified per the 3-question CRF classification.' };
    }
    if (best && best.r >= PROXY_SECONDARY_FLOOR) {
        return { tier: 'secondary', proxy: best.sym, r: best.r, sizing: 'INFORMS_ONLY',
            forceDownAuthority: false, ranked: scored,
            note: 'Fixed proxy broke. Best candidate ' + best.sym + ' r=' + best.r.toFixed(3) +
                ' clears ' + PROXY_SECONDARY_FLOOR + ' but not ' + PROXY_PRIMARY_FLOOR +
                ' — SECONDARY/weighted overlay only. Informs sizing, does not gate alone. Ticker trades on Gate 0 + its own price-action gates (1/3/4).' };
    }
    // Fundamentals Feedback Loop — Step 4
    const f = fundamentals || {};
    const checks = [
        f.yearsPublic > 5,
        f.marketCap > 2e9,
        f.avgVol20d > 1e6,
        (f.ivRank !== undefined && f.ivRank < 50)
    ];
    const confirmed = checks.filter(Boolean).length;
    if (confirmed >= 3) {
        return { tier: 'fundamentals-confirmed', proxy: null, r: best ? best.r : null,
            sizing: 'NORMAL', forceDownAuthority: false, confirmed: confirmed, ranked: scored,
            note: 'Fixed proxy broke and no candidate cleared ' + PROXY_SECONDARY_FLOOR +
                '. Fundamentals loop: ' + confirmed + '/4 confirmed => "Confirmed, no proxy" — Gate 0 only, normal sizing.' };
    }
    return { tier: 'fundamentals-speculative', proxy: null, r: best ? best.r : null,
        sizing: 'QUARTER', forceDownAuthority: false, confirmed: confirmed, ranked: scored,
        autoExecuteStop: true, elevatedCapCeiling: true,
        note: 'Fixed proxy broke and no candidate cleared ' + PROXY_SECONDARY_FLOOR +
            '. Fundamentals loop: ' + confirmed + '/4 confirmed => "Speculative, no proxy" — elevated-cap ceiling, auto-execute stop (not notify-only), quarter size per Gate 4 Phase 3 default.' };
}
/**
 * Single source of truth for which gates can force DOWN alone, replacing the
 * scattered/implicit treatment that caused mid-crisis ambiguity on Jul 29, 2026.
 *
 * SCOPE LIMIT: Gate 5 and the Taiwan rule are exempt ONLY for the tickers they
 * actually gate. They do not gain authority over non-gated names (IMVT/SMMT/TWST).
 */
const FORCEDOWN_EXEMPT = {
    PRE_GATE: { scope: 'all', reason: 'Thesis integrity — solvency/dilution/guidance-cut.' },
    GATE_0_RED: { scope: 'all', reason: 'SPY AND QQQ both down >1%.' },
    GATE_1_STEP3: { scope: 'all', reason: '60-session decline >25% structural breakdown.' },
    GATE_5_KOREA: { scope: 'korea-gated', reason: 'KOSPI down 3%+ or circuit breaker. (Proposal 1, Jul 29 2026)' },
    TAIWAN_PROXY: { scope: 'ai-semi-gated', reason: 'TSM drop >3%. (Proposal 1, Jul 29 2026)' }
};
function hasForceDownAuthority(gateKey, tickerGating, regime) {
    tickerGating = tickerGating || [];
    regime = regime || null;
    const entry = FORCEDOWN_EXEMPT[gateKey];
    if (!entry) {
        return { authorized: false,
            reason: gateKey + ' is not corroboration-exempt — needs >=2 RED gates for DOWN.' };
    }
    if (entry.scope !== 'all' && tickerGating.indexOf(entry.scope) === -1) {
        return { authorized: false,
            reason: gateKey + ' is scoped to ' + entry.scope + '; this ticker is not in that scope.' };
    }
    // Proposal 3 interaction: a BROKEN regime strips forceDown from a fixed proxy.
    const isFixedProxy = (gateKey === 'GATE_5_KOREA' || gateKey === 'TAIWAN_PROXY');
    if (isFixedProxy && regime && regime.state === 'BROKEN') {
        return { authorized: false, requiresReresolve: true,
            reason: gateKey + ' forceDown SUSPENDED — regime BROKEN (rolling r=' +
                regime.rolling.toFixed(3) + '). Route through resolveFixedProxyBreak().' };
    }
    if (isFixedProxy && regime && regime.state === 'DEGRADING') {
        return { authorized: true, requiresCoherenceCheck: true,
            reason: gateKey + ' authorized but regime DEGRADING — proxyCoherenceCheck() is MANDATORY before returning DOWN.' };
    }
    return { authorized: true, reason: entry.reason };
}
/**
 * "Pre-Catalyst Buildup" composite, per Proposal 4's own definition: sustained
 * volume 1.5x+, sector-proxy outperformance, no fresh material news yet
 * priced, and clean earnings-reaction history. The last of those has no data
 * source anywhere in this app -- no per-ticker earnings-day price-reaction
 * history is tracked -- so it's deliberately NOT faked or approximated here;
 * this checks only the first three. Requires every one of THOSE that's
 * actually computable to agree, and at least 2 of the 3 to be computable at
 * all, so a single available signal (most often just "no fresh news," which
 * is true on most days regardless of any real buildup) can never carry the
 * pattern by itself.
 */
function buildupPatternCheck(input) {
    input = input || {};
    const signals = [];
    if (typeof input.volRatio === 'number')
        signals.push(input.volRatio >= 1.5);
    if (typeof input.tickerPct === 'number' && typeof input.proxyPct === 'number') {
        // "Outperformance" read as magnitude, not direction: the ticker's own
        // session move exceeds its resolved Gate 5 proxy's move -- i.e.
        // something ticker-specific is in play beyond generic sector drift.
        signals.push(Math.abs(input.tickerPct) > Math.abs(input.proxyPct));
    }
    signals.push(!input.hasFreshNews);
    const usable = signals.length;
    const confirmed = signals.filter(Boolean).length;
    const ok = usable >= 2 && confirmed === usable;
    return {
        ok: ok, usable: usable, confirmed: confirmed,
        note: 'Buildup pattern: ' + confirmed + '/' + usable + ' available signal(s) agree' +
            (usable < 2 ? ' (insufficient data for this ticker)' : '') + '. ' +
            'Earnings-reaction-history sub-signal omitted -- no historical data source exists for it yet.'
    };
}
const CONTEXT_CORROBORATION_THRESHOLD = 2;
/**
 * Deterministic Gate 2 corroboration: does real, already-computed market
 * data (Gate 3's buildup pattern, a real scheduled earnings event)
 * confirm an active catalyst is actually in play. Both sources must
 * agree (2-of-2) to promote to a GATE2-CORROBORATED modifier; fewer
 * leaves the catalyst read as ordinary Gate 2 evidence, unweighted by
 * this check.
 */
function computeGate2Corroboration(input) {
    input = input || {};
    const sources = [
        { key: 'gate3_buildup_pattern', ok: !!(input.buildup && input.buildup.ok) },
        { key: 'earnings_calendar_event', ok: input.hasEarningsEvent === true }
    ];
    const matchCount = sources.filter(function (s) { return s.ok; }).length;
    const corroborated = matchCount >= CONTEXT_CORROBORATION_THRESHOLD;
    const matchedLabels = sources.filter(function (s) { return s.ok; }).map(function (s) { return s.key; });
    return {
        corroborated: corroborated, matchCount: matchCount, sources: sources, matchedLabels: matchedLabels,
        modifier: corroborated ? 'GATE2-CORROBORATED' : null,
        note: corroborated
            ? 'Gate 2 corroborated by ' + matchCount + '/2 deterministic signal(s): ' + matchedLabels.join(', ') + '.'
            : 'Gate 2 corroboration: ' + matchCount + '/2 deterministic signal(s) agree -- not enough to weight as confirmed.'
    };
}
module.exports = {
    evaluateGate1Sessions: evaluateGate1Sessions,
    proxyCoherenceCheck: proxyCoherenceCheck,
    regimeValidation: regimeValidation,
    resolveFixedProxyBreak: resolveFixedProxyBreak,
    hasForceDownAuthority: hasForceDownAuthority,
    dailyReturns: dailyReturns,
    pearson: pearson,
    FORCEDOWN_EXEMPT: FORCEDOWN_EXEMPT,
    GATE1_LONG_SESSIONS: GATE1_LONG_SESSIONS,
    GATE1_SHORT_SESSIONS: GATE1_SHORT_SESSIONS,
    buildupPatternCheck: buildupPatternCheck,
    computeGate2Corroboration: computeGate2Corroboration,
    CONTEXT_CORROBORATION_THRESHOLD: CONTEXT_CORROBORATION_THRESHOLD
};
