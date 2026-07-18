// ═══════════════════════════════════════════════════════════════
// TRADE VERDICT API — v3.0.0
// Built July 18, 2026
// Changes from v2.0:
//   - APP_SECRET token protection on all endpoints
//   - IV (ATM implied volatility) via Polygon options chain
//   - Put/call skew from Polygon (Gate 2 + Gate 4 real data)
//   - Expected move calculation (1-sigma, 30-day)
//   - Latest news headline per ticker via Polygon news API
//   - GLD, USO, IBB, NVDA added to market fetch
//   - Sector pulse blurb via Claude
// ═══════════════════════════════════════════════════════════════

const express = require("express");
const cors    = require("cors");
const app     = express();

app.use(cors());
app.use(express.json());

// ─── SECRET TOKEN MIDDLEWARE ──────────────────────────────────────
// All endpoints except health check require X-App-Secret header
// Set APP_SECRET in Render environment variables
app.use((req, res, next) => {
  if (req.path === "/") return next(); // health check always open
  const secret = process.env.APP_SECRET;
  if (!secret) return next(); // if not configured, skip (dev mode)
  const provided = req.headers["x-app-secret"] || req.query.secret;
  if (provided !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ─── CRF SYSTEM PROMPT ───────────────────────────────────────────
const SYSTEM_PROMPT = `
You are a trading analysis engine running the Catalyst Response Framework (CRF).
You will receive a ticker symbol, current market context, and real options data.
You must run all 5 gates plus the sector gate and return ONLY valid JSON.

IMPORTANT: When real options data is provided (IV, skew, expected move),
use it to override your estimates for Gate 1 and Gate 4. Real data beats estimates.

GATE 0 — SECTOR GATE
- Both SPY and QQQ flat or green = GREEN
- Either down >0.5% = YELLOW (cut size 50%)
- Either down >1% = RED (stand down)

GATE 1 — PRE-WINDOW EXHAUSTION (14-day run)
- Under +10% = GREEN
- +10% to +20% = YELLOW
- Over +20% = RED
- If IV Rank proxy >80% (ATM IV >> HV): lean toward YELLOW/RED

GATE 2 — CATALYST CONGRUENCE
Classify as CANARY / SENTIMENT / FLOW.
If put/call skew provided:
- Skew > +3pts (puts richer): bearish lean → more likely contrarian for longs
- Skew < -3pts (calls richer): bullish lean → congruent for longs
- Flat (±3pts): neutral

GATE 3 — OPENING BAR
- Monday bullish engulf on volume = GREEN
- Friday = YELLOW (67% reversal frequency)
- Monday bearish engulf = RED
- Mid-week = GREEN by default

GATE 4 — PHASE IDENTIFICATION
- If ATM IV provided and ATM IV > 80%: strong Phase 3 signal → RED or YELLOW
- If ATM IV provided and ATM IV < 35%: Phase 1 signal → GREEN
- Phase 1 (under 10% 14d run, low IV) = GREEN, full size
- Phase 2 (10-20% run, moderate IV) = YELLOW, half size
- Phase 3 (over 20% run, high IV) = RED, post-flush only

GATE 5 — KOREA PROXY (AI/semi only, else N/A GREEN)
- KOSPI green, no circuit breaker = GREEN
- KOSPI down 1-3% = YELLOW
- KOSPI down 3%+ or circuit breaker = RED

VERDICT RULES:
- All GREEN = UP, HIGH confidence
- Any RED = DOWN
- All GREEN + 1 YELLOW = UP, MEDIUM confidence
- 2+ YELLOW = DOWN, LOW confidence

Also determine:
- trend: "UP" | "DOWN" | "FLAT" (based on all available data)
- FLAT means: sector gate green but no clear directional edge, mixed signals

Return ONLY this JSON:
{
  "ticker": "SYMBOL",
  "type": "CANARY|SENTIMENT|FLOW",
  "verdict": "UP|DOWN|FLAT",
  "confidence": "HIGH|MEDIUM|LOW",
  "reason": "One sentence max.",
  "gates": {
    "sector":       { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g1_prewindow": { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g2_catalyst":  { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g3_openbar":   { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g4_phase":     { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g5_korea":     { "status": "GREEN|YELLOW|RED|N/A", "note": "brief" }
  },
  "sizing": "FULL|HALF|QUARTER|NONE",
  "wait_for": "null or brief description"
}
`;

const PULSE_PROMPT = `
You are a market analyst writing a 2-3 sentence sector pulse for a swing trader.
Write a plain-English summary of what is leading, lagging, and the rotation signal.
Be direct and specific. Use actual numbers. No fluff. No bullet points.
Focus on AI/tech vs biotech vs commodities vs crypto.
Return ONLY the blurb text — no JSON, no labels, no quotes.
`;

// ─── POLYGON FETCH HELPERS ────────────────────────────────────────
async function polygonFetch(path) {
  const key = process.env.POLYGON_KEY;
  if (!key) throw new Error("No POLYGON_KEY");
  const url = `https://api.polygon.io${path}${path.includes("?") ? "&" : "?"}apiKey=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polygon HTTP ${res.status}: ${path}`);
  return res.json();
}

// Previous-day close for price % change
async function fetchQuote(symbol) {
  try {
    const data = await polygonFetch(`/v2/aggs/ticker/${symbol}/prev?adjusted=true`);
    if (!data.results?.length) throw new Error("No results");
    const bar  = data.results[0];
    const pct  = ((bar.c - bar.o) / bar.o) * 100;
    const sign = pct >= 0 ? "+" : "";
    return {
      price:     bar.c.toFixed(2),
      change:    `${sign}${pct.toFixed(2)}%`,
      pct,
      direction: pct >= 0.5 ? "green" : pct <= -0.5 ? "red" : "flat",
    };
  } catch(e) {
    console.error(`fetchQuote ${symbol}:`, e.message);
    return null;
  }
}

// ATM IV and put/call skew from options chain
async function fetchOptionsData(symbol) {
  try {
    // Get current price first
    const quoteData = await polygonFetch(`/v2/last/trade/${symbol}`);
    const price = quoteData?.results?.p;
    if (!price) throw new Error("No price");

    // Get nearest expiry options (7-30 days out)
    const today      = new Date();
    const expFrom    = new Date(today.getTime() + 7  * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const expTo      = new Date(today.getTime() + 35 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const strikeMin  = (price * 0.95).toFixed(0);
    const strikeMax  = (price * 1.05).toFixed(0);

    const chainData = await polygonFetch(
      `/v3/reference/options/contracts?underlying_ticker=${symbol}&expiration_date.gte=${expFrom}&expiration_date.lte=${expTo}&strike_price.gte=${strikeMin}&strike_price.lte=${strikeMax}&limit=50`
    );
    const contracts = chainData?.results || [];
    if (!contracts.length) throw new Error("No contracts");

    // Find ATM call and put closest to current price
    let atmCall = null, atmPut = null, minCallDist = Infinity, minPutDist = Infinity;
    contracts.forEach(c => {
      const dist = Math.abs(c.strike_price - price);
      if (c.contract_type === "call" && dist < minCallDist) {
        minCallDist = dist; atmCall = c;
      }
      if (c.contract_type === "put" && dist < minPutDist) {
        minPutDist = dist; atmPut = c;
      }
    });

    if (!atmCall && !atmPut) throw new Error("No ATM contracts");

    // Fetch live quotes for ATM contracts
    let callIV = null, putIV = null;
    if (atmCall) {
      try {
        const cq = await polygonFetch(`/v3/snapshot/options/${symbol}/${atmCall.ticker}`);
        callIV = cq?.results?.implied_volatility * 100 || null;
      } catch(e) { console.error("callIV:", e.message); }
    }
    if (atmPut) {
      try {
        const pq = await polygonFetch(`/v3/snapshot/options/${symbol}/${atmPut.ticker}`);
        putIV = pq?.results?.implied_volatility * 100 || null;
      } catch(e) { console.error("putIV:", e.message); }
    }

    const atmIV  = callIV || putIV || null;
    const skew   = (putIV && callIV) ? (putIV - callIV) : null;

    // Expected move = price * ATM IV * sqrt(DTE/365)
    let expectedMove = null;
    if (atmIV && atmCall) {
      const expDate = new Date(atmCall.expiration_date);
      const dte     = Math.max(1, Math.round((expDate - today) / (1000 * 60 * 60 * 24)));
      expectedMove  = ((atmIV / 100) * price * Math.sqrt(dte / 365));
    }

    return {
      atmIV:        atmIV   ? parseFloat(atmIV.toFixed(1))   : null,
      callIV:       callIV  ? parseFloat(callIV.toFixed(1))  : null,
      putIV:        putIV   ? parseFloat(putIV.toFixed(1))   : null,
      skew:         skew    ? parseFloat(skew.toFixed(1))    : null,
      expectedMove: expectedMove ? parseFloat(expectedMove.toFixed(2)) : null,
      price,
    };
  } catch(e) {
    console.error(`fetchOptionsData ${symbol}:`, e.message);
    return null;
  }
}

// Latest news headline for a ticker
async function fetchNews(symbol) {
  try {
    const data = await polygonFetch(`/v2/reference/news?ticker=${symbol}&limit=1&order=desc`);
    const item = data?.results?.[0];
    if (!item) return null;
    return {
      headline:  item.title,
      url:       item.article_url,
      published: item.published_utc,
      source:    item.publisher?.name || "News",
    };
  } catch(e) {
    console.error(`fetchNews ${symbol}:`, e.message);
    return null;
  }
}

// ─── GENERATE SECTOR PULSE ────────────────────────────────────────
async function generatePulse(marketData) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const msg = `
Live market data:
AI/Tech: QQQ ${marketData.qqq?.change||"?"}, SOXX ${marketData.soxx?.change||"?"}, NVDA ${marketData.nvda?.change||"?"}
Biotech/Medical: XBI ${marketData.xbi?.change||"?"}, IBB ${marketData.ibb?.change||"?"}
Commodities: GLD ${marketData.gld?.change||"?"}, USO ${marketData.uso?.change||"?"}
Crypto: BTC ${marketData.btc?.change||"?"}
Broad: SPY ${marketData.spy?.change||"?"}, IWM ${marketData.iwm?.change||"?"}
Write 2-3 sentences: what is leading, lagging, rotation signal for a swing trader.
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
        max_tokens: 200,
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

// ─── HEALTH CHECK — no auth required ─────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status:    "ok",
    service:   "Trade Verdict API",
    version:   "3.0.0",
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    polygon:   !!process.env.POLYGON_KEY,
    secured:   !!process.env.APP_SECRET,
  });
});

// ─── MARKET + PULSE ───────────────────────────────────────────────
let marketCache = null;
let cacheTime   = 0;
const CACHE_MS  = 5 * 60 * 1000;

app.get("/market", async (req, res) => {
  const force = req.query.force === "true";
  if (!force && marketCache && Date.now() - cacheTime < CACHE_MS) {
    return res.json({ ...marketCache, cached: true });
  }
  try {
    const tickers = [
      { symbol: "SPY",      key: "spy"  },
      { symbol: "QQQ",      key: "qqq"  },
      { symbol: "X:BTCUSD", key: "btc"  },
      { symbol: "IWM",      key: "iwm"  },
      { symbol: "SOXX",     key: "soxx" },
      { symbol: "XBI",      key: "xbi"  },
      { symbol: "GLD",      key: "gld"  },
      { symbol: "USO",      key: "uso"  },
      { symbol: "IBB",      key: "ibb"  },
      { symbol: "NVDA",     key: "nvda" },
    ];

    const results = await Promise.allSettled(tickers.map(t => fetchQuote(t.symbol)));
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

// ─── TICKER DATA — IV, skew, news, price ─────────────────────────
app.get("/ticker/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const [optionsData, newsData] = await Promise.allSettled([
      fetchOptionsData(symbol),
      fetchNews(symbol),
    ]);
    res.json({
      symbol,
      options: optionsData.status === "fulfilled" ? optionsData.value : null,
      news:    newsData.status    === "fulfilled" ? newsData.value    : null,
      timestamp: new Date().toISOString(),
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ANALYZE ──────────────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  const { ticker, sectorContext, marketContext, optionsData } = req.body;
  if (!ticker) return res.status(400).json({ error: "ticker is required" });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  // Build options context string if available
  let optionsContext = "No options data available — use estimates.";
  if (optionsData) {
    const skewLabel = optionsData.skew === null ? "N/A"
      : optionsData.skew > 3  ? `+${optionsData.skew}pts (puts richer — bearish lean)`
      : optionsData.skew < -3 ? `${optionsData.skew}pts (calls richer — bullish lean)`
      : `${optionsData.skew}pts (flat — neutral)`;
    optionsContext = `
Real options data (use to override gate estimates):
- ATM IV: ${optionsData.atmIV !== null ? optionsData.atmIV + "%" : "N/A"}
- Put IV: ${optionsData.putIV !== null ? optionsData.putIV + "%" : "N/A"}
- Call IV: ${optionsData.callIV !== null ? optionsData.callIV + "%" : "N/A"}
- Put/Call Skew: ${skewLabel}
- Expected Move (1σ): ${optionsData.expectedMove !== null ? "±$" + optionsData.expectedMove : "N/A"}
`;
  }

  const userMessage = `
Analyze ${ticker.toUpperCase()} for a trade entry decision right now.

Live market data:
- SPY: ${sectorContext?.spy || "?"}
- QQQ: ${sectorContext?.qqq || "?"}
- BTC: ${sectorContext?.btc || "?"}
- IWM: ${sectorContext?.iwm || "?"}
- SOXX: ${sectorContext?.soxx || "?"}
- XBI: ${sectorContext?.xbi || "?"}
- GLD: ${sectorContext?.gld || "?"}
- USO: ${sectorContext?.uso || "?"}
- NVDA: ${sectorContext?.nvda || "?"}
- Sector gate: ${sectorContext?.gateStatus || "unknown"}
- BTC signal: ${sectorContext?.btcSignal || "neutral"}
- Today: ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" })}

${optionsContext}

Additional context: ${marketContext || "None"}

Run all 6 gates. Use real options data to override gate estimates where provided. Be decisive. Return only the JSON.
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
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: `Anthropic API error ${response.status}`, detail: errText });
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
  console.log(`Trade Verdict API v3.0.0 on port ${PORT}`);
  console.log(`Anthropic:  ${!!process.env.ANTHROPIC_API_KEY}`);
  console.log(`Polygon:    ${!!process.env.POLYGON_KEY}`);
  console.log(`Secured:    ${!!process.env.APP_SECRET}`);
});
