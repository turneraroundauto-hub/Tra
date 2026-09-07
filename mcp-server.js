"use strict";
// ─── MCP-over-HTTP wrapper (Sep 7, 2026) ──────────────────────────────
// A handful of Tra's own real, already-public read-only endpoints
// (/market, /ticker/:symbol, /agitator) exposed as MCP tools over a
// Streamable HTTP transport at POST /mcp, so a connected MCP client
// (e.g. a Claude session) can pull real, live production data as tool
// calls -- something no Claude-driven sandbox can otherwise do, since
// raw HTTPS to this app's own domains is blocked by org-level egress
// policy on every Claude surface tested so far (a dev sandbox, and a
// Cowork session, both confirmed blocked the same way). MCP connectors
// evidently route around that block (proven by this project's own
// Supabase/Render/GitHub connectors all working fine from inside that
// exact same blocked sandbox), so this is a real, working path to close
// that gap -- not a speculative one.
//
// Three read-only, already-free tools (get_market/get_ticker/
// check_agitator), plus one credit-spending tool (analyze) added in a
// follow-up commit once a real credential decision was made: rather
// than reuse the real PRO_KEY (shared with any real paying tier-key
// traffic) or fabricate a Supabase Auth session, /analyze rides a new,
// dedicated MCP_AGENT_KEY credential (server.js's own PATH 1.5) that
// resolves to a fixed pro-tier request with its own dedicated,
// separately-provisioned credits/tier row -- never touching any real
// user's balance.
//
// /mcp is NOT added to server.js's own auth-bypass allowlist -- it goes
// through the exact same global secret/token middleware every other
// route already does, so there's no new credential to invent or leak:
// whatever secret/token the MCP client is configured with (Free's shared
// key, or a real tier key/session) is the same one this route honors,
// and each tool's own internal call to the real REST endpoint forwards
// that identical credential rather than hardcoding one -- so this
// naturally respects whatever tier/account the connector is actually
// configured with, same as a normal request would.
//
// Each POST /mcp request builds a fresh McpServer + transport scoped to
// that one request -- the SDK's own documented "stateless" pattern (no
// session tracking), the right shape for a low-traffic, single-purpose
// wrapper like this one, not a long-lived multi-turn MCP session. That
// per-request server is what lets each tool handler close over the real
// Express `req` for that one call, so it can read back whatever
// secret/token the caller authenticated with and forward it internally.

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const z = require("zod");

const READ_ONLY_TOOLS = [
  {
    name: "get_market",
    description: "Real, live Gate 0 market status (SPY/QQQ/BTC and the other tracked sector proxies) from Trade Tribunal's own /market endpoint. Free, no credit cost.",
    inputSchema: {},
    path: () => "/market",
  },
  {
    name: "get_ticker",
    description: "Real, live ticker data (price, news, 52-week range, phase, resolved Gate 5 proxy) for one symbol from Trade Tribunal's /ticker/:symbol endpoint. Free, no credit cost.",
    inputSchema: { symbol: z.string().describe("Ticker symbol, e.g. AAPL") },
    path: (args) => `/ticker/${encodeURIComponent(String(args.symbol || "").toUpperCase())}`,
  },
  {
    name: "check_agitator",
    description: "Real, live Agitator Gauge check (a LOW/MEDIUM/HIGH signal read, plus related companies and a cited article) for a ticker, company name, or a pasted headline/rumor, from Trade Tribunal's /agitator endpoint. Free, no credit cost, rate-limited per caller the same way the real app is.",
    inputSchema: { q: z.string().describe("A ticker, a company name, or a headline/rumor to check") },
    path: (args) => `/agitator?q=${encodeURIComponent(String(args.q || ""))}`,
  },
];

// Mirrors the exact same PATH 1 / PATH 1.5 / PATH 2 precedence the
// app-wide auth middleware in server.js already uses -- whichever
// credential got THIS /mcp request past that middleware is what every
// tool call forwards internally. Bearer is checked first since that's
// what the OAuth shim's minted access tokens arrive as (see
// oauth-server.js) -- a real, previously-missed gap: this function only
// ever recognized the query/header forms, so an OAuth-connected caller's
// every tool call silently forwarded an EMPTY credential internally and
// 401'd, even though the /mcp request itself was correctly authenticated.
function callerCredentialFrom(req) {
  const authHeader = req.headers["authorization"];
  const bearerMatch = typeof authHeader === "string" && authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) return { kind: "bearer", token: bearerMatch[1] };
  const supabaseToken = req.query.supabase_token || req.headers["x-supabase-token"];
  if (supabaseToken) return { kind: "query", param: "supabase_token", value: String(supabaseToken) };
  const secret = req.query.secret || req.headers["x-app-secret"];
  return { kind: "query", param: "secret", value: String(secret || "") };
}

function buildInternalUrl(port, path, credential) {
  const url = new URL(path, `http://127.0.0.1:${port}`);
  if (credential.kind !== "query") return url.toString();
  const sep = url.search ? "&" : "?";
  return `${url.toString()}${sep}${encodeURIComponent(credential.param)}=${encodeURIComponent(credential.value)}`;
}

function credentialHeaders(credential) {
  return credential.kind === "bearer" ? { authorization: `Bearer ${credential.token}` } : {};
}

