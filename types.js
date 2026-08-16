// Phase 0/1 of the TypeScript adoption plan (trade-verdict's CLAUDE.md,
// "Engineering: TypeScript adoption path" — Aug 14, 2026), mirrored into
// this repo (Aug 16, 2026). JSDoc @typedef declarations only, checked via
// `tsc --noEmit` against tsconfig.json's `checkJs`. No .ts files, no build
// step, no runtime behavior.
//
// This file is never imported at runtime by server.js/credits.js — JSDoc
// `@typedef {import('./types.js').X}` references are erased by the JS
// engine (they're comments), so it needs no build step or module wiring.
//
// Kept byte-identical in content to trade-verdict's shared/types.js
// (adjusted only for this repo's flat layout — no shared/ subdirectory
// here) per the same "keep these files identical" mirror convention this
// repo's own server.js/credits.js/gates-extended.js already follow with
// their trade-verdict counterparts. These are the highest-risk shapes
// named in the adoption plan: the /analyze request/response and
// TickerData/GateResult. Unlike trade-verdict's copy, GateResult and the
// /analyze contract ARE built in this repo's own server.js — but server.js
// is still outside this pass's checked scope (tsconfig.json only covers
// gates-extended.js for now, matching trade-verdict's Phase 0 scope) — the
// typedefs live here so gates-extended.js can reference the same wire
// shapes server.js produces/consumes, instead of guessing independently,
// and so a future pass widening tsconfig.json to server.js has these
// shapes ready to use immediately.

/**
 * A single gate's evaluated result, as every gate normalizes to in both the
 * /ticker/:symbol response (gate1, preGate) and the /analyze response's
 * `gates` map (pre_gate, sector, g1_prewindow, g2_catalyst, g3_openbar,
 * g4_phase, g5_korea). Every gate has at least {status, note}; the
 * server-enforced ones (Gate 1, Gate 5) also carry sizing/forceDown.
 *
 * This is the exact shape whose *input* side (see SectorContext below) was
 * silently wrong for three weeks — evaluateProxyStatus() in server.js read
 * `marketData[symbol].pct` assuming an object, but every client only ever
 * sent a formatted string, so Gate 5's RED status was unreachable via
 * /analyze until root-caused by hand (Aug 13, 2026 — see trade-verdict's
 * CLAUDE.md, "Gate 5 forceDown was silently unreachable"). Writing this
 * shape down is what let that exact bug class get caught by `tsc` on save
 * during the investigation that produced this plan, instead of needing
 * another live incident.
 * @typedef {Object} GateResult
 * @property {"GREEN"|"YELLOW"|"RED"} status
 * @property {string} note
 * @property {"FULL"|"HALF"|"QUARTER"|"NONE"} [sizing]
 * @property {boolean} [forceDown]
 * @property {string} [unit]
 * @property {string} [branch]
 */

/**
 * sectorContext, exactly as every tier's client (app.js's `sc` object in
 * analyzeTicker()) actually sends it in the /analyze POST body: a plain map
 * of lowercase index/proxy symbol -> a formatted "+1.23%"/"-4.56%"
 * *string*, never a {pct, change} object — plus Gate 0's own
 * pre-resolved gateStatus/gateNote riding on the same object. This is the
 * shape the Aug 13, 2026 Gate 5 bug got wrong (see GateResult above):
 * `SectorContext[symbol]` is a `string`, not `{pct, change}`, in production.
 * @typedef {Object<string, string>} SectorContext
 */

/**
 * The GET /ticker/:symbol response — this repo's own server.js builds
 * this; every tier's client fetches and memoizes it per-symbol.
 * @typedef {Object} TickerData
 * @property {string} symbol
 * @property {{price:number, pct:(number|null), week52hi:number, week52lo:number, rangePosition:(number|null), phaseProxy:string, beta:(number|null)}|null} metrics
 * @property {{headline:string, url:string, source:string, ageLabel:string, ageHours:number}|null} news
 * @property {Object|null} openingBar
 * @property {{proxy:{symbols:string[], name:string, rationale:string}, category:string, dynamicallyResolved?:boolean, forceDownAuthority?:boolean, sizingOverride?:string, elevatedCapCeiling?:boolean, autoExecuteStop?:boolean}} proxyRule
 * @property {GateResult} gate1
 * @property {{status:"GREEN"|"YELLOW"|"RED", hardTrigger:boolean, note:string}} preGate
 * @property {number|null} [iv]
 * @property {Object|null} weeklyCarryover
 * @property {{state:"INTACT"|"DEGRADING"|"BROKEN"|"UNKNOWN", rolling:(number|null), baseline:(number|null), delta:(number|null), action:string, note:string}|null} regime
 * @property {string} timestamp
 */

/**
 * The POST /analyze request body, built by each tier's own analyzeTicker()
 * (app.js / pro/app.js / starter/app.js / shark's monolithic file — all in
 * trade-verdict, none in this repo) and consumed by this repo's own
 * server.js /analyze handler.
 * @typedef {Object} AnalyzeRequestBody
 * @property {string} ticker
 * @property {SectorContext} [sectorContext]
 * @property {string} [marketContext]
 * @property {Object} [metricsData]
 * @property {Object} [newsData]
 * @property {Object} [openingBarData]
 * @property {Object} [proxyRule]
 * @property {GateResult} [gate1Data]
 * @property {Object} [preGateData]
 * @property {Object} [weeklyCarryoverData]
 * @property {Object} [regimeData]
 */

/**
 * The POST /analyze response — the LLM's own JSON (ticker/type/verdict/
 * confidence/reason/gates/sizing/wait_for, per SYSTEM_PROMPT in server.js)
 * plus everything server-enforced on top of it before the response goes out
 * (contextCorroboration, riskFlags, marketOpen, fromCache).
 * @typedef {Object} AnalyzeResponse
 * @property {string} ticker
 * @property {"CANARY"|"SENTIMENT"|"FLOW"} type
 * @property {"UP"|"DOWN"|"FLAT"} verdict
 * @property {"HIGH"|"MEDIUM"|"LOW"} confidence
 * @property {string} reason
 * @property {Object<string, GateResult>} gates
 * @property {"FULL"|"HALF"|"QUARTER"|"NONE"} sizing
 * @property {string|null} wait_for
 * @property {{corroborated:boolean, matchCount:number, note:string}} [contextCorroboration]
 * @property {{elevatedCapCeiling:boolean, autoExecuteStop:boolean}} [riskFlags]
 * @property {boolean} marketOpen
 * @property {boolean} [fromCache]
 */

export {};
