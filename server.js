// ═══════════════════════════════════════════════════════════════
// TRADE VERDICT API — v4.0.0
// Built July 19, 2026
// Key changes from v3.x:
//   - Smart proxy algorithm for Gate 5 (never N/A)
//   - News-aware Gate 2 catalyst analysis
//   - Market closed detection → all verdicts HOLD
//   - Gate 0 server-enforced (not AI-estimated)
//   - Temperature=0 for deterministic verdicts
//   - Sector classification via Finnhub profile
// ═══════════════════════════════════════════════════════════════

const express   = require("express");
const cors      = require("cors");
const credits   = require("./credits");
const gx        = require("./gates-extended");
const ah        = require("./analyze-helpers");
const { createClient } = require("@supabase/supabase-js");

// ── SUPABASE CLIENT ───────────────────────────────────────────────
// This is the ONLY client that should ever be used for service_role-
// privileged work (credits.rpc(), subscribers, watchlist/track-record
// sync). persistSession:false is deliberate — see authClient() below for
// why this client must never accumulate a signed-in session.
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

// ── CRF VERSION (Proposal 7 — Verdict Accuracy Scorecard, Aug 26, 2026) ──
// Tags every verdict_log row so future CRF/gate-logic changes never
// silently blend with historical accuracy that was measured under
// different rules. Bump this by hand on every change that can alter what
// verdict/sizing/confidence a given input produces (gate weighting,
// forceDown/corroboration authority, confidence rules, sizing rules) —
// NOT on cosmetic/UI-only changes. Last bumped: Aug 22, 2026 (Pre-Gate
// joined the corroboration pool; Gate 4 moved server-side; Gate 3 Friday
// full-weight exception; single-RED-among-2/3/4 sizing exception).
const CRF_VERSION = "2026-08-22";

// Fixed default until Proposal 6 (Aggression Dial) ships its own dial
// position -- the Dial's neutral position is documented as "= current CRF
// behavior unchanged," so 3 trading days is this app's own de facto
// holding-period assumption today, not a new invented number.
const DEFAULT_GRADING_WINDOW_TRADING_DAYS = 3;

function addTradingDays(date, n) {
  const d = new Date(date.getTime());
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay(); // 0 = Sun, 6 = Sat
    if (day !== 0 && day !== 6) added++;
  }
  return d;
}

// Pass supabase client to credit system
credits.setSupabase(supabase);

// Public anon key — safe to keep in source, it's already public in every
// tier's page source (see e.g. pro/app.js's SUPABASE_ANON constant).
// Overridable via env if it's ever rotated.
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9pbm9tY2lrZHlpc3JiZmVlaXJwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2NzM3NzgsImV4cCI6MjEwMDI0OTc3OH0.PiMDYsSZjNd4Iw-0wbQH4niDvUmW8ymycmiyb5Raf1w";

// A FRESH client, never reused or stored in a module-level variable — see
// call sites (/auth/login, /auth/signup). signInWithPassword/signUp
// persist a session onto whatever client instance they're called on, and
// that instance's own .from()/.rpc() calls then send the session's
// access_token instead of the key it was constructed with. `supabase`
// above is shared across every concurrent request in this process; if
// login/signup ran on it, the moment any one user logged in, every other
// in-flight or subsequent request's privileged calls (credits included)
// would silently start executing as THAT user's `authenticated` role
// instead of `service_role` — confirmed as the root cause of the Aug 4,
// 2026 credits RLS mystery (see CLAUDE.md: revoking anon/authenticated
// grants broke production instantly, even though service_role's own
// grants were untouched and a SQL-editor `set role service_role` test
// worked fine). A throwaway client here has no session to leak.
function authClient() {
  return createClient(process.env.SUPABASE_URL, SUPABASE_ANON_KEY);
}

// Wraps fetch with an AbortController-based timeout so a slow/hanging
// upstream (SEC, Finnhub, Alpaca, Anthropic) fails fast with a clear error
// instead of leaving a request hanging indefinitely. Every call site below
// already has its own try/catch fallback (or, for the two /analyze paths,
// a 500 response) — this just gives those fallbacks a bounded time to kick
// in instead of one slow provider stalling an entire ticker load.
async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getSubscriber(email) {
  if (!supabase || !email) return null;
  try {
    const { data, error } = await supabase
      .from("subscribers")
      .select("*")
      .ilike("email", email.trim());

    if (error) { console.error("[SUB LOOKUP] Query error:", error.message); return null; }
    if (!data || data.length === 0) {
      console.log(`[SUB LOOKUP] No rows matched ILIKE "${email.trim()}"`);
      return null;
    }
    console.log(`[SUB LOOKUP] Found ${data.length} matching row(s)`);

    const rank = { shark: 4, pro: 3, starter: 2, free: 1 };
    data.sort((a, b) => {
      const aActive = (a.status || "").trim().toLowerCase() === "active" ? 10 : 0;
      const bActive = (b.status || "").trim().toLowerCase() === "active" ? 10 : 0;
      return (bActive + (rank[b.tier] || 0)) - (aActive + (rank[a.tier] || 0));
    });
    return data[0];
  } catch(e) { console.error("[SUB LOOKUP] Exception:", e.message); return null; }
}

async function upsertSubscriber(email, tier, stripeCustomerId, stripeSubId) {
  if (!supabase) { console.log("[UPSERT] No supabase client"); return; }
  console.log(`[UPSERT] Attempting to upsert: ${email} tier=${tier}`);
  try {
    const { data, error } = await supabase.from("subscribers").upsert({
      email,
      tier,
      status: "active",
      stripe_customer_id: stripeCustomerId || null,
      stripe_subscription_id: stripeSubId || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "email" }).select();
    if (error) {
      console.error(`[UPSERT] FAILED for ${email}:`, error.message, error.details, error.hint);
    } else {
      console.log(`[UPSERT] Success for ${email}, returned:`, data);
    }
  } catch(e) { console.error(`[UPSERT] Exception for ${email}:`, e.message); }
}

async function validateSupabaseToken(token) {
  if (!supabase || !token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  } catch(e) { return null; }
}

// validateSupabaseToken() (a Supabase Auth network call) + getSubscriber()
// (a DB query) together cost two Supabase round trips on EVERY
// authenticated request. A single page load can fire dozens of concurrent
// requests carrying the identical token (e.g. the batched ticker-data
// hydration across a large watchlist) -- without this, each one separately
// re-validates the same token and re-looks-up the same subscriber, which
// multiplies real Supabase latency by the request count for no benefit
// (the same user isn't changing tier mid-burst). Short TTL keeps a real
// tier change (upgrade/downgrade/cancellation) from staying stale for more
// than a minute.
const authCache = new Map(); // token -> { data: {user, tier}, time }
const AUTH_CACHE_MS = 60 * 1000;

// The time-based cache above only helps requests that land AFTER an earlier
// one already finished and populated it. A burst of concurrent requests
// carrying the identical token (exactly the watchlist-hydration case the
// comment above describes) all check the cache before any of them has had
// time to fill it, so every single one independently re-runs both Supabase
// round trips — the cache does nothing for the burst that motivated it in
// the first place. Track the in-flight promise per token, same pattern as
// the frontend's shared/ticker-cache.js inFlight map, so concurrent callers
// share one real lookup instead of each starting their own.
const authInFlight = new Map(); // token -> Promise

async function resolveAuth(token) {
  const cached = authCache.get(token);
  if (cached && Date.now() - cached.time < AUTH_CACHE_MS) return cached.data;

  const inFlight = authInFlight.get(token);
  if (inFlight) return inFlight;

  const p = (async () => {
    try {
      const user = await validateSupabaseToken(token);
      if (!user) { authCache.delete(token); return null; }

      const sub = await getSubscriber(user.email);
      const subStatus = sub ? (sub.status || "").trim().toLowerCase() : "none";
      const tier = (sub && subStatus === "active") ? sub.tier : "free";
      console.log(`Auth: ${user.email} → subscriber ${sub ? "found" : "MISSING"} (status: ${subStatus}) → tier: ${tier}`);

      const data = { user, tier };
      authCache.set(token, { data, time: Date.now() });
      if (authCache.size > 500) {
        const oldest = [...authCache.entries()].sort((a, b) => a[1].time - b[1].time).slice(0, 100);
        oldest.forEach(([k]) => authCache.delete(k));
      }
      return data;
    } finally {
      authInFlight.delete(token);
    }
  })();
  authInFlight.set(token, p);
  return p;
}
const app     = express();

// Render sits behind a proxy — trust its X-Forwarded-For so req.ip is the
// visitor's real address, not Render's internal hop. Needed for anonymous
// free-tier credit tracking (see getClientIp below).
app.set("trust proxy", true);

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.ip || req.connection?.remoteAddress || "unknown";
}

app.use(cors());

// IMPORTANT: Stripe webhook needs raw body — must be mounted BEFORE express.json()
app.use("/stripe/webhook", express.raw({ type: "application/json" }));
app.use("/stripe/credits", express.raw({ type: "application/json" }));

app.use(express.json());

// ─── SECRET TOKEN ─────────────────────────────────────────────────
// ── MULTI-TIER AUTH MIDDLEWARE ────────────────────────────────────
// Each tier has its own API key set as an env variable:
// FREE_KEY, STARTER_KEY, PRO_KEY, SHARK_KEY
// The client sends x-app-secret header with their tier key
// Server identifies tier and attaches user status to req

const TIER_KEYS = {
  free:    process.env.FREE_KEY    || process.env.APP_SECRET,
  starter: process.env.STARTER_KEY,
  pro:     process.env.PRO_KEY,
  shark:   process.env.SHARK_KEY,
};

app.use(async (req, res, next) => {
  if (req.path === "/") return next();
  if (req.path === "/auth/login") return next();
  if (req.path === "/auth/signup") return next();
  if (req.path === "/auth/reset") return next();
  if (req.path === "/auth/reset-confirm") return next();
  if (req.path === "/stripe/webhook") return next();
  if (req.path === "/stripe/credits") return next();

  const provided  = req.query.secret || req.headers["x-app-secret"];
  const authToken = req.query.supabase_token || req.headers["x-supabase-token"];

  // ── PATH 1: Supabase token (authenticated users) ──────────────
  if (authToken) {
    const resolved = await resolveAuth(authToken);
    if (!resolved) return res.status(401).json({ error: "Invalid session token" });

    req.userEmail  = resolved.user.email;
    req.userTier   = resolved.tier;
    req.userKey    = `sub:${resolved.user.email}`;  // stable key — email not JWT
    req.tierConfig = credits.TIERS[resolved.tier];
    return next();
  }

  // ── PATH 2: Tier key (legacy / direct access) ─────────────────
  if (provided) {
    let matchedTier = null;
    for (const [tier, key] of Object.entries(TIER_KEYS)) {
      if (key && provided === key) { matchedTier = tier; break; }
    }
    if (!matchedTier) return res.status(401).json({ error: "Invalid API key" });
    req.userTier   = matchedTier;
    // Free tier ships one public secret to every visitor, so the secret
    // itself can't be the credit key (every anonymous visitor would share
    // one pool). Key anonymous free-tier users by IP instead — each IP
    // gets its own 3-credits/week allowance (see credits.js checkWeeklyReset).
    // Paid tiers reaching this legacy path keep the shared-secret key.
    req.userKey    = matchedTier === "free" ? `ip:${getClientIp(req)}` : provided;
    req.tierConfig = credits.TIERS[matchedTier];
    return next();
  }

  return res.status(401).json({ error: "No API key or session token provided" });
});

// ─── MARKET HOURS DETECTION ───────────────────────────────────────
function isMarketOpen() {
  const now = new Date();
  // Convert to ET
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const h = et.getHours(), m = et.getMinutes();
  const mins = h * 60 + m;
  return mins >= 570 && mins < 960; // 9:30am–4:00pm ET
}

// Today's weekday in ET (0=Sun..6=Sat) — shared by every day-of-week check
// in this file so they can't drift from each other on the timezone
// conversion itself, only on what they each do with the resulting number.
function etWeekday() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })).getDay();
}

// Gate 3's weekly-carryover decay label for today, or null on Mon/Fri/
// weekend (those days keep their own same-day overlay rule instead — see
// fetchWeeklyCarryover's comment). Sessions-since-Monday is just today's
// ET weekday minus Monday's (1): Tue=1, Wed=2, Thu=3.
function carryoverDecayLabel() {
  const day = etWeekday();
  const sessionsSinceMonday = day - 1;
  if (sessionsSinceMonday === 1) return { sessionsSinceMonday, weight: 'MODERATE' };
  if (sessionsSinceMonday === 2) return { sessionsSinceMonday, weight: 'REDUCED' };
  if (sessionsSinceMonday === 3) return { sessionsSinceMonday, weight: 'MINIMAL — largely faded' };
  return null; // Mon, Fri, or weekend
}

// ─── SMART PROXY ALGORITHM ────────────────────────────────────────
// Classifies any ticker into a proxy category using Finnhub sector data
// Never returns N/A — every ticker gets a meaningful proxy

const PROXY_RULES = [
  {
    category: "Biotech/Medical",
    keywords: ["biotech","pharmaceutical","therapeutics","genomics","diagnostics",
               "medical","healthcare","oncology","biopharma","clinical"],
    tickers:  ["SMMT","VCYT","IMVT","ENVX","MRNA","PFE","BIIB","GILD","REGN","VRTX",
               "BMRN","ALNY","SRPT","BLUE","EDIT","NTLA","BEAM","CRSP"],
    proxy:    { name:"XBI (Biotech ETF)", symbols:["XBI","IBB"],
                rationale:"Biotech/medical names move with XBI sector sentiment" },
  },
  {
    category: "AI/Semiconductor",
    keywords: ["semiconductor","chip","memory","artificial intelligence","gpu",
               "fabless","foundry","electronic","integrated circuit"],
    tickers:  ["MU","NVDA","AMD","ALAB","SMCI","AVGO","QCOM","INTC","MRVL","ON",
               "IREN","CIFR","CORZ","WULF","BTDR","ARM","TSM","ASML","LRCX","KLAC"],
    proxy:    { name:"TSM + KOSPI (Taiwan/Korea Semis)",
                symbols:["TSM"],
                rationale:"AI/semi names lag Taiwan (TSM) and Korean (Samsung/SK Hynix) by 1-3 sessions. TSM drop >3% = risk-off." },
  },
  {
    category: "Software/Cloud",
    keywords: ["software","cloud","saas","platform","enterprise","cybersecurity",
               "application","data analytics","crm"],
    tickers:  ["ORCL","MSFT","CRM","NOW","SNOW","DDOG","NET","CRWD","ZS","OKTA",
               "MDB","GTLB","HUBS","BILL","VEEV"],
    proxy:    { name:"MSFT (Cloud Canary)",
                symbols:["MSFT"],
                rationale:"MSFT is the institutional canary for enterprise software and cloud. MSFT weakness precedes software sector rotation by 2-5 sessions." },
  },
  {
    category: "Fintech/Crypto",
    keywords: ["fintech","payment","financial technology","cryptocurrency","digital asset",
               "exchange","brokerage","neobank","digital bank"],
    tickers:  ["HOOD","NU","SQ","COIN","PYPL","AFRM","UPST","LC","SOFI","DAVE",
               "MARA","RIOT","CLSK","HUT","BTBT"],
    proxy:    { name:"BTC + QQQ (Risk-On Signal)",
                symbols:["BTC","QQQ"],
                rationale:"Fintech/crypto names correlate directly with BTC momentum and QQQ risk-on sentiment." },
  },
  {
    category: "Energy/Commodities",
    keywords: ["energy","oil","gas","petroleum","mining","natural resources",
               "pipeline","refining","coal","uranium","renewable"],
    tickers:  ["ET","XOM","CVX","COP","OXY","SLB","HAL","DVN","FANG","APA",
               "USO","GLD","SLV","NEM","GOLD","FCX","MP","UEC","CCJ"],
    proxy:    { name:"USO + GLD (Commodity Complex)",
                symbols:["USO","GLD"],
                rationale:"Energy and commodity names track oil (USO) and gold (GLD) directly. Macro/geopolitical signals dominate." },
  },
  {
    category: "Defense/Aerospace",
    keywords: ["defense","aerospace","military","government","contractor","security"],
    tickers:  ["LMT","RTX","NOC","GD","BA","HII","LDOS","SAIC","KTOS","AXON"],
    proxy:    { name:"LMT (Defense Canary)",
                symbols:["LMT"],
                rationale:"LMT leads defense sector moves. Geopolitical escalation (LMT +2%) = long signal for all defense names." },
  },
  {
    category: "BDC/REIT/Income",
    keywords: ["business development","real estate","reit","income","dividend",
               "mortgage","investment trust"],
    tickers:  ["ARCC","MAIN","OBDC","GBDC","FS","IWM","O","AMT","PLD","EQIX"],
    proxy:    { name:"IWM + SPY (Broad Market / Rate Sensitive)",
                symbols:["IWM","SPY"],
                rationale:"BDCs and REITs are rate-sensitive. IWM small-cap health and SPY broad market are the right barometers." },
  },
];

const DEFAULT_PROXY = {
  category: "General",
  proxy: { name:"SPY + IWM (Broad Market Default)",
           symbols:["SPY","IWM"],
           rationale:"No sector-specific proxy identified. SPY and IWM broad market health is the appropriate Gate 5 barometer." },
};

function classifyTicker(symbol, sectorInfo) {
  const sym  = symbol.toUpperCase();
  const desc = (sectorInfo?.description || sectorInfo?.finnhubIndustry || "").toLowerCase();
  const name = (sectorInfo?.name || "").toLowerCase();
  const combined = `${desc} ${name}`;

  for (const rule of PROXY_RULES) {
    // Check direct ticker match first
    if (rule.tickers.includes(sym)) return rule;
    // Check keyword match in sector description
    if (rule.keywords.some(kw => combined.includes(kw))) return rule;
  }
  return DEFAULT_PROXY;
}

// ─── PRE-GATE — THESIS INTEGRITY (Patch 3, Aug 1 2026) ─────────────
// Runs BEFORE Gate 0. Screens for solvency, dilution, and guidance-cut risk
// via SEC EDGAR full-text search across recent filings. No corroboration
// required — like Gate 0 RED and Gate 1 forceDown, a hard trigger here can
// force a DOWN verdict on its own (see FORCEDOWN_EXEMPT.PRE_GATE in
// gates-extended.js).
//
// TRIGGER TABLE — FIRST DRAFT, NEEDS REVIEW. Nothing more specific than the
// three category names (solvency/dilution/guidance-cut) ever existed in the
// framework docs; these keyword lists are a reasonable starting point, not
// an authoritative spec. Tune against real false-positive/negative rates
// before trusting this to force verdicts unattended.
//
// Widened solvency keywords (Aug 18, 2026, re-landed after a same-day
// revert of the persistent-flag work built on top of this): a distress
// 8-K rarely uses the narrow auditor-opinion phrasing below on its own --
// it announces a bankruptcy filing, a debt default, or a delisting notice
// (Items 1.03/2.04/3.01). This fix itself was never disproven by anything
// that happened later the same day -- only the NEW enforcement mechanism
// built on top of it (persistent flag, wide lookback, cross-company
// guard) caused a live false positive and got reverted. Re-landing this
// half alone, paired with real diagnostic logging this time, before
// rebuilding any enforcement on top of it.
const PRE_GATE_TRIGGERS = {
  solvency: {
    hardOrSoft: "hard",
    // "going concern" was removed as its own standalone keyword (Aug 19,
    // 2026) -- confirmed via a real live false positive on STWD (Starwood
    // Property Trust, a healthy company): the phrase isn't exclusively an
    // auditor going-concern qualification, it's also standard M&A/legal
    // terminology for a VALUATION METHOD ("fair saleable value...
    // determined on a going concern basis" -- meaning valued as an
    // operating business, not liquidated). The actual matched hit was
    // Section 5.7 "Solvency" of a merger agreement exhibit, boilerplate
    // every deal includes, with zero connection to real distress. A real
    // auditor going-concern qualification always pairs it with
    // "substantial doubt" (the required U.S. GAAP/PCAOB terminology for
    // an actual doubt determination), which is why that keyword alone is
    // kept and is sufficient -- confirmed it still catches BALY's real
    // warning ("raise substantial doubt about the company's ability to
    // continue as a going concern") on "substantial doubt" alone.
    // "insolvent"/"insolvency" removed the same way (Aug 20, 2026) --
    // confirmed live on STWD again after the "going concern" fix: still
    // RED, same 2 hits, same company, now matching "insolvent" instead.
    // A scoped EDGAR search for "insolvent" on STWD's own CIK returned
    // 1,648 hits, all boilerplate -- the word is standard language in
    // risk-factor/counterparty-risk/credit-agreement text regardless of
    // the filer's own health, the identical failure mode "going concern"
    // had. That confirmed pattern generalizes to the remaining generic,
    // definitional terms below -- "event of default", "notice of
    // default", "acceleration of indebtedness", and "receivership" are
    // all standard defined terms in loan-agreement/indenture exhibits,
    // describing what WOULD constitute a default, not that one actually
    // happened. Removed as a class rather than waiting for a third live
    // false positive on each one individually, given the same underlying
    // mechanism (a bare legal/financial term with no requirement that the
    // filer is actively asserting it about itself) is now confirmed
    // twice. What's left is deliberately narrow: an actual auditor
    // determination ("substantial doubt") or an actual bankruptcy/
    // delisting event -- phrases that are inherently about something
    // having actually happened, not hypothetical/definitional boilerplate.
    // Real trade-off, not free: this will miss real distress language
    // that doesn't use one of these specific phrases -- precision over
    // recall, a deliberate choice given today's confirmed false-positive
    // cost, not a claim that recall no longer matters.
    keywords: [
      "substantial doubt",
      "chapter 11", "chapter 7 bankruptcy", "voluntary petition for bankruptcy",
      "bankruptcy protection",
      "notice of delisting", "delisting notice",
    ],
  },
  dilution: {
    hardOrSoft: "soft",
    keywords: [
      "at-the-market offering", "atm offering", "shelf registration",
      "convertible notes offering", "registered direct offering",
      "private placement of common stock",
    ],
  },
  guidanceCut: {
    hardOrSoft: "soft",
    keywords: [
      "lowered guidance", "reduced guidance", "withdrew guidance",
      "revised outlook downward",
    ],
  },
};
// 8-K/10-Q/10-K alone is an operating-company-disclosure-only view. A real
// coverage gap for the "dilution" category above (Aug 12, 2026): an ATM
// program, shelf registration, or registered-direct offering is disclosed
// via a registration statement (S-1/S-3) or its prospectus supplement
// (424B2/3/4/5) -- these don't always also get a fresh 8-K, especially a
// periodic draw under an ATM program already set up under an existing
// shelf. Solvency/guidance-cut language can show up in these forms too
// (e.g. a going-concern risk factor in a new S-1), so widening the form
// list benefits every trigger category, not just dilution.
const PRE_GATE_FORMS = "8-K,10-Q,10-K,S-1,S-3,424B2,424B3,424B4,424B5";
const PRE_GATE_LOOKBACK_DAYS = 45;
const PRE_GATE_ESCALATION_WINDOW_DAYS = 30;
const PRE_GATE_ESCALATION_COUNT = 2;
const SEC_USER_AGENT = process.env.SEC_EDGAR_USER_AGENT || "TradeTribunal research contact@example.com";

// SEC's fair-access policy caps requests at 10/sec. Unlike Finnhub/Alpaca
// (see finnhubThrottle/alpacaThrottle below), nothing paced calls to SEC at
// all — every /ticker/:symbol request awaits evaluatePreGate() before it can
// return anything, and both the CIK map and the per-symbol Pre-Gate result
// live in plain in-memory Maps/vars that go cold on every deploy. A burst of
// concurrent requests for many *different* symbols right after a cold start
// (a fresh deploy, or simply a large watchlist's first load of the day) fires
// one full-text-search call per symbol with nothing pacing them — the exact
// failure shape the Finnhub throttle exists to prevent, just against a
// stricter per-second limit instead of per-minute, and on the one path with
// no queue in front of it at all.
const SEC_MAX_PER_SEC = 8;
const secCallTimes = [];
let secQueue = Promise.resolve();

function secThrottle() {
  const turn = secQueue.then(async () => {
    for (;;) {
      const now = Date.now();
      while (secCallTimes.length && now - secCallTimes[0] > 1000) secCallTimes.shift();
      if (secCallTimes.length < SEC_MAX_PER_SEC) {
        secCallTimes.push(now);
        return;
      }
      await new Promise(r => setTimeout(r, 1000 - (now - secCallTimes[0]) + 20));
    }
  });
  secQueue = turn.catch(() => {}); // one slow/failed turn must not wedge the queue for everyone behind it
  return turn;
}

// Ticker -> CIK map, refreshed daily. SEC's full-text search filters by CIK,
// not ticker symbol, so this is required to scope a search to one company.
// tickerCikInFlight mirrors authInFlight above: without it, every concurrent
// request landing while the map is cold (null, or >24h old) independently
// re-fetches and re-parses the entire SEC ticker list instead of the whole
// burst sharing one fetch.
let tickerCikCache = null;
let tickerCikNameCache = null; // ticker -> company name (title), logged alongside CIK resolution for direct diagnosis
let tickerCikCacheAt = 0;
let tickerCikInFlight = null;

// Secondary ticker->CIK map, built from SEC's fund-specific ticker file
// (company_tickers_mf.json). "mf" = mutual fund, but it maps by the same
// series/class registration structure most ETFs use too, and covers
// entries the primary company_tickers.json map above sometimes misses.
// Root-caused live (Aug 12, 2026): DRAM (Roundhill Memory ETF) kept
// showing "No SEC CIK found," but it has a real, findable CIK -- 1976517,
// Roundhill ETF Trust (confirmed via SEC's own EDGAR filing URLs
// referencing DRAM directly, e.g. an 8-A Cert PDF under
// /Archives/edgar/data/1976517/.../8A_Cert_DRAM.pdf). DRAM only started
// trading Apr 2, 2026 -- plausible the primary file's per-ticker coverage
// for a fund that recently-launched, sharing a trust CIK with many other
// Roundhill funds, simply hasn't caught up, or was never reliable for
// this class of security to begin with.
//
// Fetched LAZILY -- only the first time a primary-map lookup misses, not
// eagerly alongside it -- since the overwhelming majority of tickers
// resolve through the primary map, and eagerly fetching this second,
// larger, fund-specific file on every cold cache would be pure waste for
// those.
//
// UNVERIFIED against SEC's actual live file -- this sandbox's egress
// proxy blocks sec.gov outright (confirmed via curl 403 and WebFetch
// EGRESS_BLOCKED), so this was researched via web search rather than by
// fetching and inspecting the file directly. Parsed defensively against
// the documented {fields:[...], data:[[...]]} array shape (same shape as
// the sibling company_tickers_exchange.json) by looking up field
// positions by NAME rather than hardcoding indices, and fails safe to
// null on any shape mismatch. Also worth knowing: PRE_GATE_FORMS is
// "8-K,10-Q,10-K" -- operating-company forms a fund like DRAM will never
// file -- so fixing the CIK lookup changes the note from "No SEC CIK
// found" to "No solvency/dilution/guidance-cut language found," not to
// an active RED/YELLOW trigger. That's expected: Pre-Gate's trigger
// categories are operating-company risk concepts that don't really apply
// to a passively-tracked ETF, so a clean GREEN pass-through is the
// realistic outcome, not a sign the fix didn't work. Check Render logs
// for "getCikFromFundMap" errors, or confirm live that DRAM's Pre-Gate
// note changes after this deploys.
let fundTickerCikCache = null;
let fundTickerCikCacheAt = 0;
let fundTickerCikInFlight = null;

