"use strict";
// ─── Minimal single-user OAuth 2.1 shim for /mcp (Sep 7, 2026) ────────
// claude.ai's remote/custom MCP connector flow doesn't support "attach
// this static header/query param to every request" -- it always tries
// to negotiate OAuth against the server first (discovery metadata, then
// /authorize, then /token), confirmed live: pointing it at /mcp directly
// produced a browser navigation to /authorize and our own generic
// "No API key or session token provided" 401, since Tra had no OAuth
// endpoints at all. This file adds just enough of the spec (RFC 8414
// authorization server metadata, RFC 9728 protected resource metadata,
// RFC 7591 dynamic client registration, OAuth 2.1 authorization-code +
// PKCE) for that flow to complete -- scoped deliberately to a single
// owner, not a real multi-tenant auth server.
//
// The one thing this must NOT do is loosen who can actually reach /mcp
// at pro tier. /authorize still requires typing the real MCP_AGENT_KEY
// into a plain HTML form before it will ever issue a code -- the OAuth
// dance wraps that same existing credential, it doesn't replace or
// bypass it. Only after that check passes does /token mint a separate,
// revocable access_token that server.js's auth middleware accepts as
// equivalent to MCP_AGENT_KEY for exactly this reason: claude.ai's own
// long-lived token then never has to be the raw shared secret itself.
//
// In-memory stores (registeredClients/authCodes/accessTokens/
// refreshTokens) -- same posture as this codebase's existing
// authCache/marketCache/etc: a single Render process, a restart clears
// them and the client just re-registers/re-authorizes, which is an
// acceptable cost for a single-user connector, not a real availability
// concern.

const crypto = require("crypto");

const CODE_TTL_MS    = 5  * 60 * 1000;   // authorization codes: 5 min, single-use
const ACCESS_TTL_MS  = 30 * 24 * 60 * 60 * 1000; // access tokens: 30 days
const REFRESH_TTL_MS = 180 * 24 * 60 * 60 * 1000; // refresh tokens: 180 days

const registeredClients = new Map(); // client_id -> { redirect_uris: string[] }
const authCodes         = new Map(); // code -> { client_id, redirect_uri, code_challenge, expires }
const accessTokens       = new Map(); // token -> { expires }
const refreshTokens      = new Map(); // token -> { expires }

