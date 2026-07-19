// ═══════════════════════════════════════════════════════════════
// TRADE VERDICT API — v3.1.0
// Updated July 18, 2026
// Changes from v3.0:
//   - Switched primary market data source from Polygon to Finnhub
//     Reason: Polygon free tier = 5 calls/min (insufficient)
//             Finnhub free tier = 60 calls/min (12x headroom)
//   - News age filter: skip any headline older than 300 hours (14 days)
//   - Simplified options data fetch via Finnhub quote endpoint
//   - Sector pulse retained via Anthropic
//   - All other features unchanged from v3.0
// ═══════════════════════════════════════════════════════════════

const express = require("express");
const cors    = require("cors");
const app     = express();

app.use(cors());
app.use(express.json());

// ─── SECRET TOKEN MIDDLEWARE ──────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === "/") return next();
  const secret   = process.env.APP_SECRET;
  if (!secret)   return next();
  const provided = req.headers["x-app-secret"] || req.query.secret;
  if (provided !== secret) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// ─── SYSTEM PROMPTS ───────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are a trading analysis engine running the Catalyst Response Framework (CRF).
You must run all 5 gates plus the sector gate and return ONLY valid JSON.

When real options data is provided (IV, skew), use it to override gate estimates.

GATE 0 — SECTOR: Both SPY/QQQ flat or green=GREEN, either down>0.5%=YELLOW, down>1%=RED
GATE 1 — PRE-WINDOW: 14d run under 10%=GREEN, 10-20%=YELLOW, over 20%=RED. High IV(>80%) lean YELLOW/RED
GATE 2 — CATALYST: Classify CANARY/SENTIMENT/FLOW. Skew>+3pts=bearish, <-3pts=bullish, flat=neutral
GATE 3 — OPENING BAR: Monday bull engulf=GREEN, Friday=YELLOW, Monday bear engulf=RED, mid-week=GREEN
GATE 4 — PHASE: ATM IV>80%=Phase3 RED, IV<35%=Phase1 GREEN. P1 full size, P2 half, P3 post-flush only
GATE 5 — KOREA: (AI/semi only) KOSPI green=GREEN, down 1-3%=YELLOW, down 3%+ or circuit breaker=RED

VERDICT: All GREEN=UP HIGH, any RED=DOWN, all GREEN+1 YELLOW=UP MEDIUM, 2+ YELLOW=FLAT (hold)
UP means bullish edge — long bias. DOWN means bearish edge — short bias or defined risk play. FLAT means mixed signals — no clear directional edge.
SIZING: FULL=strong conviction, HALF=moderate, QUARTER=weak/high risk, NONE=defined risk only (options, spreads).

