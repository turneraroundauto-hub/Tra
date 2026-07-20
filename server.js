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

const express = require("express");
const cors    = require("cors");
const app     = express();

app.use(cors());
app.use(express.json());

// ─── SECRET TOKEN ─────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === "/") return next();
  const secret   = process.env.APP_SECRET;
  if (!secret)   return next();
  const provided = req.headers["x-app-secret"] || req.query.secret;
  if (provided !== secret) return res.status(401).json({ error: "Unauthorized" });
  next();
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

// ─── SYSTEM PROMPT ────────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are a trading analysis engine running the Catalyst Response Framework (CRF).
Return ONLY valid JSON. No markdown, no explanation.

IMPORTANT RULES:
- Gate 0 status is PRE-DETERMINED by the server. Use exactly the status provided. Never override it.
- Gate 5 proxy is PRE-DETERMINED by the server. Use exactly the proxy and status provided.
- Temperature is 0 — be deterministic. Same data = same verdict every time.
- When market is closed, return verdict FLAT with reason "Market closed".
- News headlines provided ARE potential catalysts — treat them as Gate 2 evidence.

GATE 1 — PRE-WINDOW EXHAUSTION (52-week range position proxy)
- Range position under 30% = GREEN (Phase 1, minimal exhaustion)
- Range position 30-70% = YELLOW (Phase 2, partial exhaustion)
- Range position over 70% = RED (Phase 3, high exhaustion risk)
- No data = estimate from what you know

GATE 2 — CATALYST CONGRUENCE (Canary/Sentiment/Flow + news)
- Classify ticker as CANARY, SENTIMENT, or FLOW
- If recent news provided: positive catalyst (deal, approval, beat) = GREEN lean
- Negative news (downgrade, miss, regulatory) = RED lean
- No news or neutral = assess based on sector conditions only
- Put/call skew >+3pts = bearish lean; <-3pts = bullish lean

GATE 3 — OPENING BAR
- Monday with bullish engulf on volume = GREEN
- Friday = YELLOW (67% reversal frequency on non-catalyst Fridays)
- Monday with bearish engulf on heavy volume = RED
- Weekend/holiday = YELLOW (no opening bar available)
- Mid-week = GREEN by default

GATE 4 — PHASE (from range position and beta)
- Phase 1 (range <30%, low beta) = GREEN, full size
- Phase 2 (range 30-70%) = YELLOW, half size
- Phase 3 (range >70%, high beta) = RED, post-flush only

VERDICT RULES:
- All GREEN = UP, HIGH confidence
- Any RED gate = DOWN
- All GREEN + 1 YELLOW = UP, MEDIUM
- 2+ YELLOW = FLAT (hold — mixed signals)
- Market closed = FLAT always

UP = bullish directional edge (long bias)
DOWN = bearish directional edge (short bias or defined risk play)
FLAT = mixed signals, no clear edge — wait for confirmation