async function getCikFromFundMap(symbol) {
  const now = Date.now();
  if (!fundTickerCikCache || now - fundTickerCikCacheAt > 24 * 60 * 60 * 1000) {
    if (!fundTickerCikInFlight) {
      fundTickerCikInFlight = (async () => {
        try {
          await secThrottle();
          const res = await fetchWithTimeout("https://www.sec.gov/files/company_tickers_mf.json", {
            headers: { "User-Agent": SEC_USER_AGENT },
          }, 8000);
          if (!res.ok) throw new Error(`SEC company_tickers_mf ${res.status}`);
          const data = await res.json();
          const fields = Array.isArray(data.fields) ? data.fields : [];
          const rows   = Array.isArray(data.data)   ? data.data   : [];
          const cikIdx    = fields.indexOf("cik");
          const symbolIdx = fields.indexOf("symbol");
          const map = {};
          if (cikIdx !== -1 && symbolIdx !== -1) {
            rows.forEach(row => {
              const ticker = row[symbolIdx];
              if (ticker) map[String(ticker).toUpperCase()] = String(row[cikIdx]).padStart(10, "0");
            });
          }
          fundTickerCikCache = map;
          fundTickerCikCacheAt = Date.now();
        } catch (e) {
          console.error("getCikFromFundMap fetch:", e.message);
        } finally {
          fundTickerCikInFlight = null;
        }
      })();
    }
    await fundTickerCikInFlight;
    if (!fundTickerCikCache) return null;
  }
  return fundTickerCikCache[symbol.toUpperCase()] || null;
}

// Follow-up (Aug 12, 2026): the company_tickers_mf.json fallback above
// did NOT fix DRAM -- confirmed live, no change to its Pre-Gate note.
// Most likely explanation, per further research (still can't fetch
// sec.gov directly from this sandbox to confirm outright): that file's
// "mf" naming isn't incidental -- it appears to cover traditional
// NAV-priced open-end mutual funds specifically, not exchange-traded
// funds, so an ETF like DRAM was never going to show up there regardless
// of any staleness/coverage-lag theory. Two more tiers added below,
// specifically so this doesn't just become "one more guess that might
// not work for the next ticker either":
//
// Tier 3 (KNOWN_CIK_OVERRIDES): a small, explicit, hand-confirmed map for
// tickers already proven to have a real CIK the automated lookups above
// miss. Not meant to scale by itself -- it's a guaranteed, zero-risk fix
// for specifically-reported cases (starting with DRAM, CIK 1976517 /
// Roundhill ETF Trust, confirmed via SEC's own EDGAR filing URLs
// referencing it directly) while tier 4 below is the actual general fix.
//
// Tier 4 (getCikFromEdgarSearch): SEC's own live company/ticker search --
// the same mechanism that powers EDGAR's search box -- queried only when
// every static file above misses. Unlike the static ticker-file tiers,
// this hits SEC's current database directly rather than a periodically-
// cached snapshot, so it should catch genuinely new listings (DRAM
// itself only started trading Apr 2, 2026) without needing a hardcoded
// override for every future one. SEC's classic browse-edgar endpoint
// accepts a ticker directly in its CIK parameter (well-documented,
// long-standing SEC behavior -- this is literally how EDGAR's own search
// box resolves a typed ticker), and its atom output wraps a match in a
// <company-info><cik> element. UNVERIFIED against a live response, same
// sandbox limitation as everything else SEC-related in this file --
// parsed defensively (primary <cik> tag match, loose numeric fallback)
// and fails safe to null. Its own small 24h cache (edgarSearchCikCache)
// exists because this is the slowest tier and, unlike the bulk map
// fetches above, isn't naturally cached in one shared object -- without
// it, the same recurring miss would re-hit SEC on every single request
// for that ticker instead of once a day.
const KNOWN_CIK_OVERRIDES = {
  DRAM: "0001976517", // Roundhill Memory ETF / Roundhill ETF Trust
};

const edgarSearchCikCache = new Map(); // symbol -> { cik, time }

async function getCikFromEdgarSearch(symbol) {
  const cached = edgarSearchCikCache.get(symbol);
  if (cached && Date.now() - cached.time < 24 * 60 * 60 * 1000) return cached.cik;
  try {
    await secThrottle();
    const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(symbol)}&type=&dateb=&owner=include&count=10&output=atom`;
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": SEC_USER_AGENT } }, 8000);
    if (!res.ok) throw new Error(`SEC browse-edgar ${res.status}`);
    const text = await res.text();
    // Tag match first (atom output); "CIK#:" label second (SEC's actual
    // documented label text on the HTML company page, deliberately NOT a
    // bare "CIK=" match -- that would false-positive on the request URL's
    // own query string being echoed back into the response somewhere).
    const m = text.match(/<cik>(\d+)<\/cik>/i) || text.match(/CIK#:\s*(\d{1,10})/i);
    const cik = m ? m[1].padStart(10, "0") : null;
    edgarSearchCikCache.set(symbol, { cik, time: Date.now() });
    return cik;
  } catch (e) {
    console.error(`getCikFromEdgarSearch ${symbol}:`, e.message);
    return null;
  }
}

async function getCik(symbol) {
  const sym = symbol.toUpperCase();
  const now = Date.now();
  if (!tickerCikCache || now - tickerCikCacheAt > 24 * 60 * 60 * 1000) {
    if (!tickerCikInFlight) {
      tickerCikInFlight = (async () => {
        try {
          await secThrottle();
          const res = await fetchWithTimeout("https://www.sec.gov/files/company_tickers.json", {
            headers: { "User-Agent": SEC_USER_AGENT },
          }, 8000);
          if (!res.ok) throw new Error(`SEC company_tickers ${res.status}`);
          const data = await res.json();
          const map = {};
          const nameMap = {};
          Object.values(data).forEach(row => {
            const t = String(row.ticker).toUpperCase();
            map[t] = String(row.cik_str).padStart(10, "0");
            if (row.title) nameMap[t] = row.title;
          });
          tickerCikCache = map;
          tickerCikNameCache = nameMap;
          tickerCikCacheAt = Date.now();
        } catch (e) {
          console.error("getCik ticker map fetch:", e.message);
        } finally {
          tickerCikInFlight = null;
        }
      })();
    }
    await tickerCikInFlight;
  }
  // Diagnostic logging (Aug 18, 2026, re-landed observation-only after
  // today's enforcement mechanism -- persistent flag/wide lookback/
  // cross-company guard -- was reverted for causing a live false
  // positive). Before rebuilding any of that, get real Render-log
  // evidence of which CIK/company a ticker actually resolves to and what
  // the real SEC full-text search returns. Grep Render logs for
  // "[PRE-GATE]".
  const primary = tickerCikCache ? (tickerCikCache[sym] || null) : null;
  if (primary) {
    console.log(`[PRE-GATE] ${sym} -> CIK ${primary} (primary map: ${tickerCikNameCache?.[sym] || "name unknown"})`);
    return primary;
  }
  if (KNOWN_CIK_OVERRIDES[sym]) {
    console.log(`[PRE-GATE] ${sym} -> CIK ${KNOWN_CIK_OVERRIDES[sym]} (KNOWN_CIK_OVERRIDES)`);
    return KNOWN_CIK_OVERRIDES[sym];
  }
  const fundCik = await getCikFromFundMap(sym);
  if (fundCik) {
    console.log(`[PRE-GATE] ${sym} -> CIK ${fundCik} (fund ticker map)`);
    return fundCik;
  }
  const edgarCik = await getCikFromEdgarSearch(sym);
  console.log(`[PRE-GATE] ${sym} -> CIK ${edgarCik || "NOT FOUND"} (live EDGAR search, last-resort tier)`);
  return edgarCik;
}

async function searchEdgarFilings(cik, keywords) {
  const startdt = new Date(Date.now() - PRE_GATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const enddt = new Date().toISOString().slice(0, 10);
  const q = keywords.map(k => `"${k}"`).join(" OR ");
  // dateRange=custom is required by efts.sec.gov whenever startdt/enddt are
  // supplied -- the real EDGAR full-text-search UI always includes it
  // alongside a custom date range. Without it the request is liable to be
  // rejected or the date filter silently dropped. Re-landed alongside the
  // keyword widening above -- neither of these two request-correctness
  // fixes was ever disproven by anything that happened later the same
  // day; only the persistence/enforcement layer built on top got reverted.
  const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}` +
    `&dateRange=custom&ciks=${cik}&forms=${PRE_GATE_FORMS}&startdt=${startdt}&enddt=${enddt}`;
  // Diagnostic logging, re-landed observation-only (Aug 18, 2026) -- see
  // getCik() above. This is the actual evidence needed before any
  // enforcement mechanism gets rebuilt on top of this function.
  console.log(`[PRE-GATE] searchEdgarFilings request: ${url}`);
  try {
    await secThrottle();
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": SEC_USER_AGENT } }, 8000);
    console.log(`[PRE-GATE] searchEdgarFilings response: HTTP ${res.status} for CIK ${cik}`);
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "(could not read body)");
      console.log(`[PRE-GATE] searchEdgarFilings error body (first 500 chars): ${bodyText.slice(0, 500)}`);
      throw new Error(`EDGAR full-text search ${res.status}`);
    }
    const data = await res.json();
    const allHits = data?.hits?.hits || [];
    const companies = allHits.map(h => (h._source?.display_names || []).join(", ")).join(" | ") || "(none)";
    console.log(`[PRE-GATE] searchEdgarFilings CIK ${cik}: ${allHits.length} hit(s), total=${data?.hits?.total?.value ?? "?"}, companies: ${companies}`);

    // Exhibit-vs-primary-document filter (Aug 21, 2026). Root cause of the
    // STWD false positive: the matched text lived in an EX-2.1 merger-
    // agreement exhibit's boilerplate "Solvency" representation (Section
    // 5.7), not in the 10-Q's own primary financial statements. EDGAR's
    // full-text search indexes exhibits alongside the primary document and
    // returns both under the same CIK/form -- confirmed via SEC's own
    // documented response shape, each hit's _source.file_type identifies
    // which sub-document actually matched (e.g. "10-Q" for the primary
    // document, "EX-2.1"/"EX-99.1"/etc. for an attached exhibit). A real
    // auditor going-concern opinion is part of the audited financial
    // statements themselves -- it is never filed as an attachment -- so a
    // hit is only trustworthy when it matched inside the primary document.
    // Fail permissive (keep the hit) if file_type is missing/unrecognized,
    // matching this codebase's established "don't block on thin metadata"
    // posture (see companyNamesLikelyMatch's own reasoning, elsewhere in
    // this file's history) -- excluding on absence of a signal would be a
    // new, unverified assumption of its own.
    const isExhibit = (h) => {
      const ft = h._source?.file_type;
      return typeof ft === "string" && /^EX-/i.test(ft.trim());
    };
    const hits = allHits.filter(h => !isExhibit(h));
    const excluded = allHits.length - hits.length;
    if (excluded > 0) {
      const exhibitTypes = allHits.filter(isExhibit).map(h => h._source?.file_type).join(", ");
      console.log(`[PRE-GATE] searchEdgarFilings CIK ${cik}: excluded ${excluded} exhibit-only hit(s) (${exhibitTypes}), ${hits.length} primary-document hit(s) remain`);
    }
    return hits;
  } catch (e) {
    console.error(`[PRE-GATE] searchEdgarFilings ${cik} FAILED:`, e.message);
    return [];
  }
}