Return ONLY this JSON:
{
  "ticker": "SYMBOL",
  "type": "CANARY|SENTIMENT|FLOW",
  "verdict": "UP|DOWN|FLAT",
  "confidence": "HIGH|MEDIUM|LOW",
  "reason": "One sentence max — the single most important reason.",
  "gates": {
    "sector":       { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g1_prewindow": { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g2_catalyst":  { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g3_openbar":   { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g4_phase":     { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g5_korea":     { "status": "GREEN|YELLOW|RED|N/A", "note": "brief" }
  },
  "sizing": "FULL|HALF|QUARTER|NONE",
  "wait_for": "null or one brief sentence"
}
`;

const PULSE_PROMPT = `
You are a market analyst. Write exactly 2 sentences summarizing sector rotation.
Sentence 1: what is leading and what is lagging, with specific % numbers.
Sentence 2: the rotation signal for a swing trader right now.
No bullets. No labels. Just two plain sentences.
Return only the text — no JSON, no quotes.
`;

// ─── FINNHUB HELPERS ──────────────────────────────────────────────
// Finnhub free tier: 60 calls/minute, real-time US quotes, no daily limit
const FINNHUB_KEY = () => process.env.FINNHUB_KEY;

async function finnhubGet(path) {
  const key = FINNHUB_KEY();
  if (!key) throw new Error("No FINNHUB_KEY");
  const url = `https://finnhub.io/api/v1${path}${path.includes("?") ? "&" : "?"}token=${key}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "TradeVerdict/3.1" },
  });
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}: ${path}`);
  return res.json();
}

// Real-time quote from Finnhub
async function fetchQuote(symbol) {
  try {
    // Finnhub uses different symbol for BTC
    const sym  = symbol === "X:BTCUSD" ? "BINANCE:BTCUSDT" : symbol;
    const data = await finnhubGet(`/quote?symbol=${sym}`);

    // Finnhub quote: c=current, pc=prev close, d=change, dp=change%
    if (!data.c || data.c === 0) throw new Error("No price data");

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

// Basic options-style IV from Finnhub quote metrics
// Finnhub doesn't have options on free tier, but we can get 52-week data
// and calculate a proxy for phase identification
async function fetchTickerMetrics(symbol) {
  try {
    const [quoteData, metricData] = await Promise.allSettled([
      finnhubGet(`/quote?symbol=${symbol}`),
      finnhubGet(`/stock/metric?symbol=${symbol}&metric=all`),
    ]);

    const quote  = quoteData.status  === "fulfilled" ? quoteData.value  : null;
    const metric = metricData.status === "fulfilled" ? metricData.value : null;

    if (!quote?.c) throw new Error("No quote");

    const price    = quote.c;
    const week52hi = metric?.metric?.["52WeekHigh"]  || null;
    const week52lo = metric?.metric?.["52WeekLow"]   || null;
    const beta     = metric?.metric?.beta             || null;

    // Calculate position in 52-week range as a phase proxy
    // 0% = at 52-week low (Phase 1), 100% = at 52-week high (Phase 3)
    let rangePosition = null;
    if (week52hi && week52lo && week52hi !== week52lo) {
      rangePosition = ((price - week52lo) / (week52hi - week52lo) * 100).toFixed(0);
    }

    // 14-day price change as pre-window exhaustion signal
    // Finnhub doesn't give 14d directly; we use the current vs prev patterns
    // Beta > 1.5 = high volatility name, increases phase 3 likelihood

    return {
      price,
      week52hi,
      week52lo,
      rangePosition: rangePosition ? parseInt(rangePosition) : null,
      beta,
      // Phase proxy from range position
      phaseProxy: rangePosition
        ? parseInt(rangePosition) > 75 ? "PHASE_3"
        : parseInt(rangePosition) > 40 ? "PHASE_2"
        : "PHASE_1"
        : null,
    };
  } catch(e) {
    console.error(`fetchTickerMetrics ${symbol}:`, e.message);
    return null;
  }
}

// News — filter to last 300 hours (14 days) only
const MAX_NEWS_AGE_HOURS = 300;

async function fetchNews(symbol) {
  try {
    const now      = new Date();
    const cutoff   = new Date(now.getTime() - MAX_NEWS_AGE_HOURS * 60 * 60 * 1000);
    const fromDate = cutoff.toISOString().split("T")[0];
    const toDate   = now.toISOString().split("T")[0];

    const data = await finnhubGet(
      `/company-news?symbol=${symbol}&from=${fromDate}&to=${toDate}`
    );

    if (!Array.isArray(data) || data.length === 0) return null;

    // Filter strictly to within 300 hours and sort newest first
    const filtered = data
      .filter(item => {
        const age = (now - new Date(item.datetime * 1000)) / (1000 * 60 * 60);
        return age <= MAX_NEWS_AGE_HOURS;
      })
      .sort((a, b) => b.datetime - a.datetime);

    if (!filtered.length) return null;

    const item    = filtered[0];
    const ageHrs  = Math.round((now - new Date(item.datetime * 1000)) / (1000 * 60 * 60));
    const ageLabel = ageHrs < 1 ? "just now"
      : ageHrs < 24 ? `${ageHrs}h ago`
      : `${Math.floor(ageHrs / 24)}d ago`;

    return {
      headline:  item.headline,
      url:       item.url,
      source:    item.source,
      ageLabel,
      ageHours:  ageHrs,
    };
  } catch(e) {
    console.error(`fetchNews ${symbol}:`, e.message);
    return null;
  }
}

// ─── SECTOR PULSE ─────────────────────────────────────────────────
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
        model: "claude-sonnet-4-6",
        max_tokens: 120,
        system: PULSE_PROMPT,
        messages: [{ role: "user", content: msg }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch(e) {
    console.error("generatePulse:", e.message);
    return null;
  }
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status:   "ok",
    service:  "Trade Verdict API",
    version:  "3.1.0",
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    finnhub:   !!process.env.FINNHUB_KEY,
    secured:   !!process.env.APP_SECRET,
    dataSource: "Finnhub (60 req/min free tier)",
  });
});

// ─── MARKET + PULSE ───────────────────────────────────────────────
let marketCache = null;
let cacheTime   = 0;
const CACHE_MS  = 4 * 60 * 1000; // 4 min — within Finnhub rate limits

app.get("/market", async (req, res) => {
  const force = req.query.force === "true";
  if (!force && marketCache && Date.now() - cacheTime < CACHE_MS) {
    return res.json({ ...marketCache, cached: true });
  }
  try {
    // Fetch all 10 symbols — at 60 req/min we have plenty of headroom
    const tickers = [
      { symbol: "SPY",            key: "spy"  },
      { symbol: "QQQ",            key: "qqq"  },
      { symbol: "BINANCE:BTCUSDT",key: "btc"  },
      { symbol: "IWM",            key: "iwm"  },
      { symbol: "SOXX",           key: "soxx" },
      { symbol: "XBI",            key: "xbi"  },
      { symbol: "GLD",            key: "gld"  },
      { symbol: "USO",            key: "uso"  },
      { symbol: "IBB",            key: "ibb"  },
      { symbol: "NVDA",           key: "nvda" },
    ];

    // Parallel fetch — Finnhub handles it at 60 req/min
    const results = await Promise.allSettled(
      tickers.map(t => fetchQuote(t.symbol))
    );
    const data = {};
    results.forEach((r, i) => {
      data[tickers[i].key] = r.status === "fulfilled" && r.value
        ? r.value
        : { price: "?", change: "?", direction: "flat", pct: 0 };
    });

    const spyPct = data.spy?.pct || 0;
    const qqqPct = data.qqq?.pct || 0;
    const btcPct = data.btc?.pct || 0;

    let gateStatus = "GREEN";
    let gateNote   = "SPY and QQQ flat or green — proceed";
    if (spyPct <= -1 || qqqPct <= -1) {
      gateStatus = "RED";
      gateNote   = "SPY or QQQ down >1% — stand down";
    } else if (spyPct <= -0.5 || qqqPct <= -0.5) {
      gateStatus = "YELLOW";
      gateNote   = "SPY or QQQ down >0.5% — cut size 50%";
    }

    let btcSignal = "neutral";
    if      (btcPct >=  2) btcSignal = "full conviction";
    else if (btcPct <= -5) btcSignal = "stand down";
    else if (btcPct <= -2) btcSignal = "reduce size";

    const pulse = await generatePulse(data);

    const result = {
      ...data, gateStatus, gateNote, btcSignal, pulse,
      timestamp: new Date().toISOString(), cached: false,
    };
    marketCache = result;
    cacheTime   = Date.now();
    res.json(result);
  } catch(err) {
    console.error("Market error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── TICKER DATA (metrics + news) ────────────────────────────────
app.get("/ticker/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const [metricsResult, newsResult] = await Promise.allSettled([
      fetchTickerMetrics(symbol),
      fetchNews(symbol),
    ]);
    res.json({
      symbol,
      metrics: metricsResult.status === "fulfilled" ? metricsResult.value : null,
      news:    newsResult.status    === "fulfilled" ? newsResult.value    : null,
      timestamp: new Date().toISOString(),
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ANALYZE ──────────────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  const { ticker, sectorContext, marketContext, metricsData } = req.body;
  if (!ticker) return res.status(400).json({ error: "ticker is required" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  // Build metrics context for gate override
  let metricsContext = "No enhanced metrics available — use AI estimates for phase.";
  if (metricsData) {
    metricsContext = `