Return ONLY:
{
  "ticker": "SYMBOL",
  "type": "CANARY|SENTIMENT|FLOW",
  "verdict": "UP|DOWN|FLAT",
  "confidence": "HIGH|MEDIUM|LOW",
  "reason": "One sentence — the single most important reason.",
  "gates": {
    "sector":       { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g1_prewindow": { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g2_catalyst":  { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g3_openbar":   { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g4_phase":     { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g5_korea":     { "status": "GREEN|YELLOW|RED", "note": "include proxy name and why" }
  },
  "sizing": "FULL|HALF|QUARTER|NONE",
  "wait_for": "null or one brief sentence"
}
`;

const PULSE_PROMPT = `
You are a market analyst. Write exactly 2 sentences summarizing sector rotation.
Sentence 1: what is leading and lagging with specific % numbers.
Sentence 2: the rotation signal for a swing trader right now.
No bullets. No labels. Plain sentences only. Return only the text.
`;

// ─── FINNHUB HELPERS ──────────────────────────────────────────────
const FH_KEY = () => process.env.FINNHUB_KEY;

async function finnhubGet(path) {
  const key = FH_KEY();
  if (!key) throw new Error("No FINNHUB_KEY");
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`https://finnhub.io/api/v1${path}${sep}token=${key}`,
    { headers: { "User-Agent": "TradeVerdict/4.0" } });
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

async function fetchCompanyProfile(symbol) {
  try {
    return await finnhubGet(`/stock/profile2?symbol=${symbol}`);
  } catch(e) { return null; }
}

async function fetchTickerMetrics(symbol) {
  try {
    const [quote, metric, profile] = await Promise.allSettled([
      finnhubGet(`/quote?symbol=${symbol}`),
      finnhubGet(`/stock/metric?symbol=${symbol}&metric=all`),
      fetchCompanyProfile(symbol),
    ]);
    const q = quote.status  === "fulfilled" ? quote.value  : null;
    const m = metric.status === "fulfilled" ? metric.value : null;
    const p = profile.status=== "fulfilled" ? profile.value: null;

    if (!q?.c) throw new Error("No quote");
    const price    = q.c;
    const week52hi = m?.metric?.["52WeekHigh"] || null;
    const week52lo = m?.metric?.["52WeekLow"]  || null;
    const beta     = m?.metric?.beta            || null;
    let rangePosition = null;
    if (week52hi && week52lo && week52hi !== week52lo) {
      rangePosition = Math.round((price - week52lo) / (week52hi - week52lo) * 100);
    }
    return {
      price, week52hi, week52lo, beta,
      rangePosition,
      phaseProxy: rangePosition !== null
        ? rangePosition > 70 ? "PHASE_3"
        : rangePosition > 30 ? "PHASE_2" : "PHASE_1"
        : null,
      sectorInfo: p,
    };
  } catch(e) {
    console.error(`fetchTickerMetrics ${symbol}:`, e.message);
    return null;
  }
}

const MAX_NEWS_AGE_HOURS = 300; // 14 days / last business week

async function fetchNews(symbol) {
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
    const res = await fetch("https://api.anthropic.com/v1/messages", {
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
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch(e) { return null; }
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────
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

    let gateStatus = "GREEN", gateNote = "SPY and QQQ flat or green — proceed";
    if (spyPct <= -1 || qqqPct <= -1) {
      gateStatus = "RED";
      gateNote   = `SPY ${data.spy?.change||"?"} QQQ ${data.qqq?.change||"?"} — both down >1%, stand down`;
    } else if (spyPct <= -0.5 || qqqPct <= -0.5) {
      gateStatus = "YELLOW";
      gateNote   = `SPY ${data.spy?.change||"?"} QQQ ${data.qqq?.change||"?"} — down >0.5%, cut size 50%`;
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
    const pulse      = marketOpen ? await generatePulse(data) : null;

    const result = {
      ...data, gateStatus, gateNote, btcSignal, tsmWarning,
      marketOpen, pulse,
      timestamp: new Date().toISOString(), cached: false,
    };
    marketCache = result;
    cacheTime   = Date.now();
    res.json(result);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TICKER DATA ──────────────────────────────────────────────────
app.get("/ticker/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const [metricsRes, newsRes] = await Promise.allSettled([
      fetchTickerMetrics(symbol),
      fetchNews(symbol),
    ]);
    const metrics = metricsRes.status === "fulfilled" ? metricsRes.value : null;
    const news    = newsRes.status    === "fulfilled" ? newsRes.value    : null;

    // Classify proxy using smart algorithm
    const proxyRule = classifyTicker(symbol, metrics?.sectorInfo);

    res.json({ symbol, metrics, news, proxyRule, timestamp: new Date().toISOString() });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ANALYZE ──────────────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  const { ticker, sectorContext, marketContext, metricsData, newsData, proxyRule } = req.body;
  if (!ticker) return res.status(400).json({ error: "ticker is required" });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  // ── GATE 0 — PRE-DETERMINED ───────────────────────────────────────
  const gate0Status = sectorContext?.gateStatus || "GREEN";
  const gate0Note   = sectorContext?.gateNote   || "Sector data unavailable";

  // ── GATE 5 — SMART PROXY PRE-DETERMINED ──────────────────────────
  const rule        = proxyRule || DEFAULT_PROXY;
  const gate5Result = evaluateProxyStatus(rule, sectorContext || {});

  // ── BUILD NEWS CONTEXT ────────────────────────────────────────────
  let newsContext = "No news within the last business week (300 hours).";
  if (newsData && newsData.ageHours <= MAX_NEWS_AGE_HOURS) {
    newsContext = `Recent news (${newsData.ageLabel}): "${newsData.headline}" — treat this as a potential catalyst for Gate 2 analysis.`;
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

GATE 0 — USE EXACTLY THIS (do not recalculate):
Status: ${gate0Status}
Note: ${gate0Note}

GATE 5 — USE EXACTLY THIS (do not recalculate):
Status: ${gate5Result.status}
Note: ${gate5Result.note}

Market data for Gates 1-4 context:
SPY ${sectorContext?.spy||"?"}, QQQ ${sectorContext?.qqq||"?"}, BTC ${sectorContext?.btc||"?"}
XBI ${sectorContext?.xbi||"?"}, IBB ${sectorContext?.ibb||"?"}, SOXX ${sectorContext?.soxx||"?"}
TSM ${sectorContext?.tsm||"?"}, MSFT ${sectorContext?.msft||"?"}
GLD ${sectorContext?.gld||"?"}, USO ${sectorContext?.uso||"?"}
BTC signal: ${sectorContext?.btcSignal||"neutral"}
Today: ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"short",day:"numeric",year:"numeric"})}

Ticker metrics: ${metricsContext}
News context: ${newsContext}
Additional context: ${marketContext || "None"}

Run Gates 1, 2, 3, 4 only. Gate 0 and Gate 5 are provided above — copy them exactly.
Return only JSON.
`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
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
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: `Anthropic error ${response.status}`, detail: errText });
    }

    const data  = await response.json();
    const text  = data.content?.[0]?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();

    try {
      const parsed = JSON.parse(clean);

      // ── SERVER ENFORCEMENT: Gate 0 ────────────────────────────────
      parsed.gates.sector = { status: gate0Status, note: gate0Note };

      // ── SERVER ENFORCEMENT: Gate 5 ────────────────────────────────
      parsed.gates.g5_korea = { status: gate5Result.status, note: gate5Result.note };

      // ── SERVER ENFORCEMENT: Verdict from Gate 0 ───────────────────
      if (gate0Status === "RED") {
        parsed.verdict    = "DOWN";
        parsed.reason     = `Sector gate RED — ${gate0Note}. Individual setup irrelevant until market stabilizes.`;
        if (parsed.confidence === "HIGH") parsed.confidence = "MEDIUM";
      }
      if (gate0Status === "YELLOW" && parsed.verdict === "UP") {
        parsed.confidence = "MEDIUM";
      }

      // ── SERVER ENFORCEMENT: Verdict from Gate 5 ───────────────────
      if (gate5Result.status === "RED" && parsed.verdict === "UP") {
        parsed.verdict    = "FLAT";
        parsed.confidence = "LOW";
        parsed.wait_for   = `${rule.proxy.name} to stabilize before entry.`;
      }

      res.json({ ...parsed, marketOpen: isMarketOpen() });
    } catch {
      res.status(500).json({ error: "Failed to parse AI response", raw: text });
    }
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Trade Verdict API v4.0.0 on port ${PORT}`);
  console.log(`Anthropic: ${!!process.env.ANTHROPIC_API_KEY}`);
  console.log(`Finnhub:   ${!!process.env.FINNHUB_KEY}`);
  console.log(`Secured:   ${!!process.env.APP_SECRET}`);
  console.log(`Market open: ${isMarketOpen()}`);
});
