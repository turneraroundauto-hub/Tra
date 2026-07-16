const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

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

// ─── FETCH SINGLE QUOTE via Alpha Vantage ─────────────────────────
async function fetchQuote(symbol) {
  const key = process.env.ALPHA_VANTAGE_KEY;
  if (!key) {
    console.error("No ALPHA_VANTAGE_KEY set");
    return null;
  }
  try {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${key}`;
    console.log(`Fetching ${symbol} from Alpha Vantage...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Log raw response to debug
    console.log(`${symbol} raw:`, JSON.stringify(data).substring(0, 200));

    const quote = data["Global Quote"];
    if (!quote) throw new Error("No Global Quote in response");

    const priceStr  = quote["05. price"];
    const changeStr = quote["10. change percent"];
    if (!priceStr) throw new Error("No price field");

    const price = parseFloat(priceStr);
    const pct   = parseFloat((changeStr || "0").replace("%", ""));
    const sign  = pct >= 0 ? "+" : "";

    return {
      price:     price.toFixed(2),
      change:    `${sign}${pct.toFixed(2)}%`,
      pct,
      direction: pct >= 0.5 ? "green" : pct <= -0.5 ? "red" : "flat",
    };
  } catch (e) {
    console.error(`fetchQuote ${symbol} error:`, e.message);
    return null;
  }
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Trade Verdict API",
    version: "1.7.0",
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    alphaVantage: !!process.env.ALPHA_VANTAGE_KEY,
  });
});

// ─── TEST ENDPOINT — fetch just SPY to verify Alpha Vantage ───────
app.get("/test", async (req, res) => {
  const quote = await fetchQuote("SPY");
  res.json({ spy: quote, alphaVantageKey: !!process.env.ALPHA_VANTAGE_KEY });
});

// ─── MARKET DATA — no cache, always fresh ─────────────────────────
app.get("/market", async (req, res) => {
  try {
    const tickers = [
      { symbol: "SPY",  key: "spy"  },
      { symbol: "QQQ",  key: "qqq"  },
      { symbol: "BTC",  key: "btc"  },
      { symbol: "IWM",  key: "iwm"  },
      { symbol: "SOXX", key: "soxx" },
      { symbol: "XBI",  key: "xbi"  },
    ];

    const data = {};
    for (const t of tickers) {
      const q = await fetchQuote(t.symbol);
      data[t.key] = q || { price: "?", change: "?", direction: "flat", pct: 0 };
      await new Promise(r => setTimeout(r, 1200)); // 1.2s between calls
    }

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

    res.json({ ...data, gateStatus, gateNote, btcSignal, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error("Market endpoint error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── ANALYZE ──────────────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  const { ticker, sectorContext, marketContext } = req.body;
  if (!ticker) return res.status(400).json({ error: "ticker is required" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const userMessage = `
Analyze ${ticker.toUpperCase()} for a trade entry decision right now.

Live market data:
- SPY: ${sectorContext?.spyChange || sectorContext?.spy || "?"}
- QQQ: ${sectorContext?.qqqChange || sectorContext?.qqq || "?"}
- BTC: ${sectorContext?.btcChange || sectorContext?.btc || "?"}
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Trade Verdict API v1.7.0 on port ${PORT}`);
  console.log(`Anthropic key: ${!!process.env.ANTHROPIC_API_KEY}`);
  console.log(`Alpha Vantage key: ${!!process.env.ALPHA_VANTAGE_KEY}`);
  if (process.env.ALPHA_VANTAGE_KEY) {
    console.log(`AV key prefix: ${process.env.ALPHA_VANTAGE_KEY.substring(0, 6)}...`);
  }
});