Real market structure data (use to inform gate estimates):
- Current price: $${metricsData.price || "?"}
- 52-week high: $${metricsData.week52hi || "?"}
- 52-week low:  $${metricsData.week52lo || "?"}
- Range position: ${metricsData.rangePosition !== null ? metricsData.rangePosition + "% of 52-week range" : "N/A"}
- Phase proxy: ${metricsData.phaseProxy || "unknown"} (from 52-week range position)
- Beta: ${metricsData.beta || "?"}
Note: Range position >75% = likely Phase 3. 40-75% = Phase 2. Under 40% = Phase 1.
High beta (>2.0) increases phase 3 risk even at moderate range position.
`;
  }

  const userMessage = `
Analyze ${ticker.toUpperCase()} for a trade entry decision.

Live market data:
SPY ${sectorContext?.spy||"?"}, QQQ ${sectorContext?.qqq||"?"}, BTC ${sectorContext?.btc||"?"}
IWM ${sectorContext?.iwm||"?"}, SOXX ${sectorContext?.soxx||"?"}, XBI ${sectorContext?.xbi||"?"}
GLD ${sectorContext?.gld||"?"}, USO ${sectorContext?.uso||"?"}, NVDA ${sectorContext?.nvda||"?"}
Sector gate: ${sectorContext?.gateStatus||"unknown"}
BTC signal: ${sectorContext?.btcSignal||"neutral"}
Today: ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" })}

${metricsContext}

Additional context: ${marketContext || "None"}

Run all 6 gates. Use real data to override estimates where available. Return only JSON.
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
        model: "claude-sonnet-4-6",
        max_tokens: 800,
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
      res.json(JSON.parse(clean));
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
  console.log(`Trade Verdict API v3.1.0 on port ${PORT}`);
  console.log(`Anthropic: ${!!process.env.ANTHROPIC_API_KEY}`);
  console.log(`Finnhub:   ${!!process.env.FINNHUB_KEY}`);
  console.log(`Secured:   ${!!process.env.APP_SECRET}`);
  console.log(`Data source: Finnhub (60 req/min free tier)`);
});