// 30-day soft-trigger escalation history — see pre_gate_triggers table
// (Supabase DDL handed off separately). Gracefully no-ops (never escalates
// via history, only same-request hard triggers still work) if Supabase
// isn't configured or the table doesn't exist yet.
async function getRecentSoftTriggerCount(symbol) {
  if (!supabase) return 0;
  try {
    const since = new Date(Date.now() - PRE_GATE_ESCALATION_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("pre_gate_triggers")
      .select("id")
      .eq("ticker", symbol)
      .eq("hard_or_soft", "soft")
      .gte("detected_at", since);
    if (error || !data) return 0;
    return data.length;
  } catch (e) {
    console.error(`getRecentSoftTriggerCount ${symbol}:`, e.message);
    return 0;
  }
}

async function logPreGateTrigger(symbol, category, hardOrSoft, filingAccession) {
  if (!supabase) return;
  try {
    await supabase.from("pre_gate_triggers").insert({
      ticker: symbol, category, hard_or_soft: hardOrSoft,
      filing_accession: filingAccession || null, detected_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`logPreGateTrigger ${symbol}:`, e.message);
  }
}

async function evaluatePreGate(symbol) {
  try {
    const cik = await getCik(symbol);
    if (!cik) {
      return {
        status: "GREEN", hardTrigger: false,
        note: `No SEC CIK found for ${symbol} — skipping Pre-Gate screen (likely non-US-listed or not in the SEC ticker map).`,
      };
    }

    // Search each trigger category SEPARATELY, one query per category,
    // instead of one combined OR'd query reclassified afterward against a
    // `hit.highlight` field (Aug 18, 2026 fix -- confirmed via live Render
    // logs: BALY's real, current going-concern 10-Q came back as 3
    // correctly-attributed hits from the search itself, then classified to
    // ZERO categories, because EDGAR's full-text search response doesn't
    // reliably populate `highlight` the way the old code assumed -- every
    // genuine hit was silently thrown away after the fact. A hit returned
    // from a query scoped to only ONE category's keywords is guaranteed,
    // by construction of a full-text keyword search, to actually contain
    // that category's language somewhere in the filing -- there's no
    // post-hoc reclassification step left to get wrong. Costs 3 SEC calls
    // per evaluatePreGate() invocation instead of 1, but this only runs
    // once per ticker per 24h (preGateCache), so the extra throttled calls
    // are a modest, acceptable price for actually working.
    const matched = [];
    for (const [category, def] of Object.entries(PRE_GATE_TRIGGERS)) {
      const hits = await searchEdgarFilings(cik, def.keywords);
      for (const hit of hits) {
        matched.push({ category, hardOrSoft: def.hardOrSoft, accession: hit._id });
      }
    }
    if (!matched.length) {
      return { status: "GREEN", hardTrigger: false, note: "No solvency, dilution, or guidance-cut language found in recent SEC filings." };
    }

    const hasHardTrigger = matched.some(m => m.hardOrSoft === "hard");
    for (const m of matched) {
      if (m.hardOrSoft === "soft") await logPreGateTrigger(symbol, m.category, "soft", m.accession);
    }

    let escalated = false;
    if (!hasHardTrigger) {
      const recentSoftCount = await getRecentSoftTriggerCount(symbol);
      if (recentSoftCount >= PRE_GATE_ESCALATION_COUNT) escalated = true;
    }

    const isHard = hasHardTrigger || escalated;
    const categories = [...new Set(matched.map(m => m.category))].join(", ");
    return {
      status: isHard ? "RED" : "YELLOW",
      hardTrigger: isHard,
      categories: [...new Set(matched.map(m => m.category))],
      escalated,
      note: isHard
        ? `Pre-Gate hard trigger${escalated ? " (escalated from repeated soft triggers)" : ""} — ${categories} language found in recent SEC filings. Forces DOWN regardless of any other gate.`
        : `Pre-Gate soft trigger — ${categories} language found in recent SEC filings. Logged for 30-day escalation tracking; not yet forcing a verdict.`,
    };
  } catch (e) {
    console.error(`evaluatePreGate ${symbol}:`, e.message);
    return { status: "GREEN", hardTrigger: false, note: "Pre-Gate check failed — treating as pass-through, not blocking analysis." };
  }
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are a trading analysis engine running the Catalyst Response Framework (CRF).
Return ONLY valid JSON. No markdown, no explanation.

CORE PRINCIPLE — CONGRUENCY:
All gates must tell the same story for a high-confidence entry. When gates conflict,
the conflict itself is the signal — mixed signals = FLAT, not UP or DOWN.
A single strong tailwind does not overcome multiple headwinds.
A single headwind does not confirm a downtrend without corroboration.

IMPORTANT RULES:
- Pre-Gate status is PRE-DETERMINED by the server. Copy exactly. Never override.
- Gate 0 status is PRE-DETERMINED by the server. Copy exactly. Never override.
- Gate 1 status is PRE-DETERMINED by the server. Copy exactly. Never override.
- Gate 4 phase is PRE-DETERMINED by the server. Copy exactly. Never override.
- Gate 5 proxy is PRE-DETERMINED by the server. Copy exactly. Never override.
- Temperature is 0 — be deterministic. Same data = same verdict every time.
- News headlines provided ARE potential catalysts — treat them as Gate 2 evidence.
- Always check congruency between gates before assigning verdict.

═══ GATE DEFINITIONS ═══

PRE-GATE — THESIS INTEGRITY (server-provided, never recalculate)
Screens for solvency doubt, dilution, and guidance-cut risk via SEC EDGAR
filings before any other gate runs. GREEN: no risk language found in recent
filings. YELLOW: a soft trigger (dilution or guidance-cut language) found —
logged, not yet forcing a verdict on its own. RED: a hard trigger (solvency/
going-concern language, or 2+ soft triggers within 30 days escalating) —
sets DOWN as a candidate verdict, same as any other RED gate. As of
Aug 22, 2026, Pre-Gate RED is NO LONGER an unconditional override — it is
NOT exempt from the corroboration rule below. A RED Pre-Gate only holds as
a final DOWN verdict when the corroboration rule's conditions are met
(2+ RED gates, counting Pre-Gate itself as one, or the single-RED
exception when Gates 2, 3, and 4 are all independently YELLOW) —
otherwise it downgrades to FLAT like any other uncorroborated single RED.

GATE 0 — SECTOR (server-provided, never recalculate)
GREEN-STRONG: SPY >+0.5% AND QQQ >+0.5% — genuine tailwind, boosts UP confidence
GREEN-NEUTRAL: Both flat to +0.5% — no headwind, proceed normally
YELLOW: Either down 0.5-1% — caution, cut size 50%
RED: BOTH SPY AND QQQ down >1% — broad market failure, no entries

Note: If only one index is down >1% but not both, that is YELLOW not RED.
Sector rotation (QQQ down, SPY flat) is not a broad market failure.

GATE 1 — BIDIRECTIONAL TREND STRUCTURE (server-provided, never recalculate)
Rebuilt Jul 28-29, 2026 to replace the old one-directional 52-week-range proxy.
STEP 1: 60-day price change determines branch — uptrend, downtrend, or flat.
STEP 2 (uptrend, 14-day catalyst-window exhaustion): GREEN <+10%, YELLOW +10-20%
  (reduce 50%), RED >+20% (no entry, wait for post-catalyst flush).
STEP 3 (downtrend, 60-day structural breakdown): GREEN <10% decline (normal
  pullback), YELLOW 10-25% decline (half size, requires a confirmed higher low),
  RED >25% decline — this RED carries forceDown override authority EQUIVALENT
  TO GATE 0 RED: it forces the final verdict to DOWN regardless of any other
  gate, and is exempt from the corroboration rule below. Sector tailwinds
  cannot override a Gate 1 forceDown.
Gate 1 RED from STEP 2 (uptrend exhaustion) does NOT force DOWN — it only means
  do not enter long. Only STEP 3's >25% structural breakdown forces DOWN.

GATE 2 — CATALYST CONGRUENCE
Step 1: Classify ticker as CANARY, SENTIMENT, or FLOW
Step 2: Classify the catalyst type and direction:
  - COMPANY-SPECIFIC POSITIVE (earnings beat, FDA approval, signed deal, partnership): GREEN
  - COMPANY-SPECIFIC NEGATIVE (pipeline failure, downgrade, miss, regulatory block): RED
  - SECTOR MACRO POSITIVE (XBI up, sector rotation into this space): YELLOW-GREEN
  - SECTOR MACRO NEGATIVE (XBI down, rotation out): YELLOW-RED
  - NO CATALYST / NEUTRAL: YELLOW
Step 3: Check congruency with ticker classification:
  - CANARY responding to macro = congruent (expected)
  - SENTIMENT ignoring macro risk while canary names fall = INCONGRUENT (flag this)
  - FLOW on mechanical event = mechanical — check pre-window (Gate 1) first
Step 4: Fund performance reviews, general market commentary, and index rebalancing
  reports are NOT company-specific catalysts. Treat as NEUTRAL unless they contain
  specific guidance or material information about the ticker.
Step 5: A "Session Context corroboration" block is provided below (Proposal 4,
  Aug 13 2026). This is server-computed, not your own judgment call — copy its
  conclusion exactly. If it says CONTEXT-CORROBORATED, treat the user-typed
  Session Context as real Gate 2 evidence, weighted the same as the news
  catalyst above. If it says uncorroborated, the typed context is informational
  only — do not let it move your GREEN/YELLOW/RED classification.

GATE 3 — MEAN REVERSION + 3-BAR SEQUENCE

Gate 3 operates in two modes depending on whether swing level data is provided.

MODE 1 — BLIND SEQUENCE (no Alpaca data, all tiers except Shark)
You have day-of-week and any bar data from SESSION CONTEXT only.
Run the 3-bar sequence logic:
- Bar 1: What direction did the first bar close? Note color and relative size.
- Bar 2: Did Bar 2 confirm or reject Bar 1 direction?
  - Confirms = direction building, YELLOW-BUILDING
  - Rejects = reversal in play, YELLOW-REVERSAL
- Bar 3: Conviction bar. Same direction as Bar 2 = GREEN. Reversal = RED lean.
- No bar data provided = YELLOW-MIDWEEK default

Mon/Fri overlay always applies:
- Monday + 3-bar bullish sequence = highest conviction GREEN
- Friday + any sequence = add skepticism, 67% reversal frequency
- Weekend/holiday = YELLOW, no bar data available

Friday full-weight exception (server-computed check, use exactly what it
says — do not guess at this from the bar data alone): if the "Gate 3
Friday full-weight check" context below explicitly says the week has
been FLAT, AND today's own 3-bar sequence is itself bullish/convicted,
do not apply the standard 67%-reversal skepticism discount — weight
today's sequence at full conviction instead, same as a Monday GREEN.
If that context says NOT flat, or the data was unavailable, keep the
standard Friday skepticism above. This never applies on any day other
than Friday.

MODE 2 — SWING LEVEL (Shark tier, Alpaca data provided)
Four reference levels are pre-calculated and provided:
- 14D_HIGH: 14-day absolute high (outer swing resistance)
- 14D_LOW: 14-day absolute low (outer swing support)
- 2D_MEAN_HIGH: 2-day 15-min mean high (inner resistance)
- 2D_MEAN_LOW: 2-day 15-min mean low (inner support)

Mean reversion logic — the TOUCH is the signal, not the candle color:
- Bar 1 touches swing LOW (14D or 2D mean) → expect reversion UP
- Bar 1 touches swing HIGH (14D or 2D mean) → expect reversion DOWN
- Bar 2 response confirms or fails the reversion
- Bar 3 convicts — same direction as Bar 2 = full Gate 3 signal

The touch can occur anywhere in the first 3 hours (up to 12:00pm ET).
Sequence starts from the touch bar, not necessarily from 9:30am.

Swing level interpretation:
- Touch of 14D_LOW + Bar 2 green + Bar 3 green = HIGH conviction long, GREEN
- Touch of 14D_HIGH + Bar 2 red + Bar 3 red = HIGH conviction short/avoid, RED
- Touch of 2D_MEAN_LOW/HIGH = same logic but MEDIUM conviction
- Failed touch (Bar 2 indecision) = YELLOW, noise
- No touch detected yet = YELLOW-SCANNING, sequence not triggered

Mon/Fri overlay applies in both modes. Monday touch + 3-bar conviction = maximum Gate 3 weight.

WEEKLY CARRYOVER (Tue/Wed/Thu, both modes) — this is additional context
alongside the same-day Mon/Fri overlay above, not a replacement for it.
The Friday close -> weekend -> Monday reaction is part of the broader
week's narrative, not an isolated same-day event, so it keeps informing
Gate 3 for the rest of that week on a fixed decay schedule:
- Tuesday (1 session removed): MODERATE weight — Monday's reaction still
  meaningfully shapes today's read. A CONFIRMED_UP/DOWN reaction leans
  today's sequence read the same direction; a FLAT reaction is neutral.
- Wednesday (2 sessions removed): REDUCED weight — treat it as one input
  among several, not a thumb on the scale the way Tuesday gets.
- Thursday (3 sessions removed): MINIMAL weight, largely faded — mention
  it only if today's own 3-bar sequence is otherwise ambiguous/YELLOW and
  the carryover would help break the tie; never let it override a clear
  same-day signal.
Use the "Gate 3 weekly carryover" context block provided below. If it says
data is unavailable, treat that as no additional signal — do not assume a
direction. This never applies on Monday or Friday themselves (those keep
the same-day rule above), nor on weekends/holidays.

GATE 4 — PHASE (server-provided, never recalculate)
A plain 52-week-range-position threshold, not a judgment call — computed
server-side from the same rangePosition number given to you below.
Phase 1 (range <30%): GREEN — discovery phase, full size entry appropriate
Phase 2 (range 30-70%): YELLOW — acceleration phase, half size, enter on pullbacks only
Phase 3 (range >70%): RED — priced for perfection, post-flush entry only, defined risk
Gate 4 RED means: wait for the flush. It does NOT mean short the stock.

GATE 5 — DYNAMIC PROXY RESOLUTION (server-provided, never recalculate)
The barometer ticker is resolved one of two ways: (1) a static sector rule
(keyword/ticker lookup — e.g. Taiwan/Korea semis, biotech/XBI), or (2) when
no static rule matches, the Dynamic Proxy Resolution Algorithm — a 90-day+
daily-return correlation against a basket of sector ETFs, falling through to
a fundamentals feedback loop (age, market cap, volume, IV rank) when no
candidate correlates strongly enough. The resolved tier is always stated in
the note: primary (r>=0.6, full forceDown authority same as a fixed
Korea/Taiwan hard trigger), secondary (r 0.4-0.6, informs sizing only, never
forces DOWN alone), fundamentals-confirmed (no proxy, Gate 0 only, normal
sizing), or fundamentals-speculative (no proxy, elevated-cap ceiling,
auto-execute stop, quarter size).
GREEN: Proxy flat or positive, or a fundamentals-confirmed/no-proxy ticker — no sector headwind
YELLOW: Proxy down 1-3% — sector pressure, reduce size
RED: Proxy down >3% (primary tier) — sector stress, no new entries until stabilized
Note: A negative-beta stock (beta < 0) may be UNCORRELATED to its proxy.
If beta is negative, note this explicitly and weight Gate 5 accordingly.

═══ CONGRUENCY CHECKS ═══

Run these before assigning verdict:

CHECK A — CATALYST vs SECTOR:
If Gate 2 = positive catalyst AND Gate 5 = GREEN → CONGRUENT, full confidence
If Gate 2 = positive catalyst AND Gate 5 = RED → INCONGRUENT — catalyst fighting sector
  headwind. Cap confidence at MEDIUM. Note the conflict explicitly.
If Gate 2 = negative catalyst AND Gate 5 = RED → DOUBLE NEGATIVE — both confirm bearish
  lean. This is a genuine DOWN signal when Gate 0 also confirms.
If Gate 2 = neutral AND Gate 5 = GREEN → NEUTRAL — no strong edge either way

CHECK B — PHASE vs CATALYST:
If Gate 1/4 = Phase 3 (RED) AND Gate 2 = positive catalyst → SELL-THE-NEWS RISK
  The good news may already be priced in. HOLD, not UP. Wait for post-catalyst flush.
If Gate 1/4 = Phase 1 (GREEN) AND Gate 2 = positive catalyst → IDEAL SETUP
  Early positioning before news is priced. UP with appropriate confidence.

CHECK C — TICKER TYPE vs MARKET CONDITIONS:
If SENTIMENT ticker AND Gate 0 = RED → DOWN (sentiment names get hit hardest in down markets)
If CANARY ticker AND Gate 0 = RED → DOWN (canaries lead the move)
If FLOW ticker AND Gate 0 = RED → FLAT (mechanical flows can persist briefly against market)
If SENTIMENT ticker AND Gate 2 = negative catalyst AND Gate 5 = RED → HIGH CONFIDENCE DOWN

═══ SIZING RULES ═══

FULL size only when: Gate 0 GREEN-STRONG + Gate 1 GREEN + Gate 2 GREEN + Gate 5 GREEN
HALF size when: Any single YELLOW gate, or Gate 0 GREEN-NEUTRAL
QUARTER size when: 2 YELLOW gates, Gate 2/5 incongruent, or the single-RED
  UP exception below (exactly one of Gates 2/3/4 RED on an otherwise-UP verdict)
NONE / Defined risk only when: Any RED gate present, other than the
  single-RED UP exception above, which caps at QUARTER instead of NONE

═══ VERDICT RULES ═══

The server enforces Pre-Gate, Gate 0, Gate 1, and Gate 5. You handle Gates 2-4 and congruency.

UP (bullish edge, long bias):
- Gate 0 GREEN (either strength), Gate 1 GREEN or YELLOW, Gate 5 GREEN or YELLOW
- Gates 2, 3, and 4 all GREEN or YELLOW, EXCEPT: no more than one of
  Gates 2/3/4 may be RED (single-RED exception, Aug 22, 2026) — if
  exactly one of them is RED and everything else above still supports
  UP, the verdict can still be UP, but sizing caps at QUARTER (see
  SIZING RULES) instead of the size the rest of the picture would
  otherwise earn. Two or more RED among Gates 2/3/4 is NOT this
  exception — that's DOWN/FLAT territory below.
- At least one GREEN-STRONG gate among 1,2,4,5
- Congruency checks A and B pass

DOWN (bearish edge, defined risk or short):
- Gate 0 RED (server-enforced) → always DOWN
- Gate 1 RED + Gate 4 RED together (exhaustion + Phase 3) → DOWN
- Gate 2 RED (negative catalyst) + Gate 5 RED together → DOWN
- Gate 2 RED + Gate 4 RED + Gate 0 YELLOW → DOWN
- 3 or more gates RED simultaneously → DOWN
- Single RED gate alone (except Gate 0) → NOT DOWN, see FLAT

FLAT (no edge, wait for confirmation):
- Gate 1 RED alone — exhaustion present but no downtrend confirmed
- Gate 2 RED alone — bad news but sector/market not confirming
- Gate 3 RED alone — bad opening bar but thesis intact
- Gate 4 RED alone — Phase 3 but no negative catalyst
- Gate 5 RED alone — sector stress but stock may be uncorrelated
- 2 YELLOW gates — mixed signals
- Gates 2 and 5 incongruent (catalyst fighting sector) — wait for resolution

CONFIDENCE:
HIGH: Gate 0 GREEN-STRONG + 4+ gates GREEN + congruency confirmed
MEDIUM: Gate 0 GREEN-NEUTRAL + 3 gates GREEN + minor incongruency
LOW: Any YELLOW in critical gates, or congruency conflict present
"Congruency confirmed" means the ticker's own price action (opening bar
direction) and its sector/proxy's price action both point the same way as
the verdict — not just that the pre-determined gate statuses happen to be
green. If the ticker's own price and its proxy disagree with each other,
that is a congruency conflict even if no individual gate is RED.

Return ONLY:
{
  "ticker": "SYMBOL",
  "type": "CANARY|SENTIMENT|FLOW",
  "verdict": "UP|DOWN|FLAT",
  "confidence": "HIGH|MEDIUM|LOW",
  "reason": "One sentence — cite the specific congruency or conflict driving the verdict.",
  "gates": {
    "pre_gate":     { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "sector":       { "status": "GREEN|YELLOW|RED", "note": "brief, include strength" },
    "g1_prewindow": { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g2_catalyst":  { "status": "GREEN|YELLOW|RED", "note": "catalyst type + congruency" },
    "g3_openbar":   { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g4_phase":     { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g5_korea":     { "status": "GREEN|YELLOW|RED", "note": "proxy name + tier + beta note if relevant" }
  },
  "sizing": "FULL|HALF|QUARTER|NONE",
  "wait_for": "null or specific condition to watch for"
}
`;

const PULSE_PROMPT = `
You are a market analyst. Write exactly 2 sentences summarizing sector rotation.
Sentence 1: what is leading and lagging with specific % numbers.
Sentence 2: the rotation signal for a swing trader right now.
No bullets. No labels. Plain sentences only. Return only the text.
`;


// ─── ALPACA OHLCV ─────────────────────────────────────────────────
// Shared low-level client for any Alpaca Market Data API call, any tier.
// Gate 1/5's daily-close fetching (below, all tiers) and fetchOpeningBar's
// intraday bars (Shark + non-Shark blind-sequence bar-1) both go through
// this. Future Shark-exclusive "deep analytics" (extended/granular bars,
// options/greeks — scope still TBD) should build on this same client when
// it's scoped, gated behind tierConfig.alpaca like the rest of Shark's
// Alpaca usage already is, in its own section — not folded in here.
function alpacaKeys() {
  const key = process.env.ALPACA_KEY;
  const secret = process.env.ALPACA_SECRET;
  return key && secret ? { key, secret } : null;
}

// Alpaca's free plan allows 200 requests/minute, and every one of
// fetchOpeningBar/fetchDailyCloses/fetchImpliedVolatility/
// fetchExtendedHoursPrice calls through alpacaGet() with no throttling
// upstream — a full watchlist's worth of tickers (cards + PRE + Heat Map
// each independently triggering /ticker/:symbol for the same and different
// symbols) fires 2-3 Alpaca calls per ticker concurrently, blowing past
// 200/min in seconds. Confirmed live (Aug 4, 2026): a burst of 429s across
// fetchDailyCloses/fetchOpeningBar/fetchImpliedVolatility, several for the
// same symbol within milliseconds of each other. Unlike a slow response,
// these failures aren't cosmetic — fetchDailyCloses failing to null
// degrades Gate 1's evaluation silently, not just "shows nothing." Same
// fix as Finnhub's throttle (Aug 3): one shared rolling-window limiter plus
// retry-with-backoff on 429, centralized in alpacaGet() so every call site
// gets it for free instead of needing its own copy.
const ALPACA_MAX_PER_MIN = 180;
const alpacaCallTimes = [];
let alpacaQueue = Promise.resolve();

function alpacaThrottle() {
  const turn = alpacaQueue.then(async () => {
    for (;;) {
      const now = Date.now();
      while (alpacaCallTimes.length && now - alpacaCallTimes[0] > 60000) alpacaCallTimes.shift();
      if (alpacaCallTimes.length < ALPACA_MAX_PER_MIN) {
        alpacaCallTimes.push(now);
        return;
      }
      await new Promise(r => setTimeout(r, 60000 - (now - alpacaCallTimes[0]) + 50));
    }
  });
  alpacaQueue = turn.catch(() => {}); // one slow/failed turn must not wedge the queue for everyone behind it
  return turn;
}

async function alpacaGet(path, attempt = 0) {
  const creds = alpacaKeys();
  if (!creds) throw new Error("No ALPACA_KEY/ALPACA_SECRET");
  await alpacaThrottle();
  const res = await fetchWithTimeout(`https://data.alpaca.markets${path}`, {
    headers: {
      "APCA-API-KEY-ID":     creds.key,
      "APCA-API-SECRET-KEY": creds.secret,
    },
  }, 8000);
  if (res.status === 429 && attempt < 2) {
    const retryAfterMs = Number(res.headers.get("retry-after")) * 1000 || 2000 * (attempt + 1);
    await new Promise(r => setTimeout(r, retryAfterMs));
    return alpacaGet(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`Alpaca ${res.status}: ${path}`);
  return res.json();
}

async function fetchOpeningBar(symbol) {
  if (!alpacaKeys()) return null;
  try {
    // Get today's date in ET
    const now = new Date();
    const et  = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const today = et.toISOString().split("T")[0];

    // Fetch 15-min bars for today — first bar is the opening bar
    const data = await alpacaGet(`/v2/stocks/${symbol}/bars?timeframe=15Min&start=${today}T09:30:00-04:00&limit=5&feed=iex`);
    const bars = data.bars || [];
    if (!bars.length) return null;

    const bar = bars[0]; // first bar = opening bar (9:30-9:45am)
    const avgVol = bars.reduce((a, b) => a + b.v, 0) / bars.length;

    return {
      open:   bar.o,
      high:   bar.h,
      low:    bar.l,
      close:  bar.c,
      volume: bar.v,
      vwap:   bar.vw || null,
      avgVol: Math.round(avgVol),
      volRatio: bar.v && avgVol ? parseFloat((bar.v / avgVol).toFixed(2)) : null,
      direction: bar.c > bar.o ? "bullish" : bar.c < bar.o ? "bearish" : "flat",
      timestamp: bar.t,
    };
  } catch(e) {
    console.error(`fetchOpeningBar ${symbol}:`, e.message);
    return null;
  }
}

// Latest IEX trade price via Alpaca — used by fetchTickerMetrics() only
// during isExtendedHoursWindow() (8-9:30am / 4-8pm ET), when Finnhub's free
// /quote holds the last regular-session price instead of tracking live
// trades. IEX runs its own formal pre/post-market sessions, and this
// endpoint's default feed (feed=iex) includes those prints — thinner
// liquidity than the regular consolidated tape (IEX is one exchange among
// many), so treat this as a real but imprecise read, not equivalent to a
// regular-session quote. Returns null (never throws) on a quiet name with
// no recent IEX print, or if Alpaca isn't configured — callers fall back to
// Finnhub's value in that case.
async function fetchExtendedHoursPrice(symbol) {
  if (!alpacaKeys()) return null;
  try {
    const data  = await alpacaGet(`/v2/stocks/${symbol}/trades/latest?feed=iex`);
    const trade = data.trade;
    if (!trade || typeof trade.p !== "number") return null;
    return { price: trade.p, timestamp: trade.t };
  } catch(e) {
    console.error(`fetchExtendedHoursPrice ${symbol}:`, e.message);
    return null;
  }
}

// ─── IMPLIED VOLATILITY (Pro + Shark, gated by tierConfig.iv) ──────
// IV isn't a stock metric — it's derived from options prices, and
// Finnhub's free tier (this app's main data provider) doesn't offer it at
// all, at any tier (see fetchTickerMetrics — no IV field anywhere in that
// return). Alpaca's options snapshot endpoint returns per-contract
// impliedVolatility directly, no Black-Scholes math needed here, IF the
// account has an options market-data subscription — a persistent null/403
// here almost certainly means the Alpaca plan lacks that entitlement, not a
// bug in this function. Deliberately kept OFF the shared `alpaca` flag,
// which is scoped to Shark-only Gate 3 SWING_LEVEL/deep-analytics per the
// comment on alpacaKeys() above — this is a separate tierConfig.iv flag so
// Pro can get IV without also picking up Shark's other Alpaca surface.
//
// UNVERIFIED AGAINST A LIVE ALPACA OPTIONS SUBSCRIPTION — written from the
// documented v1beta1 options snapshot shape and OCC symbol format; there is
// no way to test this against real options-data-entitled credentials from
// this environment. Confirm the endpoint path, response shape, and OCC
// symbol regex against a real account before trusting it in production, and
// watch server logs after deploy for `fetchImpliedVolatility` errors.
function pickRepresentativeIV(snapshots, price) {
  let best = null, bestScore = Infinity;
  for (const [occSymbol, snap] of Object.entries(snapshots || {})) {
    const iv = snap?.impliedVolatility ?? snap?.greeks?.impliedVolatility;
    if (typeof iv !== "number" || iv <= 0) continue;
    // OCC symbol: {root}{YYMMDD}{C|P}{strike * 1000, zero-padded to 8 digits}
    const m = /^[A-Z]+(\d{2})(\d{2})(\d{2})[CP](\d{8})$/.exec(occSymbol);
    if (!m) continue;
    const [, yy, mm, dd, strike8] = m;
    const expiration = new Date(`20${yy}-${mm}-${dd}T00:00:00Z`);
    const daysOut = (expiration.getTime() - Date.now()) / 86400000;
    if (daysOut < 0) continue; // expired/stale contract in the snapshot — skip
    const strike = parseInt(strike8, 10) / 1000;
    // Prefer near-the-money strikes first, nearer expirations as a tiebreak —
    // the same "one headline IV number" convention most retail platforms use
    // (an ATM, near-term contract), not an average across the whole chain.
    const score = (Math.abs(strike - price) / price) * 100 + daysOut * 0.05;
    if (score < bestScore) { bestScore = score; best = iv; }
  }
  return best; // fraction, e.g. 0.42 for 42% IV — caller formats as a percent
}

async function fetchImpliedVolatility(symbol, price) {
  if (!alpacaKeys() || !price) return null;
  try {
    const data = await alpacaGet(`/v1beta1/options/snapshots/${symbol}?limit=200&feed=indicative`);
    if (!data?.snapshots) return null;
    return pickRepresentativeIV(data.snapshots, price);
  } catch(e) {
    console.error(`fetchImpliedVolatility ${symbol}:`, e.message);
    return null;
  }
}

// ─── FINNHUB HELPERS ──────────────────────────────────────────────
const FH_KEY = () => process.env.FINNHUB_KEY;

// Finnhub's free tier allows 60 calls/minute. fetchTickerMetrics() alone
// fires 3 Finnhub calls per ticker with no throttling anywhere upstream —
// a cold market-data cache (a fresh deploy, or any ticker's first request
// of the day) means every one of those calls actually hits Finnhub instead
// of being served from symbolMarketCache. A single Pro watchlist's worth of
// tickers loading at once blows past 60/min in seconds: every call in that
// burst gets a 429, and since nothing retried, the entire first load after
// a deploy showed "No quote" everywhere instead of just being slow. This
// queues every Finnhub call through one shared rolling-window limiter so
// the burst gets spaced out instead of rejected outright, backed by a
// retry-with-backoff for any 429 that still slips through (e.g. a call
// already in flight when the window rolled over).
const FINNHUB_MAX_PER_MIN = 55;
const finnhubCallTimes = [];
let finnhubQueue = Promise.resolve();

function finnhubThrottle() {
  const turn = finnhubQueue.then(async () => {
    for (;;) {
      const now = Date.now();
      while (finnhubCallTimes.length && now - finnhubCallTimes[0] > 60000) finnhubCallTimes.shift();
      if (finnhubCallTimes.length < FINNHUB_MAX_PER_MIN) {
        finnhubCallTimes.push(now);
        return;
      }
      await new Promise(r => setTimeout(r, 60000 - (now - finnhubCallTimes[0]) + 50));
    }
  });
  finnhubQueue = turn.catch(() => {}); // one slow/failed turn must not wedge the queue for everyone behind it
  return turn;
}

async function finnhubGet(path, attempt = 0) {
  const key = FH_KEY();
  if (!key) throw new Error("No FINNHUB_KEY");
  await finnhubThrottle();
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetchWithTimeout(`https://finnhub.io/api/v1${path}${sep}token=${key}`,
    { headers: { "User-Agent": "TradeTribunal/4.0" } }, 8000);
  if (res.status === 429 && attempt < 2) {
    const retryAfterMs = Number(res.headers.get("retry-after")) * 1000 || 2000 * (attempt + 1);
    await new Promise(r => setTimeout(r, retryAfterMs));
    return finnhubGet(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`Finnhub ${res.status}: ${path}`);
  return res.json();
}

async function fetchQuote(symbol) {
  try {
    const sym  = symbol === "X:BTCUSD" ? "BINANCE:BTCUSDT" : symbol;
    const data = await finnhubGet(`/quote?symbol=${sym}`);
    if (!data.c || data.c === 0) throw new Error("No price");
    const pct  = data.dp || ((data.c - data.pc) / data.pc * 100);
    const sign = pct >= 0 ? "+" : "";
    return {
      price:     data.c.toFixed(2),
      change:    `${sign}${pct.toFixed(2)}%`,
      pct,
      direction: pct >= 0.5 ? "green" : pct <= -0.5 ? "red" : "flat",
    };
  } catch(e) {
    console.error(`fetchQuote ${symbol}:`, e.message);
    return null;
  }
}

// 52-week high/low, beta, market cap, IPO date, and 20-day-avg volume don't
// move intraday — they're daily-cadence facts at best (52W range/avgVol) or
// effectively static (market cap, IPO date). Before this split they still
// rode the same fetch as live price/quote, which respects each tier's
// cacheMinutes (as tight as 1 minute for Pro) — so a Pro watchlist re-hit
// Finnhub for these on every single refresh, all day, for numbers that
// hadn't actually changed since yesterday. That's most of the per-ticker
// Finnhub call volume that trips the rate limiter above on a cold cache.
// Splitting them onto their own 24h cache, decoupled from the price clock,
// cuts recurring Finnhub calls from 3/ticker down to 1/ticker after the
// first fetch of the day — same pattern Pre-Gate got in Session Log Part 5.
const FUNDAMENTALS_REFRESH_MS = 24 * 60 * 60 * 1000;
const symbolFundamentalsCache = new Map(); // symbol -> { data, time }

async function fetchTickerFundamentals(symbol) {
  try {
    const [metric, profile] = await Promise.allSettled([
      finnhubGet(`/stock/metric?symbol=${symbol}&metric=all`),
      finnhubGet(`/stock/profile2?symbol=${symbol}`),
    ]);
    // Both calls run raw here (not through a try/catch-to-null wrapper) so a
    // genuine Finnhub failure surfaces as "rejected" instead of looking
    // identical to "fetched fine, Finnhub just has no data for this field" —
    // the caller needs that distinction to decide whether to commit this
    // result to the 24h cache or retry on the next request.
    if (metric.status === "rejected" && profile.status === "rejected") return null;
    const m = metric.status  === "fulfilled" ? metric.value  : null;
    const p = profile.status === "fulfilled" ? profile.value : null;

    const week52hi = m?.metric?.["52WeekHigh"] || null;
    const week52lo = m?.metric?.["52WeekLow"]  || null;
    const beta     = m?.metric?.beta            || null;
    // Fundamentals for Gate 5's Dynamic Proxy fallback loop (Patch 2).
    // marketCap: Finnhub reports profile2.marketCapitalization in millions USD.
    // yearsPublic: derived from profile2.ipo (IPO date string).
    // avgVol20d: Finnhub's stock/metric has no exact 20-day field on the free
    // tier — 10DayAverageTradingVolume (reported in millions of shares) is the
    // closest available proxy, used as an approximation.
    const marketCap   = p?.marketCapitalization ? p.marketCapitalization * 1e6 : null;
    const yearsPublic = p?.ipo ? (Date.now() - new Date(p.ipo).getTime()) / (365.25 * 24 * 3600 * 1000) : null;
    const avgVol20d   = m?.metric?.["10DayAverageTradingVolume"]
      ? m.metric["10DayAverageTradingVolume"] * 1e6 : null;
    return { week52hi, week52lo, beta, marketCap, yearsPublic, avgVol20d, sectorInfo: p };
  } catch(e) {
    console.error(`fetchTickerFundamentals ${symbol}:`, e.message);
    return null;
  }
}

async function fetchTickerMetrics(symbol) {
  try {
    const q = await finnhubGet(`/quote?symbol=${symbol}`).catch(() => null);
    if (!q?.c) throw new Error("No quote");
    let price = q.c;
    let pct   = q.dp ?? null; // today's %change — Gate 5 Proxy Coherence Check (Patch 4) needs this

    // Pre/post-market: Finnhub's `c`/`dp` above are frozen at the last
    // regular-session values (see isExtendedHoursWindow()'s comment) —
    // substitute Alpaca's live IEX print when one's available, recomputing
    // %change against Finnhub's `pc` (previous close, reliable at any hour
    // since it doesn't need to track live trades). Falls back to Finnhub's
    // own (stale but non-null) values if Alpaca has nothing for this name.
    if (isExtendedHoursWindow()) {
      const ext = await fetchExtendedHoursPrice(symbol);
      if (ext && typeof q.pc === "number" && q.pc > 0) {
        price = ext.price;
        pct   = ((ext.price - q.pc) / q.pc) * 100;
      }
    }

    let fundEntry = symbolFundamentalsCache.get(symbol);
    if (!fundEntry || Date.now() - fundEntry.time >= FUNDAMENTALS_REFRESH_MS) {
      const fresh = await fetchTickerFundamentals(symbol);
      // Only commit a SUCCESSFUL fetch to the 24h cache — a transient
      // Finnhub blip shouldn't blank out 52W/beta/market cap for an entire
      // day. On failure, serve whatever's cached (even if stale) without
      // bumping its timestamp, so the very next request tries again.
      if (fresh) fundEntry = { data: fresh, time: Date.now() };
      else if (!fundEntry) fundEntry = { data: {}, time: 0 };
    }
    const f = fundEntry.data;

    let rangePosition = null;
    if (f.week52hi && f.week52lo && f.week52hi !== f.week52lo) {
      rangePosition = Math.round((price - f.week52lo) / (f.week52hi - f.week52lo) * 100);
    }
    symbolFundamentalsCache.set(symbol, fundEntry);
    return {
      price, pct, week52hi: f.week52hi ?? null, week52lo: f.week52lo ?? null, beta: f.beta ?? null,
      rangePosition,
      phaseProxy: rangePosition !== null
        ? rangePosition > 70 ? "PHASE_3"
        : rangePosition > 30 ? "PHASE_2" : "PHASE_1"
        : null,
      sectorInfo: f.sectorInfo ?? null,
      marketCap: f.marketCap ?? null, yearsPublic: f.yearsPublic ?? null, avgVol20d: f.avgVol20d ?? null,
    };
  } catch(e) {
    console.error(`fetchTickerMetrics ${symbol}:`, e.message);
    return null;
  }
}

// ─── DAILY CLOSES (shared) ──────────────────────────────────────────
// Ascending [oldest...newest] daily-close series from Alpaca. Reused by
// Gate 1 (needs >=61 session bars) and Gate 5's Dynamic Proxy correlation
// math (Patch 2, gates-extended.js) — 130 calendar days comfortably covers
// both. Do NOT date-anchor into this array; index positionally (sessions).
//
// Sourced from Alpaca, not Finnhub — Finnhub's /stock/candle returns 403
// on the current API key; historical candles are gated behind their paid
// tiers (confirmed via Render logs + finnhubio/Finnhub-API#546, a known,
// persistent restriction, not transient). Finnhub could be reinstated as
// an alternate source later if that plan is ever upgraded, but there's no
// reason to keep a dead fallback path for a 403 that isn't going away on
// its own. adjustment=split avoids a stock split reading as a fake crash
// in Gate 1's % change math.
async function fetchDailyCloses(symbol, lookbackDays = 130) {
  if (!alpacaKeys()) return null;
  try {
    const end   = new Date();
    const start = new Date(end.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const startStr = start.toISOString().split("T")[0];
    const endStr   = end.toISOString().split("T")[0];
    const data = await alpacaGet(
      `/v2/stocks/${symbol}/bars?timeframe=1Day&start=${startStr}&end=${endStr}&limit=${lookbackDays + 10}&feed=iex&adjustment=split`
    );
    const bars = data.bars || [];
    if (bars.length < 2) return null;
    return bars.map(b => b.c);
  } catch (e) {
    console.error(`fetchDailyCloses ${symbol}:`, e.message);
    return null;
  }
}

// ─── GATE 3 WEEKLY CARRYOVER (Tue/Wed/Thu decay context) ──────────
// Gate 3's Mon/Fri overlay only ever fired as a same-day flag -- "today
// happens to be Monday" / "today happens to be Friday" -- with nothing
// carrying Monday's reaction to Friday's move into the rest of the week,
// even though the framework's own intent (confirmed directly, Aug 12,
// 2026) is that the Friday -> weekend -> Monday sequence is part of the
// broader week's narrative, not an isolated same-day event.
//
// Deliberately a SEPARATE small fetch, not a derivation from
// fetchDailyCloses's array above -- that array is bare closes with no
// dates attached and is explicitly indexed positionally, not by calendar
// date (see the "Do NOT date-anchor" comment on it, and the Gate 1 Patch 4
// story in CLAUDE.md about exactly this class of bug). Finding "last
// Friday" and "the Monday after it" needs real dates, so this fetches its
// own short window of bars WITH timestamps and locates them by actual
// weekday rather than by guessing array offsets from today's weekday --
// robust to holidays and to whatever ambiguity exists around whether
// today's own in-progress bar is included. Only ~10 days requested (vs
// dailyCloses's 130), and callers only invoke this on Tue/Wed/Thu (see
// refreshMarketEntry) since Monday/Friday already have their own same-day
// rule and don't need it.
async function fetchWeeklyCarryover(symbol) {
  if (!alpacaKeys()) return null;
  try {
    const end   = new Date();
    const start = new Date(end.getTime() - 10 * 24 * 60 * 60 * 1000);
    const data = await alpacaGet(
      `/v2/stocks/${symbol}/bars?timeframe=1Day&start=${start.toISOString().split("T")[0]}&end=${end.toISOString().split("T")[0]}&limit=15&feed=iex&adjustment=split`
    );
    const bars = data.bars || [];
    if (bars.length < 2) return null;

    const etDay = (isoTime) =>
      new Date(new Date(isoTime).toLocaleString("en-US", { timeZone: "America/New_York" })).getDay();

    // Walk backward looking for a Monday bar immediately preceded (in this
    // trading-day series) by a Friday bar -- true regardless of any
    // Thu/holiday gaps elsewhere in the window.
    for (let i = bars.length - 1; i >= 1; i--) {
      if (etDay(bars[i].t) !== 1) continue;       // Monday
      if (etDay(bars[i - 1].t) !== 5) continue;   // immediately preceded by Friday
      const fridayClose = bars[i - 1].c, mondayClose = bars[i].c;
      const reactionPct = Math.round(((mondayClose - fridayClose) / fridayClose) * 10000) / 100;
      return {
        fridayClose, mondayClose, reactionPct,
        reaction: reactionPct > 0.3 ? 'CONFIRMED_UP' : reactionPct < -0.3 ? 'CONFIRMED_DOWN' : 'FLAT',
        mondayDate: new Date(bars[i].t).toISOString().split('T')[0],
      };
    }
    return null;
  } catch (e) {
    console.error(`fetchWeeklyCarryover ${symbol}:`, e.message);
    return null;
  }
}

// fetchWeekOwnRange — Gate 3 Friday full-weight check (Aug 22, 2026).
// Only ever called on Friday itself (see /analyze) -- classifies whether
// THIS week (Monday's close through the most recent completed session,
// normally Thursday) has been flat, so a genuinely convicted Friday
// opening-bar sequence isn't automatically discounted by the standard
// 67%-reversal skepticism the same way a directional week would be.
// Called directly from /analyze, not relayed through /ticker/:symbol --
// same pattern as Proposal 4's fetchNewsBodiesForCorroboration/
// fetchEarningsCalendarFlag below: a conditional, day-gated fetch that
// adds zero call volume on the 4 days it doesn't apply, with no new
// client-relay field or frontend change needed anywhere.
// Own dated-bars fetch, same reasoning as fetchWeeklyCarryover just above
// -- dailyCloses (Gate 1's own array) is deliberately NOT date-anchored
// (see its own comment), so it can't be reused to find "this week's
// Monday" robustly across holidays.
async function fetchWeekOwnRange(symbol) {
  if (!alpacaKeys()) return null;
  try {
    const end   = new Date();
    const start = new Date(end.getTime() - 10 * 24 * 60 * 60 * 1000);
    const data = await alpacaGet(
      `/v2/stocks/${symbol}/bars?timeframe=1Day&start=${start.toISOString().split("T")[0]}&end=${end.toISOString().split("T")[0]}&limit=15&feed=iex&adjustment=split`
    );
    const bars = data.bars || [];
    if (bars.length < 2) return null;

    const etDay = (isoTime) =>
      new Date(new Date(isoTime).toLocaleString("en-US", { timeZone: "America/New_York" })).getDay();

    // Most recent bar in the window is the most recent completed session
    // (normally Thursday's close, when this runs on a real Friday).
    const latest = bars[bars.length - 1];
    // Walk backward from there to find this week's own Monday bar.
    let monday = null;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (etDay(bars[i].t) === 1) { monday = bars[i]; break; }
    }
    if (!monday || monday.t === latest.t) return null;

    const mondayClose = monday.c, latestClose = latest.c;
    const pctMove = Math.round(((latestClose - mondayClose) / mondayClose) * 10000) / 100;
    return {
      mondayClose, latestClose, pctMove,
      flat: Math.abs(pctMove) <= 0.3, // same tolerance as fetchWeeklyCarryover's own CONFIRMED_UP/DOWN vs FLAT threshold
      throughDate: new Date(latest.t).toISOString().split("T")[0],
    };
  } catch (e) {
    console.error(`fetchWeekOwnRange ${symbol}:`, e.message);
    return null;
  }
}

// ─── GATE 1 — BIDIRECTIONAL TREND STRUCTURE (server-enforced) ─────
// Rebuilt Jul 28-29, 2026. Replaces the old 52-week-range-position
// proxy inside fetchTickerMetrics() as the source of truth for Gate 1.
//
// Patch 4 (Aug 1, 2026): the original implementation measured "60 days"/
// "14 days" via calendar-day date-arithmetic (walking the candle timestamps
// to find the bar nearest N*86400 seconds ago). Measured live data showed
// this flips the verdict branch on names like NBIS depending on which unit
// is used. RESOLVED: 60/14 mean TRADING SESSIONS, not calendar days — see
// gates-extended.js's evaluateGate1Sessions() for the full writeup. This
// function now just fetches the ascending close series and hands it off,
// with no date arithmetic of its own.
async function fetchGate1Metrics(symbol) {
  return fetchDailyCloses(symbol);
}

// evaluateGate1 — adapts gx.evaluateGate1Sessions() (session-based, Patch 4
// bug fix) into the {status, sizing, forceDown, note} shape /analyze already
// expects, so no other call site needs to change. forceDown === true has
// override authority equivalent to Gate 0 RED: it forces a DOWN verdict
// regardless of any other gate (see /analyze).
function evaluateGate1(closesAscending) {
  const r = gx.evaluateGate1Sessions(closesAscending);
  if (!r.ok) {
    return { status: "YELLOW", sizing: "HALF", forceDown: false, unit: r.unit, note: r.note };
  }
  return { status: r.color, sizing: r.sizing, forceDown: r.forceDown, unit: r.unit, branch: r.branch, note: r.note };
}

// evaluateGate4 — Phase, a plain 52-week-range-position threshold, not an
// LLM judgment call (Aug 22, 2026). rangePosition is already computed
// server-side in fetchTickerFundamentals()'s caller above and relayed to
// /analyze inside metricsData -- this just applies the same GREEN <30% /
// YELLOW 30-70% / RED >70% thresholds the prompt used to hand the model
// and ask it to apply itself. Same "PRE-DETERMINED, copy exactly" pattern
// as Gate 0/1/5.
function evaluateGate4(metricsData) {
  const rp = metricsData?.rangePosition;
  if (rp === null || rp === undefined) {
    return { status: "GREEN", note: "52-week range position unavailable — treating as no signal." };
  }
  if (rp > 70) {
    return { status: "RED", note: `${rp}% of 52-week range — Phase 3, priced for perfection. Wait for a post-catalyst flush; do not chase.` };
  }
  if (rp > 30) {
    return { status: "YELLOW", note: `${rp}% of 52-week range — Phase 2, acceleration. Half size, enter on pullbacks only.` };
  }
  return { status: "GREEN", note: `${rp}% of 52-week range — Phase 1, discovery. Full size entry appropriate.` };
}

const MAX_NEWS_AGE_HOURS = 300; // 14 days / last business week

// A per-ticker news feed can legitimately include a broad market-wide
// "top gainers and losers" / sector-roundup article tagged against every
// large constituent of an index the ticker belongs to -- technically "in
// AAPL's feed" because Apple gets a passing mention, not actually a story
// about Apple. Confirmed live (Aug 27, 2026, Agitator Gauge bare-name
// search): reported as "not getting related news at all" even though a
// real article was returned. Used to PREFER a relevant candidate out of
// several, never to hide news entirely -- every call site still falls
// back to the plain most-recent article when nothing scores as relevant,
// so this can only improve or neutrally match prior behavior.
function isHeadlineRelevant(headline, symbol, companyName) {
  if (!headline) return false;
  const h = String(headline).toLowerCase();
  if (symbol && new RegExp("\\b" + symbol.toLowerCase() + "\\b").test(h)) return true;
  if (!companyName) return false;
  const core = String(companyName)
    .replace(/\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|the|holdings?|group|class\s+[a-z])\b\.?/gi, "")
    .replace(/[.,]/g, "")
    .trim()
    .split(/\s+/)[0];
  if (!core || core.length < 3) return false;
  return new RegExp("\\b" + core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(h);
}

async function fetchFinnhubNews(symbol, companyName) {
  try {
    const now    = new Date();
    const cutoff = new Date(now.getTime() - MAX_NEWS_AGE_HOURS * 3600000);
    const from   = cutoff.toISOString().split("T")[0];
    const to     = now.toISOString().split("T")[0];
    const data   = await finnhubGet(`/company-news?symbol=${symbol}&from=${from}&to=${to}`);
    if (!Array.isArray(data) || !data.length) return null;
    const filtered = data
      .filter(i => (now - new Date(i.datetime * 1000)) / 3600000 <= MAX_NEWS_AGE_HOURS)
      .sort((a, b) => b.datetime - a.datetime);
    if (!filtered.length) return null;
    const item = (companyName ? filtered.find(i => isHeadlineRelevant(i.headline, symbol, companyName)) : null) || filtered[0];
    const ageHrs = Math.round((now - new Date(item.datetime * 1000)) / 3600000);
    return {
      headline: item.headline,
      url:      item.url,
      source:   item.source,
      ageLabel: ageHrs < 1 ? "just now"
        : ageHrs < 24 ? `${ageHrs}h ago`
        : `${Math.floor(ageHrs / 24)}d ago`,
      ageHours: ageHrs,
    };
  } catch(e) { return null; }
}

// Second news source, Alpaca's /v1beta1/news (Benzinga-sourced, same
// account/throttle as every other Alpaca call here via alpacaGet()).
// Queried alongside Finnhub every time, not only as an empty-result
// fallback -- confirmed live (Aug 4, 2026, BB) that Finnhub can return a
// real, non-empty article that's simply older than a materially newer
// story it doesn't have at all, so "Finnhub returned something" isn't
// sufficient on its own to call the coverage current.
//
// UNVERIFIED AGAINST LIVE ALPACA NEWS ENTITLEMENT -- written from Alpaca's
// documented v1beta1/news response shape (id, headline, summary, url,
// source, created_at, symbols); Alpaca's free plan is documented to
// include News API access at the same 200/min as market data, but there's
// no way to confirm the exact field names/behavior against a real account
// from this sandbox. Fails safe (null) on any error including a 403 if the
// account genuinely lacks the entitlement -- confirm after deploy that a
// real symbol returns a real headline, not just silent nulls.
async function fetchAlpacaNews(symbol, companyName) {
  if (!alpacaKeys()) return null;
  try {
    const now    = new Date();
    const cutoff = new Date(now.getTime() - MAX_NEWS_AGE_HOURS * 3600000);
    const data   = await alpacaGet(
      `/v1beta1/news?symbols=${symbol}&start=${cutoff.toISOString()}&end=${now.toISOString()}&limit=10&sort=desc`
    );
    const articles = data?.news;
    if (!Array.isArray(articles) || !articles.length) return null;
    // sort=desc -> most recent first; prefer a relevant one among the
    // fetched batch (see isHeadlineRelevant), same fallback posture as
    // fetchFinnhubNews.
    const item = (companyName ? articles.find(a => isHeadlineRelevant(a.headline, symbol, companyName)) : null) || articles[0];
    const itemTime = new Date(item.created_at);
    const ageHrs   = Math.round((now - itemTime) / 3600000);
    if (!(ageHrs <= MAX_NEWS_AGE_HOURS)) return null; // guards against a bad/missing created_at too (NaN comparisons are always false)
    return {
      headline: item.headline,
      url:      item.url,
      source:   item.source || "Benzinga",
      ageLabel: ageHrs < 1 ? "just now"
        : ageHrs < 24 ? `${ageHrs}h ago`
        : `${Math.floor(ageHrs / 24)}d ago`,
      ageHours: ageHrs,
    };
  } catch(e) {
    console.error(`fetchAlpacaNews ${symbol}:`, e.message);
    return null;
  }
}

// Queries both sources concurrently and returns whichever headline is
// actually more recent, rather than only falling back to Alpaca when
// Finnhub comes back completely empty (see fetchAlpacaNews's comment for
// why that distinction mattered in practice).
async function fetchNews(symbol, companyName) {
  const [fh, al] = await Promise.allSettled([
    fetchFinnhubNews(symbol, companyName),
    fetchAlpacaNews(symbol, companyName),
  ]);
  const finnhub = fh.status === "fulfilled" ? fh.value : null;
  const alpaca  = al.status === "fulfilled" ? al.value : null;
  if (!finnhub) return alpaca;
  if (!alpaca) return finnhub;
  return alpaca.ageHours <= finnhub.ageHours ? alpaca : finnhub;
}

// ─── PROPOSAL 4 — CONTEXT-WEIGHTED GATE 2 CORROBORATION (Aug 13, 2026) ────
// Session Context (the free-text textarea every tier already sends as
// marketContext) previously had zero backend awareness at all -- purely a
// client-side keyword-highlight cosmetic (shared/context-highlight.js).
// Both functions below are only ever called when the user actually typed
// something into it (see the /analyze corroboration block), so they add
// zero extra Alpaca/Finnhub call volume on the common case of an analysis
// run with Session Context left blank -- same "lazy, cost only on real use"
// posture as the SEC CIK fallback tiers.

function stripHtmlForCorroboration(s) {
  return String(s || "").replace(/<[^>]*>/g, " ");
}

// Full-body article text for the news-content-match corroboration source --
// fetchNews()/newsData above only ever carries a headline, too short for a
// reliable 2-distinct-word overlap match. Queries both sources directly
// (not the newsData already on the request, which is headline-only) and
// pools every recent article's text rather than just the single newest one,
// since the corroborating article need not be the most recent headline.
// UNVERIFIED AGAINST LIVE ALPACA ENTITLEMENT for the `content` field
// specifically -- same posture as fetchAlpacaNews above; falls back to
// `summary`/headline on any shape mismatch, never throws.
async function fetchNewsBodiesForCorroboration(symbol) {
  const now    = new Date();
  const cutoff = new Date(now.getTime() - MAX_NEWS_AGE_HOURS * 3600000);
  const bodies = [];
  try {
    if (alpacaKeys()) {
      const data = await alpacaGet(
        `/v1beta1/news?symbols=${symbol}&start=${cutoff.toISOString()}&end=${now.toISOString()}&limit=10&sort=desc`
      );
      const articles = Array.isArray(data?.news) ? data.news : [];
      articles.forEach(a => {
        const text = stripHtmlForCorroboration(a.content || a.summary || a.headline || "");
        if (text.trim()) bodies.push(text);
      });
    }
  } catch (e) { console.error(`fetchNewsBodiesForCorroboration alpaca ${symbol}:`, e.message); }
  try {
    const from = cutoff.toISOString().split("T")[0];
    const to   = now.toISOString().split("T")[0];
    const data = await finnhubGet(`/company-news?symbol=${symbol}&from=${from}&to=${to}`);
    if (Array.isArray(data)) {
      data.forEach(a => {
        const text = stripHtmlForCorroboration(a.summary || a.headline || "");
        if (text.trim()) bodies.push(text);
      });
    }
  } catch (e) { console.error(`fetchNewsBodiesForCorroboration finnhub ${symbol}:`, e.message); }
  return bodies;
}

// Corroboration source 3: a real dated calendar event. Silent/boolean only
// -- true if the ticker has an earnings date within a window around today,
// false if the call succeeds with none, null on any fetch error (treated as
// "not corroborated" by corroborateSessionContext, never as a false
// positive). Routed through finnhubGet()/finnhubThrottle() like every other
// Finnhub call in this file.
// ─── PROPOSAL 6 — AGGRESSION DIAL (Aug 26, 2026) ──────────────────────
// The Notion log's own "dial-proof gates" list named a "hard pre-earnings
// exit rule" as already-existing, fixed-at-all-5-positions infrastructure
// -- grepped both repos before building anything and confirmed no such
// rule exists anywhere in this app. This is that rule, built as the real
// prerequisite it actually is, not a pointer to existing code.
//
// Deliberately its own function, not a reuse of fetchEarningsCalendarFlag()
// above: that one's -3/+14 day window is tuned for Session Context
// corroboration ("is there an earnings date anywhere near this claim"),
// not "is a real entry about to walk into an earnings print" -- a
// forward-only, tight window is what an exit rule actually needs.
async function checkUpcomingEarnings(symbol) {
  try {
    const now  = new Date();
    const from = now.toISOString().split("T")[0];
    const to   = new Date(now.getTime() + 2 * 86400000).toISOString().split("T")[0];
    const data = await finnhubGet(`/calendar/earnings?symbol=${symbol}&from=${from}&to=${to}`);
    const items = data?.earningsCalendar;
    if (!Array.isArray(items) || !items.length) return null;
    return items[0]?.date || true;
  } catch (e) {
    console.error(`checkUpcomingEarnings ${symbol}:`, e.message);
    return null; // fail-safe: a Finnhub error never blocks an entry on its own
  }
}

// Dial position metadata. Only sizingCeiling is actually enforced --
// monitoringCadence/entryGuidance/stopGuidance/recheckInterval are
// informational display text the Pro UI shows independently (this app
// has no stop-order tracking, no per-ticker scheduling/notifications, and
// no gamma-exposure computation anywhere, so those can't be real,
// server-enforced mechanics yet -- disclosed here rather than faked).
// Per direct instruction: ceiling-only, never a floor -- Position-Lean/
// Position/Long's "larger position size" is portfolio-construction
// guidance (shown as text), not a mandate to inflate a verdict's real,
// gate-earned sizing. NEUTRAL is a guaranteed no-op, matching "= current
// CRF behavior unchanged."
const SIZING_ORDER = ["NONE", "QUARTER", "HALF", "FULL"];
const DIAL_POSITIONS = {
  ACTIVE_SWING:  { sizingCeiling: "HALF" },
  ACTIVE_LEAN:   { sizingCeiling: "FULL" },
  NEUTRAL:       { sizingCeiling: "FULL" },
  POSITION_LEAN: { sizingCeiling: "FULL" },
  POSITION_LONG: { sizingCeiling: "FULL" },
};
// Phase 1.5 (Aug 26 2026) -- Starter's own restricted Dial range, per the
// Notion plan's original "Narrow" (Starter) vs "Medium" (Pro) framing,
// confirmed via AskUserQuestion rather than shipped as parity-with-Pro.
// Keyed by tierConfig.dialRange ("full" for Pro, "narrow" for Starter);
// an unset/unrecognized range falls back to "full" -- harmless for any
// tier where tierConfig.dial is itself false. This is enforcement, not
// just a UI restriction: the client only ever offers the buttons for its
// own tier's range, but a stale/tampered dialPosition value from any
// tier still gets silently rejected back to NEUTRAL here, same fail-safe
// posture as every other dial validation in this function.
const DIAL_RANGES = {
  full:   ["ACTIVE_SWING", "ACTIVE_LEAN", "NEUTRAL", "POSITION_LEAN", "POSITION_LONG"],
  narrow: ["ACTIVE_LEAN", "NEUTRAL", "POSITION_LEAN"],
};
function applySizingCeiling(sizing, dialPosition) {
  const ceiling = DIAL_POSITIONS[dialPosition]?.sizingCeiling || "FULL";
  const cur = SIZING_ORDER.indexOf(sizing);
  const cap = SIZING_ORDER.indexOf(ceiling);
  if (cur === -1 || cap === -1 || cur <= cap) return sizing;
  return ceiling;
}

async function fetchEarningsCalendarFlag(symbol) {
  try {
    const now  = new Date();
    const from = new Date(now.getTime() - 3 * 86400000).toISOString().split("T")[0];
    const to   = new Date(now.getTime() + 14 * 86400000).toISOString().split("T")[0];
    const data = await finnhubGet(`/calendar/earnings?symbol=${symbol}&from=${from}&to=${to}`);
    const items = data?.earningsCalendar;
    return Array.isArray(items) && items.length > 0;
  } catch (e) {
    console.error(`fetchEarningsCalendarFlag ${symbol}:`, e.message);
    return null;
  }
}

// Finnhub's /search matches against a company's registered legal name
// (e.g. "ALPHABET INC-CL A"), not the consumer brand name it trades
// under in everyday speech -- so a plain-text search for "Google" or
// "Facebook" finds nothing at all, since neither word appears anywhere
// in "Alphabet Inc"/"Meta Platforms Inc". Confirmed live (Aug 27, 2026):
// the Agitator Gauge reported "Couldn't find a company for 'Google'"
// even though GOOGL/GOOG obviously exist -- same bug class as the DRAM
// SEC-CIK gap documented elsewhere in this file, fixed the same way: a
// small, hand-confirmed override, checked first, guaranteed correct
// regardless of whatever Finnhub's own fuzzy search actually does with
// the term. Deliberately narrow -- only the reported case plus the
// other universally-known instance of this exact bug class, not a
// speculative general brand-name database.
const KNOWN_BRAND_TICKER_OVERRIDES = {
  google: "GOOGL",
  alphabet: "GOOGL",
  youtube: "GOOGL",
  facebook: "META",
  instagram: "META",
  whatsapp: "META",
};

// Company-name -> ticker resolution for Import's free-text entry (Aug
// 2026). Only ever called for an Import entry that already failed the
// plain-ticker regex client-side (shared/watchlist.ts's parseTickers) --
// typing a real ticker directly never round-trips through this at all.
// Also the shared resolver behind the Agitator Gauge's own free-text
// query. Routed through the same finnhubGet()/finnhubThrottle() queue as
// every other Finnhub call in this file. Results (including misses) are
// cached in symbolSearchCache above so a popular name isn't re-searched
// on every Import/Agitator lookup across every user.
async function searchSymbolByName(query) {
  const key = query.trim().toLowerCase();
  if (!key) return null;
  if (KNOWN_BRAND_TICKER_OVERRIDES[key]) return KNOWN_BRAND_TICKER_OVERRIDES[key];
  const cached = symbolSearchCache.get(key);
  if (cached && Date.now() - cached.time < SYMBOL_SEARCH_MAX_AGE_MS) return cached.symbol;
  let symbol = null;
  try {
    const data = await finnhubGet(`/search?q=${encodeURIComponent(query)}`);
    const hits = Array.isArray(data?.result) ? data.result : [];
    // Finnhub's search already ranks by relevance -- just take the first
    // hit that's a plain, bare US-listed symbol (no exchange suffix like
    // ".DE"/".MX", matching the same 1-5 letter shape shared/watchlist.ts's
    // own ticker regex expects) and an actual tradable security type, not
    // a warrant/index/mutual-fund-class row a bare name search can also
    // surface.
    const hit = hits.find(h => typeof h.symbol === "string" && /^[A-Z]{1,5}$/.test(h.symbol)
      && (h.type === "Common Stock" || h.type === "ETP"));
    if (hit) symbol = hit.symbol;
  } catch (e) {
    console.error(`searchSymbolByName "${query}":`, e.message);
  }
  symbolSearchCache.set(key, { symbol, time: Date.now() });
  return symbol;
}

// ─── PROPOSAL 5 — AGITATOR GAUGE (Aug 26, 2026) ───────────────────────
// Standalone discovery/validation tool -- proofing a new stock interest or
// a media rumor BEFORE it enters the watchlist. Sits alongside the CRF,
// not inside it: no gate-layer conflict, no change to Pre-Gate/Gate 2.
// Scored out of 6 factors, not the 7 the Notion log named -- Historical
// Reaction is deliberately omitted, same reason gx.buildupPatternCheck()
// already omits its own earnings-reaction sub-signal: no per-ticker
// headline/earnings-reaction history exists anywhere in this app, and
// faking one would be worse than disclosing the gap.
//
// Hybrid scoring per direct instruction: deterministic where real data
// already exists (Liquidity Sensitivity from fetchTickerFundamentals's
// marketCap/avgVol20d, Options/IV Environment from the existing
// fetchImpliedVolatility()), one lightweight AI call for the 4 factors
// that are genuinely judgment calls (Surprise/Uncertainty/Positioning/
// Cross-Asset Exposure) -- not a full 7-factor AI guess.

const AGITATOR_PROMPT = `You are scoring a single news headline's likely
market-moving impact on ONE stock, across exactly 4 factors. Score each
0-100 (100 = maximum). Return ONLY this exact JSON shape, no other text,
no markdown fences:
{"surprise":N,"uncertainty":N,"positioning":N,"crossAsset":N}
- surprise: how unexpected this is given the company's normal trajectory
- uncertainty: how much the market doesn't yet know how to price this
- positioning: how fresh/unpriced this catalyst still is (100 = fresh and unpriced, 0 = fully priced in already)
- crossAsset: how much this could ripple into the ticker's sector proxy, correlated names, or crypto/macro`;

// First-draft heuristic, explicitly not yet tuned against real outcomes --
// same "needs review, tune against real data" posture this file already
// uses for Pre-Gate's own trigger-keyword table when it first shipped.
// Smaller market cap / thinner volume = a given dollar of buying/selling
// moves the price more, i.e. higher liquidity sensitivity.
function computeLiquiditySensitivity(fundamentals) {
  if (!fundamentals || (fundamentals.marketCap == null && fundamentals.avgVol20d == null)) return null;
  let score = 50;
  if (fundamentals.marketCap != null) {
    if (fundamentals.marketCap < 2e9) score += 25;
    else if (fundamentals.marketCap > 10e9) score -= 25;
  }
  if (fundamentals.avgVol20d != null) {
    if (fundamentals.avgVol20d < 1e6) score += 15;
    else if (fundamentals.avgVol20d > 10e6) score -= 15;
  }
  return Math.max(0, Math.min(100, score));
}

// A representative IV reading (a %, typically 15-150+ for equities) mapped
// directly onto the same 0-100 scale the other factors use -- clamped, not
// rescaled, since IV past 100% already represents extreme expected
// movement and shouldn't need to be compressed to fit.
function ivToAgitatorScore(iv) {
  if (typeof iv !== "number") return null;
  return Math.max(0, Math.min(100, Math.round(iv)));
}

async function scoreAgitatorFactors(symbol, headline) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !headline) return null;
  try {
    const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 150, temperature: 0,
        system: AGITATOR_PROMPT,
        messages: [{ role: "user", content: `Ticker: ${symbol}\nHeadline: "${headline}"` }],
      }),
    }, 20000);
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    const match = text.match(/\{[^}]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const clamp = v => (typeof v === "number" && v >= 0 && v <= 100) ? Math.round(v) : null;
    return {
      surprise:    clamp(parsed.surprise),
      uncertainty: clamp(parsed.uncertainty),
      positioning: clamp(parsed.positioning),
      crossAsset:  clamp(parsed.crossAsset),
    };
  } catch (e) {
    console.error(`scoreAgitatorFactors ${symbol}:`, e.message);
    return null;
  }
}

