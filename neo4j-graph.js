// ═══════════════════════════════════════════════════════════════
// COMPANY/INDUSTRY KNOWLEDGE GRAPH — Neo4j (Phase 1, Sep 1 2026)
// ═══════════════════════════════════════════════════════════════
//
// Phase 1 of a 5-phase build, the full shape worked out directly with
// Mr. T before any code (see the Notion build log / CLAUDE.md once this
// is documented — deliberately not touched yet per direct instruction).
// The end goal is a Neo4j graph pairing a static Company/industry
// relationship layer (TSMC -[:RELATED_TO {relationship_type:"supplies"}]->
// NVIDIA) with an Event layer (news events scored and linked to the real
// companies they expose), eventually feeding the Agitator Gauge's RELATED
// companies with real supply-chain/competitor traversal instead of hoping
// a news article happens to name the right company (see the Marketaux
// integration this same session shipped — a real improvement, but still
// fundamentally "hope the source mentions it," not "walk the real graph").
//
// THIS PHASE SHIPS ONLY THE FOUNDATION:
//   - the driver connection (fail-safe, same posture as every other
//     integration in this file — a missing/broken Neo4j config degrades
//     every function here to a safe no-op, never a thrown error into a
//     caller that isn't expecting one)
//   - idempotent schema constraints/indexes
//   - basic Company node + Company<->Company relationship upsert/query
// NOT YET BUILT (later phases, each to be scoped and confirmed before
// being built, not assumed from this comment):
//   - the Event node layer and Event-[:EXPOSES]->Company edges
//   - the continuous background ingestion pipeline from the existing news
//     sources (Finnhub/Alpaca/Marketaux) into this graph
//   - event_type classification (an AI call, same shape as the Agitator's
//     existing surprise/uncertainty/freshness scoring)
//   - wiring the Agitator's RELATED companies to actually query this graph
//   - the historical pattern-mining ("which relationship types react
//     strongest") layer — explicitly deferred until real history
//     accumulates, per direct instruction
//
// DESIGN DECISIONS, CONFIRMED DIRECTLY, NOT GUESSED:
// - Company<->Company relationships are ONE generic Neo4j relationship
//   type (:RELATED_TO) with relationship_type as a string property
//   ("supplies", "competes_with", "buys_equipment_from", ...) — freeform,
//   not a fixed enum, and not real distinct Neo4j relationship types per
//   label. Adding a new relationship_type value needs no schema change,
//   matching the explicit "freeform text label" decision.
// - Event->Company edges will be a real Neo4j relationship (:EXPOSES,
//   later phase), not a separate "EVENT_EXPOSURES" node/table — a Neo4j
//   relationship's own properties already ARE the bridge-table shape
//   Mr. T's original 5-table sketch called for.
// - Realized market-reaction data (5m/15m/30m/1h return, volume_change,
//   IV_change) will NOT live in Neo4j at all — it extends the existing
//   Supabase verdict_log/grading system (Proposal 7), joined back to
//   Neo4j only by event_id. Neo4j holds structure + predictions; Supabase
//   holds graded outcomes. Confirmed directly ("extend the existing
//   system") over a parallel Neo4j-native outcome mechanism.
// - source_credibility (Event field, later phase) ships as a real,
//   populated field from day one, seeded from a small static lookup —
//   explicitly built so it CAN be re-derived from a source's own
//   historical track record later, not held back until that mining layer
//   exists.
//
// company_id is the one required, stable identifier — ticker is
// deliberately nullable, since a private/foreign/unlisted entity (e.g. an
// equipment supplier with no public listing) still needs a real node.

const neo4j = require("neo4j-driver");

const driver = (process.env.NEO4J_URI && process.env.NEO4J_USERNAME && process.env.NEO4J_PASSWORD)
  ? neo4j.driver(
      process.env.NEO4J_URI,
      neo4j.auth.basic(process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD),
    )
  : null;

function isConfigured() {
  return !!driver;
}

function getSession() {
  return driver ? driver.session() : null;
}

async function closeDriver() {
  if (driver) await driver.close();
}

