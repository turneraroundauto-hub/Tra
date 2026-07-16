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

THE 5 GATES + SECTOR GATE:

GATE 0 — SECTOR GATE
Check SPY and QQQ direction provided by the user:
- Both flat or green = GREEN
- Either down >0.5% = YELLOW (cut size 50%)
- Either down >1% = RED (stand down)

GATE 1 — PRE-WINDOW EXHAUSTION (14-day run)
- Under +10% = GREEN
- +10% to +20% = YELLOW
- Over +20% = RED (do not enter, wait for flush)

GATE 2 — CATALYST CONGRUENCE
Classify name as CANARY / SENTIMENT / FLOW:
- CANARY: European/institutional base, prices macro risk (ASML, TSMC, SAP, LVMH)
- SENTIMENT: Moves with AI capex/sector mood, ignores macro until it breaks (MU, NVDA, AMD, SMCI)
- FLOW: Moves on mechanical events, distributes at open on positive catalysts (ALAB, IREN, high-beta momentum)
Then assess if current catalyst context is congruent or contrarian for that type.
- Congruent setup = GREEN
- Mixed signals = YELLOW
- Contrarian setup = RED

GATE 3 — OPENING BAR (day of week signal)
- Monday with bullish engulf on volume = GREEN
- Friday = YELLOW (wait for bar-2 before entry, 67% reversal frequency)
- Monday with bearish engulf on heavy volume = RED
- Mid-week with no special pattern = GREEN by default

GATE 4 — PHASE IDENTIFICATION
- Phase 1 (Discovery, under 10% 14d run, underpriced thesis) = GREEN, full size
- Phase 2 (Acceleration, 10-20% run, enter pullbacks only) = YELLOW, half size
- Phase 3 (Priced for perfection, over 20% run, sell-the-news risk) = RED, post-flush only

GATE 5 — KOREA PROXY (AI/semiconductor names only)
- For non-AI/semi names: mark N/A and set status GREEN
- KOSPI green, no circuit breaker = GREEN
- KOSPI down 1-3% = YELLOW
- KOSPI down 3%+ or circuit breaker = RED

FINAL VERDICT RULES:
- All GREEN = THUMBS UP, HIGH confidence
- Any RED gate = THUMBS DOWN
- All GREEN + 1 YELLOW = THUMBS UP, MEDIUM confidence
- All GREEN + 2+ YELLOW = THUMBS DOWN, LOW confidence (too much uncertainty)
- Multiple YELLOW = THUMBS DOWN

Return ONLY this exact JSON structure, no markdown, no explanation, no other text:
{
  "ticker": "SYMBOL",
  "type": "CANARY|SENTIMENT|FLOW",
  "verdict": "UP|DOWN",
  "confidence": "HIGH|MEDIUM|LOW",
  "reason": "One sentence max. The single most important reason for this verdict.",
  "gates": {
    "sector": { "status": "GREEN|YELLOW|RED", "note": "one brief phrase" },
    "g1_prewindow": { "status": "GREEN|YELLOW|RED", "note": "one brief phrase" },
    "g2_catalyst": { "status": "GREEN|YELLOW|RED", "note": "one brief phrase" },
    "g3_openbar": { "status": "GREEN|YELLOW|RED", "note": "one brief phrase" },
    "g4_phase": { "status": "GREEN|YELLOW|RED", "note": "one brief phrase" },
    "g5_korea": { "status": "GREEN|YELLOW|RED|N/A", "note": "one brief phrase" }
  },
  "sizing": "FULL|HALF|QUARTER|NONE",
  "wait_for": "null or one sentence describing what to wait for if verdict is DOWN"
}
`;

// ─── HEALTH CHECK ────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Trade Verdict API", version: "1.0.0" });
});

// ─── ANALYZE ENDPOINT ────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  const { ticker, sectorContext, marketContext } = req.body;

  if (!ticker) {
    return res.status(400).json({ error: "ticker is required" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "API key not configured on server" });
  }

  const userMessage = `
Analyze ${ticker.toUpperCase()} for a trade entry decision right now.

Market context provided by the user:
- SPY: ${sectorContext?.spy || "unknown"}
- QQQ: ${sectorContext?.qqq || "unknown"}
- BTC: ${sectorContext?.btc || "unknown"}
- Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" })}

Additional context: ${marketContext || "None provided"}

Run all 6 gates (sector + G1-G5) against ${ticker.toUpperCase()} using your knowledge of this stock's recent behavior, sector classification, and any known catalysts. Be decisive. Return only the JSON.
`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
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
      const err = await response.text();
      return res.status(502).json({ error: "Anthropic API error", detail: err });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();

    try {
      const parsed = JSON.parse(clean);
      res.json(parsed);
    } catch {
      res.status(500).json({ error: "Failed to parse AI response", raw: text });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Trade Verdict API running on port ${PORT}`);
});