// Averages whatever subset of the 6 factors actually resolved (a headline-
// less lookup still gets Liquidity/IV; a call with no Alpaca IV entitlement
// still gets the 4 AI factors) -- never blocks on a factor that's missing,
// same fail-safe posture as gx.buildupPatternCheck()'s own "usable >= 2".
function computeAgitatorComposite(factors) {
  const vals = Object.values(factors).filter(v => typeof v === "number");
  if (!vals.length) return null;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return {
    score: Math.round(avg),
    level: avg >= 66 ? "HIGH" : avg >= 34 ? "MEDIUM" : "LOW",
    factorCount: vals.length,
  };
}

// "Comps" -- reworked Aug 26, 2026 (same day) after direct feedback that
// the original approach (rank the Gate 5 candidate-proxy basket --
// SPY/QQQ/TSM/GLD/etc. -- by correlation) wasn't "related companies" at
// all, just the same macro/sector ETF list this app already uses
// everywhere else for Gate 5, dumped as a list of up to 8. Real fix:
// Finnhub's own /stock/peers endpoint (free-tier, returns genuine
// same-industry competitor tickers for a symbol) -- an actual "related
// companies" answer instead of a repurposed proxy basket. Cached
// alongside the existing symbol-search cache pattern since a company's
// peer set doesn't change day to day.
const peersCache = new Map(); // symbol -> { peers, time }
const PEERS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
async function fetchTickerPeers(symbol) {
  const cached = peersCache.get(symbol);
  if (cached && Date.now() - cached.time < PEERS_MAX_AGE_MS) return cached.peers;
  let peers = [];
  try {
    const data = await finnhubGet(`/stock/peers?symbol=${symbol}`);
    peers = Array.isArray(data) ? data.filter(s => typeof s === "string" && /^[A-Z]{1,5}$/.test(s) && s !== symbol) : [];
  } catch (e) {
    console.error(`fetchTickerPeers ${symbol}:`, e.message);
  }
  peersCache.set(symbol, { peers, time: Date.now() });
  return peers;
}