function pruneExpired(map) {
  const now = Date.now();
  for (const [k, v] of map.entries()) if (v.expires < now) map.delete(k);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function base64UrlSha256(input) {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

function issuerFrom(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function validateAccessToken(token) {
  pruneExpired(accessTokens);
  const entry = accessTokens.get(token);
  return !!entry;
}

function authorizeFormHtml({ error, query }) {
  const hidden = Object.entries(query)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, "&quot;")}">`)
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Trade Tribunal MCP Authorization</title>
<style>body{font-family:system-ui,sans-serif;background:#080c12;color:#e9edf3;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}
form{background:#121a24;padding:32px;border-radius:12px;max-width:360px;width:100%}
h1{font-size:18px;margin:0 0 8px}p{color:#98a1ad;font-size:13px;margin:0 0 20px}
input[type=password]{width:100%;box-sizing:border-box;padding:10px;border-radius:6px;
border:1px solid #2a3542;background:#0d131b;color:#e9edf3;font-size:14px;margin-bottom:12px}
button{width:100%;padding:10px;border-radius:6px;border:none;background:#ffb62d;
color:#080c12;font-weight:600;font-size:14px;cursor:pointer}
.err{color:#ef4444;font-size:13px;margin-bottom:12px}</style></head>
<body><form method="POST">
<h1>Authorize Trade Tribunal access</h1>
<p>Enter the Trade Tribunal MCP key to approve this connection.</p>
${error ? `<div class="err">${error}</div>` : ""}
<input type="password" name="mcp_key" placeholder="MCP key" autofocus required>
${hidden}
<button type="submit">Approve</button>
</form></body></html>`;
}

function mountOAuthRoutes(app) {
  // ── RFC 8414: Authorization Server Metadata ──────────────────────
  app.get("/.well-known/oauth-authorization-server", (req, res) => {
    const issuer = issuerFrom(req);
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  // ── RFC 9728: Protected Resource Metadata (for /mcp itself) ──────
  app.get("/.well-known/oauth-protected-resource", (req, res) => {
    const issuer = issuerFrom(req);
    res.json({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
    });
  });
  app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => {
    const issuer = issuerFrom(req);
    res.json({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
    });
  });

  // ── RFC 7591: Dynamic Client Registration ────────────────────────
  app.post("/register", (req, res) => {
    console.log(`[OAUTH] POST /register body: ${JSON.stringify(req.body)}`);
    const redirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : [];
    if (redirectUris.length === 0) {
      console.log("[OAUTH] /register rejected: no redirect_uris");
      return res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris is required" });
    }
    const clientId = randomToken(16);
    registeredClients.set(clientId, { redirect_uris: redirectUris });
    console.log(`[OAUTH] /register issued client_id=${clientId} redirect_uris=${JSON.stringify(redirectUris)} (registeredClients now has ${registeredClients.size} entries)`);
    res.status(201).json({
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  // ── /authorize: GET renders the approval form, POST checks the ──
  // real MCP_AGENT_KEY and issues a one-time code on success ───────
  app.get("/authorize", (req, res) => {
    const { client_id, redirect_uri, code_challenge, code_challenge_method } = req.query;
    console.log(`[OAUTH] GET /authorize client_id=${client_id} redirect_uri=${redirect_uri} (registeredClients has ${registeredClients.size} entries: ${JSON.stringify([...registeredClients.keys()])})`);
    const client = registeredClients.get(String(client_id || ""));
    if (!client || !client.redirect_uris.includes(String(redirect_uri || ""))) {
      console.log(`[OAUTH] GET /authorize REJECTED -- client found: ${!!client}, client's own redirect_uris: ${JSON.stringify(client?.redirect_uris)}`);
      return res.status(400).send("Unknown client_id or redirect_uri.");
    }
    if (code_challenge_method !== "S256" || !code_challenge) {
      return res.status(400).send("PKCE (S256) is required.");
    }
    res.set("content-type", "text/html").send(authorizeFormHtml({ query: req.query }));
  });

  app.post("/authorize", (req, res) => {
    const { client_id, redirect_uri, code_challenge, code_challenge_method, state, mcp_key } = req.body || {};
    console.log(`[OAUTH] POST /authorize client_id=${client_id} redirect_uri=${redirect_uri} (registeredClients has ${registeredClients.size} entries: ${JSON.stringify([...registeredClients.keys()])})`);
    const client = registeredClients.get(String(client_id || ""));
    if (!client || !client.redirect_uris.includes(String(redirect_uri || ""))) {
      console.log(`[OAUTH] POST /authorize REJECTED -- client found: ${!!client}, client's own redirect_uris: ${JSON.stringify(client?.redirect_uris)}`);
      return res.status(400).send("Unknown client_id or redirect_uri.");
    }
    const agentKey = process.env.MCP_AGENT_KEY;
    if (!agentKey || mcp_key !== agentKey) {
      return res.set("content-type", "text/html").status(401).send(
        authorizeFormHtml({ error: "Incorrect key -- try again.", query: req.body })
      );
    }
    pruneExpired(authCodes);
    const code = randomToken(24);
    authCodes.set(code, {
      client_id: String(client_id),
      redirect_uri: String(redirect_uri),
      code_challenge: String(code_challenge),
      expires: Date.now() + CODE_TTL_MS,
    });
    const redirect = new URL(String(redirect_uri));
    redirect.searchParams.set("code", code);
    if (state) redirect.searchParams.set("state", String(state));
    res.redirect(302, redirect.toString());
  });

  // ── /token: authorization_code and refresh_token grants ──────────
  app.post("/token", (req, res) => {
    const body = req.body || {};
    console.log(`[OAUTH] POST /token grant_type=${body.grant_type} client_id=${body.client_id} (authCodes has ${authCodes.size} entries)`);
    if (body.grant_type === "authorization_code") {
      pruneExpired(authCodes);
      const entry = authCodes.get(String(body.code || ""));
      if (!entry) {
        console.log(`[OAUTH] /token REJECTED -- code not found (authCodes keys: ${JSON.stringify([...authCodes.keys()])})`);
        return res.status(400).json({ error: "invalid_grant", error_description: "Unknown or expired code." });
      }
      authCodes.delete(String(body.code)); // single-use

      if (entry.client_id !== String(body.client_id || "") || entry.redirect_uri !== String(body.redirect_uri || "")) {
        return res.status(400).json({ error: "invalid_grant", error_description: "client_id/redirect_uri mismatch." });
      }
      const verifier = String(body.code_verifier || "");
      if (!verifier || base64UrlSha256(verifier) !== entry.code_challenge) {
        return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed." });
      }

      pruneExpired(accessTokens);
      pruneExpired(refreshTokens);
      const accessToken  = randomToken(32);
      const refreshToken = randomToken(32);
      accessTokens.set(accessToken, { expires: Date.now() + ACCESS_TTL_MS });
      refreshTokens.set(refreshToken, { expires: Date.now() + REFRESH_TTL_MS });
      return res.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TTL_MS / 1000),
        refresh_token: refreshToken,
      });
    }

    if (body.grant_type === "refresh_token") {
      pruneExpired(refreshTokens);
      const entry = refreshTokens.get(String(body.refresh_token || ""));
      if (!entry) return res.status(400).json({ error: "invalid_grant", error_description: "Unknown or expired refresh token." });

      pruneExpired(accessTokens);
      const accessToken = randomToken(32);
      accessTokens.set(accessToken, { expires: Date.now() + ACCESS_TTL_MS });
      return res.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TTL_MS / 1000),
        refresh_token: body.refresh_token,
      });
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });
}

module.exports = { mountOAuthRoutes, validateAccessToken };
