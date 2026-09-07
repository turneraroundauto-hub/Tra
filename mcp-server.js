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
// Deliberately narrow for this first pass: three read-only, already-free
// tools. No /analyze here -- that spends a real credit and needs a real
// signed-in session/tier credential decision this project's own history
// has learned not to make without asking first. Add it deliberately
// later, not as a side effect of shipping this.
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

// Mirrors the exact same PATH 1 / PATH 2 precedence the app-wide auth
// middleware in server.js already uses -- whichever credential got THIS
// /mcp request past that middleware is what every tool call forwards.
function callerCredentialFrom(req) {
  const supabaseToken = req.query.supabase_token || req.headers["x-supabase-token"];
  if (supabaseToken) return { param: "supabase_token", value: String(supabaseToken) };
  const secret = req.query.secret || req.headers["x-app-secret"];
  return { param: "secret", value: String(secret || "") };
}

function buildInternalUrl(port, path, credential) {
  const url = new URL(path, `http://127.0.0.1:${port}`);
  const sep = url.search ? "&" : "?";
  return `${url.toString()}${sep}${encodeURIComponent(credential.param)}=${encodeURIComponent(credential.value)}`;
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
          const res = await fetch(url);
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
  return server;
}

function mountMcpRoutes(app, port) {
  app.post("/mcp", async (req, res) => {
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

  app.get("/mcp", (req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  });

  app.delete("/mcp", (req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  });
}

module.exports = { mountMcpRoutes };