// Idempotent (IF NOT EXISTS on every statement) — safe to call on every
// boot, same posture this app already takes with its Supabase DDL patches
// (run once, safe to re-run). Never thrown into the boot sequence: a
// Neo4j outage at startup must not take the whole API down with it, same
// fail-safe posture as every other external dependency in this app.
const SCHEMA_STATEMENTS = [
  "CREATE CONSTRAINT company_id_unique IF NOT EXISTS FOR (c:Company) REQUIRE c.company_id IS UNIQUE",
  "CREATE INDEX company_ticker_idx IF NOT EXISTS FOR (c:Company) ON (c.ticker)",
  "CREATE INDEX company_industry_idx IF NOT EXISTS FOR (c:Company) ON (c.industry)",
  // Event constraints are declared now (even though the Event node itself
  // isn't written by any function in this phase) so a later phase's first
  // write already lands on an indexed, unique-constrained node type —
  // schema-readiness the design conversation explicitly asked for, not
  // scope creep into building the Event layer itself.
  "CREATE CONSTRAINT event_id_unique IF NOT EXISTS FOR (e:Event) REQUIRE e.event_id IS UNIQUE",
  "CREATE INDEX event_type_idx IF NOT EXISTS FOR (e:Event) ON (e.event_type)",
  "CREATE INDEX event_timestamp_idx IF NOT EXISTS FOR (e:Event) ON (e.timestamp)",
];

async function ensureSchema() {
  if (!driver) return { ok: false, reason: "NEO4J_URI/NEO4J_USERNAME/NEO4J_PASSWORD not set" };
  const session = getSession();
  try {
    for (const stmt of SCHEMA_STATEMENTS) {
      await session.run(stmt);
    }
    return { ok: true };
  } catch (e) {
    console.error("neo4j ensureSchema:", e.message);
    return { ok: false, reason: e.message };
  } finally {
    await session.close();
  }
}

// ── Company nodes ───────────────────────────────────────────────────
async function upsertCompany(company) {
  if (!driver) return null;
  const { company_id, name, country = null, industry = null, ticker = null, exchange = null } = company || {};
  if (!company_id || !name) throw new Error("upsertCompany requires company_id and name");
  const session = getSession();
  try {
    const result = await session.run(
      `MERGE (c:Company {company_id: $company_id})
       SET c.name = $name, c.country = $country, c.industry = $industry,
           c.ticker = $ticker, c.exchange = $exchange
       RETURN c`,
      { company_id, name, country, industry, ticker, exchange },
    );
    return result.records[0]?.get("c").properties || null;
  } finally {
    await session.close();
  }
}

// ── Company<->Company relationships ─────────────────────────────────
// MERGE matches on (fromCompany, toCompany, relationship_type) TOGETHER,
// via the relationship_type property inside the MERGE pattern itself —
// so re-running an identical claim (e.g. a re-seed) never creates a
// duplicate edge, but the SAME two companies can still carry multiple
// DIFFERENT relationship_type edges (e.g. TSMC could plausibly both
// "supplies" and "competes_with" the same company in different segments
// — the original design example anticipates exactly this).
async function upsertRelationship(fromCompanyId, toCompanyId, rel) {
  if (!driver) return null;
  const { relationship_type, strength = null, direction = "directed", confidence = null, source = null } = rel || {};
  if (!relationship_type) throw new Error("upsertRelationship requires relationship_type");
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (a:Company {company_id: $fromCompanyId})
       MATCH (b:Company {company_id: $toCompanyId})
       MERGE (a)-[r:RELATED_TO {relationship_type: $relationship_type}]->(b)
       SET r.strength = $strength, r.direction = $direction,
           r.confidence = $confidence, r.source = $source
       RETURN r`,
      { fromCompanyId, toCompanyId, relationship_type, strength, direction, confidence, source },
    );
    return result.records[0]?.get("r").properties || null;
  } finally {
    await session.close();
  }
}

// ── Query: a company's direct (1-hop) relationships, either direction ──
// Matched by ticker OR company_id so a caller with only a ticker in hand
// (the common case everywhere else in this app) doesn't need to look up
// the internal company_id first. This is the shape a later phase will
// point the Agitator's RELATED companies at — ships now so Phase 1 has
// something real to verify end-to-end against, not just write-only
// plumbing with nothing to read back.
async function getCompanyRelationships(tickerOrCompanyId) {
  if (!driver) return [];
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (c:Company)
       WHERE c.ticker = $key OR c.company_id = $key
       MATCH (c)-[r:RELATED_TO]-(other:Company)
       RETURN other.company_id AS company_id, other.name AS name,
              other.ticker AS ticker, r.relationship_type AS relationship_type,
              r.strength AS strength, r.confidence AS confidence,
              startNode(r).company_id = c.company_id AS outgoing`,
      { key: tickerOrCompanyId },
    );
    return result.records.map(rec => ({
      company_id: rec.get("company_id"),
      name: rec.get("name"),
      ticker: rec.get("ticker"),
      relationship_type: rec.get("relationship_type"),
      strength: rec.get("strength"),
      confidence: rec.get("confidence"),
      direction: rec.get("outgoing") ? "outgoing" : "incoming",
    }));
  } finally {
    await session.close();
  }
}

module.exports = {
  isConfigured,
  getSession,
  closeDriver,
  ensureSchema,
  upsertCompany,
  upsertRelationship,
  getCompanyRelationships,
};