// A short, genuinely useful list -- "a few related companies as a
// positive recommendation," not an exhaustive correlation dump. Each
// comp carries a real live price/% change (fetchQuote, already used for
// the primary symbol) rather than a correlation float -- a tangible,
// at-a-glance read instead of an abstract number next to an unrelated
// macro ticker. Flat limit for every tier now that this is a real,
// curated peer list rather than a repurposed proxy basket -- the old
// isFull-scaled 3-vs-8 split existed to ration a bigger data dump, which
// no longer applies once the list itself is short by design.
const AGITATOR_COMPS_LIMIT = 3;
// mentionedSymbols: other real, resolvable companies already named in the
// user's own typed input (e.g. "Salesforce, Crowdstrike, Okta surge" ->
// CRWD/OKTA alongside primary CRM) -- when present, these are what the user
// actually asked about, so they take priority over a generic same-industry
// guess from Finnhub's peer list, which can surface something genuinely
// unrelated to the story being checked (confirmed live: APP/AppLovin as a
// "related" company for a Salesforce enterprise-SaaS earnings beat).
// A resolved-but-untradeable/junk symbol -- fetchQuote failed entirely, or
// came back at $0.00 -- is strictly worse than showing nothing: it looks
// like a real recommendation with no way for the user to sanity-check it.
// Confirmed live: a Title-Case headline's common capitalized words
// ("World", "Share", "One", ...) fuzzy-matched Finnhub's company-name
// search into unrelated, effectively-worthless tickers (GDVM, PRDL) shown
// as "related companies" for an Apple headline. Validated against the
// real thing that matters -- does it have a real, live, positive price --
// rather than trying to out-guess which capitalized words are "real"
// company names with more stopwords (the same lesson already learned
// from the "Nvidia earnings beat" resolution bug). Pulls a slightly wider
// candidate pool than the display limit so filtering bad ones out still
// leaves room to reach a full list.
const AGITATOR_COMPS_CANDIDATE_POOL = 6;
async function computeAgitatorComps(symbol, mentionedSymbols) {
  const candidatePeers = (mentionedSymbols && mentionedSymbols.length)
    ? mentionedSymbols.slice(0, AGITATOR_COMPS_CANDIDATE_POOL)
    : (await fetchTickerPeers(symbol)).slice(0, AGITATOR_COMPS_CANDIDATE_POOL);
  const quotes = await Promise.all(candidatePeers.map(sym => fetchQuote(sym)));
  const valid = [];
  candidatePeers.forEach((sym, i) => {
    const q = quotes[i];
    const price = q ? parseFloat(q.price) : 0;
    if (q && price > 0) valid.push({ symbol: sym, price: q.price, change: q.change, direction: q.direction });
  });
  const finalComps = valid.slice(0, AGITATOR_COMPS_LIMIT);
  // Each related company gets the same real, relevance-filtered news
  // fetch as the primary ticker -- "with news links all the same" per
  // direct instruction, not a lesser/different treatment. Bounded to the
  // final (already-validated, capped) comp list, not the wider candidate
  // pool, and fetchTickerFundamentals is 24h-cached, so repeat comps
  // across different searches are usually free.
  await Promise.all(finalComps.map(async (c) => {
    const fund = await fetchTickerFundamentals(c.symbol);
    const name = fund?.sectorInfo?.name || null;
    const news = await fetchNews(c.symbol, name).catch(() => null);
    c.news = news ? { headline: news.headline, url: news.url, ageHours: news.ageHours } : null;
  }));
  return finalComps;
}

// Real operational-cost safeguard, not part of the original Notion scope:
// this endpoint is free (no credit deduction, per direct instruction --
// it's a discovery tool meant to be used before a ticker even enters the
// watchlist, so a credit gate would work against its own purpose), but a
// headline-bearing call still makes a real, uncosted-to-the-user Anthropic
// call. A plain in-memory per-userKey rate limit keeps that from becoming
// an open-ended cost, the same spirit as finnhubThrottle/alpacaThrottle
// protecting this app's other unmetered paths.
const agitatorRateLimit = new Map(); // userKey -> { count, windowStart }
const AGITATOR_RATE_LIMIT_MAX = 20;
const AGITATOR_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
function checkAgitatorRateLimit(userKey) {
  const now = Date.now();
  const entry = agitatorRateLimit.get(userKey);
  if (!entry || now - entry.windowStart > AGITATOR_RATE_LIMIT_WINDOW_MS) {
    agitatorRateLimit.set(userKey, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= AGITATOR_RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// parsePctString / CONFIDENCE_NEGLIGIBLE_MOVE_PCT / priceConfirmedConfidence /
// normalizeMarketReading / evaluateProxyStatus (Gate 5's forceDown status
// check -- see the Aug 13, 2026 CLAUDE.md incident writeup) all moved to
// analyze-helpers.js (Aug 16, 2026, Phase 4 of the TypeScript adoption
// plan) -- pure, side-effect-free logic, extracted so it's requirable and
// unit-testable in isolation (server.js itself can't be required for tests
// without also starting a real Express server). Pure code motion, same
// names/bodies/behavior, called below via the `ah.` namespace.

// ─── GATE 5 — DYNAMIC PROXY RESOLUTION (Patch 2, Aug 1 2026) ───────
// classifyTicker()/PROXY_RULES above are already Steps 1-2 of the Dynamic
// Proxy Resolution Algorithm (GICS sector + keyword/ticker classification).
// When those are ambiguous (DEFAULT_PROXY), this runs Steps 3-4: a 90-day+
// daily-return correlation fallback against a candidate basket, then (if no
// candidate clears the correlation floor) the fundamentals feedback loop —
// both already implemented in gates-extended.js's resolveFixedProxyBreak(),
// written for the "a fixed proxy broke" case (Proposal 3) but identical math
// for this case (Steps 3-4 are the same cascade either way).
//
// Candidate basket = the same sector ETFs /market already tracks, so a
// dynamically-adopted primary/secondary proxy can be checked against fresh
// sectorContext data in /analyze with no extra fetch there.
const GATE5_CANDIDATE_SYMBOLS = ["SPY","QQQ","IWM","XBI","SOXX","TSM","MSFT","GLD","USO"];
const GATE5_RECOMPUTE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // Step 5: quarterly

// Step 5/6 persistence — see proxy_resolution table (Supabase DDL handed off
// separately). Gracefully no-ops (always recompute, never cache) if Supabase
// isn't configured or the table doesn't exist yet.
async function getCachedProxyResolution(symbol) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("proxy_resolution")
      .select("*")
      .eq("ticker", symbol)
      .maybeSingle();
    if (error || !data) return null;
    const ageMs = Date.now() - new Date(data.computed_at).getTime();
    if (ageMs > GATE5_RECOMPUTE_MAX_AGE_MS) return null;
    return data;
  } catch (e) {
    console.error(`getCachedProxyResolution ${symbol}:`, e.message);
    return null;
  }
}

async function saveProxyResolution(symbol, resolved, trigger) {
  if (!supabase) return;
  try {
    await supabase.from("proxy_resolution").upsert({
      ticker:        symbol,
      tier:          resolved.tier,
      proxy_symbol:  resolved.proxy || null,
      correlation_r: resolved.r ?? null,
      computed_at:   new Date().toISOString(),
      trigger:       trigger || "quarterly",
    }, { onConflict: "ticker" });
  } catch (e) {
    console.error(`saveProxyResolution ${symbol}:`, e.message);
  }
}

// ─── PROPOSAL 7 — VERDICT ACCURACY SCORECARD (Aug 26, 2026) ───────────
// One row per /analyze response, written just before the response is
// sent. Never blocks/rejects the request -- same fail-safe posture as
// every other Supabase write in this file. grade/actual_return_pct/
// graded_at stay null until the grading job (below) fills them in once
// grade_due_at has passed.
async function logVerdict(fields) {
  if (!supabase) return;
  try {
    const issuedAt = new Date();
    const dueAt = addTradingDays(issuedAt, fields.gradingWindowDays);
    await supabase.from("verdict_log").insert({
      ticker:                    fields.ticker,
      issued_at:                 issuedAt.toISOString(),
      issued_price:              fields.issuedPrice ?? null,
      verdict:                   fields.verdict,
      size_action:               fields.sizeAction || null,
      crf_version:               CRF_VERSION,
      pre_gate_state:            fields.preGateState || null,
      gate1_branch:              fields.gate1Branch || null,
      gate0_read:                fields.gate0Read || null,
      gate2_corroboration_state: fields.gate2CorroborationState || null,
      dial_position:             fields.dialPosition || null,
      grading_window_days:       fields.gradingWindowDays,
      grade_due_at:              dueAt.toISOString(),
      user_email:                fields.userEmail || null,
      tier:                      fields.tier,
    });
  } catch (e) {
    console.error(`logVerdict ${fields.ticker}:`, e.message);
  }
}

// Only logs actual hits (one row per source that matched), matching
// corroboration_log's "timestamp per source hit" design -- a miss isn't a
// row. Label mapping matches gx.corroborateSessionContext()'s own
// matchedLabels keys so this can never drift from what CONTEXT-
// CORROBORATED actually counted.
const CORROBORATION_SOURCE_MAP = {
  news_content_match:    "news_match",
  gate3_buildup_pattern:  "gate3_buildup",
  earnings_calendar_event: "earnings_calendar",
};
async function logCorroborationHits(ticker, corroboration) {
  if (!supabase || !corroboration) return;
  const rows = (corroboration.matchedLabels || [])
    .map(label => CORROBORATION_SOURCE_MAP[label])
    .filter(Boolean)
    .map(source => ({ ticker, source }));
  if (!rows.length) return;
  try {
    await supabase.from("corroboration_log").insert(rows);
  } catch (e) {
    console.error(`logCorroborationHits ${ticker}:`, e.message);
  }
}

// Proposal 7's own zone definitions (0.75% flat band + 1.75-pt margin band
// each side = 2.5% confirm threshold, no gap/overlap). The TRUE/MARGINAL/
// FALSE mapping per verdict direction below is this session's own
// interpretation, NOT copied from a "full grading matrix" -- the Notion
// log only carried the R-zone boundaries, referencing a matrix from chat
// that wasn't in the log itself. Reasoning: UP/DOWN get TRUE only on a
// same-direction Strong move, MARGINAL on a same-direction Weak move,
// FALSE on flat or wrong-direction; FLAT gets TRUE on a real flat
// outcome, MARGINAL on either Weak band (close to flat), FALSE on either
// Strong band (a real move happened despite the flat call). Flag to Mr. T
// to confirm this matches what was actually worked out in chat.
function classifyVerdictReturn(verdict, r) {
  let zone;
  if (r >= 2.5) zone = "STRONG_UP";
  else if (r > 0.75) zone = "WEAK_UP";
  else if (r >= -0.75) zone = "FLAT";
  else if (r > -2.5) zone = "WEAK_DOWN";
  else zone = "STRONG_DOWN";

  if (verdict === "UP") {
    if (zone === "STRONG_UP") return "TRUE";
    if (zone === "WEAK_UP") return "MARGINAL";
    return "FALSE";
  }
  if (verdict === "DOWN") {
    if (zone === "STRONG_DOWN") return "TRUE";
    if (zone === "WEAK_DOWN") return "MARGINAL";
    return "FALSE";
  }
  // FLAT
  if (zone === "FLAT") return "TRUE";
  if (zone === "WEAK_UP" || zone === "WEAK_DOWN") return "MARGINAL";
  return "FALSE";
}

// Runs every 30 minutes, grades any verdict_log row whose grade_due_at has
// passed. Same "poll on an interval, no external cron infra" shape as the
// Market-Open Cache Warm below -- this app's only other recurring
// scheduled job, and (per Proposal 7's own plan) the "quarterly proxy
// recompute" this was originally supposed to match is actually a lazy
// on-request staleness check, not a real cron -- that pattern doesn't fit
// a sweep across every user's due rows, so this reuses the interval
// pattern instead. Batched (50 rows/tick) so a large backlog can't fire an
// unbounded burst of Finnhub calls in one tick -- fetchQuote() already
// rides the shared finnhubThrottle() queue regardless.
const GRADING_BATCH_SIZE = 50;
async function runVerdictGradingSweep() {
  if (!supabase) return;
  try {
    const nowIso = new Date().toISOString();
    const { data: due, error } = await supabase
      .from("verdict_log")
      .select("id, ticker, verdict, issued_price")
      .is("graded_at", null)
      .lte("grade_due_at", nowIso)
      .limit(GRADING_BATCH_SIZE);
    if (error) { console.error("runVerdictGradingSweep query:", error.message); return; }
    if (!due || !due.length) return;

    for (const row of due) {
      if (row.issued_price == null) {
        // No entry price captured (e.g. logged before this column existed,
        // or metricsData.price was missing) -- can't compute a real return.
        // Mark graded with no grade rather than re-querying it forever.
        await supabase.from("verdict_log").update({ graded_at: new Date().toISOString() }).eq("id", row.id);
        continue;
      }
      const quote = await fetchQuote(row.ticker);
      if (!quote) continue; // fail-safe: leave ungraded, retry next sweep
      const actualPrice = parseFloat(quote.price);
      const r = (actualPrice - row.issued_price) / row.issued_price * 100;
      const grade = classifyVerdictReturn(row.verdict, r);
      await supabase.from("verdict_log").update({
        actual_return_pct: r,
        grade,
        graded_at: new Date().toISOString(),
      }).eq("id", row.id);
    }
    console.log(`Verdict grading sweep: ${due.length} row(s) processed.`);
  } catch (e) {
    console.error("runVerdictGradingSweep:", e.message);
  }
}
setInterval(() => { runVerdictGradingSweep().catch(e => console.error("runVerdictGradingSweep:", e.message)); }, 30 * 60 * 1000);

// ─── PROPOSAL 3 — FIXED-PROXY REGIME VALIDATION (Aug 13, 2026) ────────
// gates-extended.js's regimeValidation()/resolveFixedProxyBreak() have
// existed since Patch 4 but were never wired up -- they need a place to
// persist state on a weekly cadence (lighter than Patch 2's quarterly
// dynamic-proxy recompute above, since this is a health check on the fixed
// Taiwan/Korea proxy assignment itself, not a full re-derivation). Same
// shape as proxy_resolution above: gracefully no-ops (always returns null,
// meaning "no regime signal, proceed normally" to hasForceDownAuthority) if
// Supabase isn't configured or the table doesn't exist yet.
const REGIME_RECOMPUTE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // weekly

async function getCachedRegimeState(symbol) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("proxy_regime_state")
      .select("*")
      .eq("ticker", symbol)
      .maybeSingle();
    if (error || !data) return null;
    const ageMs = Date.now() - new Date(data.computed_at).getTime();
    if (ageMs > REGIME_RECOMPUTE_MAX_AGE_MS) return null;
    return data;
  } catch (e) {
    console.error(`getCachedRegimeState ${symbol}:`, e.message);
    return null;
  }
}

async function saveRegimeState(symbol, result) {
  if (!supabase) return;
  try {
    await supabase.from("proxy_regime_state").upsert({
      ticker:      symbol,
      state:       result.state,
      action:      result.action,
      rolling_r:   result.rolling ?? null,
      baseline_r:  result.baseline ?? null,
      computed_at: new Date().toISOString(),
    }, { onConflict: "ticker" });
  } catch (e) {
    console.error(`saveRegimeState ${symbol}:`, e.message);
  }
}