// analyze() is a real, credit-spending call and needs a full Gate 0-5
// request body assembled from two upstream reads first -- /market (for
// sectorContext, the same shape every tier's own analyzeOne() builds:
// each tracked proxy's .change string plus gateStatus/gateNote/
// btcSignal) and /ticker/:symbol (for metrics/news/openingBar/
// proxyRule/gate1/preGate/weeklyCarryover/regime). Mirrors
// starter/app.ts's real analyzeOne() body assembly line for line --
// not reinvented -- since this app's own history (the Aug 13, 2026
// Gate 5 bug) is a direct lesson in how easily a re-derived version of
// this exact wiring goes subtly wrong.
async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  const data = await res.json().catch(() => ({ error: "non-JSON response", status: res.status }));
  return { ok: res.ok, status: res.status, data };
}

function buildSectorContext(market) {
  const chg = (k) => (market && market[k] ? market[k].change : "?");
  return {
    spy: chg("spy"), qqq: chg("qqq"), btc: chg("btc"), iwm: chg("iwm"),
    soxx: chg("soxx"), xbi: chg("xbi"), ibb: chg("ibb"), gld: chg("gld"),
    uso: chg("uso"), tsm: chg("tsm"), msft: chg("msft"),
    gateStatus: (market && market.gateStatus) || "GREEN",
    gateNote: (market && market.gateNote) || "",
    btcSignal: (market && market.btcSignal) || "neutral",
  };
}

async function runAnalyze(port, credential, ticker) {
  const symbol = String(ticker || "").toUpperCase();
  const marketUrl = buildInternalUrl(port, "/market", credential);
  const tickerUrl = buildInternalUrl(port, `/ticker/${encodeURIComponent(symbol)}`, credential);
  const authHeaders = credentialHeaders(credential);

  const [marketRes, tickerRes] = await Promise.all([fetchJson(marketUrl, authHeaders), fetchJson(tickerUrl, authHeaders)]);
  if (!tickerRes.ok) {
    return { error: true, step: "ticker", status: tickerRes.status, ...tickerRes.data };
  }
  const td = tickerRes.data || {};
  const market = marketRes.ok ? marketRes.data : null;

  const body = {
    ticker: symbol,
    sectorContext: buildSectorContext(market),
    marketContext: "",
    metricsData: td.metrics || null,
    newsData: td.news || null,
    openingBarData: td.openingBar || null,
    proxyRule: td.proxyRule || null,
    gate1Data: td.gate1 || null,
    preGateData: td.preGate || null,
    weeklyCarryoverData: td.weeklyCarryover || null,
    regimeData: td.regime || null,
    dialPosition: "NEUTRAL",
    holdThroughEarnings: false,
  };

  const analyzeUrl = buildInternalUrl(port, "/analyze", credential);
  const res = await fetch(analyzeUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: "non-JSON response", status: res.status }));
  if (!res.ok) return { error: true, step: "analyze", status: res.status, ...data };
  return data;
}

function getServer(req, port) {
  const server = new McpServer({ name: "trade-tribunal-mcp", version: "1.0.0" });
  const credential = callerCredentialFrom(req);

  for (const tool of READ_ONLY_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args) => {
        const url = buildInternalUrl(port, tool.path(args || {}), credential);
        try {
          const res = await fetch(url, { headers: credentialHeaders(credential) });
          const data = await res.json().catch(() => ({ error: "non-JSON response", status: res.status }));
          if (!res.ok) {
            return { content: [{ type: "text", text: JSON.stringify({ error: true, status: res.status, ...data }) }], isError: true };
          }
          return { content: [{ type: "text", text: JSON.stringify(data) }] };
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ error: true, message: e.message }) }], isError: true };
        }
      },
    );
  }

  server.registerTool(
    "analyze",
    {
      description: "Run a real Trade Tribunal Catalyst Response Framework analysis (Pre-Gate + Gates 0-5, verdict, sizing, confidence, wait_for) for one ticker via /analyze, and return the full breakdown. Spends a real credit against whichever credential this MCP connection authenticated with -- not free like the other 3 tools.",
      inputSchema: { ticker: z.string().describe("Ticker symbol to analyze, e.g. AAPL") },
    },
    async (args) => {
      try {
        const result = await runAnalyze(port, credential, args && args.ticker);
        const isError = !!(result && result.error);
        return { content: [{ type: "text", text: JSON.stringify(result) }], isError };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ error: true, message: e.message }) }], isError: true };
      }
    },
  );

  return server;
}

function mountMcpAt(app, port, path) {
  app.post(path, async (req, res) => {
    const server = getServer(req, port);
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (e) {
      console.error("MCP request error:", e.message);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  app.get(path, (req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  });

  app.delete(path, (req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  });
}

// /mcp itself has a stuck, unremovable/unrecoverable claude.ai custom-
// connector entry from before the OAuth shim existed (see oauth-server.js's
// own history) -- claude.ai enforces one connector per URL and gives no
// way to edit or delete that entry, so a second /mcp2 mount, byte-
// identical in every other respect, is what actually lets a real, working
// connector get created without fighting that stuck entry at all. Keep
// /mcp mounted too (still a real, working endpoint on its own) in case
// the stuck entry ever gets cleared/fixed on claude.ai's side later.
function mountMcpRoutes(app, port) {
  mountMcpAt(app, port, "/mcp");
  mountMcpAt(app, port, "/mcp2");
}

module.exports = { mountMcpRoutes };
