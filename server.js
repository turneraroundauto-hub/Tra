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

async function resolveAuth(token) {
  const cached = authCache.get(token);
  if (cached && Date.now() - cached.time < AUTH_CACHE_MS) return cached.data;

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
                rationale:"AI/semi names lag Taiwan (TSM) and Korean (Samsung/SK Hynix) by 1-3 sessions. TSM drop >3% = stand down." },
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
const PRE_GATE_TRIGGERS = {
  solvency: {
    hardOrSoft: "hard",
    keywords: ["substantial doubt", "going concern"],
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
const PRE_GATE_FORMS = "8-K,10-Q,10-K";
const PRE_GATE_LOOKBACK_DAYS = 45;
const PRE_GATE_ESCALATION_WINDOW_DAYS = 30;
const PRE_GATE_ESCALATION_COUNT = 2;
const SEC_USER_AGENT = process.env.SEC_EDGAR_USER_AGENT || "TradeTribunal research contact@example.com";

// Ticker -> CIK map, refreshed daily. SEC's full-text search filters by CIK,
// not ticker symbol, so this is required to scope a search to one company.
let tickerCikCache = null;
let tickerCikCacheAt = 0;

async function getCik(symbol) {
  const now = Date.now();
  if (!tickerCikCache || now - tickerCikCacheAt > 24 * 60 * 60 * 1000) {
    try {
      const res = await fetchWithTimeout("https://www.sec.gov/files/company_tickers.json", {
        headers: { "User-Agent": SEC_USER_AGENT },
      }, 8000);
      if (!res.ok) throw new Error(`SEC company_tickers ${res.status}`);
      const data = await res.json();
      const map = {};
      Object.values(data).forEach(row => {
        map[String(row.ticker).toUpperCase()] = String(row.cik_str).padStart(10, "0");
      });
      tickerCikCache = map;
      tickerCikCacheAt = now;
    } catch (e) {
      console.error("getCik ticker map fetch:", e.message);
      if (!tickerCikCache) return null;
    }
  }
  return tickerCikCache[symbol.toUpperCase()] || null;
}

async function searchEdgarFilings(cik, keywords) {
  const startdt = new Date(Date.now() - PRE_GATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const enddt = new Date().toISOString().slice(0, 10);
  const q = keywords.map(k => `"${k}"`).join(" OR ");
  const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}` +
    `&ciks=${cik}&forms=${PRE_GATE_FORMS}&startdt=${startdt}&enddt=${enddt}`;
  try {
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": SEC_USER_AGENT } }, 8000);
    if (!res.ok) throw new Error(`EDGAR full-text search ${res.status}`);
    const data = await res.json();
    return data?.hits?.hits || [];
  } catch (e) {
    console.error(`searchEdgarFilings ${cik}:`, e.message);
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

    const allKeywords = Object.values(PRE_GATE_TRIGGERS).flatMap(t => t.keywords);
    const hits = await searchEdgarFilings(cik, allKeywords);
    if (!hits.length) {
      return { status: "GREEN", hardTrigger: false, note: "No solvency, dilution, or guidance-cut language found in recent SEC filings." };
    }

    // Classify each hit into a trigger category by keyword match against its
    // returned metadata (full-text search returns snippets/highlights, not
    // the full filing body).
    const matched = [];
    for (const hit of hits) {
      const text = `${(hit._source?.display_names || []).join(" ")} ${JSON.stringify(hit.highlight || hit._source || {})}`.toLowerCase();
      for (const [category, def] of Object.entries(PRE_GATE_TRIGGERS)) {
        if (def.keywords.some(kw => text.includes(kw))) {
          matched.push({ category, hardOrSoft: def.hardOrSoft, accession: hit._id });
        }
      }
    }
    if (!matched.length) {
      return { status: "GREEN", hardTrigger: false, note: "SEC filings matched search terms but none confirmed a hard/soft trigger category on closer classification." };
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
this RED carries forceDown override authority EQUIVALENT TO GATE 0 RED: it
forces the final verdict to DOWN regardless of any other gate, and is exempt
from the corroboration rule below.

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

GATE 4 — PHASE
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
QUARTER size when: 2 YELLOW gates, or Gate 2/5 incongruent
NONE / Defined risk only when: Any RED gate present

═══ VERDICT RULES ═══

The server enforces Pre-Gate, Gate 0, Gate 1, and Gate 5. You handle Gates 2-4 and congruency.

UP (bullish edge, long bias):
- Gate 0 GREEN (either strength) AND Gates 1,2,3,4 all GREEN or YELLOW
- At least one GREEN-STRONG gate among 1,2,4,5
- No RED gates
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

const MAX_NEWS_AGE_HOURS = 300; // 14 days / last business week

async function fetchFinnhubNews(symbol) {
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
    const item   = filtered[0];
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
async function fetchAlpacaNews(symbol) {
  if (!alpacaKeys()) return null;
  try {
    const now    = new Date();
    const cutoff = new Date(now.getTime() - MAX_NEWS_AGE_HOURS * 3600000);
    const data   = await alpacaGet(
      `/v1beta1/news?symbols=${symbol}&start=${cutoff.toISOString()}&end=${now.toISOString()}&limit=10&sort=desc`
    );
    const articles = data?.news;
    if (!Array.isArray(articles) || !articles.length) return null;
    const item     = articles[0]; // sort=desc -> most recent first
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
async function fetchNews(symbol) {
  const [fh, al] = await Promise.allSettled([
    fetchFinnhubNews(symbol),
    fetchAlpacaNews(symbol),
  ]);
  const finnhub = fh.status === "fulfilled" ? fh.value : null;
  const alpaca  = al.status === "fulfilled" ? al.value : null;
  if (!finnhub) return alpaca;
  if (!alpaca) return finnhub;
  return alpaca.ageHours <= finnhub.ageHours ? alpaca : finnhub;
}

// ─── EVALUATE PROXY STATUS ────────────────────────────────────────
function evaluateProxyStatus(proxyRule, marketData) {
  const symbols = proxyRule.proxy.symbols;
  const readings = symbols.map(s => {
    const key = s.toLowerCase();
    return marketData[key] || null;
  }).filter(Boolean);

  if (!readings.length) return { status: "GREEN", note: proxyRule.proxy.rationale };

  const avgPct = readings.reduce((a, b) => a + (b.pct || 0), 0) / readings.length;
  const anyRedFlag = readings.some(r => (r.pct || 0) <= -3);

  let status = "GREEN";
  if (anyRedFlag || avgPct <= -3)      status = "RED";
  else if (avgPct <= -1)               status = "YELLOW";

  const changeStr = readings.map((r, i) =>
    `${symbols[i]} ${r.change || "?"}`).join(", ");

  return {
    status,
    note: `${proxyRule.proxy.name}: ${changeStr}. ${proxyRule.proxy.rationale}`,
  };
}

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

// Maps a resolveFixedProxyBreak()-shaped result (fresh or reconstructed from
// a cached row) into a proxyRule-compatible object: evaluateProxyStatus() can
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

async function resolveGate5(symbol, metrics, tickerCloses, forceRecompute) {
  const staticRule = classifyTicker(symbol, metrics?.sectorInfo);
  if (staticRule !== DEFAULT_PROXY) {
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
        { month: "short", day: "numeric", year: "numeric" });
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
      gateNote   = `SPY ${data.spy?.change||"?"} QQQ ${data.qqq?.change||"?"} — both down >1%, broad market failure, stand down`;
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
      ? `⚠ TSM ${data.tsm?.change} — Taiwan semi stress, stand down AI/semi names`
      : null;

    let btcSignal = "neutral";
    if      (btcPct >=  2) btcSignal = "full conviction";
    else if (btcPct <= -5) btcSignal = "stand down";
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
const symbolMarketCache = new Map(); // symbol -> { data: {metrics,openingBar,dailyCloses,proxyRule}, time }
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
  const [metricsRes, barRes, gate1Res] = await Promise.allSettled([
    fetchTickerMetrics(symbol),
    fetchOpeningBar(symbol),
    fetchGate1Metrics(symbol),
  ]);
  const metrics     = metricsRes.status === "fulfilled" ? metricsRes.value : null;
  const openingBar  = barRes.status     === "fulfilled" ? barRes.value     : null;
  const dailyCloses = gate1Res.status   === "fulfilled" ? gate1Res.value   : null; // ascending closes, Patch 4

  // Gate 5 — static classification, falling through to the Dynamic Proxy
  // Resolution Algorithm (correlation + fundamentals loop) when ambiguous.
  const proxyRule = await resolveGate5(symbol, metrics, dailyCloses, hardTrigger);

  const marketEntry = { data: { metrics, openingBar, dailyCloses, proxyRule }, time: Date.now() };
  symbolMarketCache.set(symbol, marketEntry);
  return marketEntry;
}

// ─── TICKER DATA ──────────────────────────────────────────────────
app.get("/ticker/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    // ── NEWS — own 30-minute cadence, only while inside the 8am-8pm ET
    // window; outside it (or on a weekend night) the last-fetched headline
    // is served as-is rather than re-hit every load. A symbol with no cache
    // entry yet always fetches once regardless of the window (bootstrap).
    let newsEntry = newsCache.get(symbol);
    if (!newsEntry || (isNewsWindow() && Date.now() - newsEntry.time >= NEWS_REFRESH_MS)) {
      const news = await fetchNews(symbol).catch(() => null);
      newsEntry = { data: news, time: Date.now() };
      newsCache.set(symbol, newsEntry);
    }
    const news = newsEntry.data;

    // ── PRE-GATE — own 24h cache, fully decoupled from the price clock
    // below (see the comment on preGateCache above). A symbol with no cache
    // entry yet always fetches once regardless of age (bootstrap).
    let preGateEntry = preGateCache.get(symbol);
    if (!preGateEntry || Date.now() - preGateEntry.time >= PRE_GATE_REFRESH_MS) {
      const preGate = await evaluatePreGate(symbol);
      preGateEntry = { data: preGate, time: Date.now() };
      preGateCache.set(symbol, preGateEntry);
    }
    const preGate = preGateEntry.data;

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
    const { metrics, openingBar, dailyCloses, proxyRule } = marketEntry.data;

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

    res.json({ symbol, metrics, news, openingBar, proxyRule, gate1, preGate, iv, timestamp: new Date().toISOString() });
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
  const { ticker, sectorContext, marketContext, metricsData, newsData, openingBarData, proxyRule, gate1Data, preGateData } = req.body;
  if (!ticker) return res.status(400).json({ error: "ticker is required" });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

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
  const gate5Result = evaluateProxyStatus(rule, sectorContext || {});

  // ── GATE 1 — BIDIRECTIONAL TREND, PRE-DETERMINED ─────────────────
  // Computed server-side once in /ticker/:symbol and passed through here
  // untouched — same pattern as Gate 0/Gate 5. Never recalculated by the LLM.
  const gate1Result = gate1Data || evaluateGate1(null);

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

GATE 5 — USE EXACTLY THIS (do not recalculate):
Status: ${gate5Result.status}
Note: ${gate5Result.note}

Market data for Gates 2-4 context:
SPY ${sectorContext?.spy||"?"}, QQQ ${sectorContext?.qqq||"?"}, BTC ${sectorContext?.btc||"?"}
XBI ${sectorContext?.xbi||"?"}, IBB ${sectorContext?.ibb||"?"}, SOXX ${sectorContext?.soxx||"?"}
TSM ${sectorContext?.tsm||"?"}, MSFT ${sectorContext?.msft||"?"}
GLD ${sectorContext?.gld||"?"}, USO ${sectorContext?.uso||"?"}
BTC signal: ${sectorContext?.btcSignal||"neutral"}
Today: ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"short",day:"numeric",year:"numeric"})}

Ticker metrics: ${metricsContext}
News context: ${newsContext}
Gate 3 bar mode: ${barMode}
Opening bar context: ${barContext}
Additional context: ${marketContext || "None"}

Run Gates 2, 3, 4 only. Pre-Gate, Gate 0, Gate 1, and Gate 5 are provided above — copy them exactly.
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

      // ── SERVER ENFORCEMENT: Gate 5 ────────────────────────────────
      parsed.gates.g5_korea = { status: gate5Result.status, note: gate5Result.note };

      // ── SERVER ENFORCEMENT: Pre-Gate forceDown ────────────────────
      // No corroboration required — solvency/dilution/guidance-cut risk has
      // override authority equivalent to Gate 0 RED. This is a hard
      // code-level override, not a prompt instruction, so it can't be missed.
      if (preGateResult.hardTrigger) {
        parsed.verdict    = "DOWN";
        parsed.sizing      = "NONE";
        parsed.confidence = "MEDIUM";
        parsed.reason      = `Pre-Gate thesis-integrity override — ${preGateResult.note}`;
        parsed.wait_for    = "Resolved solvency/dilution/guidance concern (or a new filing clearing it) required before re-evaluating.";
      }

      // ── SERVER ENFORCEMENT: Gate 0 ────────────────────────────────
      if (gate0Status === "RED") {
        // Both SPY AND QQQ down >1% — genuine broad market failure
        parsed.verdict    = "DOWN";
        parsed.confidence = "MEDIUM";
        parsed.reason     = `Broad market failure — ${gate0Note}. No entries until market stabilizes.`;
      } else if (gate0Status === "YELLOW" && parsed.verdict === "UP") {
        // Sector rotation or mild headwind — cap confidence
        parsed.confidence = "MEDIUM";
      }

      // ── SERVER ENFORCEMENT: Gate 1 forceDown ──────────────────────
      // 60-day structural breakdown >25% has override authority equivalent
      // to Gate 0 RED. Forces DOWN regardless of any other gate, sizing NONE,
      // and skips the corroboration check below entirely — this is a hard
      // code-level override, not a prompt instruction, so it can't be missed.
      if (gate1Result.forceDown) {
        parsed.verdict    = "DOWN";
        parsed.sizing      = "NONE";
        parsed.confidence = "MEDIUM";
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
      // Proposal 3 (regimeValidation) is NOT wired yet — it needs its own
      // weekly-cadence persistence layer (flagged, not built, this pass).
      // regime stays null; hasForceDownAuthority treats that as "no regime
      // signal, proceed normally."
      const regime = null;
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
        if (tickerGating.length && metricsData?.pct != null && sectorContext?.tsm?.pct != null) {
          const coherence = gx.proxyCoherenceCheck(metricsData.pct, sectorContext.tsm.pct);
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
            parsed.confidence = "MEDIUM";
          } else {
            parsed.confidence = "LOW";
          }
        } else {
          gate5ForceDown    = true;
          parsed.verdict    = "DOWN";
          parsed.sizing      = "NONE";
          parsed.confidence = "MEDIUM";
          parsed.reason      = `Gate 5 forceDown — ${gate5Result.note}`;
          parsed.wait_for    = `${rule.proxy.name} must stabilize before re-evaluating.`;
        }
      } else if (gate5Result.status === "RED") {
        // Not independently exempt — original congruency-only handling.
        // Gate 5 RED alone = FLAT (sector stress, not confirmed downtrend)
        // Gate 5 RED + Gate 2 RED = DOWN (double negative, congruent bearish)
        if (g2Status === "RED") {
          parsed.verdict    = "DOWN";
          parsed.confidence = "MEDIUM";
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
      // of them can force DOWN on its own.)
      const g1Status = parsed.gates?.g1_prewindow?.status || "GREEN";
      const g4Status = parsed.gates?.g4_phase?.status || "GREEN";
      const downForceAuthorized = preGateResult.hardTrigger || gate0Status === "RED" || gate1Result.forceDown || gate5ForceDown;
      if (parsed.verdict === "DOWN" && !downForceAuthorized) {
        // DOWN without an exempt gate requires corroboration
        const redCount = [g1Status, g2Status, g4Status, gate5Result.status]
          .filter(x => x === "RED").length;
        if (redCount < 2) {
          // Single non-exempt RED gate — not enough for DOWN
          parsed.verdict    = "FLAT";
          parsed.confidence = "LOW";
          parsed.wait_for   = parsed.wait_for || "Additional confirmation needed before directional entry.";
        }
      }

      const result = { ...parsed, marketOpen: isMarketOpen() };
      setCache(cacheKey, result);
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
    const { data, error } = await authClient().auth.signUp({ email, password });
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
  if (spyPct <= -1 || qqqPct <= -1) { gateStatus = "RED"; gateNote = `SPY ${data.spy?.change||"?"} QQQ ${data.qqq?.change||"?"} — both down >1%, stand down`; }
  else if (spyPct <= -0.5 || qqqPct <= -0.5) { gateStatus = "YELLOW"; gateNote = `SPY ${data.spy?.change||"?"} QQQ ${data.qqq?.change||"?"} — down >0.5%, cut size 50%`; }
  let btcSignal = "neutral";
  if (btcPct >= 2) btcSignal = "full conviction";
  else if (btcPct <= -5) btcSignal = "stand down";
  else if (btcPct <= -2) btcSignal = "reduce size";
  const tsmWarning = tsmPct <= -3 ? `⚠ TSM ${data.tsm?.change} — Taiwan semi stress, stand down AI/semi names` : null;
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