// Caller (refreshMarketEntry) only invokes this for tickers whose STATIC
// classification is the fixed Taiwan/Korea rule -- a dynamically-resolved
// proxy already gets re-validated on its own quarterly cadence
// (resolveGate5's GATE5_RECOMPUTE_MAX_AGE_MS above), so this doesn't apply
// there. tickerCloses is the ticker's own ascending daily closes (already
// fetched by refreshMarketEntry for Gate 1 -- reused here, no extra fetch);
// the proxy's own closes (TSM) are fetched fresh only on a cache miss, so
// this adds an Alpaca call at most once a week per gated ticker, never on
// every /ticker/:symbol refresh.
async function resolveProxyRegime(symbol, tickerCloses) {
  if (!tickerCloses) return null;

  const cached = await getCachedRegimeState(symbol);
  if (cached) {
    const checkedDate = new Date(cached.computed_at).toLocaleDateString("en-US",
      { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
    return {
      state: cached.state, action: cached.action,
      rolling: cached.rolling_r, baseline: cached.baseline_r,
      note: `Cached weekly regime check (${checkedDate}): ${cached.state}.`,
    };
  }

  const proxyCloses = await fetchDailyCloses("TSM", 130);
  if (!proxyCloses) return null;

  const result = gx.regimeValidation(tickerCloses, proxyCloses);
  if (result.state !== "UNKNOWN") await saveRegimeState(symbol, result);
  return result;
}

// Maps a resolveFixedProxyBreak()-shaped result (fresh or reconstructed from
// a cached row) into a proxyRule-compatible object: ah.evaluateProxyStatus() can
// consume it unchanged (reads rule.proxy.symbols/name/rationale), and /analyze
// reads the extra tier/forceDownAuthority/sizingOverride/etc fields directly
// off the same object once it round-trips back through req.body.
function buildDynamicProxyRule(resolved) {
  if (resolved.tier === "primary" || resolved.tier === "secondary") {
    return {
      category: "Dynamic",
      proxy: {
        name: `${resolved.proxy} (dynamically resolved${resolved.r != null ? `, r=${resolved.r.toFixed(2)}` : ""})`,
        symbols: [resolved.proxy],
        rationale: resolved.note,
      },
      tier: resolved.tier,
      forceDownAuthority: !!resolved.forceDownAuthority,
      dynamicallyResolved: true,
    };
  }
  // fundamentals-confirmed / fundamentals-speculative — no market-data proxy
  // symbols exist for these tiers; per spec they trade on Gate 0 alone, so we
  // reuse DEFAULT_PROXY's SPY+IWM broad-market symbols as the closest
  // equivalent to "Gate 0 only" and it can never independently force DOWN.
  const isSpeculative = resolved.tier === "fundamentals-speculative";
  return {
    ...DEFAULT_PROXY,
    proxy: { ...DEFAULT_PROXY.proxy, rationale: resolved.note },
    tier: resolved.tier,
    forceDownAuthority: false,
    dynamicallyResolved: true,
    sizingOverride: isSpeculative ? "QUARTER" : "NORMAL",
    autoExecuteStop: isSpeculative,
    elevatedCapCeiling: isSpeculative,
  };
}

// regime (optional 5th param, Proposal 3, Aug 13 2026): the caller's
// already-resolved weekly regime check for a fixed Taiwan/Korea ticker (null
// for every other ticker's classification). A BROKEN regime strips the
// static rule's authority to stay fixed -- falls through to the Dynamic
// Proxy Resolution Algorithm below exactly like a DEFAULT_PROXY ticker,
// instead of returning the static rule unconditionally. This is the
// "graduates into the dynamic system, triggered by breakdown instead of
// onboarding" fallback the proposal describes. Every other static category
// (Biotech/XBI, Defense/LMT, etc.) has no regime tracking at all -- Proposal
// 3 only ever validates the Taiwan/Korea rule -- so `regime` is always null
// for them and this is a no-op.
async function resolveGate5(symbol, metrics, tickerCloses, forceRecompute, regime) {
  const staticRule = classifyTicker(symbol, metrics?.sectorInfo);
  const regimeBroken = staticRule !== DEFAULT_PROXY && staticRule.category === "AI/Semiconductor" && regime?.state === "BROKEN";
  if (staticRule !== DEFAULT_PROXY && !regimeBroken) {
    return { ...staticRule, tier: "primary", forceDownAuthority: false, dynamicallyResolved: false };
  }

  if (!forceRecompute) {
    const cached = await getCachedProxyResolution(symbol);
    if (cached) {
      // Plain-English note, not raw cache internals — this reaches the UI
      // verbatim via proxyRule.proxy.rationale, and a bare ISO timestamp +
      // "r=0.928" correlation coefficient read as debug output to a user,
      // not an explanation. Same info, described instead of dumped.
      const checkedDate = new Date(cached.computed_at).toLocaleDateString("en-US",
        { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
      const coherencePct = cached.correlation_r != null
        ? `${Math.round(Number(cached.correlation_r) * 100)}% coherence` : null;
      return buildDynamicProxyRule({
        tier: cached.tier,
        proxy: cached.proxy_symbol,
        r: cached.correlation_r,
        note: `Proxy match confirmed via price correlation` +
          (coherencePct ? ` (${coherencePct})` : "") +
          `. Last checked ${checkedDate}.`,
      });
    }
  }

  if (!tickerCloses) {
    // No candle history to correlate — fall back to the static default,
    // same behavior as before Patch 2 existed.
    return { ...DEFAULT_PROXY, tier: "primary", forceDownAuthority: false, dynamicallyResolved: false };
  }

  const candidateEntries = await Promise.all(
    GATE5_CANDIDATE_SYMBOLS.map(async sym => [sym, await fetchDailyCloses(sym, 130)])
  );
  const candidateBasket = {};
  for (const [sym, closes] of candidateEntries) if (closes) candidateBasket[sym] = closes;

  const fundamentals = {
    yearsPublic: metrics?.yearsPublic,
    marketCap:   metrics?.marketCap,
    avgVol20d:   metrics?.avgVol20d,
    ivRank:      undefined, // Finnhub free tier doesn't provide IV — deliberate conservative bias, see gates-extended.js
  };

  const resolved = gx.resolveFixedProxyBreak(tickerCloses, candidateBasket, fundamentals);
  await saveProxyResolution(symbol, resolved, forceRecompute ? "pre_gate_hard_trigger" : "quarterly");
  return buildDynamicProxyRule(resolved);
}

async function generatePulse(marketData) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const msg = `
AI/Tech: QQQ ${marketData.qqq?.change||"?"}, SOXX ${marketData.soxx?.change||"?"}, NVDA ${marketData.nvda?.change||"?"}
Biotech: XBI ${marketData.xbi?.change||"?"}, IBB ${marketData.ibb?.change||"?"}
Commodities: GLD ${marketData.gld?.change||"?"}, USO ${marketData.uso?.change||"?"}
Crypto: BTC ${marketData.btc?.change||"?"}
Broad: SPY ${marketData.spy?.change||"?"}, IWM ${marketData.iwm?.change||"?"}
Write exactly 2 sentences: sector rotation summary for a swing trader.
`;
  try {
    const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 120,
        temperature: 0,
        system: PULSE_PROMPT,
        messages: [{ role: "user", content: msg }],
      }),
    }, 20000);
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch(e) { return null; }
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────
// ── USER STATUS ───────────────────────────────────────────────────
app.get("/status", async (req, res) => {
  const status = await credits.getUserStatus(req.userKey, req.userTier);
  res.json(status);
});

// Company-name -> ticker lookup, powering Import's free-text entry
// (shared/watchlist.ts's addTickers()). Free, no credit cost -- a plain
// data lookup like /ticker/:symbol, not an AI call like /analyze.
app.get("/lookup", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "q is required" });
  try {
    const symbol = await searchSymbolByName(q);
    res.json({ symbol });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PROPOSAL 5 — GET /agitator (Aug 26, 2026) ────────────────────────
// Free (no credit deduction) and Pro-gated for now (tierConfig.agitator),
// per the same Pro-first rollout as Proposal 7. "Full" (expanded comps +
// a second corroborating news source) reuses tierConfig.tracker -- already
// Pro/Shark-exclusive, same reuse-an-existing-flag reasoning as
// /scorecard's own breakdown gate, rather than a second new flag for the
// identical tier split.
// Reworked Aug 26, 2026 (same day) after direct feedback that two separate
// inputs ("ticker/company" + an optional headline box) wasn't what was
// asked for -- one box that "recognizes context from a company like a
// real search engine designed for the stock market." A short, name-shaped
// query (<=4 words, no sentence-ending punctuation) resolves exactly as
// before -- zero behavior change for the common "type AAPL"/"type Tesla"
// case. A longer, sentence-shaped query is treated as a pasted headline/
// rumor: still tried as a literal company-name search first (Finnhub's
// own fuzzy search occasionally still surfaces the right hit), and if
// that misses, this pulls out capitalized proper-noun-looking phrases
// from the text and tries each in turn -- the same searchSymbolByName()
// lookup, just fed better candidates than the raw sentence. Either way,
// the one thing typed becomes both the resolved symbol AND (for the
// headline-shaped path) the exact headline scored/displayed, since the
// user typed the real thing to check.
const CANDIDATE_STOPWORDS = new Set(["The","This","That","These","Those","A","An","Is","Are","Was","Were","Why","How","What","When","Where","Who","Will","Could","Should","Would","New","Real","Big","Not","And","But","For","With","After","Before","Amid","Says","Said","It","Its","There","Here"]);
function extractCompanyCandidates(text) {
  const words = String(text).split(/\s+/);
  const runs = [];
  let current = [];
  for (const w of words) {
    // Strip a possessive suffix ('s / ’s) BEFORE the shape test, so
    // "Nvidia's" -> "Nvidia" instead of failing the shape test outright
    // on the internal apostrophe and silently dropping the one word that
    // matters most in a real headline like "Nvidia's Real Story...".
    let clean = w.replace(/['’]s$/i, "");
    clean = clean.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
    if (clean && /^[A-Z][a-zA-Z]*$/.test(clean) && !CANDIDATE_STOPWORDS.has(clean)) {
      current.push(clean);
    } else {
      if (current.length) runs.push(current.join(" "));
      current = [];
    }
  }
  if (current.length) runs.push(current.join(" "));
  // Also add each run's own individual words as fallback candidates -- an
  // incidental adjacent capitalized token (a mid-sentence "Q3" cleaning to
  // "Q", a trailing "CEO") can merge into an otherwise-useful run (e.g.
  // "Tesla Q"), and the merged phrase may not resolve on its own even
  // though the real company name inside it would. Tried after every full
  // run, never instead of one.
  const candidates = [];
  for (const run of runs) {
    candidates.push(run);
    const parts = run.split(" ");
    if (parts.length > 1) candidates.push(...parts);
  }
  // Longest runs first -- "Roundhill Memory ETF" is a better candidate than
  // its own substring "Roundhill" alone -- then dedupe while preserving order.
  const seen = new Set();
  return candidates.sort((a, b) => b.split(" ").length - a.split(" ").length).filter(r => {
    const k = r.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

app.get("/agitator", async (req, res) => {
  if (!req.tierConfig?.agitator) {
    return res.status(403).json({ error: "Agitator Gauge not available on this tier yet" });
  }
  if (!checkAgitatorRateLimit(req.userKey)) {
    return res.status(429).json({ error: "Too many Agitator checks this hour — try again later." });
  }
  const raw = String(req.query.q || "").trim();
  if (!raw) return res.status(400).json({ error: "q is required" });
  // Legacy separate `headline` param still honored if a not-yet-updated
  // client sends it, but the single-box client below never does.
  let headlineOverride = req.query.headline ? String(req.query.headline).trim() : null;

  try {
    // No word-count/punctuation heuristic -- that version (same day)
    // mis-shipped: it gated candidate-extraction behind "looks long/
    // sentence-shaped," so a short-but-not-a-real-name phrase like
    // "Nvidia earnings beat" (3 words, no terminal punctuation) took the
    // bare-name path, searchSymbolByName() correctly failed to match the
    // literal 3-word string, and extraction never even ran -- reported
    // live as "Couldn't find a company." The real distinction that
    // matters isn't length, it's whether raw resolved AS TYPED: if it
    // did (a real ticker, or Finnhub's own fuzzy search matched the
    // literal string), there's no headline in what was typed, just a
    // name. If it didn't, extraction runs regardless of length, and
    // succeeding there is itself the proof the input was headline/
    // rumor-shaped -- that's what makes it the score-this-text case.
    let symbol = null;
    let directMatch = false;
    if (/^[A-Z]{1,6}$/.test(raw)) {
      symbol = raw;
      directMatch = true;
    } else {
      symbol = await searchSymbolByName(raw);
      if (symbol) directMatch = true;
      else {
        for (const candidate of extractCompanyCandidates(raw)) {
          symbol = await searchSymbolByName(candidate);
          if (symbol) break;
        }
      }
    }
    if (!symbol) return res.json({ resolved: false, query: raw });
    symbol = symbol.toUpperCase();
    if (!directMatch && !headlineOverride) headlineOverride = raw;

    // Scan the SAME candidate list for other real companies the user
    // already named alongside the primary one -- e.g. "Salesforce,
    // Crowdstrike, Okta surge" should surface CRWD/OKTA as the related
    // companies, not a generic industry-peer guess (confirmed live: APP/
    // AppLovin surfaced as a "related" company for a Salesforce earnings
    // beat, which makes no sense next to actual enterprise-SaaS peers the
    // user had just named). Cheap on the common single-company case:
    // extractCompanyCandidates is pure/no-network, and skipped entirely
    // when raw is already a bare ticker; every searchSymbolByName call
    // here is cache-backed, and several will already have run (success or
    // fail) during primary resolution above.
    // Not capped by how many are FOUND -- only by how many candidates get
    // SCANNED. computeAgitatorComps validates each one against a real live
    // quote before it's ever shown, so a resolved-but-junk candidate (a
    // common capitalized word from a Title-Case headline fuzzy-matching an
    // unrelated ticker) needs to not consume one of the display slots --
    // it needs a chance to be replaced by a later, real candidate instead.
    const mentionedSymbols = [];
    if (!/^[A-Z]{1,6}$/.test(raw)) {
      const MENTION_SCAN_CAP = 6;
      let scanned = 0;
      for (const candidate of extractCompanyCandidates(raw)) {
        if (scanned >= MENTION_SCAN_CAP) break;
        scanned++;
        const candSym = await searchSymbolByName(candidate);
        if (candSym && candSym.toUpperCase() !== symbol && !mentionedSymbols.includes(candSym.toUpperCase())) {
          mentionedSymbols.push(candSym.toUpperCase());
        }
      }
    }

    const isFull = !!req.tierConfig?.tracker;
    let fundamentals, quote, news;
    if (headlineOverride) {
      // No real news fetch needed here -- company-name relevance
      // filtering doesn't apply, keep the original fully-parallel fetch.
      [fundamentals, quote] = await Promise.all([fetchTickerFundamentals(symbol), fetchQuote(symbol)]);
      news = null;
    } else {
      // Fundamentals fetched first so the company's real name (Finnhub's
      // own profile2.name) is available to filter news for actual
      // relevance -- see isHeadlineRelevant()'s own comment. A per-ticker
      // news feed can legitimately return a broad market-wide roundup
      // article that only passingly mentions this company; reported live
      // as "not getting related news at all" even though a real article
      // came back. Costs a small amount of sequential latency only on a
      // cold fundamentals cache (24h TTL) -- acceptable for this free,
      // rate-limited discovery endpoint.
      fundamentals = await fetchTickerFundamentals(symbol);
      const companyName = fundamentals?.sectorInfo?.name || null;
      [quote, news] = await Promise.all([fetchQuote(symbol), fetchNews(symbol, companyName).catch(() => null)]);
    }
    const effectiveHeadline = headlineOverride || (news ? news.headline : null);
    const price = quote ? parseFloat(quote.price) : null;

    const [aiFactors, iv] = await Promise.all([
      effectiveHeadline ? scoreAgitatorFactors(symbol, effectiveHeadline) : null,
      req.tierConfig?.iv ? fetchImpliedVolatility(symbol, price) : null,
    ]);

    const liquidity = computeLiquiditySensitivity(fundamentals);
    const ivEnvironment = ivToAgitatorScore(iv);

    const factorsForComposite = {};
    if (aiFactors) Object.assign(factorsForComposite, aiFactors);
    if (liquidity != null) factorsForComposite.liquidity = liquidity;
    if (ivEnvironment != null) factorsForComposite.ivEnvironment = ivEnvironment;
    const composite = computeAgitatorComposite(factorsForComposite);

    const comps = await computeAgitatorComps(symbol, mentionedSymbols);

    res.json({
      resolved: true, symbol,
      // The resolved ticker's own real, live price move -- so a claimed
      // rally/catalyst can be checked directly against actual trading
      // instead of only an abstract AI-scored signal reading. `quote` was
      // already fetched above (its `price` field feeds the IV lookup);
      // this is the first time `change`/`direction` are surfaced.
      tickerQuote: quote ? { price: quote.price, change: quote.change, direction: quote.direction } : null,
      headlineUsed: effectiveHeadline,
      // Only a real, fetched article (not a user-pasted headline/rumor,
      // which has no source URL) is ever linkable.
      headlineUsedUrl: (!headlineOverride && news) ? news.url || null : null,
      // Phase 0 fix (Aug 26, 2026): the sub-factor breakdown is Pro's
      // "full dynamic gauge" per the Notion log's own tier table -- Starter
      // gets "Simple gauge (low/med/high)" only. This was missed in the
      // original pass (only comps-count/secondary-news were tier-gated);
      // caught before Starter's own flag ever flips on. Omitted entirely
      // (not just hidden client-side) so a non-full tier never receives
      // data it isn't meant to show.
      factors: isFull ? {
        surprise:    aiFactors?.surprise    ?? null,
        uncertainty: aiFactors?.uncertainty ?? null,
        positioning: aiFactors?.positioning ?? null,
        crossAsset:  aiFactors?.crossAsset  ?? null,
        liquidity, ivEnvironment,
        historicalReaction: null, // deliberately omitted -- no data source exists for this yet
      } : undefined,
      composite, comps,
    });
  } catch (e) {
    console.error(`GET /agitator "${raw}":`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── WATCHLIST SYNC (any authenticated account, any tier) ───────────
// Keyed by email so the SAME saved list follows a user through tier
// changes. Deliberately gated on req.userEmail presence, not req.userTier —
// a lapsed Starter/Pro/Shark subscriber still has req.userEmail (PATH 1
// Supabase-token auth above; only their *resolved* tier falls to "free"),
// so this is exactly how a lapsed user keeps their list instead of losing
// it. Anonymous free-tier visitors (PATH 2, tier-key auth) never get
// req.userEmail and 401 here — anonymous browsing stays localStorage-only,
// there's no account to key cloud storage to.
//
// Stores the FULL list untruncated — tier caps are enforced client-side per
// tier (shared/watchlist.js's maxTickers), same as everywhere else in this
// app. A lapsed Starter user with 7 saved tickers gets all 7 back from here;
// the free-tier frontend then displays only the first 3 (its own cap) but
// doesn't destroy the other 4 — they reappear if the user resubscribes.
app.get("/watchlist", async (req, res) => {
  if (!req.userEmail) return res.status(401).json({ error: "Sign in required" });
  if (!supabase) return res.json({ tickers: [] });
  try {
    // Normalized the same way as the write path below — see the comment
    // there for why this has to match exactly.
    const { data, error } = await supabase
      .from("watchlists")
      .select("tickers")
      .eq("email", req.userEmail.trim().toLowerCase())
      .maybeSingle();
    if (error) { console.error("GET /watchlist:", error.message); return res.json({ tickers: [] }); }
    const tickers = (data && data.tickers) || [];
    console.log(`GET /watchlist: ${req.userEmail.trim().toLowerCase()} -> row ${data ? "found" : "NOT FOUND"}, ${tickers.length} tickers`);
    res.json({ tickers });
  } catch(e) { console.error("GET /watchlist:", e.message); res.json({ tickers: [] }); }
});

app.post("/watchlist", async (req, res) => {
  if (!req.userEmail) return res.status(401).json({ error: "Sign in required" });
  const { tickers, seed } = req.body;
  if (!Array.isArray(tickers)) return res.status(400).json({ error: "tickers must be an array" });
  // Storage-abuse guard, not a tier-enforcement point — tiers already cap
  // client-side per their own maxTickers before this is ever called.
  const clean = tickers
    .filter(t => typeof t === "string" && /^[A-Z]{1,6}$/.test(t))
    .slice(0, 1000);
  if (!supabase) return res.json({ success: true, stored: false });
  // Normalize consistently with the GET lookup above so a case difference
  // between how Supabase Auth issued this session's email and how it was
  // stored on an earlier write can never make the two sides miss each other.
  const emailKey = req.userEmail.trim().toLowerCase();
  try {
    // supabase-js doesn't throw on a DB-level error (e.g. the watchlists
    // table not existing yet because the migration hasn't been run) — it
    // resolves with { error } instead, so this has to be checked explicitly
    // or a failed write would silently report success:true.
    //
    // `seed` marks the client's "nothing came back from GET, so push what's
    // local (tier defaults or pre-login state) instead of starting empty"
    // call (see shared/watchlist-sync.js). A GET miss there is ambiguous —
    // it can mean a genuinely new account, but it can just as easily mean a
    // transient read failure or a race against a write that's still in
    // flight, and the client can't tell those apart. `ignoreDuplicates`
    // turns this into an ON CONFLICT DO NOTHING: it seeds a truly-new row
    // but can never clobber a row that already exists, so a false-negative
    // GET can no longer destroy real saved data. A normal (non-seed) save —
    // the user actually adding/removing/reordering — still overwrites, same
    // as always.
    const { error } = await supabase.from("watchlists").upsert({
      email:      emailKey,
      tickers:    clean,
      updated_at: new Date().toISOString(),
    }, seed ? { onConflict: "email", ignoreDuplicates: true } : { onConflict: "email" });
    if (error) { console.error("POST /watchlist:", error.message); return res.status(500).json({ error: error.message, stored: false }); }
    console.log(`POST /watchlist: ${emailKey} -> ${seed ? "SEED (ignoreDuplicates)" : "normal overwrite"}, ${clean.length} tickers`);
    res.json({ success: true, stored: true, count: clean.length });
  } catch(e) {
    console.error("POST /watchlist:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── TRACK RECORD SYNC (Pro only for now) ──────────────────────────
// Mirrors /watchlist above exactly -- same auth gating (req.userEmail,
// any signed-in tier, though only pro/app.js actually calls
// initTrackRecordSync() as of this writing -- see shared/track-record-sync.js)
// and the same seed/ignoreDuplicates write semantics, for the same reason:
// a GET miss is ambiguous between "genuinely new account" and "transient
// read failure/race," so a seed write can only insert, never clobber.
//
// Stores the full, already-capped entries array shared/track-record.js
// builds (capped at 200 client-side); re-capped server-side too as a
// storage-abuse guard, not because the client cap can't be trusted -- same
// posture as /watchlist's tickers cap.
app.get("/track", async (req, res) => {
  if (!req.userEmail) return res.status(401).json({ error: "Sign in required" });
  if (!supabase) return res.json({ entries: [] });
  try {
    const { data, error } = await supabase
      .from("accuracy_log")
      .select("entries")
      .eq("email", req.userEmail.trim().toLowerCase())
      .maybeSingle();
    if (error) { console.error("GET /track:", error.message); return res.json({ entries: [] }); }
    const entries = (data && data.entries) || [];
    console.log(`GET /track: ${req.userEmail.trim().toLowerCase()} -> row ${data ? "found" : "NOT FOUND"}, ${entries.length} entries`);
    res.json({ entries });
  } catch(e) { console.error("GET /track:", e.message); res.json({ entries: [] }); }
});

// ─── PROPOSAL 7 — /scorecard (Aug 26, 2026) ───────────────────────────
// Free tier: aggregate, system-wide, pooled across every anonymous Free
// visitor (tier='free' rows, no user_email filter) -- this is the only
// query anyone reaches without a real signed-in session, and it never
// returns a single row's data, only a pooled count/percentage, so it
// can't leak any one user's history. Paid tiers: personalized, filtered
// by user_email, same "real sign-in required" posture as GET /track.
// Suppressed to insufficientData until n>=20 graded rows either way (an
// early 100%/0% off 2-3 samples is worse than no number).
const SCORECARD_MIN_GRADED = 20;
function computeAccuracyStats(rows) {
  const total = rows.length;
  if (!total) return { gradedCount: 0, strictPct: null, directionalPct: null };
  const trueCount     = rows.filter(r => r.grade === "TRUE").length;
  const marginalCount = rows.filter(r => r.grade === "MARGINAL").length;
  return {
    gradedCount:    total,
    strictPct:      +(trueCount / total * 100).toFixed(1),
    directionalPct: +((trueCount + marginalCount) / total * 100).toFixed(1),
  };
}
app.get("/scorecard", async (req, res) => {
  // Gated Pro-first (credits.js TIERS.<tier>.scorecard) -- flip the flag
  // per tier as this rolls out further, rather than branching on tier
  // name here.
  if (!req.tierConfig?.scorecard) {
    return res.status(403).json({ error: "Scorecard not available on this tier yet" });
  }
  if (!supabase) return res.json({ insufficientData: true, gradedCount: 0 });

  try {
    if (req.userTier === "free") {
      const { data, error } = await supabase
        .from("verdict_log").select("grade")
        .eq("tier", "free").not("graded_at", "is", null);
      if (error) { console.error("GET /scorecard (free):", error.message); return res.json({ insufficientData: true, gradedCount: 0 }); }
      const stats = computeAccuracyStats(data || []);
      if (stats.gradedCount < SCORECARD_MIN_GRADED) return res.json({ insufficientData: true, gradedCount: stats.gradedCount });
      // Directional % only for Free, per Proposal 7's tier rollout table.
      return res.json({ scope: "aggregate", directionalPct: stats.directionalPct, gradedCount: stats.gradedCount });
    }

    if (!req.userEmail) return res.status(401).json({ error: "Sign in required" });
    const email = req.userEmail.trim().toLowerCase();
    const { data, error } = await supabase
      .from("verdict_log")
      .select("grade, pre_gate_state, gate1_branch, gate0_read")
      .eq("user_email", email).not("graded_at", "is", null);
    if (error) { console.error("GET /scorecard:", error.message); return res.json({ insufficientData: true, gradedCount: 0 }); }
    const rows  = data || [];
    const stats = computeAccuracyStats(rows);
    if (stats.gradedCount < SCORECARD_MIN_GRADED) {
      return res.json({ insufficientData: true, gradedCount: stats.gradedCount });
    }
    const result = { scope: "personal", strictPct: stats.strictPct, directionalPct: stats.directionalPct, gradedCount: stats.gradedCount };

    // Full breakdown by gate/branch fired — reuses tierConfig.tracker
    // (already Pro/Shark-only, already means "real accuracy tracking is
    // a real feature on this tier") rather than inventing a second flag
    // for the same tier split.
    if (req.tierConfig?.tracker) {
      const breakdownBy = key => {
        const groups = {};
        rows.forEach(r => { const k = r[key] || "(none)"; (groups[k] = groups[k] || []).push(r); });
        return Object.fromEntries(Object.entries(groups).map(([k, rs]) => [k, computeAccuracyStats(rs)]));
      };
      result.breakdown = {
        gate1Branch:  breakdownBy("gate1_branch"),
        preGateState: breakdownBy("pre_gate_state"),
        gate0Read:    breakdownBy("gate0_read"),
      };
    }
    res.json(result);
  } catch (e) {
    console.error("GET /scorecard:", e.message);
    res.json({ insufficientData: true, gradedCount: 0 });
  }
});

const TRACK_VERDICTS = new Set(["UP", "DOWN", "FLAT"]);
app.post("/track", async (req, res) => {
  if (!req.userEmail) return res.status(401).json({ error: "Sign in required" });
  const { entries, seed } = req.body;
  if (!Array.isArray(entries)) return res.status(400).json({ error: "entries must be an array" });
  const clean = entries
    .filter(e => e && typeof e === "object"
      && typeof e.ticker === "string" && /^[A-Z]{1,6}$/.test(e.ticker)
      && TRACK_VERDICTS.has(e.verdict)
      && typeof e.correct === "boolean"
      && typeof e.ts === "string" && !isNaN(Date.parse(e.ts))
      && typeof e.session === "string")
    .map(e => ({
      ticker: e.ticker, verdict: e.verdict, correct: e.correct, ts: e.ts, session: e.session,
      ...(typeof e.trigger === "string" ? { trigger: e.trigger } : {}),
    }))
    .slice(-200);
  if (!supabase) return res.json({ success: true, stored: false });
  const emailKey = req.userEmail.trim().toLowerCase();
  try {
    const { error } = await supabase.from("accuracy_log").upsert({
      email:      emailKey,
      entries:    clean,
      updated_at: new Date().toISOString(),
    }, seed ? { onConflict: "email", ignoreDuplicates: true } : { onConflict: "email" });
    if (error) { console.error("POST /track:", error.message); return res.status(500).json({ error: error.message, stored: false }); }
    console.log(`POST /track: ${emailKey} -> ${seed ? "SEED (ignoreDuplicates)" : "normal overwrite"}, ${clean.length} entries`);
    res.json({ success: true, stored: true, count: clean.length });
  } catch(e) {
    console.error("POST /track:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ADD CREDITS (Stripe webhook or manual) ────────────────────────
app.post("/credits/add", async (req, res) => {
  const { count } = req.body;
  if (!count || count <= 0) return res.status(400).json({ error: "Invalid count" });
  const newTotal = await credits.addPurchasedCredits(req.userKey, count, req.userTier);
  res.json({ success: true, totalCredits: newTotal });
});

app.get("/", (req, res) => res.json({
  status: "ok", version: "4.0.0",
  marketOpen: isMarketOpen(),
  anthropic: !!process.env.ANTHROPIC_API_KEY,
  finnhub:   !!process.env.FINNHUB_KEY,
  secured:   !!process.env.APP_SECRET,
}));

// ─── MARKET + PULSE ───────────────────────────────────────────────
let marketCache = null, cacheTime = 0;
const CACHE_MS  = 4 * 60 * 1000;

app.get("/market", async (req, res) => {
  const force = req.query.force === "true";
  if (!force && marketCache && Date.now() - cacheTime < CACHE_MS)
    return res.json({ ...marketCache, cached: true });

  try {
    const tickers = [
      { symbol: "SPY",             key: "spy"  },
      { symbol: "QQQ",             key: "qqq"  },
      { symbol: "BINANCE:BTCUSDT", key: "btc"  },
      { symbol: "IWM",             key: "iwm"  },
      { symbol: "SOXX",            key: "soxx" },
      { symbol: "XBI",             key: "xbi"  },
      { symbol: "GLD",             key: "gld"  },
      { symbol: "USO",             key: "uso"  },
      { symbol: "IBB",             key: "ibb"  },
      { symbol: "NVDA",            key: "nvda" },
      { symbol: "TSM",             key: "tsm"  },
      { symbol: "MSFT",            key: "msft" },
    ];

    const results = await Promise.allSettled(tickers.map(t => fetchQuote(t.symbol)));
    const data = {};
    results.forEach((r, i) => {
      data[tickers[i].key] = r.status === "fulfilled" && r.value
        ? r.value : { price:"?", change:"?", direction:"flat", pct:0 };
    });

    const spyPct = data.spy?.pct || 0;
    const qqqPct = data.qqq?.pct || 0;
    const btcPct = data.btc?.pct || 0;
    const tsmPct = data.tsm?.pct || 0;

    // Gate 0 — dynamic calculation based on actual SPY/QQQ values
    const avgPct = (spyPct + qqqPct) / 2;
    const gateStrong = spyPct >= 0.5 && qqqPct >= 0.5;
    const bothNeg    = spyPct < 0 && qqqPct < 0;
    const eitherNeg  = spyPct < 0 || qqqPct < 0;

    let gateStatus, gateNote;

    if (spyPct <= -1 && qqqPct <= -1) {
      // Both down hard — broad market failure
      gateStatus = "RED";
      gateNote   = `SPY ${data.spy?.change||"?"} QQQ ${data.qqq?.change||"?"} — both down >1%, broad market failure, risk-off`;
    } else if (spyPct <= -1 || qqqPct <= -1) {
      // One index hard down — sector rotation, caution
      gateStatus = "YELLOW";
      gateNote   = `SPY ${data.spy?.change||"?"} QQQ ${data.qqq?.change||"?"} — one index down >1%, sector rotation risk, cut size 50%`;
    } else if (spyPct <= -0.5 || qqqPct <= -0.5) {
      // Either down meaningfully
      gateStatus = "YELLOW";
      gateNote   = `SPY ${data.spy?.change||"?"} QQQ ${data.qqq?.change||"?"} — market under pressure, cut size 50%`;
    } else if (bothNeg) {
      // Both negative but mild — cautionary green
      gateStatus = "GREEN";
      gateNote   = `SPY ${data.spy?.change||"?"} QQQ ${data.qqq?.change||"?"} — both slightly negative, proceed with caution, half size`;
    } else if (eitherNeg) {
      // Mixed — one positive one negative
      gateStatus = "GREEN";
      gateNote   = `SPY ${data.spy?.change||"?"} QQQ ${data.qqq?.change||"?"} — mixed signals, proceed at reduced size`;
    } else if (gateStrong) {
      // Both clearly positive
      gateStatus = "GREEN";
      gateNote   = `SPY ${data.spy?.change||"?"} QQQ ${data.qqq?.change||"?"} — both up >0.5%, strong tailwind, full proceed`;
    } else {
      // Both flat to mildly positive
      gateStatus = "GREEN";
      gateNote   = `SPY ${data.spy?.change||"?"} QQQ ${data.qqq?.change||"?"} — flat to mild positive, proceed normally`;
    }

    // TSM drop >3% = global AI/semi warning
    const tsmWarning = tsmPct <= -3
      ? `⚠ TSM ${data.tsm?.change} — Taiwan semi stress, risk-off on AI/semi names`
      : null;

    let btcSignal = "neutral";
    if      (btcPct >=  2) btcSignal = "full conviction";
    else if (btcPct <= -5) btcSignal = "risk-off";
    else if (btcPct <= -2) btcSignal = "reduce size";

    const marketOpen = isMarketOpen();

    // Send market data immediately without waiting for pulse
    const result = {
      ...data, gateStatus, gateNote, btcSignal, tsmWarning,
      marketOpen, pulse: marketCache?.pulse || null,
      timestamp: new Date().toISOString(), cached: false,
    };
    marketCache = result;
    cacheTime   = Date.now();
    res.json(result);

    // Generate pulse in background — updates cache for next request
    generatePulse(data).then(pulse => {
      if(pulse && marketCache) {
        marketCache.pulse = pulse;
      }
    }).catch(() => {});
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TICKER DATA CACHES ─────────────────────────────────────────────
// Two independent caches with two independent refresh rules, because news
// and market data go stale on completely different clocks: a headline can
// drop at 6pm on a Saturday, but a stock's price/opening-bar/trend data
// cannot move at all while the market's closed. Sharing one cache/TTL
// between them meant either serving stale news for 15+ minutes during the
// day, or re-fetching identical Friday-close market data on every single
// weekend page load — this splits them so each refetches only when its own
// underlying reality can actually have changed.
const newsCache        = new Map(); // symbol -> { data, time }
const symbolMarketCache = new Map(); // symbol -> { data: {metrics,openingBar,dailyCloses,proxyRule,weeklyCarryover}, time }
// Pre-Gate (SEC filings) is a THIRD clock, slower than either of the above:
// 10-Q/10-K/8-K filings don't change minute to minute like price does, but
// it was riding the same short market-data TTL, so Pro tier was re-hitting
// SEC's full-text search endpoint roughly every minute per ticker during
// market hours. SEC's endpoint is slower and far more aggressively
// rate-limited than Finnhub/Alpaca, so a burst of many tickers loading at
// once (a big watchlist's first load, or Analyze All) could trip its
// throttling -- almost certainly the real source of the reported ~40s loads
// and per-ticker timeouts. Its own 24h cache fixes both: far fewer SEC
// calls overall, and none of them bunched into the same price-driven burst.
const preGateCache      = new Map(); // symbol -> { data, time }
const NEWS_REFRESH_MS     = 30 * 60 * 1000;
const PRE_GATE_REFRESH_MS = 24 * 60 * 60 * 1000;

// Company-name -> ticker lookup cache (Import's free-text entry -- see
// searchSymbolByName() below). A week-long TTL, not a market-data-length
// one: unlike price/news, a name<->symbol mapping essentially never
// changes day to day, so there's no reason to treat this like a live feed.
const symbolSearchCache      = new Map(); // lowercased query -> { symbol, time }
const SYMBOL_SEARCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// News window: 8am-8pm ET, every day of the week (including weekends) —
// unlike price/trend data, a headline can land any day, so this window is
// deliberately NOT gated on weekday like market data below.
function isNewsWindow() {
  const et   = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 480 && mins < 1200; // 8:00am–8:00pm ET
}

// Market-data refresh window: 8am-8pm ET, Monday through Sunday, EXCEPT
// Saturday. That covers pre-market/after-hours prospecting on every weekday
// (not just the 9:30-4 regular session isMarketOpen() would allow) plus
// Sunday evening, when futures reopen and next-week positioning starts —
// but skips Saturday entirely, where nothing about a ticker's price data can
// realistically move. Outside this window the cached copy is served
// regardless of age. This is deliberately a different, wider check than
// isMarketOpen() (which still gates the actual Gate 0 SPY/QQQ trading logic
// elsewhere in this file) — this one only governs cache-refresh eligibility.
//
// Briefly narrowed to 9:30am-8pm on Aug 4, 2026 after finding Finnhub's
// free /quote doesn't reflect pre-market trades in its `c` field (holds the
// last regular-session price until 9:30) — confirmed live (CIFR showing
// $24.16 pre-market against a real $21.80). Reverted the same day: IEX
// Exchange runs its own formal pre-market (4:00am-9:30am ET) and post-market
// (4:00pm-8:00pm ET) sessions, and Alpaca's bars/latest-trade endpoints
// (feed=iex, already used elsewhere in this file) include those IEX prints
// by default. So the fix isn't to stop refreshing during extended hours —
// it's to source the price from Alpaca instead of Finnhub during them. See
// isExtendedHoursWindow() and fetchExtendedHoursPrice().
function isMarketDataWindow() {
  const et  = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay(); // 0=Sun, 6=Sat
  if (day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 480 && mins < 1200; // 8:00am–8:00pm ET
}

// The sub-window of isMarketDataWindow() where Finnhub's free /quote can't
// be trusted for price: IEX's own pre-market (4:00am-9:30am ET) and
// post-market (4:00pm-8:00pm ET) sessions, minus the part that overlaps
// isMarketDataWindow's 8am floor (pre-8am IEX pre-market isn't covered by
// either window, consistent with this app's existing 8am prospecting
// convention). Regular session (9:30-4:00) is excluded here — Finnhub is
// confirmed accurate then, no need to route it through the thinner IEX tape.
function isExtendedHoursWindow() {
  const et   = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const mins = et.getHours() * 60 + et.getMinutes();
  return (mins >= 480 && mins < 570) || (mins >= 960 && mins < 1200); // 8-9:30am or 4-8pm ET
}

// Fetches and stores a fresh symbolMarketCache entry for one ticker —
// metrics/opening bar/gate1 daily closes/Gate 5 proxy resolution. Factored
// out of /ticker/:symbol's own staleness check so the market-open warm pass
// below (marketOpenWarm()) can refresh every already-tracked symbol through
// the exact same path, instead of a second copy that could drift from it.
// hardTrigger comes from the caller's own Pre-Gate lookup (its own 24h
// cache, doesn't need to line up with this function's clock) — defaults to
// false for callers (like the warm pass) that don't have it handy, same as
// a symbol with no Pre-Gate history yet would resolve to.
async function refreshMarketEntry(symbol, hardTrigger = false) {
  // Weekly carryover only matters Tue/Wed/Thu (see carryoverDecayLabel) —
  // Mon/Fri keep their own same-day overlay and don't need it, so this
  // skips the extra Alpaca call entirely on 4 of 7 days, weekends included.
  const wantCarryover = carryoverDecayLabel() !== null;

  const [metricsRes, barRes, gate1Res, carryoverRes] = await Promise.allSettled([
    fetchTickerMetrics(symbol),
    fetchOpeningBar(symbol),
    fetchGate1Metrics(symbol),
    wantCarryover ? fetchWeeklyCarryover(symbol) : Promise.resolve(null),
  ]);
  const metrics     = metricsRes.status === "fulfilled" ? metricsRes.value : null;
  const openingBar  = barRes.status     === "fulfilled" ? barRes.value     : null;
  const dailyCloses = gate1Res.status   === "fulfilled" ? gate1Res.value   : null; // ascending closes, Patch 4
  const weeklyCarryover = carryoverRes.status === "fulfilled" ? carryoverRes.value : null;

  // Proposal 3 — weekly health check on a FIXED Taiwan/Korea proxy
  // assignment (no-op / null for every other ticker's classification).
  // Computed BEFORE resolveGate5 below so a BROKEN regime can steer that
  // function's own static-vs-dynamic branch, and so both the response and
  // resolveGate5 share one regime value instead of resolving it twice.
  const staticRule = classifyTicker(symbol, metrics?.sectorInfo);
  const isFixedTaiwanKorea = staticRule !== DEFAULT_PROXY && staticRule.category === "AI/Semiconductor";
  const regime = isFixedTaiwanKorea ? await resolveProxyRegime(symbol, dailyCloses) : null;

  // Gate 5 — static classification, falling through to the Dynamic Proxy
  // Resolution Algorithm (correlation + fundamentals loop) when ambiguous,
  // or when the regime check above says the fixed proxy has gone BROKEN.
  const proxyRule = await resolveGate5(symbol, metrics, dailyCloses, hardTrigger, regime);

  const marketEntry = { data: { metrics, openingBar, dailyCloses, proxyRule, weeklyCarryover, regime }, time: Date.now() };
  symbolMarketCache.set(symbol, marketEntry);
  return marketEntry;
}

// ─── PROPOSAL 7 — CORROBORATION DECAY (Aug 26, 2026) ──────────────────
// Computed inline off the most recent corroboration_log hit for this
// ticker (across whoever's analysis produced it -- corroboration_log has
// no user scoping, matching its "timestamp per source hit" design). No
// new endpoint, no new fetch cadence -- reuses whatever /ticker/:symbol
// already runs on. Real gap, disclosed rather than hidden: Proposal 7
// says decay should tie to the Agitator Gauge's Immediacy sub-factor, but
// Proposal 5 (Agitator) hasn't been built yet, so this uses one fixed
// 24h half-life for every hit regardless of source until Agitator ships
// -- Free/Starter/Pro all effectively get the "fixed decay rate" tier
// from Proposal 7's own rollout table for now, not the Agitator-tied
// variable rate Pro/Shark are meant to eventually have. Returns null
// (render nothing) for a ticker with zero corroboration_log rows --
// most tickers, most of the time, since the underlying check only ever
// runs when a user typed Session Context text.
const DECAY_HALF_LIFE_HOURS = 24;
async function computeCorroborationDecay(symbol) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("corroboration_log")
      .select("hit_at")
      .eq("ticker", symbol)
      .order("hit_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const hoursSince = (Date.now() - new Date(data.hit_at).getTime()) / 3600000;
    const freshnessPct = Math.max(0, Math.round(100 - (hoursSince / DECAY_HALF_LIFE_HOURS) * 100));
    return { freshnessPct, label: freshnessPct >= 50 ? "FRESH" : "STALE", hitAt: data.hit_at };
  } catch (e) {
    console.error(`computeCorroborationDecay ${symbol}:`, e.message);
    return null;
  }
}

// ─── TICKER DATA ──────────────────────────────────────────────────
app.get("/ticker/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    // ── NEWS + PRE-GATE — run concurrently, not sequentially. Neither
    // depends on the other (or on anything else in this handler) — News is
    // its own 30-minute cadence, Pre-Gate its own 24h cache (see the
    // comment on preGateCache above) — but they used to run one after the
    // other anyway, so a cold Pre-Gate cache (SEC-throttled, can be the
    // slowest thing in this whole request) delayed News for no reason, and
    // both delayed the market-data fetch below from even starting. This
    // doesn't change what either computes, just removes serial waiting
    // that had no correctness reason behind it — market data's real
    // dependency on preGate.hardTrigger (see resolveGate5 below) still
    // gets the fully-resolved, fresh value, same as before.
    const [news, preGate] = await Promise.all([
      (async () => {
        let newsEntry = newsCache.get(symbol);
        if (!newsEntry || (isNewsWindow() && Date.now() - newsEntry.time >= NEWS_REFRESH_MS)) {
          const newsData = await fetchNews(symbol).catch(() => null);
          newsEntry = { data: newsData, time: Date.now() };
          newsCache.set(symbol, newsEntry);
        }
        return newsEntry.data;
      })(),
      (async () => {
        let preGateEntry = preGateCache.get(symbol);
        if (!preGateEntry || Date.now() - preGateEntry.time >= PRE_GATE_REFRESH_MS) {
          const preGateData = await evaluatePreGate(symbol);
          preGateEntry = { data: preGateData, time: Date.now() };
          preGateCache.set(symbol, preGateEntry);
        }
        return preGateEntry.data;
      })(),
    ]);

    // ── MARKET DATA — metrics/opening bar/gate1/proxy rule.
    // Shared across every tier requesting this symbol (the underlying data
    // isn't tier-specific), but judged stale against the REQUESTING tier's
    // own cacheMinutes, so a Pro request (1 min) still forces a refresh a
    // Free request (15 min) wouldn't have asked for — everyone just reads
    // whatever the freshest fetch left behind. Refreshed only inside
    // isMarketDataWindow() (weekdays + Sunday evening, 8am-8pm ET) — outside
    // that the cached copy is served regardless of age, since nothing about
    // it can have changed. fetchTickerMetrics() internally routes the price
    // itself through Alpaca instead of Finnhub during isExtendedHoursWindow().
    const tierCacheMinutes = req.tierConfig?.cacheMinutes ?? 15;
    let marketEntry = symbolMarketCache.get(symbol);
    const marketStale = !marketEntry ||
      (isMarketDataWindow() && Date.now() - marketEntry.time >= tierCacheMinutes * 60 * 1000);
    if (marketStale) marketEntry = await refreshMarketEntry(symbol, preGate.hardTrigger);
    const { metrics, openingBar, dailyCloses, proxyRule, weeklyCarryover, regime } = marketEntry.data;

    // Server-enforced Gate 1 — pure/cheap derivation from dailyCloses, so it's
    // recomputed on every request (cache hit or not) rather than stored,
    // same result either way, passed through untouched by /analyze.
    const gate1 = evaluateGate1(dailyCloses);

    // IV — Pro + Shark only (tierConfig.iv), needs metrics.price to pick a
    // representative contract. Deliberately left outside both caches above:
    // it's a narrow, already tier-gated feature, and its own upstream
    // (Alpaca options snapshots) is a separate cost/staleness profile that
    // doesn't need to ride on the same invalidation rule as the rest.
    const iv = req.tierConfig?.iv ? await fetchImpliedVolatility(symbol, metrics?.price) : null;

    // Corroboration Decay Indicator (Proposal 7) — gated on the same
    // scorecard flag as /scorecard itself, since both parts of Proposal 7
    // were approved and are rolling out on the same Pro-first schedule.
    const corroborationDecay = req.tierConfig?.scorecard ? await computeCorroborationDecay(symbol) : null;

    res.json({ symbol, metrics, news, openingBar, proxyRule, gate1, preGate, iv, weeklyCarryover, regime, corroborationDecay, timestamp: new Date().toISOString() });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ANALYZE CACHE ────────────────────────────────────────────────
const analyzeCache = new Map();

function getCached(key, maxMinutes) {
  const entry = analyzeCache.get(key);
  if (!entry) return null;
  const ageMs = Date.now() - entry.time;
  if (ageMs > maxMinutes * 60 * 1000) { analyzeCache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  analyzeCache.set(key, { data, time: Date.now() });
  // Clean old entries periodically
  if (analyzeCache.size > 500) {
    const oldest = [...analyzeCache.entries()]
      .sort((a,b) => a[1].time - b[1].time)
      .slice(0, 100);
    oldest.forEach(([k]) => analyzeCache.delete(k));
  }
}

// ─── ANALYZE ──────────────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  const { ticker, sectorContext, marketContext, metricsData, newsData, openingBarData, proxyRule, gate1Data, preGateData, weeklyCarryoverData, regimeData, dialPosition, holdThroughEarnings } = req.body;
  if (!ticker) return res.status(400).json({ error: "ticker is required" });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  // ── PROPOSAL 6 — AGGRESSION DIAL (Aug 26, 2026) ──────────────────
  // Only takes effect where the Dial feature itself is enabled
  // (tierConfig.dial, Pro-first) -- scoped exactly to the feature's own
  // rollout rather than a blast-radius-widening CRF-wide change. A
  // missing/unrecognized value falls back to NEUTRAL, which is a
  // guaranteed no-op (sizingCeiling FULL, no earnings check) -- so this
  // is safe even before the client sends a real dial position.
  const allowedDialPositions = DIAL_RANGES[req.tierConfig?.dialRange] || DIAL_RANGES.full;
  const effectiveDialPosition = (req.tierConfig?.dial && DIAL_POSITIONS[dialPosition] && allowedDialPositions.includes(dialPosition)) ? dialPosition : "NEUTRAL";

  // ── CREDIT CHECK ──────────────────────────────────────────────
  const userStatus = await credits.getUserStatus(req.userKey, req.userTier);

  // Check ticker limit
  if (req.userTier !== "shark" && req.userTier !== "pro") {
    const maxTickers = credits.TIERS[req.userTier]?.maxTickers || 3;
    // ticker count check happens client-side via watchlist cap
    // server enforces single-call ticker limit via the request itself
  }

  // Check credit balance — 1 credit per analyze call
  if (userStatus.totalCredits < 1) {
    return res.status(402).json({
      error:       "Insufficient credits",
      code:        "NO_CREDITS",
      totalCredits: userStatus.totalCredits,
      tier:         req.userTier,
      message:     "Purchase more credits or upgrade your plan to continue analyzing.",
    });
  }

  // Check cache before deducting credit
  const cacheKey    = `${req.userTier}:${ticker.toUpperCase()}`;
  const cacheMinutes = credits.TIERS[req.userTier]?.cacheMinutes || 15;
  const cached      = getCached(cacheKey, cacheMinutes);
  if (cached) {
    return res.json({ ...cached, fromCache: true });
  }

  // Deduct 1 credit (only if not cached)
  await credits.deductCredit(req.userKey, 1, req.userTier);

  // Dial-proof at all 5 positions, no exceptions, per direct instruction --
  // only runs where the Dial feature itself is enabled (tierConfig.dial),
  // and only when the caller hasn't already opted in for this specific
  // run (the "one-time opt-in toggle," never a persistent default, per
  // the Notion log's own framing).
  const upcomingEarnings = (req.tierConfig?.dial && !holdThroughEarnings)
    ? await checkUpcomingEarnings(ticker) : null;

  // ── PRE-GATE — THESIS INTEGRITY, PRE-DETERMINED (Patch 3) ──────────
  // Computed server-side once in /ticker/:symbol and passed through here
  // untouched — same pattern as Gate 0/1/5. Runs conceptually before Gate 0;
  // no corroboration required, can force DOWN on its own.
  const preGateResult = preGateData || { status: "GREEN", hardTrigger: false, note: "Pre-Gate data unavailable — server enforcement failed, treat cautiously." };

  // ── GATE 0 — PRE-DETERMINED ───────────────────────────────────────
  const gate0Status = sectorContext?.gateStatus || "GREEN";
  const gate0Note   = sectorContext?.gateNote   || "Sector data unavailable";

  // ── GATE 5 — SMART PROXY PRE-DETERMINED ──────────────────────────
  const rule        = proxyRule || DEFAULT_PROXY;
  const gate5Result = ah.evaluateProxyStatus(rule, sectorContext || {});

  // ── GATE 1 — BIDIRECTIONAL TREND, PRE-DETERMINED ─────────────────
  // Computed server-side once in /ticker/:symbol and passed through here
  // untouched — same pattern as Gate 0/Gate 5. Never recalculated by the LLM.
  const gate1Result = gate1Data || evaluateGate1(null);

  // ── GATE 4 — PHASE, PRE-DETERMINED (Aug 22, 2026) ────────────────
  // Plain math off metricsData.rangePosition (already computed and sent by
  // the client every call) -- no reason for the LLM to eyeball a number
  // it's just been handed and re-derive the same three thresholds itself.
  const gate4Result = evaluateGate4(metricsData);

  // ── BUILD NEWS CONTEXT ────────────────────────────────────────────
  let newsContext = "No news within the last business week (300 hours). Gate 2 catalyst = NEUTRAL.";
  if (newsData && newsData.ageHours <= MAX_NEWS_AGE_HOURS) {
    newsContext = `Recent news (${newsData.ageLabel}): "${newsData.headline}" — treat this as a potential catalyst for Gate 2 analysis. Classify as COMPANY-SPECIFIC POSITIVE, NEGATIVE, or NEUTRAL based on the headline content.`;
  }

  // ── BUILD OPENING BAR CONTEXT ──────────────────────────────────
  const isShark = req.userTier === "shark";
  let barContext = "No opening bar data — BLIND SEQUENCE mode. Use SESSION CONTEXT bar data if provided by user.";
  let barMode   = "BLIND_SEQUENCE";

  if (openingBarData) {
    const vStr = openingBarData.volRatio
      ? `${openingBarData.volRatio}x average volume (${openingBarData.volume?.toLocaleString()} vs avg ${openingBarData.avgVol?.toLocaleString()})`
      : `${openingBarData.volume?.toLocaleString()} shares`;

    if (isShark && openingBarData.swingLevels) {
      // Shark tier — full swing level mode
      barMode   = "SWING_LEVEL";
      const sl  = openingBarData.swingLevels;
      barContext = `Gate 3 MODE: SWING_LEVEL
14D_HIGH: ${sl.high14d} | 14D_LOW: ${sl.low14d}
2D_MEAN_HIGH: ${sl.meanHigh2d} | 2D_MEAN_LOW: ${sl.meanLow2d}
Completed bars today: ${openingBarData.barsToday || 1}
Bar 1 (opening): O=${openingBarData.open} H=${openingBarData.high} L=${openingBarData.low} C=${openingBarData.close} Vol=${vStr} Direction=${openingBarData.direction}
${openingBarData.allBars ? `All bars today: ${JSON.stringify(openingBarData.allBars)}` : ''}
Touch detected: ${openingBarData.touchLevel || 'none yet — scanning'}
Apply mean reversion 3-bar sequence logic.`;
    } else {
      // Non-Shark with Alpaca bar 1 only — blind sequence
      barMode   = "BLIND_SEQUENCE";
      barContext = `Gate 3 MODE: BLIND_SEQUENCE
Bar 1 (opening): O=${openingBarData.open} H=${openingBarData.high} L=${openingBarData.low} C=${openingBarData.close} Vol=${vStr} Direction=${openingBarData.direction}
No swing levels available. Apply 3-bar sequence logic with Mon/Fri overlay.
Check SESSION CONTEXT for additional bar data provided by user.`;
    }
  }

  // ── BUILD WEEKLY CARRYOVER CONTEXT (Gate 3 Tue/Wed/Thu decay) ──────
  // Decay weight is computed server-side from today's real ET weekday
  // (carryoverDecayLabel), same reasoning as the "Today:" line below —
  // never trust the client for what day it is. The underlying Friday/
  // Monday closes (weeklyCarryoverData) are also server-sourced, just
  // relayed through the client from its earlier /ticker/:symbol response
  // (same pattern as gate1Data/proxyRule/openingBarData above).
  let carryoverContext = "N/A — Monday/Friday keep their own same-day overlay rule instead.";
  const decay = carryoverDecayLabel();
  if (decay && weeklyCarryoverData) {
    const wc = weeklyCarryoverData;
    carryoverContext = `Last Friday closed $${wc.fridayClose}, the following Monday (${wc.mondayDate}) closed $${wc.mondayClose} (${wc.reactionPct > 0 ? '+' : ''}${wc.reactionPct}%, ${wc.reaction}). ${decay.sessionsSinceMonday} session(s) removed from that Monday — carryover weight: ${decay.weight}.`;
  } else if (decay) {
    carryoverContext = `Weekly carryover data unavailable this run — treat as no additional signal (do not assume a direction).`;
  }

  // ── BUILD GATE 3 FRIDAY FULL-WEIGHT CONTEXT (Aug 22, 2026) ─────────
  // Only relevant/fetched on Friday itself (real ET weekday, same "never
  // trust the client for what day it is" reasoning as everything else
  // here) -- adds zero call volume the other 4 days of the week.
  let fridayWeightContext = "N/A — not Friday, this override doesn't apply.";
  if (etWeekday() === 5) {
    const weekRange = await fetchWeekOwnRange(ticker.toUpperCase());
    fridayWeightContext = weekRange
      ? `This week (Monday $${weekRange.mondayClose} → ${weekRange.throughDate} $${weekRange.latestClose}, ${weekRange.pctMove > 0 ? '+' : ''}${weekRange.pctMove}%) has been ${weekRange.flat ? 'FLAT' : 'NOT flat'}.`
      : `Week-range data unavailable this run — treat as NOT flat (apply the standard Friday skepticism discount).`;
  }

  // ── BUILD METRICS CONTEXT ─────────────────────────────────────────
  let metricsContext = "No metrics data — estimate from training knowledge.";
  if (metricsData) {
    metricsContext = `
52-week range position: ${metricsData.rangePosition !== null ? metricsData.rangePosition+"%" : "unknown"}
Phase proxy: ${metricsData.phaseProxy || "unknown"}
Beta: ${metricsData.beta || "unknown"}
Current price: $${metricsData.price || "?"}
52W High: $${metricsData.week52hi || "?"}, 52W Low: $${metricsData.week52lo || "?"}
`;
  }

  // ── TICKER/PROXY SESSION % CHANGE ───────────────────────────────────
  // Shared by the Gate 5 Proxy Coherence Check (Proposal 2) below and the
  // Session Context buildup-pattern check (Proposal 4) further down --
  // computed once here rather than twice. Deliberately do NOT read
  // metricsData.pct / sectorContext.<sym>.pct -- every tier's client only
  // ever sends sectorContext[sym] as the formatted `.change` string (e.g.
  // "+1.23%"), never a raw `.pct` number, and metricsData never carries a
  // `.pct` field either, so both are always null/undefined in practice.
  // That's the BUG FIX (Aug 13, 2026) documented on ah.evaluateProxyStatus()
  // above -- this is the second half of it: the Coherence Check read the
  // same two always-null fields, so it never ran either, silently falling
  // through to the plain forceDown branch every time. Sourced instead from
  // openingBarData's own bar-1 open->close and a parse of sectorContext's
  // change strings via ah.parsePctString(), both of which are actually
  // populated.
  const tickerPct = (openingBarData && openingBarData.open)
    ? (openingBarData.close - openingBarData.open) / openingBarData.open * 100
    : null;
  const proxyPct = (() => {
    const syms = (rule.proxy?.symbols || []).map(s => s.toLowerCase());
    const vals = syms.map(s => ah.parsePctString(sectorContext?.[s])).filter(v => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  })();

  // ── SESSION CONTEXT CORROBORATION (Proposal 4) ─────────────────────
  // Only runs when the user actually typed something -- see the fetch
  // functions above for why that keeps this free on every other analysis.
  let contextCorroboration = null;
  if (marketContext && marketContext.trim().length > 0) {
    const [newsBodies, hasEarningsEvent] = await Promise.all([
      fetchNewsBodiesForCorroboration(ticker),
      fetchEarningsCalendarFlag(ticker),
    ]);
    const newsMatch = newsBodies.some(body => gx.contextTextMatches(marketContext, body));

    const buildup = gx.buildupPatternCheck({
      volRatio: typeof openingBarData?.volRatio === "number" ? openingBarData.volRatio : null,
      tickerPct, proxyPct,
      hasFreshNews: !!(newsData && newsData.ageHours <= 24),
    });

    contextCorroboration = gx.corroborateSessionContext({ newsMatch, buildup, hasEarningsEvent });
    await logCorroborationHits(ticker, contextCorroboration);
  }

  const userMessage = `
Analyze ${ticker.toUpperCase()}.

PRE-GATE — USE EXACTLY THIS (do not recalculate, server-enforced thesis integrity check):
Status: ${preGateResult.status}
Note: ${preGateResult.note}

GATE 0 — USE EXACTLY THIS (do not recalculate):
Status: ${gate0Status}
Note: ${gate0Note}

GATE 1 — USE EXACTLY THIS (do not recalculate, server-enforced bidirectional trend):
Status: ${gate1Result.status}
Sizing: ${gate1Result.sizing}
Note: ${gate1Result.note}

GATE 4 — USE EXACTLY THIS (do not recalculate, server-enforced phase):
Status: ${gate4Result.status}
Note: ${gate4Result.note}

GATE 5 — USE EXACTLY THIS (do not recalculate):
Status: ${gate5Result.status}
Note: ${gate5Result.note}

Market data for Gates 2-3 context:
SPY ${sectorContext?.spy||"?"}, QQQ ${sectorContext?.qqq||"?"}, BTC ${sectorContext?.btc||"?"}
XBI ${sectorContext?.xbi||"?"}, IBB ${sectorContext?.ibb||"?"}, SOXX ${sectorContext?.soxx||"?"}
TSM ${sectorContext?.tsm||"?"}, MSFT ${sectorContext?.msft||"?"}
GLD ${sectorContext?.gld||"?"}, USO ${sectorContext?.uso||"?"}
BTC signal: ${sectorContext?.btcSignal||"neutral"}
Today: ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"short",day:"numeric",year:"numeric",timeZone:"America/New_York"})}

Ticker metrics: ${metricsContext}
News context: ${newsContext}
Gate 3 bar mode: ${barMode}
Opening bar context: ${barContext}
Gate 3 weekly carryover: ${carryoverContext}
Gate 3 Friday full-weight check: ${fridayWeightContext}
Additional context: ${marketContext || "None"}
Session Context corroboration: ${contextCorroboration ? contextCorroboration.note : "N/A — no Session Context provided."}

Run Gates 2 and 3 only. Pre-Gate, Gate 0, Gate 1, Gate 4, and Gate 5 are provided above — copy them exactly.
Return only JSON.
`;

  try {
    const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 800,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    }, 25000);

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: `Anthropic error ${response.status}`, detail: errText });
    }

    const data  = await response.json();
    const text  = data.content?.[0]?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();

    try {
      const parsed = JSON.parse(clean);

      // ── SERVER ENFORCEMENT: Pre-Gate ──────────────────────────────
      parsed.gates.pre_gate = { status: preGateResult.status, note: preGateResult.note };

      // ── SERVER ENFORCEMENT: Gate 0 ────────────────────────────────
      parsed.gates.sector = { status: gate0Status, note: gate0Note };

      // ── SERVER ENFORCEMENT: Gate 1 ────────────────────────────────
      parsed.gates.g1_prewindow = { status: gate1Result.status, note: gate1Result.note };

      // ── SERVER ENFORCEMENT: Gate 4 ────────────────────────────────
      parsed.gates.g4_phase = { status: gate4Result.status, note: gate4Result.note };

      // ── SERVER ENFORCEMENT: Gate 5 ────────────────────────────────
      parsed.gates.g5_korea = { status: gate5Result.status, note: gate5Result.note };

      // ── SERVER ENFORCEMENT: Session Context corroboration (Proposal 4) ──
      // Corroboration state is server-computed (not left to the model's own
      // judgment, same "PRE-DETERMINED, copy exactly" posture as the gates
      // above) and attached to the response as its own field, plus appended
      // to Gate 2's note so it's visible with zero frontend change -- every
      // tier's card already renders gate.note verbatim.
      if (contextCorroboration && parsed.gates?.g2_catalyst) {
        parsed.contextCorroboration = contextCorroboration;
        const tag = contextCorroboration.corroborated
          ? ` [Session Context: CONTEXT-CORROBORATED, ${contextCorroboration.matchCount}/3]`
          : ` [Session Context: uncorroborated, informational only]`;
        parsed.gates.g2_catalyst.note = (parsed.gates.g2_catalyst.note || "") + tag;
      }

      // ── SERVER ENFORCEMENT: Pre-Gate ──────────────────────────────
      // No longer an unconditional override (Aug 22, 2026, direct
      // instruction) — a RED Pre-Gate sets DOWN as a CANDIDATE verdict,
      // same as any other RED gate, and is now subject to the CONGRUENCY
      // check below (2+ RED gates, counting Pre-Gate itself as one, or the
      // new Gates-2/3/4-all-YELLOW escape hatch) before it's allowed to
      // stand. Previously this had blanket forceDown authority equivalent
      // to Gate 0 RED — deliberately walked back: a single SEC filing
      // shouldn't be able to force DOWN entirely alone anymore.
      if (preGateResult.hardTrigger) {
        parsed.verdict = "DOWN";
        parsed.reason  = `Pre-Gate thesis-integrity concern — ${preGateResult.note}`;
      }

      // ── SERVER ENFORCEMENT: Gate 0 ────────────────────────────────
      if (gate0Status === "RED") {
        // Both SPY AND QQQ down >1% — genuine broad market failure
        parsed.verdict    = "DOWN";
        parsed.confidence = ah.priceConfirmedConfidence("DOWN", tickerPct, proxyPct);
        parsed.reason     = `Broad market failure — ${gate0Note}. No entries until market stabilizes.`;
      } else if (gate0Status === "YELLOW" && parsed.verdict === "UP") {
        // Sector rotation or mild headwind — was a flat MEDIUM cap; now
        // reflects whether the ticker's own price is actually cutting
        // through the headwind (confirmed) or the model's UP call isn't
        // backed by real price action yet (unconfirmed/contradicted).
        parsed.confidence = ah.priceConfirmedConfidence("UP", tickerPct, proxyPct);
      }

      // ── SERVER ENFORCEMENT: Gate 1 forceDown ──────────────────────
      // 60-day structural breakdown >25% has override authority equivalent
      // to Gate 0 RED. Forces DOWN regardless of any other gate, sizing NONE,
      // and skips the corroboration check below entirely — this is a hard
      // code-level override, not a prompt instruction, so it can't be missed.
      if (gate1Result.forceDown) {
        parsed.verdict    = "DOWN";
        parsed.sizing      = "NONE";
        parsed.confidence = ah.priceConfirmedConfidence("DOWN", tickerPct, proxyPct);
        parsed.reason      = `Gate 1 structural breakdown override — ${gate1Result.note}`;
        parsed.wait_for    = "Structural reversal (higher high + reclaim of 50-day MA) required before re-evaluating.";
      }

      // ── FORCEDOWN AUTHORITY REGISTRY (Patch 4 / Proposal 1) ────────
      // tickerGating: which fixed-proxy exemption scopes this ticker falls
      // under. Today only the combined AI/Semiconductor PROXY_RULES entry
      // (TSM+KOSPI) exists, so 'ai-semi-gated' and 'korea-gated' are granted
      // together — KOSPI itself isn't in the /market tracked symbol set, so
      // in practice only the Taiwan (TSM) leg is checkable; Korea gating is
      // registered for when a live KOSPI feed is wired.
      // Proposal 3 (Aug 13, 2026): regimeData is computed server-side once
      // in refreshMarketEntry()/resolveProxyRegime() on a weekly cadence
      // (proxy_regime_state table) and relayed through here untouched, same
      // pattern as gate1Data/weeklyCarryoverData above — never recalculated
      // by the LLM. null (no regime signal, e.g. a non-fixed-proxy ticker,
      // or Supabase not configured) is treated by hasForceDownAuthority()
      // as "proceed normally," same as before this was wired up.
      const regime = regimeData || null;
      const tickerGating = (!rule.dynamicallyResolved && rule.category === "AI/Semiconductor")
        ? ["ai-semi-gated", "korea-gated"]
        : [];
      const gate5Auth = tickerGating.length
        ? gx.hasForceDownAuthority("TAIWAN_PROXY", tickerGating, regime)
        : (rule.forceDownAuthority
            ? { authorized: true, reason: "Dynamically-resolved primary proxy (Patch 2)." }
            : { authorized: false, reason: "Not corroboration-exempt — needs >=2 RED gates for DOWN." });

      // ── SERVER ENFORCEMENT: Gate 5 ───────────────────────────────
      const g2Status = parsed.gates?.g2_catalyst?.status || "GREEN";
      let gate5ForceDown = false;
      if (gate5Result.status === "RED" && gate5Auth.authorized) {
        // Korea/Taiwan-gated hard trigger, or a dynamically-resolved primary
        // proxy (Patch 2) — both can force DOWN alone, same override
        // authority as Gate 0 RED / Gate 1 forceDown. For the fixed
        // Korea/Taiwan case, run the Proxy Coherence Check (Proposal 2)
        // first — a decoupled/lagging ticker downgrades to an unconfirmed
        // label instead of forcing DOWN blind.
        // BUG FIX (Aug 13, 2026): this condition/call used to read
        // metricsData.pct and sectorContext.tsm.pct directly — both are
        // always null/undefined given the real client payload shape (see
        // the tickerPct/proxyPct comment above), so this branch never
        // actually ran; every RED-and-authorized case fell through to the
        // plain forceDown else below instead. Now uses tickerPct/proxyPct,
        // computed once above from data that's actually populated.
        if (tickerGating.length && tickerPct != null && proxyPct != null) {
          const coherence = gx.proxyCoherenceCheck(tickerPct, proxyPct);
          // proxyCoherenceCheck() returns 'HOLD' for case 3 (possible
          // decoupling) — the project's terminology rule restricts the
          // verdict field to UP|DOWN|FLAT only, so map it here. The fuller
          // "possible proxy decoupling" explanation still reaches the user
          // via parsed.reason (coherence.note), just not as the verdict enum.
          parsed.verdict = coherence.verdict === "HOLD" ? "FLAT" : coherence.verdict;
          parsed.reason  = coherence.note;
          if (coherence.forceDown) {
            gate5ForceDown    = true;
            parsed.sizing     = "NONE";
            // Case 1: ticker actively moved WITH the proxy -- two
            // independent signals genuinely confirming each other, HIGH.
            // Case 2: ticker is flat/inside the coherence check's own flat
            // band -- the trigger still applies (hasn't been contradicted),
            // but the ticker hasn't actually confirmed it either, just
            // hasn't caught up yet -- MEDIUM, not HIGH.
            parsed.confidence = coherence.case === 1 ? "HIGH" : "MEDIUM";
          } else {
            parsed.confidence = "LOW";
          }
        } else {
          // No coherence check possible (not tickerGating-eligible, or
          // tickerPct/proxyPct genuinely missing) -- still run the generic
          // price-confirmation read rather than a flat MEDIUM, so a
          // dynamically-resolved primary proxy (Patch 2, not Taiwan/Korea-
          // gated, so it skips proxyCoherenceCheck above) still gets real
          // credit when its own tickerPct/proxyPct happen to be available
          // and actually agree.
          gate5ForceDown    = true;
          parsed.verdict    = "DOWN";
          parsed.sizing      = "NONE";
          parsed.confidence = ah.priceConfirmedConfidence("DOWN", tickerPct, proxyPct);
          parsed.reason      = `Gate 5 forceDown — ${gate5Result.note}`;
          parsed.wait_for    = `${rule.proxy.name} must stabilize before re-evaluating.`;
        }
      } else if (gate5Result.status === "RED") {
        // Not independently exempt — original congruency-only handling.
        // Gate 5 RED alone = FLAT (sector stress, not confirmed downtrend)
        // Gate 5 RED + Gate 2 RED = DOWN (double negative, congruent bearish)
        if (g2Status === "RED") {
          parsed.verdict    = "DOWN";
          // Two independent gates (sector proxy + catalyst) already agree;
          // if the ticker's own price and its proxy's price also confirm
          // the same direction, that's every signal this app checks
          // aligning at once -- the actual HIGH bar, not just MEDIUM by
          // default because a rule fired.
          parsed.confidence = ah.priceConfirmedConfidence("DOWN", tickerPct, proxyPct);
          parsed.wait_for   = `${rule.proxy.name} and catalyst headwind both need to clear.`;
        } else if (parsed.verdict === "UP") {
          parsed.verdict    = "FLAT";
          parsed.confidence = "LOW";
          parsed.wait_for   = `${rule.proxy.name} to stabilize. Catalyst positive but sector fighting it.`;
        }
      }

      // ── SERVER ENFORCEMENT: Gate 5 dynamic-proxy sizing/risk flags ──
      // fundamentals-speculative tier (Patch 2 Step 4) — elevated-cap
      // ceiling + auto-execute stop + quarter sizing, per spec, regardless
      // of verdict direction.
      if (rule.sizingOverride === "QUARTER" && parsed.sizing !== "NONE") {
        parsed.sizing = "QUARTER";
      }
      if (rule.elevatedCapCeiling || rule.autoExecuteStop) {
        parsed.riskFlags = {
          elevatedCapCeiling: !!rule.elevatedCapCeiling,
          autoExecuteStop:    !!rule.autoExecuteStop,
        };
      }

      // ── CONGRUENCY: a lone non-exempt RED gate should never be DOWN ──
      // (Exceptions: Gate 0 RED, Gate 1 forceDown, and Gate 5 forceDown
      // (Korea/Taiwan hard trigger or dynamically-resolved primary proxy)
      // are all corroboration-exempt per the Corroboration Rule — any one
      // of them can force DOWN on its own. Pre-Gate lost its own blanket
      // exemption Aug 22, 2026 — it's now a normal member of the
      // corroboration pool below, same as Gates 1/2/4/5.)
      const g1Status = parsed.gates?.g1_prewindow?.status || "GREEN";
      const g3Status = parsed.gates?.g3_openbar?.status || "GREEN";
      const g4Status = parsed.gates?.g4_phase?.status || "GREEN";
      const downForceAuthorized = gate0Status === "RED" || gate1Result.forceDown || gate5ForceDown;
      if (parsed.verdict === "DOWN" && !downForceAuthorized) {
        // DOWN without an exempt gate requires corroboration. Pre-Gate
        // counts toward the RED tally here — direct instruction, Aug 22,
        // 2026 — same as it counts toward every other congruency check.
        const redCount = [preGateResult.status, g1Status, g2Status, g4Status, gate5Result.status]
          .filter(x => x === "RED").length;
        // Single-RED escape hatch (Aug 22, 2026): if Gates 2, 3, and 4 are
        // ALL independently showing caution (YELLOW), that's treated as
        // sufficient corroboration on its own, even with only one outright
        // RED gate (Pre-Gate included) — three gates agreeing something's
        // off doesn't need a second RED to be taken seriously.
        const threeYellowBreakdown = g2Status === "YELLOW" && g3Status === "YELLOW" && g4Status === "YELLOW";
        if (redCount < 2 && !threeYellowBreakdown) {
          // Single non-exempt RED gate, no 3-yellow corroboration either — not enough for DOWN
          parsed.verdict    = "FLAT";
          parsed.confidence = "LOW";
          parsed.wait_for   = parsed.wait_for || "Additional confirmation needed before directional entry.";
        }
      }

      // ── INVARIANT: LOW confidence always ships with a real wait_for ──
      // Confirmed (Aug 16, 2026) this wasn't actually guaranteed: the Proxy
      // Coherence Check's "possible decoupling" branch above sets confidence
      // to LOW without touching wait_for at all, and the model's own
      // self-assigned LOW (per the CONFIDENCE rubric, when no server
      // override fires) was never instructed to pair one either. A single
      // choke point here — after every branch that can set confidence has
      // already run — is more robust than patching each site individually,
      // and doesn't overwrite a real wait_for the model or an earlier branch
      // already provided.
      if (parsed.confidence === "LOW" && (!parsed.wait_for || parsed.wait_for === "null")) {
        parsed.wait_for = "Additional confirmation needed before directional entry.";
      }

      // ── PROPOSAL 6 — AGGRESSION DIAL: sizing ceiling + pre-earnings ──
      // Both applied last, after every other sizing rule has already run,
      // so nothing downstream can re-inflate past either one. The ceiling
      // never raises sizing (see applySizingCeiling); the earnings block
      // forces NONE outright, regardless of verdict direction -- this
      // isn't a directional call, it's "don't size into a print."
      parsed.sizing = applySizingCeiling(parsed.sizing, effectiveDialPosition);
      let earningsBlocked = false;
      if (upcomingEarnings) {
        earningsBlocked = true;
        parsed.sizing   = "NONE";
        parsed.wait_for = `Earnings imminent${typeof upcomingEarnings === "string" ? ` (${upcomingEarnings})` : ""} — no new entries until it's reported, unless you explicitly hold through it.`;
      }

      const result = { ...parsed, marketOpen: isMarketOpen(), earningsBlocked };
      setCache(cacheKey, result);
      await logVerdict({
        ticker, verdict: parsed.verdict, sizeAction: parsed.sizing,
        issuedPrice: typeof metricsData?.price === "number" ? metricsData.price : null,
        preGateState: preGateResult.status, gate1Branch: gate1Result.branch,
        gate0Read: gate0Status,
        gate2CorroborationState: contextCorroboration
          ? `${contextCorroboration.corroborated ? "CONTEXT-CORROBORATED" : "UNCORROBORATED"} (${contextCorroboration.matchCount}/3)`
          : null,
        dialPosition: req.tierConfig?.dial ? effectiveDialPosition : null,
        gradingWindowDays: DEFAULT_GRADING_WINDOW_TRADING_DAYS,
        userEmail: req.userEmail, tier: req.userTier,
      });
      res.json(result);
    } catch {
      res.status(500).json({ error: "Failed to parse AI response", raw: text });
    }
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── AUTH ENDPOINTS ───────────────────────────────────────────────

// Login with email + password
app.post("/auth/login", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Auth not configured" });
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const { data, error } = await authClient().auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });
    const sub = await getSubscriber(data.user.email);
    const subStatus = sub ? (sub.status || "").trim().toLowerCase() : "none";
    const tier = (sub && subStatus === "active") ? sub.tier : "free";

    // Determine correct app URL for this tier
    const TIER_URLS = {
      free:    "https://tradetribunal.app/",
      starter: "https://tradetribunal.app/starter/",
      pro:     "https://tradetribunal.app/pro/",
      shark:   "https://tradetribunal.app/shark/",
    };
    const redirectUrl = TIER_URLS[tier] || TIER_URLS.free;

    console.log(`Login: ${data.user.email} → tier ${tier} → ${redirectUrl}`);

    res.json({
      token:       data.session.access_token,
      email:       data.user.email,
      tier,
      redirectUrl,
      expiresAt:   data.session.expires_at,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Signup
app.post("/auth/signup", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Auth not configured" });
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const { data, error } = await authClient().auth.signUp({
      email,
      password,
      options: { emailRedirectTo: "https://tradetribunal.app/" },
    });
    if (error) return res.status(400).json({ error: error.message });
    // Create free subscriber record
    await upsertSubscriber(email, "free", null, null);
    res.json({ message: "Account created. Check your email to confirm.", email });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get current session info
app.get("/auth/me", async (req, res) => {
  res.json({
    email:  req.userEmail || null,
    tier:   req.userTier,
    config: req.tierConfig,
  });
});


// Reset password — sends magic link via Supabase
app.post("/auth/reset", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Auth not configured" });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: "https://tradetribunal.app/reset",
    });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: "Reset link sent" });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Consume a password-recovery link (from /reset/) and set a new password.
// Handles both Supabase recovery-link shapes: the classic implicit-grant
// hash (#access_token=...&type=recovery) and the newer OTP-style query
// param (?token_hash=...&type=recovery) — reset/index.html forwards
// whichever one it parsed out of the URL. This existed in the trade-verdict
// mirror (PR #16, Aug 1) but was never ported here — the actual deploy
// target — so every real reset attempt 401'd with "No API key or session
// token provided" (this path wasn't in the auth-middleware's exemption
// list above either, on top of the route itself not existing).
//
// getUser(accessToken) and verifyOtp() both go through authClient(), not
// the shared admin `supabase` client — verifyOtp establishes a session
// exactly like signInWithPassword/signUp do, so running it on the admin
// client would reintroduce the same session-contamination bug fixed
// elsewhere in this file (see authClient()'s comment above). Only the
// actual privileged write (admin.updateUserById) needs service_role.
app.post("/auth/reset-confirm", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Auth not configured" });
  const { accessToken, tokenHash, password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  if (!accessToken && !tokenHash) return res.status(400).json({ error: "Missing or expired reset link" });
  try {
    let userId = null;
    if (accessToken) {
      const { data, error } = await authClient().auth.getUser(accessToken);
      if (error || !data?.user) return res.status(401).json({ error: "This reset link is invalid or has expired" });
      userId = data.user.id;
    } else {
      const { data, error } = await authClient().auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });
      if (error || !data?.user) return res.status(401).json({ error: "This reset link is invalid or has expired" });
      userId = data.user.id;
    }
    const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, { password });
    if (updateErr) return res.status(400).json({ error: updateErr.message });
    res.json({ message: "Password updated" });
  } catch(e) { res.status(500).json({ error: e.message }); }
});



// ─── STRIPE WEBHOOK ───────────────────────────────────────────────
// Receives events from Stripe when subscriptions change
// Set this URL in Stripe Dashboard → Webhooks:
// https://tra-zacg.onrender.com/stripe/webhook

app.post("/stripe/webhook", async (req, res) => {
  const sig         = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Map Stripe price IDs to tier keys
  // Set these in Render environment variables
  const PRICE_TO_TIER = {
    [process.env.STRIPE_STARTER_PRICE_ID]: { tier: "starter", key: process.env.STARTER_KEY },
    [process.env.STRIPE_PRO_PRICE_ID]:     { tier: "pro",     key: process.env.PRO_KEY     },
    [process.env.STRIPE_SHARK_PRICE_ID]:   { tier: "shark",   key: process.env.SHARK_KEY   },
  };

  let event;
  try {
    // Verify webhook signature if secret is set
    if (webhookSecret) {
      const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      event = JSON.parse(req.body);
    }
  } catch(err) {
    console.error("Stripe webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const data = event.data.object;
  console.log(`[STRIPE WEBHOOK] Event: ${event.type}`);

  // Try multiple ways to find email
  let email = data.customer_email
           || data.customer_details?.email
           || data.metadata?.email
           || data.receipt_email
           || null;

  // If no email but we have a customer ID, fetch the customer to get email
  if (!email && data.customer && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
      const customer = await stripe.customers.retrieve(data.customer);
      email = customer.email;
      console.log(`[STRIPE WEBHOOK] Fetched email from customer: ${email}`);
    } catch(e) {
      console.error(`[STRIPE WEBHOOK] Failed to fetch customer:`, e.message);
    }
  }

  // Try multiple ways to find price ID — including deep in invoice lines
  const priceId = data.items?.data?.[0]?.price?.id
               || data.price?.id
               || data.lines?.data?.[0]?.price?.id
               || data.lines?.data?.[0]?.pricing?.price_details?.price
               || data.plan?.id
               || data.metadata?.price_id
               || null;

  const tierInfo = PRICE_TO_TIER[priceId];

  console.log(`[STRIPE WEBHOOK] Email: ${email || "NOT FOUND"}, Price: ${priceId || "NOT FOUND"}, Tier: ${tierInfo?.tier || "NOT MATCHED"}`);

  switch(event.type) {
    // Also handle checkout.session.completed — this fires immediately after payment
    case "checkout.session.completed":
      if (email && data.mode === "subscription") {
        // Look up the subscription to get the price ID
        try {
          const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
          const sub = await stripe.subscriptions.retrieve(data.subscription);
          const subPriceId = sub.items.data[0].price.id;
          const subTierInfo = PRICE_TO_TIER[subPriceId];
          if (subTierInfo) {
            await credits.upgradeTier(`sub:${email}`, subTierInfo.tier);
            await upsertSubscriber(email, subTierInfo.tier, data.customer, data.subscription);
            console.log(`[STRIPE WEBHOOK] Checkout: ${email} upgraded to ${subTierInfo.tier}`);
          } else {
            console.log(`[STRIPE WEBHOOK] Checkout: no tier match for price ${subPriceId}`);
          }
        } catch(err) {
          console.error(`[STRIPE WEBHOOK] Checkout retrieve failed:`, err.message);
        }
      }
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
      if (tierInfo && email) {
        // Use email-based key so credits align with Supabase auth
        await credits.upgradeTier(`sub:${email}`, tierInfo.tier);
        await upsertSubscriber(email, tierInfo.tier, data.customer, data.id);
        console.log(`[STRIPE WEBHOOK] Subscription: ${email} upgraded to ${tierInfo.tier}`);
      } else {
        console.log(`[STRIPE WEBHOOK] Subscription: missing email or tier match — email=${email}, tier=${tierInfo?.tier}`);
      }
      break;

    case "customer.subscription.deleted":
      // Downgrade to free on cancellation — credits remain. Key must
      // match the sub:<email> convention used everywhere else (auth
      // middleware, upgradeTier, purchases) — this used to build a
      // different, never-read key here, so the cancellation never
      // actually reached the record real requests use.
      if (email && tierInfo) {
        await credits.setTier(`sub:${email}`, "free");
        await upsertSubscriber(email, "free", null, null);
        console.log(`Stripe: ${email} cancelled — downgraded to free, credits preserved`);
      }
      break;

    case "invoice.payment_succeeded":
      // Initial payment or monthly renewal — ensure subscriber row is correct
      if (email && tierInfo) {
        await credits.upgradeTier(`sub:${email}`, tierInfo.tier);
        await upsertSubscriber(email, tierInfo.tier, data.customer, data.subscription);
        console.log(`[STRIPE WEBHOOK] Payment: ${email} confirmed on ${tierInfo.tier}`);
      } else {
        console.log(`[STRIPE WEBHOOK] Payment: email=${email}, tier=${tierInfo?.tier} — skipped`);
      }
      break;

    case "invoice.payment_failed":
      console.error(`Stripe: payment failed for ${email}`);
      break;
  }

  res.json({ received: true });
});

// ─── CREDIT PURCHASE (one-time, $0.99 for 10 credits) ─────────────
app.post("/stripe/credits", async (req, res) => {
  // This endpoint receives Stripe payment_intent.succeeded events
  // for one-time credit purchases
  let event;
  try {
    event = JSON.parse(req.body);
  } catch(err) {
    return res.status(400).send("Invalid payload");
  }

  if (event.type === "payment_intent.succeeded") {
    const email    = event.data.object.metadata?.email;
    const quantity = parseInt(event.data.object.metadata?.credits || "10");
    if (email) {
      // /stripe/credits is exempted from the auth middleware (it's a
      // server-to-server Stripe webhook, not a logged-in app request), so
      // req.userKey is never set here — it must be undefined. Key off the
      // buyer's email instead, same convention as the subscriber webhook.
      credits.addPurchasedCredits(`sub:${email}`, quantity);
      console.log(`Credits: added ${quantity} purchased credits for ${email}`);
    } else {
      console.error("Credits: payment_intent.succeeded with no email in metadata — cannot attribute purchase");
    }
  }
  res.json({ received: true });
});

// Refreshes marketCache (the fixed SPY/QQQ/BTC/etc. tracked-symbol list
// backing Gate 0 and the /market overview) via fetchQuote. Factored out so
// both the boot-time warm and the market-open warm pass below use the same
// logic instead of two copies drifting apart. Deliberately separate from
// /market's own handler (which computes gateStatus/gateNote with slightly
// more granular branching) rather than unifying the two — that's a
// pre-existing, unrelated duplication not worth touching here.
async function warmTrackedMarketCache() {
  const tickers = [
    { symbol: "SPY",             key: "spy"  },
    { symbol: "QQQ",             key: "qqq"  },
    { symbol: "BINANCE:BTCUSDT", key: "btc"  },
    { symbol: "IWM",             key: "iwm"  },
    { symbol: "SOXX",            key: "soxx" },
    { symbol: "XBI",             key: "xbi"  },
    { symbol: "GLD",             key: "gld"  },
    { symbol: "USO",             key: "uso"  },
    { symbol: "IBB",             key: "ibb"  },
    { symbol: "NVDA",            key: "nvda" },
    { symbol: "TSM",             key: "tsm"  },
    { symbol: "MSFT",            key: "msft" },
  ];
  const results = await Promise.allSettled(tickers.map(t => fetchQuote(t.symbol)));
  const data = {};
  results.forEach((r, i) => {
    data[tickers[i].key] = r.status === "fulfilled" && r.value
      ? r.value : { price:"?", change:"?", direction:"flat", pct:0 };
  });
  const spyPct = data.spy?.pct || 0;
  const qqqPct = data.qqq?.pct || 0;
  const btcPct = data.btc?.pct || 0;
  const tsmPct = data.tsm?.pct || 0;
  let gateStatus = "GREEN", gateNote = "SPY and QQQ flat or green — proceed";
  const gateStrong = spyPct >= 0.5 && qqqPct >= 0.5;
  if (gateStrong) gateNote = `SPY ${data.spy?.change||"?"} QQQ ${data.qqq?.change||"?"} — both up >0.5%, strong tailwind`;
  if (spyPct <= -1 || qqqPct <= -1) { gateStatus = "RED"; gateNote = `SPY ${data.spy?.change||"?"} QQQ ${data.qqq?.change||"?"} — both down >1%, risk-off`; }
  else if (spyPct <= -0.5 || qqqPct <= -0.5) { gateStatus = "YELLOW"; gateNote = `SPY ${data.spy?.change||"?"} QQQ ${data.qqq?.change||"?"} — down >0.5%, cut size 50%`; }
  let btcSignal = "neutral";
  if (btcPct >= 2) btcSignal = "full conviction";
  else if (btcPct <= -5) btcSignal = "risk-off";
  else if (btcPct <= -2) btcSignal = "reduce size";
  const tsmWarning = tsmPct <= -3 ? `⚠ TSM ${data.tsm?.change} — Taiwan semi stress, risk-off on AI/semi names` : null;
  const marketOpen = isMarketOpen();
  marketCache = { ...data, gateStatus, gateNote, btcSignal, tsmWarning, marketOpen, pulse: marketCache?.pulse || null, timestamp: new Date().toISOString(), cached: false };
  cacheTime = Date.now();
  console.log(`Market cache warmed. Gate: ${gateStatus}. Market open: ${marketOpen}`);
  generatePulse(data).then(p => {
    if (p && marketCache) marketCache.pulse = p;
  }).catch(() => {});
}

// ─── MARKET-OPEN CACHE WARM ─────────────────────────────────────────
// The 9:30am ET open is exactly when symbolMarketCache entries most need
// to be fresh, and exactly when they're least likely to be: isMarketDataWindow()
// has been closed all morning (see its comment), so nothing has auto-
// refreshed since the prior close. Without this, whichever ticker a user
// happens to load first after 9:30 pays for its own refresh individually,
// and everyone else keeps seeing a stale price until their own next
// request happens to land. This proactively refreshes the fixed tracked
// list AND every symbol currently sitting in symbolMarketCache (i.e.
// anything any tier's watchlist has touched recently) the moment the bell
// rings, so real traffic ramping up right after open finds already-fresh
// data instead of triggering the refresh itself. Fires once per trading
// day, in a 5-minute window starting at 9:30 (not a single instant) so a
// missed tick from event-loop load doesn't just skip the day entirely.
let lastOpenWarmDate = null;
setInterval(async () => {
  const et  = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return; // no 9:30 open on Sat/Sun
  const mins = et.getHours() * 60 + et.getMinutes();
  const dateKey = et.toISOString().slice(0, 10);
  if (mins < 570 || mins >= 575 || lastOpenWarmDate === dateKey) return;
  lastOpenWarmDate = dateKey;
  console.log("Market open — warming cache for all tracked symbols...");
  try {
    await warmTrackedMarketCache();
    const watchlistSymbols = Array.from(symbolMarketCache.keys());
    await Promise.allSettled(watchlistSymbols.map(s => {
      const hardTrigger = preGateCache.get(s)?.data?.hardTrigger || false;
      return refreshMarketEntry(s, hardTrigger).catch(e => console.error(`Market open warm ${s}:`, e.message));
    }));
    console.log(`Market open cache warm complete: ${watchlistSymbols.length} watchlist symbol(s) refreshed.`);
  } catch(e) {
    console.error("Market open cache warm failed:", e.message);
  }
}, 60 * 1000);

// ─── START ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
credits.loadCredits(); // no-op with Supabase backend
app.listen(PORT, async () => {
  console.log(`Trade Tribunal API v4.0.0 on port ${PORT}`);
  console.log(`Anthropic: ${!!process.env.ANTHROPIC_API_KEY}`);
  console.log(`Finnhub:   ${!!process.env.FINNHUB_KEY}`);
  console.log(`Alpaca:    ${!!(process.env.ALPACA_KEY && process.env.ALPACA_SECRET)}`);
  console.log(`Secured:   ${!!process.env.APP_SECRET}`);
  console.log(`Market open: ${isMarketOpen()}`);
  console.log(`Free key:    ${!!process.env.FREE_KEY}`);
  console.log(`Starter key: ${!!process.env.STARTER_KEY}`);
  console.log(`Pro key:     ${!!process.env.PRO_KEY}`);
  console.log(`Shark key:   ${!!process.env.SHARK_KEY}`);
  console.log(`Stripe key:  ${!!process.env.STRIPE_SECRET_KEY}`);
  console.log(`Supabase:    ${!!supabase}`);
  console.log(`Stripe WH:   ${!!process.env.STRIPE_WEBHOOK_SECRET}`);

  // Pre-warm market data cache on startup so first user request is instant
  console.log(`Pre-warming market data cache...`);
  try {
    await warmTrackedMarketCache();
  } catch(e) {
    console.error("Cache warm-up failed:", e.message);
  }
});
