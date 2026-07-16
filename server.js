const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ─── CRF SYSTEM PROMPT ───────────────────────────────────────────
const SYSTEM_PROMPT = `
You are a trading analysis engine running the Catalyst Response Framework (CRF).
You will receive a ticker symbol and current market context.
You must run all 5 gates plus the sector gate and return ONLY valid JSON.

GATE 0 — SECTOR GATE
- Both SPY and QQQ flat or green = GREEN
- Either down >0.5% = YELLOW (cut size 50%)
- Either down >1% = RED (stand down)

GATE 1 — PRE-WINDOW EXHAUSTION (14-day run)
- Under +10% = GREEN
- +10% to +20% = YELLOW
- Over +20% = RED

GATE 2 — CATALYST CONGRUENCE
Classify as CANARY / SENTIMENT / FLOW:
- CANARY: European/institutional base, prices macro risk (ASML, TSMC, SAP)
- SENTIMENT: Moves with AI capex/sector mood (MU, NVDA, AMD, SMCI)
- FLOW: Moves on mechanical events, distributes at open (ALAB, IREN, high-beta)

GATE 3 — OPENING BAR
- Monday bullish engulf on volume = GREEN
- Friday = YELLOW (67% reversal frequency)
- Monday bearish engulf on heavy volume = RED
- Mid-week = GREEN by default

GATE 4 — PHASE
- Phase 1 (under 10% 14d run) = GREEN, full size
- Phase 2 (10-20% run) = YELLOW, half size
- Phase 3 (over 20% run) = RED, post-flush only

GATE 5 — KOREA PROXY (AI/semi only, else N/A GREEN)
- KOSPI green, no circuit breaker = GREEN
- KOSPI down 1-3% = YELLOW
- KOSPI down 3%+ or circuit breaker = RED

VERDICT RULES:
- All GREEN = UP, HIGH confidence
- Any RED = DOWN
- All GREEN + 1 YELLOW = UP, MEDIUM confidence
- 2+ YELLOW = DOWN, LOW confidence

Return ONLY this JSON, no markdown, no other text:
{
  "ticker": "SYMBOL",
  "type": "CANARY|SENTIMENT|FLOW",
  "verdict": "UP|DOWN",
  "confidence": "HIGH|MEDIUM|LOW",
  "reason": "One sentence max.",
  "gates": {
    "sector":      { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g1_prewindow":{ "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g2_catalyst": { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g3_openbar":  { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g4_phase":    { "status": "GREEN|YELLOW|RED", "note": "brief" },
    "g5_korea":    { "status": "GREEN|YELLOW|RED|N/A", "note": "brief" }
  },
  "sizing": "FULL|HALF|QUARTER|NONE",
  "wait_for": "null or brief description"
}
`;

// ─── FETCH LIVE QUOTE ─────────────────────────────────────────────
async function fetchQuote(symbol) {
  try {
    // Use Yahoo Finance v7 with full browser headers
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketChange`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://finance.yahoo.com",
        "Origin": "https://finance.yahoo.com",
      },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const quote = data?.quoteResponse?.result?.[0];
    if (!quote) throw new Error("No quote data");

    const pct  = quote.regularMarketChangePercent || 0;
    const sign = pct >= 0 ? "+" : "";
    return {
      price:     (quote.regularMarketPrice || 0).toFixed(2),
      change:    `${sign}${pct.toFixed(2)}%`,
      pct,
      direction: pct >= 0.5 ? "green" : pct <= -0.5 ? "red" : "flat",
    };
  } catch (e) {
    console.error(`fetchQuote ${symbol}:`, e.message);
    return null;
  }
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Trade Verdict API", version: "1.2.0" });
});

// ─── MARKET DATA ENDPOINT ─────────────────────────────────────────
app.get("/market", async (req, res) => {
  try {
    const symbols = ["SPY", "QQQ", "BTC-USD", "IWM", "SOXX", "XBI"];
    const results = await Promise.allSettled(symbols.map(s => fetchQuote(s)));

    const [spy, qqq, btc, iwm, soxx, xbi] = results.map(r =>
      r.status === "fulfilled" ? r.value : null
    );

    const spyPct = spy?.pct || 0;
    const qqqPct = qqq?.pct || 0;
    const btcPct = btc?.pct || 0;

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

    res.json({
      spy:  spy  || { price: "?", change: "?", direction: "flat" },
      qqq:  qqq  || { price: "?", change: "?", direction: "flat" },
      btc:  btc  || { price: "?", change: "?", direction: "flat" },
      iwm:  iwm  || { price: "?", change: "?", direction: "flat" },
      soxx: soxx || { price: "?", change: "?", direction: "flat" },
      xbi:  xbi  || { price: "?", change: "?", direction: "flat" },
      gateStatus,
      gateNote,
      btcSignal,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ANALYZE ENDPOINT ─────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  const { ticker, sectorContext, marketContext } = req.body;

  if (!ticker) {
    return res.status(400).json({ error: "ticker is required" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not set in environment variables" });
  }

  const userMessage = `
Analyze ${ticker.toUpperCase()} for a trade entry decision right now.

Live market data:
- SPY: ${sectorContext?.spy || "?"} (${sectorContext?.spyChange || "?"})
- QQQ: ${sectorContext?.qqq || "?"} (${sectorContext?.qqqChange || "?"})
- BTC: ${sectorContext?.btc || "?"} (${sectorContext?.btcChange || "?"})
- IWM: ${sectorContext?.iwm || "?"}
- SOXX: ${sectorContext?.soxx || "?"}
- XBI: ${sectorContext?.xbi || "?"}
- Sector gate: ${sectorContext?.gateStatus || "unknown"}
- BTC signal: ${sectorContext?.btcSignal || "neutral"}
- Today: ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" })}

Additional context: ${marketContext || "None"}

Run all 6 gates against ${ticker.toUpperCase()}. Be decisive. Return only the JSON.
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
      console.error("Anthropic error:", errText);
      return res.status(502).json({ error: "Anthropic API error", detail: errText });
    }

    const data  = await response.json();
    const text  = data.content?.[0]?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();

    try {
      res.json(JSON.parse(clean));
    } catch {
      res.status(500).json({ error: "Failed to parse AI response", raw: text });
    }
  } catch (err) {
    console.error("Analyze error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Trade Verdict API v1.2.0 running on port ${PORT}`);
  console.log(`API key configured: ${!!process.env.ANTHROPIC_API_KEY}`);
});
